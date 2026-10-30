import { describe, expect, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { getTableColumns } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createDrizzleD1Adapter, createDrizzleD1IdempotencyStore, createDrizzleJobStore } from "@xonava/adapters/drizzle-d1"
import { setup } from "./sqliteFixture"
import { createScriptedDb } from "../../__tests__/support/scriptedDb"

const ts = (name: string) => integer(name, { mode: "timestamp_ms" })
const jobs = sqliteTable("platform_jobs", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), scopeKey: text("scope_key"), payload: text("payload"),
  status: text("status"), priority: integer("priority"), attempts: integer("attempts"), maxAttempts: integer("max_attempts"), runAt: ts("run_at"), nextAttemptAt: ts("next_attempt_at"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: ts("lease_expires_at"), claimToken: text("claim_token"), idempotencyKey: text("idempotency_key"), idempotencyScope: text("idempotency_scope"),
  fingerprint: text("fingerprint"), correlationId: text("correlation_id"), lastError: text("last_error"), resultPayload: text("result_payload"), metadata: text("metadata"),
  createdAt: ts("created_at"), startedAt: ts("started_at"), completedAt: ts("completed_at"), partitionKey: text("partition_key"),
})
const executions = sqliteTable("platform_job_executions", {
  id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt"), workerId: text("worker_id"), status: text("status"), errorMessage: text("error_message"),
  startedAt: ts("started_at"), finishedAt: ts("finished_at"),
})

describe("d1 job store required-history failure text", () => {
  it("names the framework error code that the d1 dialect assigns, never provider text", async () => {
    const scripted = createScriptedDb("sqlite", () => [], { atomicJobTransition: () => { throw new Error("D1_ERROR: UNIQUE constraint failed: platform_job_executions.id: SQLITE_CONSTRAINT") } })
    const store = createDrizzleJobStore(scripted.db as never, {
      jobsTable: jobs, executionsTable: executions, executionHistory: "required",
      columnMap: { jobs: getTableColumns(jobs) as never, executions: getTableColumns(executions) as never },
    })
    const result = await store.markSucceeded({ jobId: "j", workerId: "w", claimToken: "t", attempt: 1 })
    expect(result).toMatchObject({ applied: false, reason: "HISTORY_FAILED" })
    const message = (result as { historyError: string }).historyError
    expect(message).toMatch(/^Execution history persistence failed \((?!PERSISTENCE_ERROR)[A-Z_]+\)$/)
    expect(message).not.toContain("platform_job_executions")
  })
})

describe("d1 idempotency claims with an undecodable stored result", () => {
  it("claims the invalidations and reports the result as null rather than failing", async () => {
    const fixture = await setup({
      extraSchema: ["CREATE TABLE idem_res (id TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, token TEXT NOT NULL, status TEXT NOT NULL, result TEXT, resource_entity TEXT, resource_id TEXT, resource_version TEXT, pending_invalidations TEXT, finalizer_claim_owner TEXT, finalizer_claim_token TEXT, finalizer_claim_expires_at INTEGER, created_at INTEGER NOT NULL, completed_at INTEGER, UNIQUE (scope, key))"],
    })
    const records = sqliteTable("idem_res", {
      id: text("id").primaryKey(), scope: text("scope").notNull(), key: text("key").notNull(), fingerprint: text("fingerprint").notNull(), token: text("token").notNull(), status: text("status").notNull(), result: text("result"),
      resourceEntity: text("resource_entity"), resourceId: text("resource_id"), resourceVersion: text("resource_version"), pendingInvalidations: text("pending_invalidations"),
      finalizerClaimOwner: text("finalizer_claim_owner"), finalizerClaimToken: text("finalizer_claim_token"), finalizerClaimExpiresAt: integer("finalizer_claim_expires_at"), createdAt: integer("created_at").notNull(), completedAt: integer("completed_at"),
    })
    const store = createDrizzleD1IdempotencyStore<{ ok: number }>(createDrizzleD1Adapter(drizzle(fixture.d1 as never) as never).repository, records)
    fixture.d1.sqlite.exec("INSERT INTO idem_res (id, scope, key, fingerprint, token, status, created_at, pending_invalidations, result) VALUES ('i1','s','k1','fp','tok','business-committed',1,'[\"t\"]','{broken')")
    const [claim] = await store.claimPendingInvalidations({ claimOwner: "fin", leaseMs: 60_000, claimToken: "c" })
    expect(claim).toEqual({ scope: "s", key: "k1", fingerprint: "fp", token: "tok", invalidations: ["t"], result: null, claimToken: "c", claimOwner: "fin" })
    expect(claim!.result).toBeNull()
  })
})
