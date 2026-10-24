import { describe, expect, it } from "vitest"
import { ConfigurationError, ConflictError, StaleClaimError } from "@xonava/core/domain"
import { DrizzlePgJobProgressStore } from "../drizzleJobProgressStore"
import { DrizzlePgSequenceStore, postgresSequenceSchemaSql, POSTGRES_SEQUENCE_SCHEMA_SQL } from "../drizzleSequenceStore"
import { DrizzlePgTemporalHistoryStore, postgresTemporalSchemaSql, POSTGRES_TEMPORAL_SCHEMA_SQL } from "../drizzleTemporalHistoryStore"
import { getAffectedRows, pgDate } from "../pgUtils"
import { createScriptedPgPool, type PoolCall } from "../../__tests__/support/scriptedPool"

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim()
const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms)
const resource = { scopeId: "fscope:v1:t" as never, entityType: "invoice", entityId: "i1" }

describe("pgUtils", () => {
  it("extracts the affected-row count from every supported result shape", () => {
    expect(getAffectedRows({ affectedRows: 3 })).toBe(3)
    expect(getAffectedRows({ rowCount: 4 })).toBe(4)
    expect(getAffectedRows({ rowsAffected: 5 })).toBe(5)
    expect(getAffectedRows({ count: 6 })).toBe(6)
    expect(getAffectedRows({ meta: { rowCount: 7 } })).toBe(7)
    expect(getAffectedRows({ meta: { changes: 8 } })).toBe(8)
    expect(getAffectedRows({ affectedRows: 0, rowCount: 9 })).toBe(0)
    expect(getAffectedRows({ rowCount: 0 })).toBe(0)
  })

  it("distinguishes a non-object result from an object with no count", () => {
    for (const bad of [null, undefined, 0, "text", 5, true]) {
      expect(() => getAffectedRows(bad)).toThrow(new ConfigurationError("Unsupported PostgreSQL mutation result shape: expected an object"))
    }
    for (const bad of [{}, { meta: null }, { meta: {} }, { meta: "x" }, { rowCount: "3" }, { meta: { changes: "1" } }]) {
      expect(() => getAffectedRows(bad)).toThrow(new ConfigurationError("Unsupported PostgreSQL mutation result shape: could not extract affected rows"))
    }
  })

  it("keeps Date instances and parses other values as text", () => {
    const date = new Date("2026-01-01T00:00:00.123Z")
    expect(pgDate(date)).toBe(date)
    expect(pgDate("2026-01-01T00:00:00.123Z")).toEqual(date)
    expect(pgDate(date.getTime()).getTime()).toBe(new Date(String(date.getTime())).getTime())
  })
})

describe("sequence store", () => {
  it("accepts the smallest valid value and names the failure", async () => {
    const one = createScriptedPgPool(() => [{ value: 1 }])
    expect(await new DrizzlePgSequenceStore(one.pool).next("s" as never, "n", "p")).toBe(1)
    expect(norm(one.calls[0]!.sql)).toBe("INSERT INTO public.sequences(scope_id,name,period,value) VALUES($1,$2,$3,1) ON CONFLICT(scope_id,name,period) DO UPDATE SET value=public.sequences.value+1 RETURNING value")
    await expect(new DrizzlePgSequenceStore(createScriptedPgPool(() => [{ value: 0 }]).pool).next("s" as never, "n", "p")).rejects.toThrow(new Error("PostgreSQL sequence allocation failed"))
  })

  it("renders the exact sequence DDL and validates the schema", () => {
    expect(postgresSequenceSchemaSql()).toBe("CREATE TABLE IF NOT EXISTS public.sequences(scope_id text NOT NULL,name text NOT NULL,period text NOT NULL,value bigint NOT NULL CHECK(value>0),PRIMARY KEY(scope_id,name,period));")
    expect(postgresSequenceSchemaSql("tenant_a")).toContain("tenant_a.sequences(")
    expect(POSTGRES_SEQUENCE_SCHEMA_SQL).toBe(postgresSequenceSchemaSql("framework_test"))
    expect(() => postgresSequenceSchemaSql("bad schema")).toThrow(new ConfigurationError("Unsafe PostgreSQL schema name"))
  })
})

