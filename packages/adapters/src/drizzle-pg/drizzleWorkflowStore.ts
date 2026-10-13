import type { StartWorkflowInput, WorkflowFence, WorkflowStore } from "core/workflow"
import type { WorkflowClaim, WorkflowInstance, WorkflowSignal } from "core/workflow"
import { assertWorkflowDurableValue, isWorkflowSignalWait } from "core/workflow"
import { pgSchemaName } from "./pgSchemaName"
import { pgDate } from "./pgUtils"
import { normalizeDrizzleError } from "../drizzle-shared/errors"
import { decodeWorkflowFailure, encodeWorkflowFailure } from "../drizzle-shared/workflowFailureCodec"

interface PgResult { rows: Record<string, unknown>[]; rowCount?: number | null }
interface PgClient { query(text: string, values?: unknown[]): Promise<PgResult>; release?(): void }
interface PgPool extends PgClient { connect(): Promise<PgClient> }

function decode(row: Record<string, unknown>): WorkflowInstance {
  return { id: String(row.id), workflowType: String(row.workflow_type), workflowVersion: Number(row.workflow_version), executionScope: JSON.parse(String(JSON.stringify(row.execution_scope))), status: row.status as WorkflowInstance["status"], currentStep: String(row.current_step), variables: JSON.parse(String(JSON.stringify(row.variables))), stepAttempt: Number(row.step_attempt), compensationStack: JSON.parse(String(JSON.stringify(row.compensation_stack))), waitingSignal: row.waiting_signal == null ? null : String(row.waiting_signal), wakeAt: row.wake_at == null ? null : pgDate(row.wake_at), outcome: row.outcome == null ? null : row.outcome as WorkflowInstance["outcome"], revision: Number(row.revision), resumeSignalId: row.resume_signal_id == null ? null : String(row.resume_signal_id), failure: decodeWorkflowFailure(row.failure), leaseOwner: row.lease_owner == null ? null : String(row.lease_owner), claimToken: row.claim_token == null ? null : String(row.claim_token), leaseExpiresAt: row.lease_expires_at == null ? null : pgDate(row.lease_expires_at), createdAt: pgDate(row.created_at), updatedAt: pgDate(row.updated_at) }
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "compensation_failed"])
const SIGNAL_COLUMNS = "id,instance_id,name,payload,delivered_at"

function decodeSignal(row: Record<string, unknown> | undefined): WorkflowSignal | null {
  if (!row) return null
  const payload: unknown = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  return { id: String(row.id), instanceId: String(row.instance_id), name: String(row.name), payload: payload as Record<string, unknown>, deliveredAt: pgDate(row.delivered_at) }
}

