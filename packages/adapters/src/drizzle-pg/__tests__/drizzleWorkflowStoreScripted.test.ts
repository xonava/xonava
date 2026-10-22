import { describe, expect, it } from "vitest"
import { ConflictError, PersistenceError } from "@xonava/core/domain"
import type { WorkflowInstance } from "@xonava/core/workflow"
import { DrizzlePgWorkflowStore } from "../drizzleWorkflowStore"
import { createScriptedPgPool, type PoolCall, type PoolResponder } from "../../__tests__/support/scriptedPool"

const NOW = new Date("2026-01-01T00:00:00.000Z")
const scope = { kind: "system", systemKey: "framework" }
const workflowRow = (overrides: Record<string, unknown> = {}) => ({
  id: "wf1", workflow_type: "order", workflow_version: 1, execution_scope: scope, status: "pending", current_step: "reserve", variables: { n: 1 }, step_attempt: 0, compensation_stack: [],
  waiting_signal: null, wake_at: null, outcome: null, revision: 0, resume_signal_id: null, failure: null, lease_owner: null, claim_token: null, lease_expires_at: null,
  created_at: NOW, updated_at: NOW, ...overrides,
})
const fence = { instanceId: "wf1", workerId: "w1", claimToken: "tok", revision: 3 }
const instance = (overrides: Partial<WorkflowInstance> = {}): WorkflowInstance => ({
  id: "wf1", workflowType: "order", workflowVersion: 1, executionScope: scope as never, status: "running", currentStep: "charge", variables: { n: 2 }, stepAttempt: 1, compensationStack: ["undo"],
  waitingSignal: null, wakeAt: null, outcome: null, revision: 3, failure: null, leaseOwner: "w1", claimToken: "tok", leaseExpiresAt: NOW, createdAt: NOW, updatedAt: NOW, ...overrides,
})
const build = (respond: PoolResponder, schema?: string) => {
  const scripted = createScriptedPgPool(respond)
  return { store: new DrizzlePgWorkflowStore(scripted.pool as never, schema === undefined ? {} : { schema }), ...scripted }
}
const matches = (call: PoolCall, text: string) => call.sql.includes(text)