describe("temporal history store", () => {
  const revisionRow = (overrides: Record<string, unknown> = {}) => ({ scope_id: resource.scopeId, entity_type: "invoice", entity_id: "i1", revision: "2", occurred_at: at(10), kind: "updated", state: { n: 2 }, entity_version: "4", event_id: "e1", audit_id: "a1", ...overrides })

  it("rejects an append that changed no head with the exact message", async () => {
    const store = new DrizzlePgTemporalHistoryStore(createScriptedPgPool(() => []).pool)
    await expect(store.append({ ...resource, occurredAt: at(0), kind: "updated", state: { n: 1 } })).rejects.toThrow(
      new ConflictError("Temporal revision rejected: not chronological, not a valid lifecycle transition, or the entity already exists"),
    )
  })

  it("decodes a stored revision with absent state and optional ids", async () => {
    const gone = createScriptedPgPool(() => [revisionRow({ kind: "deleted", state: undefined, entity_version: undefined, event_id: undefined, audit_id: undefined })])
    const revision = await new DrizzlePgTemporalHistoryStore(gone.pool).append({ ...resource, occurredAt: at(10), kind: "deleted", state: null })
    expect(revision.state).toBeNull()
    expect(revision).not.toHaveProperty("entityVersion")
    expect(revision).not.toHaveProperty("eventId")
    expect(revision).not.toHaveProperty("auditId")
    const text = createScriptedPgPool(() => [revisionRow({ state: '{"n":2}' })])
    expect((await new DrizzlePgTemporalHistoryStore(text.pool).append({ ...resource, occurredAt: at(10), kind: "updated", state: { n: 2 } })).state).toEqual({ n: 2 })
  })

  it("saves a snapshot with an idempotent insert", async () => {
    const { pool, calls } = createScriptedPgPool(() => [])
    await new DrizzlePgTemporalHistoryStore(pool, "tenant_a").saveSnapshot({ ...resource, revision: 3, occurredAt: at(5), state: { n: 3 } })
    expect(norm(calls[0]!.sql)).toBe("INSERT INTO tenant_a.temporal_snapshots(scope_id,entity_type,entity_id,revision,occurred_at,state) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING")
    expect(calls[0]!.params).toEqual([resource.scopeId, "invoice", "i1", 3, at(5), '{"n":3}'])
  })

  it("reads the latest snapshot at or before a time", async () => {
    const snapshot = createScriptedPgPool(() => [{ revision: "3", occurred_at: at(5), state: '{"n":3}' }])
    const found = await new DrizzlePgTemporalHistoryStore(snapshot.pool, "tenant_a").latestSnapshot(resource, at(9))
    expect(found).toEqual({ ...resource, revision: 3, occurredAt: at(5), state: { n: 3 } })
    expect(norm(snapshot.calls[0]!.sql)).toBe("SELECT * FROM tenant_a.temporal_snapshots WHERE scope_id=$1 AND entity_type=$2 AND entity_id=$3 AND occurred_at<=$4 ORDER BY revision DESC LIMIT 1")
    expect(snapshot.calls[0]!.params).toEqual([resource.scopeId, "invoice", "i1", at(9)])
    const deleted = createScriptedPgPool(() => [{ revision: 0, occurred_at: at(5), state: null }])
    expect((await new DrizzlePgTemporalHistoryStore(deleted.pool).latestSnapshot(resource, at(9)))?.state).toBeNull()
    const undefinedState = createScriptedPgPool(() => [{ revision: 1, occurred_at: at(5), state: undefined }])
    expect((await new DrizzlePgTemporalHistoryStore(undefinedState.pool).latestSnapshot(resource, at(9)))?.state).toBeNull()
    expect(await new DrizzlePgTemporalHistoryStore(createScriptedPgPool(() => []).pool).latestSnapshot(resource, at(9))).toBeNull()
  })

  it("pages revisions after a revision and reports more only when a further row exists", async () => {
    const rows = [revisionRow({ revision: 1, kind: "created" }), revisionRow({ revision: 2 })]
    const exact = createScriptedPgPool(() => rows)
    const page = await new DrizzlePgTemporalHistoryStore(exact.pool, "tenant_a").revisions(resource, { afterRevision: 0, asOf: at(100), limit: 2 })
    expect(page.items.map((item) => item.revision)).toEqual([1, 2])
    expect(page.hasMore).toBe(false)
    expect(norm(exact.calls[0]!.sql)).toBe("SELECT * FROM tenant_a.temporal_revisions WHERE scope_id=$1 AND entity_type=$2 AND entity_id=$3 AND revision>$4 AND occurred_at<=$5 ORDER BY revision LIMIT $6")
    expect(exact.calls[0]!.params).toEqual([resource.scopeId, "invoice", "i1", 0, at(100), 3])
    const more = createScriptedPgPool(() => [...rows, revisionRow({ revision: 3 })])
    expect((await new DrizzlePgTemporalHistoryStore(more.pool).revisions(resource, { afterRevision: 0, asOf: at(100), limit: 2 })).hasMore).toBe(true)
  })

  it("renders the exact temporal DDL for the schema", () => {
    expect(postgresTemporalSchemaSql()).toBe("CREATE TABLE IF NOT EXISTS public.temporal_heads(scope_id text NOT NULL,entity_type text NOT NULL,entity_id text NOT NULL,revision bigint NOT NULL CHECK(revision>0),occurred_at timestamptz NOT NULL,kind text NOT NULL CHECK(kind IN ('created','updated','deleted','restored')),CHECK(revision>1 OR kind='created'),PRIMARY KEY(scope_id,entity_type,entity_id));CREATE TABLE IF NOT EXISTS public.temporal_revisions(scope_id text NOT NULL,entity_type text NOT NULL,entity_id text NOT NULL,revision bigint NOT NULL CHECK(revision>0),occurred_at timestamptz NOT NULL,kind text NOT NULL CHECK(kind IN ('created','updated','deleted','restored')),state jsonb,entity_version bigint,event_id text,audit_id text,CHECK((kind='deleted' AND state IS NULL) OR (kind<>'deleted' AND state IS NOT NULL)),PRIMARY KEY(scope_id,entity_type,entity_id,revision));CREATE INDEX IF NOT EXISTS temporal_revisions_time_idx ON public.temporal_revisions(scope_id,entity_type,entity_id,occurred_at,revision);CREATE TABLE IF NOT EXISTS public.temporal_snapshots(scope_id text NOT NULL,entity_type text NOT NULL,entity_id text NOT NULL,revision bigint NOT NULL CHECK(revision>=0),occurred_at timestamptz NOT NULL,state jsonb,PRIMARY KEY(scope_id,entity_type,entity_id,revision));")
    expect(POSTGRES_TEMPORAL_SCHEMA_SQL).toBe(postgresTemporalSchemaSql("framework_test"))
  })
})

