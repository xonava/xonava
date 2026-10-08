import { sql } from "drizzle-orm"
import type { AnyPgTable } from "drizzle-orm/pg-core"
import type { ClaimedPendingInvalidation, IdempotencyAcquireResult, IdempotencyCompletion, IdempotencyCommitItem, IdempotencyFinalizationPort, IdempotencyRequest, TransactionalIdempotencyPort } from "core/events"
import type { PersistenceProvider } from "core/persistence"
import { ConflictError } from "core/domain"
import type { DrizzleSessionLike } from "./drizzleRepository"
import { getAffectedRows } from "./pgUtils"
import { getDrizzleSession } from "./drizzlePersistenceProvider"
import { parseInvalidations, serializeInvalidations, encodeResourceVersion, resolveExistingIdempotency } from "../drizzle-shared/idempotency"
import { validateLeaseDuration, validateLeaseOwner, resolveLeaseLimit } from "../drizzle-shared/lease"

function findPgProperty(error: unknown, property: "code" | "constraint"): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === "object" && property in current) {
      const value = (current as Record<string, unknown>)[property]
      if (typeof value === "string") return value
    }
    current = typeof current === "object" && "cause" in current ? (current as { cause?: unknown }).cause : undefined
  }
  return undefined
}

export class DrizzlePgIdempotencyStore<TResult>
  implements TransactionalIdempotencyPort<TResult>, IdempotencyFinalizationPort<TResult>
{
  constructor(private readonly db: DrizzleSessionLike, private readonly table: AnyPgTable) {}

  async acquire(request: IdempotencyRequest): Promise<IdempotencyAcquireResult<TResult>> {
    const leaseDurationMs = validateLeaseDuration(request.leaseDurationMs)
    const token = crypto.randomUUID()
    try {
      await this.db.insert(this.table).values({
        id: crypto.randomUUID(),
        scope: request.scope,
        key: request.key,
        fingerprint: request.fingerprint,
        token,
        status: "in-progress",
        result: null,
      })
      return { outcome: "acquired", token }
    } catch (error) {
      if (findPgProperty(error, "code") !== "23505") throw error
      // A unique violation may be the idempotency scope+key constraint or an
      // unrelated collision. Only treat it as an idempotency conflict when the
      // reservation is actually addressable by scope+key.
      const [existing] = await this.db.select().from(this.table)
        .where(sql`scope = ${request.scope} AND key = ${request.key}`)
        .limit(1)
      const row = existing as Record<string, unknown> | undefined
      if (!row) throw error
       let resolved: IdempotencyAcquireResult<TResult> | undefined
       try {
          resolved = resolveExistingIdempotency<TResult>(request, row)
       } catch (error) {
         await this.db.update(this.table).set({ status: "poisoned" }).where(sql`scope = ${row.scope} AND key = ${row.key} AND token = ${row.token} AND status = 'business-committed'`)
         throw error
       }
      if (resolved) return resolved
      return this.takeoverOrRecheck(request, leaseDurationMs)
    }
  }

  private async takeoverOrRecheck(request: IdempotencyRequest, leaseDurationMs: number): Promise<IdempotencyAcquireResult<TResult>> {
    const takeoverToken = crypto.randomUUID()
    const updated = await this.db.update(this.table).set({
      token: takeoverToken,
      createdAt: sql`now()`,
    }).where(sql`scope = ${request.scope} AND key = ${request.key} AND fingerprint = ${request.fingerprint} AND status = 'in-progress' AND created_at < now() - (${leaseDurationMs} * interval '1 millisecond')`)
    if (getAffectedRows(updated) === 1) return { outcome: "acquired", token: takeoverToken }
    const [current] = await this.db.select().from(this.table)
      .where(sql`scope = ${request.scope} AND key = ${request.key}`)
      .limit(1)
    const currentRow = current as Record<string, unknown> | undefined
    if (!currentRow) return { outcome: "in-progress" }
     try {
        return resolveExistingIdempotency<TResult>(request, currentRow) ?? { outcome: "in-progress" }
     } catch (error) {
       await this.db.update(this.table).set({ status: "poisoned" }).where(sql`scope = ${currentRow.scope} AND key = ${currentRow.key} AND token = ${currentRow.token} AND status = 'business-committed'`)
       throw error
     }
  }

  async renew(lease: { scope: string; key: string; fingerprint: string; token: string; leaseDurationMs?: number }): Promise<void> {
    validateLeaseDuration(lease.leaseDurationMs)
    const updated = await this.db.update(this.table).set({ createdAt: sql`now()` }).where(sql`scope = ${lease.scope} AND key = ${lease.key} AND fingerprint = ${lease.fingerprint} AND token = ${lease.token} AND status = 'in-progress'`)
    if (getAffectedRows(updated) !== 1) throw new Error("Idempotency lease renewal lost ownership")
  }

  /** Releases an uncommitted reservation this caller still owns; committed receipts are never touched. */
  async abandon(lease: { scope: string; key: string; fingerprint: string; token: string }): Promise<void> {
    await this.db.delete(this.table).where(sql`scope = ${lease.scope} AND key = ${lease.key} AND fingerprint = ${lease.fingerprint} AND token = ${lease.token} AND status = 'in-progress'`)
  }

  async markCommittedInTransaction(completion: IdempotencyCommitItem, persistence: PersistenceProvider): Promise<void> {
    const session = getDrizzleSession(persistence)
    // The committed marker stores only the receipt (identity + obligations),
    // never a replayable response. The safe response is written by complete().
    const updated = await session.update(this.table).set({
      status: "business-committed",
      result: null,
      resourceEntity: completion.resource?.entity ?? null,
      resourceId: completion.resource?.id ?? null,
      resourceVersion: completion.resource?.version == null ? null : encodeResourceVersion(completion.resource.version),
      pendingInvalidations: serializeInvalidations(completion.invalidations),
      completedAt: sql`now()`,
    }).where(sql`scope = ${completion.scope} AND key = ${completion.key} AND fingerprint = ${completion.fingerprint} AND token = ${completion.token} AND status = 'in-progress'`)
    if (getAffectedRows(updated) !== 1) {
      throw new ConflictError("Idempotency ownership was lost before the mutation committed")
    }
  }

  async claimPendingInvalidations(args: {
    limit?: number
    claimOwner: string
    leaseMs: number
    claimToken?: string
  }): Promise<ClaimedPendingInvalidation[]> {
    const leaseMs = validateLeaseDuration(args.leaseMs)
    const limit = resolveLeaseLimit(args.limit)
    validateLeaseOwner(args.claimOwner)
    const claimToken = args.claimToken ?? crypto.randomUUID()
    // Select candidates that are not leased or whose lease expired (DB time via now())
    const rows = await this.db.select().from(this.table)
      .where(sql`status = 'business-committed' AND pending_invalidations IS NOT NULL AND (finalizer_claim_expires_at IS NULL OR finalizer_claim_expires_at < now())`)
      .limit(limit)
    const claimed: ClaimedPendingInvalidation[] = []
    for (const rawRow of rows) {
      const row = rawRow as Record<string, unknown>
      let invalidations: string[]
      try {
        invalidations = parseInvalidations(row.pendingInvalidations)
      } catch {
        await this.db.update(this.table).set({ status: "poisoned" }).where(sql`scope = ${row.scope} AND key = ${row.key} AND token = ${row.token} AND status = 'business-committed'`)
        continue
      }
      const result: unknown = typeof row.result === "string" ? (() => { try { return JSON.parse(row.result) as unknown } catch { return null } })() : null
      const updated = await this.db.update(this.table).set({
        finalizerClaimOwner: args.claimOwner,
        finalizerClaimToken: claimToken,
        finalizerClaimExpiresAt: sql`now() + (${leaseMs} * interval '1 millisecond')`,
      }).where(sql`scope = ${row.scope} AND key = ${row.key} AND token = ${row.token} AND status = 'business-committed' AND pending_invalidations IS NOT NULL AND (finalizer_claim_expires_at IS NULL OR finalizer_claim_expires_at < now())`)
      if (getAffectedRows(updated) === 1) {
        // Omit finalizerClaimExpiresAt from returned claim to avoid informational divergence; DB is source of truth.
        claimed.push({
          scope: row.scope as string,
          key: row.key as string,
          fingerprint: row.fingerprint as string,
          token: row.token as string,
          invalidations,
          result,
          claimToken,
          claimOwner: args.claimOwner,
        })
      }
    }
    return claimed
  }

  async ackClaimedInvalidation(request: {
    scope: string
    key: string
    fingerprint: string
    token: string
    claimToken: string
  }): Promise<void> {
    const updated = await this.db.update(this.table).set({
      pendingInvalidations: null,
      finalizerClaimOwner: null,
      finalizerClaimToken: null,
      finalizerClaimExpiresAt: null,
    }).where(sql`scope = ${request.scope} AND key = ${request.key} AND fingerprint = ${request.fingerprint} AND token = ${request.token} AND finalizer_claim_token = ${request.claimToken} AND status = 'business-committed' AND finalizer_claim_expires_at > now()`)
    if (getAffectedRows(updated) !== 1) throw new Error("Idempotency ack claimed invalidations lost ownership or lease expired")
  }

  async completeClaimedInvalidation(completion: IdempotencyCompletion<TResult> & { claimToken: string }): Promise<void> {
    const updated = await this.db.update(this.table).set({
      status: "completed",
      result: JSON.stringify(completion.result),
      pendingInvalidations: null,
      finalizerClaimOwner: null,
      finalizerClaimToken: null,
      finalizerClaimExpiresAt: null,
      completedAt: sql`now()`,
    }).where(sql`scope = ${completion.scope} AND key = ${completion.key} AND fingerprint = ${completion.fingerprint} AND token = ${completion.token} AND finalizer_claim_token = ${completion.claimToken} AND status = 'business-committed' AND finalizer_claim_expires_at > now()`)
    if (getAffectedRows(updated) !== 1) throw new Error("Idempotency complete claimed invalidations lost ownership or lease expired")
  }

  async complete(completion: IdempotencyCompletion<TResult>): Promise<void> {
    const updated = await this.db.update(this.table).set({
      status: "completed",
      result: JSON.stringify(completion.result),
      pendingInvalidations: null,
      finalizerClaimOwner: null,
      finalizerClaimToken: null,
      finalizerClaimExpiresAt: null,
      completedAt: sql`now()`,
    }).where(sql`scope = ${completion.scope} AND key = ${completion.key} AND fingerprint = ${completion.fingerprint} AND token = ${completion.token} AND status = 'business-committed'`)
    if (getAffectedRows(updated) !== 1) throw new Error("Idempotency completion lost ownership of the reservation")
  }
}

export function createDrizzlePgIdempotencyStore<TResult>(
  db: DrizzleSessionLike,
  table: AnyPgTable,
): TransactionalIdempotencyPort<TResult> & IdempotencyFinalizationPort<TResult> {
  return new DrizzlePgIdempotencyStore<TResult>(db, table)
}
