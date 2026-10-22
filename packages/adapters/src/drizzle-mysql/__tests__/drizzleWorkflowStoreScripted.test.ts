import { describe, expect, it } from "vitest"
import type { WorkflowInstance } from "@xonava/core/workflow"
import { DrizzleMySqlWorkflowStore, MYSQL_WORKFLOW_STORE_TABLES } from "../drizzleWorkflowStore"
import { createScriptedMySqlPool, type PoolCall, type PoolResponder } from "../../__tests__/support/scriptedPool"

const NOW = new Date("2026-01-01T00:00:00.000Z")
const scope = { kind: "system", systemKey: "framework" }
const row = (overrides: Record<string, unknown> = {}) => ({
  id: "wf1", workflow_type: "order", workflow_version: 1, execution_scope: JSON.stringify(scope), status: "pending", current_step: "reserve", variables: '{"n":1}', step_attempt: 0, compensation_stack: "[]",
  waiting_signal: null, wake_at: null, outcome: null, revision: 0, resume_signal_id: null, failure: null, lease_owner: null, claim_token: null, lease_expires_at: null, created_at: NOW, updated_at: NOW, ...overrides,
})
const fence = { instanceId: "wf1", workerId: "w1", claimToken: "tok", revision: 3 }
const instance = (overrides: Partial<WorkflowInstance> = {}): WorkflowInstance => ({
  id: "wf1", workflowType: "order", workflowVersion: 1, executionScope: scope as never, status: "running", currentStep: "charge", variables: { n: 2 }, stepAttempt: 1, compensationStack: ["undo"],
  waitingSignal: null, wakeAt: null, outcome: null, revision: 3, failure: null, leaseOwner: "w1", claimToken: "tok", leaseExpiresAt: NOW, createdAt: NOW, updatedAt: NOW, ...overrides,
})
const header = (affectedRows: number) => ({ affectedRows })
const build = (respond: PoolResponder, options: Record<string, unknown> = {}) => {
  const scripted = createScriptedMySqlPool(respond)
  return { store: new DrizzleMySqlWorkflowStore(scripted.pool as never, options), ...scripted }
}
const has = (call: PoolCall, text: string) => call.sql.includes(text)

describe("MySQL workflow store: reads and claims", () => {
  it("starts an instance and reads it back, decoding JSON and optional columns", async () => {
    const { store, calls } = build((call) => (call.sql.startsWith("SELECT") ? [row({ variables: { n: 1 }, execution_scope: scope, compensation_stack: ["a"], wake_at: NOW, lease_expires_at: NOW, lease_owner: "w", claim_token: "t", waiting_signal: "go", resume_signal_id: "s", outcome: "failed", failure: JSON.stringify({ code: "X", message: "m", step: "s", phase: "compensate", attempt: 2, at: NOW.toISOString() }) })] : header(1)))
    const started = await store.start({ id: "wf1", workflowType: "order", workflowVersion: 1, executionScope: scope as never, initialStep: "reserve", variables: { n: 1 } })
    expect(started).toMatchObject({ variables: { n: 1 }, executionScope: scope, compensationStack: ["a"], waitingSignal: "go", resumeSignalId: "s", outcome: "failed", leaseOwner: "w", claimToken: "t" })
    expect(started.failure).toMatchObject({ code: "X", phase: "compensate" })
    expect(started.wakeAt).toEqual(NOW)
    expect(calls[0]!.sql).toContain("INSERT INTO `workflows`")
    await expect(store.start({ id: "x", workflowType: "o", workflowVersion: 1, executionScope: scope as never, initialStep: "s", variables: { fn: () => 1 } as never })).rejects.toThrow()
    expect(calls).toHaveLength(2)
  })

  it("reads by id with string JSON columns, honouring table overrides", async () => {
    const { store, calls } = build(() => [row()], { tables: { workflows: "app_workflows" } })
    expect(await store.get("wf1")).toMatchObject({ variables: { n: 1 }, compensationStack: [], failure: null })
    expect(calls[0]!.sql).toContain("`app_workflows`")
    expect(await build(() => []).store.get("none")).toBeNull()
    expect(MYSQL_WORKFLOW_STORE_TABLES).toEqual({ workflows: "workflows", workflowSignals: "workflow_signals" })
  })

  it("claims due instances in one transaction, bumping each row individually", async () => {
    const { store, calls, events } = build((call) => {
      if (has(call, "FOR UPDATE SKIP LOCKED")) return [{ id: "a" }, { id: "b" }]
      if (call.sql.startsWith("SELECT * FROM")) return [row({ id: String(call.params[0]), step_attempt: 1 })]
      return header(1)
    })
    const claims = await store.claimDue({ workerId: "w1", limit: 2, leaseDurationMs: 5_000 })
    expect(claims.map((claim) => claim.instance.id)).toEqual(["a", "b"])
    expect(claims.every((claim) => claim.workerId === "w1" && claim.claimToken.length > 0)).toBe(true)
    expect(events).toEqual(["begin", "commit", "release"])
    expect(calls[0]!.params).toEqual([2])
  })

  it("rolls the claim transaction back on failure and guards invalid arguments", async () => {
    const boom = new Error("select failed")
    const failing = build((call) => { if (has(call, "SKIP LOCKED")) throw boom; return [] })
    await expect(failing.store.claimDue({ workerId: "w", limit: 1, leaseDurationMs: 1 })).rejects.toBe(boom)
    expect(failing.events).toEqual(["begin", "rollback", "release"])
    const { store, calls } = build(() => [])
    for (const limit of [0, -1, 1.5, Number.NaN]) expect(await store.claimDue({ workerId: "w", limit, leaseDurationMs: 1 })).toEqual([])
    expect(await store.claimDue({ workerId: "w", limit: 1, leaseDurationMs: -1 })).toEqual([])
    expect(calls).toEqual([])
  })

  it("asserts and renews leases by fence", async () => {
    expect(await build(() => [{ id: "wf1" }]).store.assertLease(fence)).toBe(true)
    expect(await build(() => []).store.assertLease(fence)).toBe(false)
    const { store, calls } = build(() => header(1))
    expect(await store.renewLease(fence, 1_000)).toBe(true)
    expect(calls[0]!.params).toEqual([1_000, "wf1", "w1", "tok", 3])
    expect(await store.renewLease(fence, 0)).toBe(false)
    expect(await store.renewLease(fence, Number.NaN)).toBe(false)
    expect(await build(() => header(0)).store.renewLease(fence, 1_000)).toBe(false)
  })
})