describe("PostgreSQL workflow store: reads and claims", () => {
  it("starts an instance, decoding the returned row, and rejects non-durable variables", async () => {
    const { store, calls } = build(() => [workflowRow({ failure: { code: "X", message: "m", step: "s", phase: "execute", attempt: 1, at: NOW.toISOString() }, wake_at: NOW.toISOString(), lease_expires_at: NOW, resume_signal_id: "s1", waiting_signal: "go", outcome: "failed", lease_owner: "w", claim_token: "t" })])
    const started = await store.start({ id: "wf1", workflowType: "order", workflowVersion: 1, executionScope: scope as never, initialStep: "reserve", variables: { n: 1 } })
    expect(started).toMatchObject({ id: "wf1", workflowType: "order", executionScope: scope, status: "pending", variables: { n: 1 }, waitingSignal: "go", outcome: "failed", resumeSignalId: "s1", leaseOwner: "w", claimToken: "t" })
    expect(started.wakeAt).toEqual(NOW)
    expect(started.failure).toMatchObject({ code: "X", attempt: 1 })
    expect(calls[0]!.params).toEqual(["wf1", "order", 1, JSON.stringify(scope), "reserve", '{"n":1}'])
    await expect(store.start({ id: "x", workflowType: "o", workflowVersion: 1, executionScope: scope as never, initialStep: "s", variables: { fn: () => 1 } as never })).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it("reads by id, returning null when absent, and honours a custom schema", async () => {
    const found = build(() => [workflowRow()], "tenant_a")
    expect((await found.store.get("wf1"))?.id).toBe("wf1")
    expect(found.calls[0]!.sql).toContain("tenant_a.workflows")
    expect(await build(() => []).store.get("none")).toBeNull()
    expect(() => build(() => [], "bad schema;")).toThrow()
  })

  it("claims due instances, guarding invalid limits and lease durations", async () => {
    const { store, calls } = build(() => [workflowRow({ claim_token: "ct", lease_owner: "w1", step_attempt: 1 })])
    const claims = await store.claimDue({ workerId: "w1", limit: 2, leaseDurationMs: 5_000 })
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({ workerId: "w1", claimToken: "ct", instance: { stepAttempt: 1 } })
    expect(calls[0]!.params).toEqual([2, "w1", 5_000])
    for (const limit of [0, -1, 1.5, Number.NaN]) expect(await store.claimDue({ workerId: "w1", limit, leaseDurationMs: 1 })).toEqual([])
    expect(await store.claimDue({ workerId: "w1", limit: 1, leaseDurationMs: -1 })).toEqual([])
    expect(await store.claimDue({ workerId: "w1", limit: 1, leaseDurationMs: Number.NaN })).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it("asserts and renews leases by fence", async () => {
    const live = build(() => ({ rows: [{}], rowCount: 1 }))
    expect(await live.store.assertLease(fence)).toBe(true)
    expect(await live.store.renewLease(fence, 1_000)).toBe(true)
    expect(live.calls[1]!.params).toEqual(["wf1", "w1", "tok", 3, 1_000])
    const lost = build(() => ({ rows: [], rowCount: 0 }))
    expect(await lost.store.assertLease(fence)).toBe(false)
    expect(await lost.store.renewLease(fence, 1_000)).toBe(false)
    expect(await live.store.renewLease(fence, 0)).toBe(false)
    expect(await live.store.renewLease(fence, Number.POSITIVE_INFINITY)).toBe(false)
    expect(live.calls).toHaveLength(2)
  })
})

describe("PostgreSQL workflow store: commit", () => {
  it("commits a plain transition inside a transaction with the fence in both statements", async () => {
    const { store, calls, events } = build((call) => (matches(call, "FOR UPDATE") ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 1 }))
    expect(await store.commit(fence, instance({ failure: { code: "F", message: "m", step: "s", phase: "execute", attempt: 1, at: NOW } }))).toBe(true)
    expect(calls.map((c) => c.sql.trim().split(/\s+/)[0])).toEqual(["BEGIN", "SELECT", "UPDATE", "COMMIT"])
    const update = calls[2]!
    expect(update.params.slice(0, 3)).toEqual([1, "running", "charge"])
    expect(update.params).toEqual(expect.arrayContaining(["wf1", "w1", "tok", 3]))
    expect(update.params[13]).toContain('"code":"F"')
    expect(update.params[14]).toBeNull()
    expect(events.at(-1)).toBe("release")
  })

  it("rolls back and reports false when the fence no longer matches", async () => {
    const { store, calls } = build(() => ({ rows: [], rowCount: 0 }))
    expect(await store.commit(fence, instance())).toBe(false)
    expect(calls.map((c) => c.sql.trim().split(/\s+/)[0])).toEqual(["BEGIN", "SELECT", "ROLLBACK"])
  })

  it("resumes a signal wait from a buffered receipt", async () => {
    const { store, calls } = build((call) => {
      if (matches(call, "FOR UPDATE")) return { rows: [{}], rowCount: 1 }
      if (matches(call, "RETURNING id")) return { rows: [{ id: "sig-1" }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    expect(await store.commit(fence, instance({ status: "waiting", waitingSignal: "go", wakeAt: null }))).toBe(true)
    const consume = calls.find((c) => matches(c, "workflow_signals SET consumed_at"))!
    expect(consume.params).toEqual(["wf1", "go", 4])
    const update = calls.find((c) => matches(c, "UPDATE public.workflows"))!
    expect(update.params[1]).toBe("pending")
    expect(update.params[4]).toBe(0)
    expect(update.params[7]).toBeNull()
    expect(update.params[14]).toBe("sig-1")
  })

  it("parks on a signal wait when nothing is buffered, keeping the wake time and resume id", async () => {
    const { store, calls } = build((call) => (matches(call, "FOR UPDATE") ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 1 }))
    await store.commit(fence, instance({ status: "waiting", waitingSignal: "go", wakeAt: null, resumeSignalId: "prev" }))
    const update = calls.find((c) => matches(c, "UPDATE public.workflows"))!
    expect(update.params[1]).toBe("waiting")
    expect(update.params[14]).toBe("prev")
  })

  it("rolls back and rethrows when a statement fails, tolerating a failing rollback", async () => {
    const boom = new Error("update failed")
    const { store, events } = build((call) => { if (matches(call, "UPDATE public.workflows")) throw boom; return { rows: [{}], rowCount: 1 } })
    await expect(store.commit(fence, instance())).rejects.toBe(boom)
    expect(events).toContain("ROLLBACK")
    expect(events.at(-1)).toBe("release")
    const noRollback = build((call) => { if (matches(call, "FOR UPDATE")) return { rows: [{}], rowCount: 1 }; if (call.sql.startsWith("ROLLBACK")) throw new Error("rollback failed"); throw boom })
    await expect(noRollback.store.commit(fence, instance())).rejects.toBe(boom)
  })
})

describe("PostgreSQL workflow store: signals and cancellation", () => {
  const signal = { id: "s1", instanceId: "wf1", name: "go", payload: { by: "x" } }
  const delivery = (state: Record<string, unknown> | null, options: { duplicateId?: boolean; inserted?: number } = {}): PoolResponder => (call) => {
    if (matches(call, "FOR UPDATE")) return { rows: state ? [state] : [], rowCount: state ? 1 : 0 }
    if (matches(call, "SELECT 1 FROM public.workflow_signals WHERE id=$1")) return { rows: [], rowCount: options.duplicateId ? 1 : 0 }
    if (matches(call, "ON CONFLICT (id) DO NOTHING")) return { rows: [], rowCount: options.inserted ?? 1 }
    if (matches(call, "RETURNING id")) return { rows: [{ id: "s1" }], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  }

  it("stores a signal for a live instance without waking it", async () => {
    const { store, calls } = build(delivery({ status: "running", wake_at: null, waiting_signal: null, revision: 2 }))
    expect(await store.deliverSignal(signal)).toEqual({ delivered: true, duplicate: false })
    expect(calls.some((c) => matches(c, "SET status='pending'"))).toBe(false)
    expect(calls.at(-1)!.sql).toBe("COMMIT")
  })

  it("consumes the oldest receipt and wakes an instance waiting for that name", async () => {
    const { store, calls } = build(delivery({ status: "waiting", wake_at: null, waiting_signal: "go", revision: 4 }))
    expect(await store.deliverSignal(signal)).toEqual({ delivered: true, duplicate: false })
    expect(calls.find((c) => matches(c, "SET consumed_at"))!.params).toEqual(["wf1", "go", 5])
    expect(calls.find((c) => matches(c, "SET status='pending'"))!.params).toEqual(["wf1", "s1"])
  })

  it("does not wake an instance waiting for another name or on a timer", async () => {
    for (const state of [{ status: "waiting", wake_at: null, waiting_signal: "other", revision: 1 }, { status: "waiting", wake_at: NOW, waiting_signal: "go", revision: 1 }]) {
      const { store, calls } = build(delivery(state))
      expect(await store.deliverSignal(signal)).toEqual({ delivered: true, duplicate: false })
      expect(calls.some((c) => matches(c, "SET status='pending'"))).toBe(false)
    }
  })

  it("reports unknown instances, duplicate ids, terminal instances and lost insert races", async () => {
    expect(await build(delivery(null)).store.deliverSignal(signal)).toEqual({ delivered: false, duplicate: false })
    expect(await build(delivery({ status: "running", revision: 1 }, { duplicateId: true })).store.deliverSignal(signal)).toEqual({ delivered: false, duplicate: true })
    expect(await build(delivery({ status: "failed", revision: 1 })).store.deliverSignal(signal)).toEqual({ delivered: false, duplicate: false })
    expect(await build(delivery({ status: "running", revision: 1 }, { inserted: 0 })).store.deliverSignal(signal)).toEqual({ delivered: false, duplicate: true })
  })

  it("normalizes provider failures during delivery", async () => {
    const failing = build((call) => { if (matches(call, "FOR UPDATE")) throw Object.assign(new Error("secret"), { code: "XX000" }); return { rows: [], rowCount: 0 } })
    const error = await failing.store.deliverSignal(signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PersistenceError)
    expect(String((error as Error).message)).not.toContain("secret")
    expect(failing.events.at(-1)).toBe("release")
    const conflict = build((call) => { if (matches(call, "FOR UPDATE")) throw Object.assign(new Error("dup"), { code: "23505" }); return { rows: [], rowCount: 0 } })
    expect(await conflict.store.deliverSignal(signal).catch((e: unknown) => e)).toBeInstanceOf(ConflictError)
  })

  it("cancels live instances and reads signals back", async () => {
    const { store, calls } = build((call) => (matches(call, "SELECT id,instance_id") ? [{ id: "s1", instance_id: "wf1", name: "go", payload: '{"a":1}', delivered_at: NOW }] : { rows: [], rowCount: 1 }))
    expect(await store.cancel("wf1")).toBe(true)
    expect(calls[0]!.params).toEqual(["wf1"])
    expect(await build(() => ({ rows: [], rowCount: 0 })).store.cancel("wf1")).toBe(false)
    expect(await store.getSignal("wf1", "go")).toMatchObject({ id: "s1", payload: { a: 1 } })
    expect(await store.getSignalById("wf1", "s1")).toMatchObject({ name: "go", deliveredAt: NOW })
    const objectPayload = build(() => [{ id: "s2", instance_id: "wf1", name: "go", payload: { b: 2 }, delivered_at: NOW.toISOString() }])
    expect((await objectPayload.store.getSignal("wf1", "go"))?.payload).toEqual({ b: 2 })
    expect(await build(() => []).store.getSignal("wf1", "go")).toBeNull()
    expect(await build(() => [{ id: "s3", instance_id: "wf1", name: "go", payload: "[1]", delivered_at: NOW }]).store.getSignalById("wf1", "s3")).toBeNull()
  })
})