export class DrizzlePgWorkflowStore implements WorkflowStore {
  private readonly schema: string
  /** @param options.schema PostgreSQL schema holding `workflows` and `workflow_signals` (default `public`). */
  constructor(private readonly pool: PgPool, options: { schema?: string } = {}) { this.schema = pgSchemaName(options.schema ?? "public") }
  async start(input: StartWorkflowInput): Promise<WorkflowInstance> { assertWorkflowDurableValue(input.variables); const result = await this.pool.query(`INSERT INTO ${this.schema}.workflows (id,workflow_type,workflow_version,execution_scope,status,current_step,variables) VALUES ($1,$2,$3,$4,'pending',$5,$6) RETURNING *`, [input.id,input.workflowType,input.workflowVersion,JSON.stringify(input.executionScope),input.initialStep,JSON.stringify(input.variables)]); return decode(result.rows[0]!) }
  async get(id: string): Promise<WorkflowInstance | null> { const result = await this.pool.query(`SELECT * FROM ${this.schema}.workflows WHERE id=$1`, [id]); return result.rows[0] ? decode(result.rows[0]) : null }
  async claimDue(args: { workerId: string; limit: number; leaseDurationMs: number; now?: Date }): Promise<readonly WorkflowClaim[]> { if(!Number.isSafeInteger(args.limit)||args.limit<=0||!Number.isFinite(args.leaseDurationMs)||args.leaseDurationMs<0)return []; const result = await this.pool.query(`WITH due AS (SELECT id FROM ${this.schema}.workflows WHERE (status='pending' OR (status='compensating' AND (wake_at IS NULL OR wake_at<=clock_timestamp())) OR (status='waiting' AND wake_at IS NOT NULL AND wake_at<=clock_timestamp())) AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE ${this.schema}.workflows w SET status=CASE WHEN w.status='waiting' THEN 'pending' ELSE w.status END, lease_owner=$2,claim_token=gen_random_uuid()::text,lease_expires_at=clock_timestamp()+($3*interval '1 millisecond'),step_attempt=step_attempt+1,revision=revision+1,updated_at=clock_timestamp() FROM due WHERE w.id=due.id RETURNING w.*`, [args.limit,args.workerId,args.leaseDurationMs]); return result.rows.map(row => { const instance=decode(row); return { instance, workerId: args.workerId, claimToken: instance.claimToken! } }) }
  async assertLease(fence: WorkflowFence): Promise<boolean> { const result=await this.pool.query(`SELECT 1 FROM ${this.schema}.workflows WHERE id=$1 AND lease_owner=$2 AND claim_token=$3 AND revision=$4 AND lease_expires_at>clock_timestamp()`,[fence.instanceId,fence.workerId,fence.claimToken,fence.revision]);return result.rowCount===1 }
  async renewLease(fence: WorkflowFence, extendByMs: number): Promise<boolean> { if(!Number.isFinite(extendByMs)||extendByMs<=0)return false; const result=await this.pool.query(`UPDATE ${this.schema}.workflows SET lease_expires_at=GREATEST(lease_expires_at,clock_timestamp()+($5*interval '1 millisecond')) WHERE id=$1 AND lease_owner=$2 AND claim_token=$3 AND revision=$4 AND lease_expires_at>clock_timestamp()`,[fence.instanceId,fence.workerId,fence.claimToken,fence.revision,extendByMs]);return result.rowCount===1 }
  /**
   * Fenced transition. The workflow row is locked first (`FOR UPDATE`, with the fence in the predicate), then, for a
   * signal wait, the oldest pending receipt of the awaited name is consumed in a NEW statement. Doing both in one
   * statement would let READ COMMITTED evaluate the receipt sub-select against a snapshot taken before the row lock was
   * granted, missing a delivery that committed while this commit waited for the lock: a lost wake. A delivery locks the
   * same row, so it is either committed before the receipt statement runs (the commit consumes it) or runs after this
   * commit and sees the waiting instance (the delivery consumes it).
   */
  async commit(fence: WorkflowFence, next: WorkflowInstance): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const locked = await client.query(`SELECT 1 FROM ${this.schema}.workflows WHERE id=$1 AND lease_owner=$2 AND claim_token=$3 AND revision=$4 AND lease_expires_at>clock_timestamp() FOR UPDATE`, [fence.instanceId, fence.workerId, fence.claimToken, fence.revision])
      if (locked.rowCount !== 1) { await client.query("ROLLBACK"); return false }
      let buffered: string | null = null
      if (isWorkflowSignalWait(next)) {
        const consumed = await client.query(`UPDATE ${this.schema}.workflow_signals SET consumed_at=clock_timestamp(),consumed_revision=$3 WHERE id=(SELECT id FROM ${this.schema}.workflow_signals WHERE instance_id=$1 AND name=$2 AND consumed_at IS NULL ORDER BY seq LIMIT 1) RETURNING id`, [fence.instanceId, next.waitingSignal, fence.revision + 1])
        buffered = consumed.rows[0] ? String(consumed.rows[0].id) : null
      }
      // A consumed receipt stores the resumed shape (resumeWorkflowFromBufferedSignal): pending, attempt 0, no timer, resume receipt set.
      await client.query(`UPDATE ${this.schema}.workflows SET workflow_version=$1,status=$2,current_step=$3,variables=$4,step_attempt=$5,compensation_stack=$6,waiting_signal=$7,wake_at=$8,outcome=$9,failure=$14,resume_signal_id=$15,revision=revision+1,lease_owner=NULL,claim_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$10 AND lease_owner=$11 AND claim_token=$12 AND revision=$13`, [next.workflowVersion, buffered ? "pending" : next.status, next.currentStep, JSON.stringify(next.variables), buffered ? 0 : next.stepAttempt, JSON.stringify(next.compensationStack), next.waitingSignal, buffered ? null : next.wakeAt, next.outcome, fence.instanceId, fence.workerId, fence.claimToken, fence.revision, encodeWorkflowFailure(next.failure), buffered ?? next.resumeSignalId ?? null])
      await client.query("COMMIT")
      return true
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally { client.release?.() }
  }
  /**
   * Records a signal receipt and, when the instance is waiting for that name, consumes the oldest pending receipt of the
   * name and wakes the instance. The instance row is locked FOR UPDATE before anything is inserted: deliveries and
   * commits of one instance serialize there, so the per-instance delivery order (`seq`) is the commit order and a
   * delivery can never miss a concurrent wait commit. A missing instance yields `{ delivered: false, duplicate: false }`
   * instead of a foreign-key failure, as does a terminal one (nothing is stored). Other provider failures are normalized.
   */
  async deliverSignal(signal: Omit<WorkflowSignal,"deliveredAt">): Promise<{delivered:boolean;duplicate:boolean}> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const instance = await client.query(`SELECT status,wake_at,waiting_signal,revision FROM ${this.schema}.workflows WHERE id=$1 FOR UPDATE`, [signal.instanceId])
      const row = instance.rows[0]
      if (!row) { await client.query("ROLLBACK"); return { delivered: false, duplicate: false } }
      // The receipt id is global: an id stored for any instance is a duplicate, even when this instance is terminal.
      if ((await client.query(`SELECT 1 FROM ${this.schema}.workflow_signals WHERE id=$1`, [signal.id])).rowCount === 1) { await client.query("ROLLBACK"); return { delivered: false, duplicate: true } }
      if (TERMINAL_STATUSES.has(String(row.status))) { await client.query("ROLLBACK"); return { delivered: false, duplicate: false } }
      const inserted = await client.query(`INSERT INTO ${this.schema}.workflow_signals (id,instance_id,name,payload) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING id`, [signal.id, signal.instanceId, signal.name, JSON.stringify(signal.payload)])
      // Same id inserted concurrently for another instance (that row's lock is not ours): the loser is a duplicate.
      if (inserted.rowCount !== 1) { await client.query("ROLLBACK"); return { delivered: false, duplicate: true } }
      if (row.status === "waiting" && row.wake_at == null && row.waiting_signal === signal.name) {
        const consumed = await client.query(`UPDATE ${this.schema}.workflow_signals SET consumed_at=clock_timestamp(),consumed_revision=$3 WHERE id=(SELECT id FROM ${this.schema}.workflow_signals WHERE instance_id=$1 AND name=$2 AND consumed_at IS NULL ORDER BY seq LIMIT 1) RETURNING id`, [signal.instanceId, signal.name, Number(row.revision) + 1])
        await client.query(`UPDATE ${this.schema}.workflows SET status='pending',wake_at=NULL,step_attempt=0,resume_signal_id=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`, [signal.instanceId, consumed.rows[0]!.id])
      }
      await client.query("COMMIT")
      return { delivered: true, duplicate: false }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw normalizeDrizzleError(error, "postgresql")
    } finally { client.release?.() }
  }
  async cancel(id: string): Promise<boolean> { const result=await this.pool.query(`UPDATE ${this.schema}.workflows SET status=CASE WHEN jsonb_array_length(compensation_stack)>0 THEN 'compensating' ELSE 'cancelled' END,outcome=CASE WHEN jsonb_array_length(compensation_stack)>0 THEN NULL ELSE 'cancelled' END,failure=jsonb_build_object('code','CANCELLED','message','Workflow was cancelled','step',current_step,'phase','execute','attempt',step_attempt,'at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),step_attempt=0,waiting_signal=NULL,resume_signal_id=NULL,wake_at=NULL,revision=revision+1,lease_owner=NULL,claim_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status NOT IN ('succeeded','failed','cancelled','compensation_failed','compensating')`,[id]); return result.rowCount===1 }
  /** The latest receipt of this name by delivery order, pending or consumed (legacy lookup; see `getSignalById`). */
  async getSignal(instanceId: string, name: string): Promise<WorkflowSignal | null> { const result = await this.pool.query(`SELECT ${SIGNAL_COLUMNS} FROM ${this.schema}.workflow_signals WHERE instance_id=$1 AND name=$2 ORDER BY seq DESC LIMIT 1`, [instanceId, name]); return decodeSignal(result.rows[0]) }
  /** The receipt with this id for this instance, pending or consumed. */
  async getSignalById(instanceId: string, signalId: string): Promise<WorkflowSignal | null> { const result = await this.pool.query(`SELECT ${SIGNAL_COLUMNS} FROM ${this.schema}.workflow_signals WHERE instance_id=$1 AND id=$2`, [instanceId, signalId]); return decodeSignal(result.rows[0]) }
}