describe("MySQL workflow store: commit", () => {
  it("commits a plain transition under the fence", async () => {
    const { store, calls, events } = build((call) => (has(call, "FOR UPDATE") ? [{ id: "wf1" }] : header(1)))
    expect(await store.commit(fence, instance({ failure: { code: "F", message: "m", step: "s", phase: "execute", attempt: 1, at: NOW } }))).toBe(true)
    expect(events).toEqual(["begin", "commit", "release"])
    const update = calls.find((call) => call.sql.startsWith("UPDATE `workflows`"))!
    expect(update.params.slice(0, 3)).toEqual([1, "running", "charge"])
    expect(update.params[9]).toContain('"code":"F"')
    expect(update.params[10]).toBeNull()
    expect(update.params.slice(11)).toEqual(["wf1", "w1", "tok", 3])
  })

  it("rolls back when the fence no longer matches", async () => {
    const { store, events } = build(() => [])
    expect(await store.commit(fence, instance())).toBe(false)
    expect(events).toEqual(["begin", "rollback", "release"])
  })

  it("resumes a signal wait from the oldest buffered receipt, or parks when none is pending", async () => {
    const buffered = build((call) => {
      if (has(call, "FOR UPDATE") && has(call, "FROM `workflows`")) return [{ id: "wf1" }]
      if (has(call, "FROM `workflow_signals`")) return [{ id: "sig-1" }]
      return header(1)
    })
    expect(await buffered.store.commit(fence, instance({ status: "waiting", waitingSignal: "go" }))).toBe(true)
    expect(buffered.calls.find((call) => has(call, "SET consumed_at"))!.params).toEqual([4, "sig-1"])
    const update = buffered.calls.find((call) => call.sql.startsWith("UPDATE `workflows`"))!
    expect(update.params[1]).toBe("pending")
    expect(update.params[4]).toBe(0)
    expect(update.params[10]).toBe("sig-1")
    const parked = build((call) => (has(call, "FOR UPDATE") && has(call, "FROM `workflows`") ? [{ id: "wf1" }] : has(call, "FROM `workflow_signals`") ? [] : header(1)))
    await parked.store.commit(fence, instance({ status: "waiting", waitingSignal: "go", resumeSignalId: "prev" }))
    const parkedUpdate = parked.calls.find((call) => call.sql.startsWith("UPDATE `workflows`"))!
    expect(parkedUpdate.params[1]).toBe("waiting")
    expect(parkedUpdate.params[10]).toBe("prev")
  })

  it("rolls back and rethrows on statement failures, even when the rollback itself fails", async () => {
    const boom = new Error("update failed")
    const failing = build((call) => { if (call.sql.startsWith("UPDATE `workflows`")) throw boom; return [{ id: "wf1" }] })
    await expect(failing.store.commit(fence, instance())).rejects.toBe(boom)
    expect(failing.events).toEqual(["begin", "rollback", "release"])
    const scripted = createScriptedMySqlPool((call) => { if (call.sql.startsWith("UPDATE")) throw boom; return [{ id: "wf1" }] })
    const connection = await scripted.pool.getConnection()
    connection.rollback = async () => { throw new Error("rollback failed") }
    const store = new DrizzleMySqlWorkflowStore(scripted.pool as never)
    await expect(store.commit(fence, instance())).rejects.toBe(boom)
  })
})