describe("job progress store", () => {
  const fence = { jobId: "j1", workerId: "w1", claimToken: "tok", attempt: 2 }
  const progressRow = (overrides: Record<string, unknown> = {}) => ({ job_id: "j1", attempt: 2, sequence: "1", percent: "10", checkpoint: { step: 1 }, updated_at: at(5), ...overrides })
  const FENCE_SQL = `"id"=$1 AND "worker_id"=$2 AND "claim_token"=$3 AND "attempt"=$4 AND "lease_expires_at" > clock_timestamp()`

  it("reads progress by job id from the configured schema", async () => {
    const { pool, calls } = createScriptedPgPool(() => [progressRow({ checkpoint: '{"step":1}' })])
    const progress = await new DrizzlePgJobProgressStore(pool, { schema: "app" }).read("j1")
    expect(calls.map((call) => [norm(call.sql), call.params])).toEqual([["SELECT job_id,attempt,sequence,percent,checkpoint,updated_at FROM app.job_progress WHERE job_id=$1", ["j1"]]])
    expect(progress).toEqual({ jobId: "j1", attempt: 2, sequence: 1, percent: 10, checkpoint: { step: 1 }, updatedAt: at(5).toISOString() })
  })

  it("writes through one fenced upsert and returns the stored checkpoint", async () => {
    const { pool, calls } = createScriptedPgPool(() => [progressRow({ sequence: "3", checkpoint: { raw: true } })])
    const written = await new DrizzlePgJobProgressStore(pool, { schema: "app", jobsTable: "platform_jobs" }).write(fence, 2, { percent: 55, checkpoint: { a: 1 } })
    expect(written).toEqual({ jobId: "j1", attempt: 2, sequence: 3, percent: 10, checkpoint: { raw: true }, updatedAt: at(5).toISOString() })
    expect(calls).toHaveLength(1)
    expect(norm(calls[0]!.sql)).toBe(`INSERT INTO app.job_progress(job_id,attempt,sequence,percent,checkpoint,updated_at) SELECT "id","attempt",$5,$6,$7::jsonb,clock_timestamp() FROM app.platform_jobs WHERE ${FENCE_SQL} AND ($8::bigint=0 OR EXISTS(SELECT 1 FROM app.job_progress WHERE job_id=$1)) ON CONFLICT(job_id) DO UPDATE SET attempt=EXCLUDED.attempt,sequence=EXCLUDED.sequence,percent=EXCLUDED.percent,checkpoint=EXCLUDED.checkpoint,updated_at=EXCLUDED.updated_at WHERE app.job_progress.sequence=$8 RETURNING job_id,attempt,sequence,percent,checkpoint,updated_at`)
    expect(calls[0]!.params).toEqual(["j1", "w1", "tok", 2, 3, 55, '{"a":1}', 2])
  })

  it("validates progress before issuing any SQL", async () => {
    const { pool, calls } = createScriptedPgPool(() => [progressRow()])
    await expect(new DrizzlePgJobProgressStore(pool).write(fence, 0, { percent: 500 })).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it("tells lost ownership from a sequence conflict by re-checking the fence", async () => {
    const owned = createScriptedPgPool((call: PoolCall) => (call.sql.startsWith("INSERT") ? { rows: [], rowCount: 0 } : { rows: [{}], rowCount: 1 }))
    await expect(new DrizzlePgJobProgressStore(owned.pool, { schema: "app", jobsTable: "platform_jobs" }).write(fence, 1, { percent: 5 })).rejects.toThrow(new ConflictError("Job progress sequence conflict"))
    expect(owned.calls).toHaveLength(2)
    expect(norm(owned.calls[1]!.sql)).toBe(`SELECT 1 FROM app.platform_jobs WHERE ${FENCE_SQL}`)
    expect(owned.calls[1]!.params).toEqual(["j1", "w1", "tok", 2])
    const lost = createScriptedPgPool(() => ({ rows: [], rowCount: 0 }))
    await expect(new DrizzlePgJobProgressStore(lost.pool).write(fence, 1, { percent: 5 })).rejects.toThrow(new StaleClaimError("Job progress ownership was lost"))
  })

  it("names the fence column that is unsafe or missing", () => {
    const pool = createScriptedPgPool(() => []).pool
    const complete = { id: { name: "job_id" }, leaseOwner: { name: "owner" }, claimToken: { name: "token" }, attempts: { name: "tries" }, leaseExpiresAt: { name: "lease_until" } }
    const labels: Record<string, string> = { id: "id", leaseOwner: "workerId", claimToken: "claimToken", attempts: "attempt", leaseExpiresAt: "leaseExpiresAt" }
    for (const [key, label] of Object.entries(labels)) {
      const { [key]: _removed, ...rest } = complete as Record<string, unknown>
      expect(() => new DrizzlePgJobProgressStore(pool, { jobColumns: rest as never })).toThrow(new ConfigurationError(`Unsafe or missing PostgreSQL column name for job progress '${label}'`))
      expect(() => new DrizzlePgJobProgressStore(pool, { jobColumns: { ...complete, [key]: { name: 'bad"name' } } as never })).toThrow(`job progress '${label}'`)
    }
    expect(() => new DrizzlePgJobProgressStore(pool, { jobColumns: complete as never })).not.toThrow()
    const empty = new DrizzlePgJobProgressStore(pool, { fenceColumns: { id: "a1" } })
    expect(empty).toBeTruthy()
  })
})