describe("MySQL workflow store: signals and cancellation", () => {
  const signal = { id: "s1", instanceId: "wf1", name: "go", payload: { by: "x" } }
  const delivery = (state: Record<string, unknown> | null, options: { duplicateId?: boolean; insertError?: unknown } = {}): PoolResponder => (call) => {
    if (has(call, "FROM `workflows`") && has(call, "FOR UPDATE")) return state ? [state] : []
    if (call.sql.startsWith("SELECT id FROM `workflow_signals` WHERE id=?")) return options.duplicateId ? [{ id: "s1" }] : []
    if (call.sql.startsWith("INSERT INTO `workflow_signals`")) { if (options.insertError) throw options.insertError; return header(1) }
    if (has(call, "ORDER BY seq LIMIT 1 FOR UPDATE")) return [{ id: "s1" }]
    return header(1)
  }

  it("stores signals for live instances and wakes an instance waiting for the name", async () => {
    const plain = build(delivery({ status: "running", wake_at: null, waiting_signal: null, revision: 2 }))
    expect(await plain.store.deliverSignal(signal)).toEqual({ delivered: true, duplicate: false })
    expect(plain.calls.some((call) => has(call, "SET status='pending'"))).toBe(false)
    expect(plain.events).toEqual(["begin", "commit", "release"])
    const waiting = build(delivery({ status: "waiting", wake_at: null, waiting_signal: "go", revision: 4 }))
    expect(await waiting.store.deliverSignal(signal)).toEqual({ delivered: true, duplicate: false })
    expect(waiting.calls.find((call) => has(call, "SET consumed_at"))!.params).toEqual([5, "s1"])
    expect(waiting.calls.find((call) => has(call, "SET status='pending'"))!.params).toEqual(["s1", "wf1"])
    for (const state of [{ status: "waiting", wake_at: null, waiting_signal: "other", revision: 1 }, { status: "waiting", wake_at: NOW, waiting_signal: "go", revision: 1 }]) {
      const idle = build(delivery(state))
      await idle.store.deliverSignal(signal)
      expect(idle.calls.some((call) => has(call, "SET status='pending'"))).toBe(false)
    }
  })

  it("reports unknown, duplicate, terminal and racing deliveries without storing anything", async () => {
    const unknown = build(delivery(null))
    expect(await unknown.store.deliverSignal(signal)).toEqual({ delivered: false, duplicate: false })
    expect(unknown.events).toEqual(["begin", "rollback", "release"])
    expect(await build(delivery({ status: "running", revision: 1 }, { duplicateId: true })).store.deliverSignal(signal)).toEqual({ delivered: false, duplicate: true })
    const terminal = build(delivery({ status: "cancelled", revision: 1 }))
    expect(await terminal.store.deliverSignal(signal)).toEqual({ delivered: false, duplicate: false })
    expect(terminal.calls.some((call) => has(call, "INSERT INTO"))).toBe(false)
    const raced = build(delivery({ status: "running", revision: 1 }, { insertError: Object.assign(new Error("dup"), { errno: 1062 }) }))
    expect(await raced.store.deliverSignal(signal)).toEqual({ delivered: false, duplicate: true })
  })

  it("rethrows other insert failures after rolling back", async () => {
    const boom = Object.assign(new Error("disk full"), { errno: 1114 })
    const failing = build(delivery({ status: "running", revision: 1 }, { insertError: boom }))
    await expect(failing.store.deliverSignal(signal)).rejects.toBe(boom)
    expect(failing.events).toEqual(["begin", "rollback", "release"])
  })

  it("cancels live instances and reads signals back", async () => {
    expect(await build(() => header(1)).store.cancel("wf1")).toBe(true)
    expect(await build(() => header(0)).store.cancel("wf1")).toBe(false)
    const { store } = build(() => [{ id: "s1", instance_id: "wf1", name: "go", payload: '{"a":1}', delivered_at: NOW }])
    expect(await store.getSignal("wf1", "go")).toMatchObject({ id: "s1", payload: { a: 1 }, deliveredAt: NOW })
    expect(await store.getSignalById("wf1", "s1")).toMatchObject({ name: "go" })
    expect((await build(() => [{ id: "s2", instance_id: "wf1", name: "go", payload: { b: 2 }, delivered_at: NOW }]).store.getSignal("wf1", "go"))?.payload).toEqual({ b: 2 })
    expect(await build(() => []).store.getSignal("wf1", "go")).toBeNull()
    expect(await build(() => [{ id: "s3", instance_id: "wf1", name: "go", payload: "[1]", delivered_at: NOW }]).store.getSignalById("wf1", "s3")).toBeNull()
  })
})
