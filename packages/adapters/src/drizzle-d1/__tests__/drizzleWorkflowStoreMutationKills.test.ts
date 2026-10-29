import { describe, expect, it } from "vitest"
import type { WorkflowFence, WorkflowInstance } from "@xonava/core/workflow"
import { DrizzleD1WorkflowStore } from "@xonava/adapters/drizzle-d1"

interface Prepared { readonly sql: string; binds: unknown[] }
interface Script {
  first?: (sql: string, binds: readonly unknown[]) => unknown
  all?: (sql: string, binds: readonly unknown[]) => unknown
  run?: (sql: string, binds: readonly unknown[]) => unknown
  batch?: (statements: readonly Prepared[]) => unknown[]
}
function stub(script: Script = {}) {
  const prepared: Prepared[] = []
  const batches: (readonly Prepared[])[] = []
  const db = {
    prepare(sql: string) {
      const statement: Prepared & Record<string, unknown> = {
        sql, binds: [],
        bind(...values: unknown[]) { statement.binds = values; return statement },
        first: async () => (script.first ? script.first(sql, statement.binds) : null),
        all: async () => (script.all ? script.all(sql, statement.binds) : { success: true, results: [] }),
        run: async () => (script.run ? script.run(sql, statement.binds) : { success: true, meta: { changes: 1 } }),
      }
      prepared.push(statement)
      return statement
    },
    batch: async (statements: readonly Prepared[]) => { batches.push(statements); return script.batch ? script.batch(statements) : [] },
  }
  return { store: new DrizzleD1WorkflowStore(db as never), prepared, batches }
}

const baseRow = {
  id: "wf1", workflow_type: "order", workflow_version: 2, execution_scope: '{"kind":"system","systemKey":"framework"}', status: "pending", current_step: "reserve",
  variables: '{"n":1}', step_attempt: 3, compensation_stack: '["undo"]', revision: 5, created_at_ms: 1_000, updated_at_ms: 2_000,
}
const fence: WorkflowFence = { instanceId: "wf1", workerId: "w1", claimToken: "tok", revision: 4 }
const instance = (overrides: Partial<WorkflowInstance> = {}): WorkflowInstance => ({
  id: "wf1", workflowType: "order", workflowVersion: 2, executionScope: { kind: "system", systemKey: "framework" }, status: "pending", currentStep: "next", variables: { n: 2 }, stepAttempt: 1,
  compensationStack: ["undo"], waitingSignal: null, wakeAt: null, outcome: null, revision: 4, resumeSignalId: null, failure: null, leaseOwner: "w1", claimToken: "tok", leaseExpiresAt: null,
  createdAt: new Date(1_000), updatedAt: new Date(2_000), ...overrides,
}) as WorkflowInstance
const NOW = "CAST(unixepoch('subsec')*1000 AS INTEGER)"

describe("d1 workflow store row decoding", () => {
  it("maps absent optional columns to null and keeps zero timestamps as dates", async () => {
    const bare = await stub({ first: () => baseRow }).store.get("wf1")
    expect(bare).toEqual({
      id: "wf1", workflowType: "order", workflowVersion: 2, executionScope: { kind: "system", systemKey: "framework" }, status: "pending", currentStep: "reserve", variables: { n: 1 },
      stepAttempt: 3, compensationStack: ["undo"], waitingSignal: null, wakeAt: null, outcome: null, revision: 5, resumeSignalId: null, failure: null, leaseOwner: null, claimToken: null,
      leaseExpiresAt: null, createdAt: new Date(1_000), updatedAt: new Date(2_000),
    })
    const nulls = await stub({ first: () => ({ ...baseRow, waiting_signal: null, wake_at_ms: null, outcome: null, resume_signal_id: null, lease_owner: null, claim_token: null, lease_expires_at_ms: null }) }).store.get("wf1")
    expect(nulls).toMatchObject({ waitingSignal: null, wakeAt: null, outcome: null, resumeSignalId: null, leaseOwner: null, claimToken: null, leaseExpiresAt: null })
    const full = await stub({ first: () => ({ ...baseRow, waiting_signal: "approved", wake_at_ms: 0, outcome: "succeeded", resume_signal_id: "s1", lease_owner: "w9", claim_token: "t9", lease_expires_at_ms: 5_000 }) }).store.get("wf1")
    expect(full).toMatchObject({ waitingSignal: "approved", wakeAt: new Date(0), outcome: "succeeded", resumeSignalId: "s1", leaseOwner: "w9", claimToken: "t9", leaseExpiresAt: new Date(5_000) })
    const emptyStrings = await stub({ first: () => ({ ...baseRow, waiting_signal: "", resume_signal_id: "", lease_owner: "", claim_token: "" }) }).store.get("wf1")
    expect(emptyStrings).toMatchObject({ waitingSignal: "", resumeSignalId: "", leaseOwner: "", claimToken: "" })
  })

  it("reads an instance by id with a parameterised select", async () => {
    const f = stub({ first: () => null })
    expect(await f.store.get("wf1")).toBeNull()
    expect(f.prepared[0]).toMatchObject({ sql: "SELECT * FROM framework_workflows WHERE id=?", binds: ["wf1"] })
  })
})

describe("d1 workflow store signal decoding", () => {
  const signalRow = { id: "s1", instance_id: "wf1", name: "approved", payload: '{"by":"x"}', delivered_at_ms: 3_000 }

  it("decodes object payloads and rejects anything else as absent", async () => {
    expect(await stub({ first: () => signalRow }).store.getSignal("wf1", "approved")).toEqual({ id: "s1", instanceId: "wf1", name: "approved", payload: { by: "x" }, deliveredAt: new Date(3_000) })
    expect(await stub({ first: () => null }).store.getSignal("wf1", "approved")).toBeNull()
    for (const payload of ["{broken", "null", "5", '"text"', "[1]", "true", undefined, null]) {
      expect(await stub({ first: () => ({ ...signalRow, payload }) }).store.getSignalById("wf1", "s1")).toBeNull()
    }
    expect(await stub({ first: () => ({ ...signalRow, payload: "{}" }) }).store.getSignalById("wf1", "s1")).toMatchObject({ payload: {} })
  })

  it("looks signals up by name (latest first) and by id", async () => {
    const f = stub({ first: () => signalRow })
    await f.store.getSignal("wf1", "approved")
    await f.store.getSignalById("wf1", "s1")
    expect(f.prepared[0]).toMatchObject({ sql: "SELECT id,instance_id,name,payload,delivered_at_ms FROM framework_workflow_signals WHERE instance_id=? AND name=? ORDER BY seq DESC LIMIT 1", binds: ["wf1", "approved"] })
    expect(f.prepared[1]).toMatchObject({ sql: "SELECT id,instance_id,name,payload,delivered_at_ms FROM framework_workflow_signals WHERE instance_id=? AND id=?", binds: ["wf1", "s1"] })
  })
})

describe("d1 workflow store claiming and leases", () => {
  it("claims nothing for invalid limits or lease durations, and allows a zero-length lease", async () => {
    const args = (overrides: Record<string, unknown>) => ({ workerId: "w", limit: 2, leaseDurationMs: 1_000, ...overrides }) as never
    for (const bad of [{ limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: Number.NaN }, { limit: Number.POSITIVE_INFINITY }, { leaseDurationMs: -1 }, { leaseDurationMs: Number.NaN }, { leaseDurationMs: Number.POSITIVE_INFINITY }]) {
      const f = stub()
      expect(await f.store.claimDue(args(bad))).toEqual([])
      expect(f.prepared).toHaveLength(0)
    }
    const zero = stub({ all: () => ({ success: true, results: [] }) })
    expect(await zero.store.claimDue(args({ leaseDurationMs: 0 }))).toEqual([])
    expect(zero.prepared).toHaveLength(1)
    expect(zero.prepared[0]!.binds.slice(2)).toEqual([0, 2])
  })

  it("returns each claimed row with the worker and the shared claim token", async () => {
    const f = stub({ all: () => ({ success: true, results: [baseRow, { ...baseRow, id: "wf2" }] }) })
    const claims = await f.store.claimDue({ workerId: "w7", limit: 2, leaseDurationMs: 500 })
    const token = f.prepared[0]!.binds[1]
    expect(f.prepared[0]!.binds).toEqual(["w7", token, 500, 2])
    expect(typeof token).toBe("string")
    expect(claims.map((claim) => [claim.instance.id, claim.workerId, claim.claimToken])).toEqual([["wf1", "w7", token], ["wf2", "w7", token]])
    expect(await stub({ all: () => ({ success: true }) }).store.claimDue({ workerId: "w", limit: 1, leaseDurationMs: 1 })).toEqual([])
  })

  it("asserts the lease by owner, token and revision", async () => {
    const live = stub({ first: () => ({ id: "wf1" }) })
    expect(await live.store.assertLease(fence)).toBe(true)
    expect(live.prepared[0]!.binds).toEqual(["wf1", "w1", "tok", 4])
    expect(await stub({ first: () => null }).store.assertLease(fence)).toBe(false)
  })

  it("renews only for positive finite extensions and an exact single-row change", async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const f = stub()
      expect(await f.store.renewLease(fence, bad)).toBe(false)
      expect(f.prepared).toHaveLength(0)
    }
    const ok = stub({ run: () => ({ success: true, meta: { changes: 1 } }) })
    expect(await ok.store.renewLease(fence, 250)).toBe(true)
    expect(ok.prepared[0]!.binds).toEqual([250, "wf1", "w1", "tok", 4])
    for (const result of [{ success: true, meta: { changes: 0 } }, { success: true, meta: { changes: 2 } }, { success: true, meta: {} }, { success: true }]) {
      expect(await stub({ run: () => result }).store.renewLease(fence, 250)).toBe(false)
    }
  })
})

describe("d1 workflow store commit", () => {
  it("commits a non-waiting transition under the fence with every column bound in order", async () => {
    const f = stub()
    const wakeAt = new Date(9_000)
    expect(await f.store.commit(fence, instance({ wakeAt, outcome: "succeeded" as never, resumeSignalId: "s9", status: "compensating" as never }))).toBe(true)
    const [update] = f.prepared
    expect(update!.sql.startsWith("UPDATE framework_workflows SET workflow_version=?,status=?,current_step=?")).toBe(true)
    expect(update!.sql).toContain(`updated_at_ms=${NOW} WHERE id=? AND lease_owner=? AND claim_token=? AND revision=? AND lease_expires_at_ms>${NOW}`)
    expect(update!.binds).toEqual([2, "compensating", "next", '{"n":2}', 1, '["undo"]', null, 9_000, "succeeded", null, "s9", "wf1", "w1", "tok", 4])
    const bare = stub()
    await bare.store.commit(fence, instance())
    expect(bare.prepared[0]!.binds.slice(7, 11)).toEqual([null, null, null, null])
  })

  it("accepts a non-waiting commit only when exactly one row changed", async () => {
    for (const [result, expected] of [[{ success: true, meta: { changes: 1 } }, true], [{ success: true, meta: { changes: 0 } }, false], [{ success: true, meta: { changes: 2 } }, false], [{ success: true, meta: {} }, false], [{ success: true }, false]] as const) {
      expect(await stub({ run: () => result }).store.commit(fence, instance())).toBe(expected)
    }
  })

  const waiting = () => instance({ status: "waiting" as never, waitingSignal: "approved", wakeAt: null })

  it("commits a signal wait as one batch: consume, fenced update, then restore", async () => {
    const f = stub({ batch: () => [{ success: true }, { success: true, meta: { changes: 1 } }, { success: true }] })
    expect(await f.store.commit(fence, waiting())).toBe(true)
    expect(f.prepared).toHaveLength(3)
    expect(f.batches).toHaveLength(1)
    const [consume, update, restore] = f.batches[0]!
    expect(f.prepared.map((p) => p)).toEqual([consume, update, restore])
    expect(consume!.sql.startsWith("UPDATE framework_workflow_signals SET consumed_at_ms=")).toBe(true)
    expect(consume!.binds).toEqual([5, "wf1", "approved", "wf1", "w1", "tok", 4])
    const resume = ["wf1", "approved", 5]
    expect(update!.binds).toEqual([2, ...resume, "waiting", "next", '{"n":2}', ...resume, 1, '["undo"]', "approved", ...resume, null, null, null, ...resume, "wf1", "w1", "tok", 4])
    expect(restore!.sql).toContain("WHERE changes()=0 AND instance_id=? AND consumed_revision=?")
    expect(restore!.binds).toEqual(["wf1", 5, "wf1", 4])
  })

  it("accepts a signal-wait commit only on a single-row change from the update statement", async () => {
    for (const results of [[{}, { meta: { changes: 0 } }, {}], [{}, { meta: { changes: 2 } }, {}], [{}, { meta: {} }, {}], [{}, {}, {}], [{ meta: { changes: 1 } }], []]) {
      expect(await stub({ batch: () => results }).store.commit(fence, waiting())).toBe(false)
    }
  })
})

describe("d1 workflow store signal delivery and cancellation", () => {
  const signal = { id: "s1", instanceId: "wf1", name: "approved", payload: { by: "x" } }

  it("batches insert, consume and wake and reports delivery from the insert's change count", async () => {
    const f = stub({ batch: () => [{ success: true, meta: { changes: 1 } }, {}, {}] })
    expect(await f.store.deliverSignal(signal)).toEqual({ delivered: true, duplicate: false })
    expect(f.batches[0]).toHaveLength(3)
    const [insert, consume, wake] = f.batches[0]!
    expect(insert!.binds).toEqual(["s1", "wf1", "approved", '{"by":"x"}', "wf1", "s1"])
    expect(consume!.binds).toEqual(["wf1", "wf1", "approved", "wf1", "approved"])
    expect(wake!.binds).toEqual(["approved", "wf1", "approved"])
    expect(f.prepared).toHaveLength(3)
  })

  it("tells an unknown instance from a duplicate receipt when nothing was inserted", async () => {
    const outcome = async (state: unknown, batchResult: unknown = { success: true, meta: { changes: 0 } }) => {
      const f = stub({ batch: () => [batchResult], first: () => state })
      const result = await f.store.deliverSignal(signal)
      expect(f.prepared[3]!.sql).toBe("SELECT (SELECT 1 FROM framework_workflows WHERE id=?) AS instance,(SELECT 1 FROM framework_workflow_signals WHERE id=?) AS stored")
      expect(f.prepared[3]!.binds).toEqual(["wf1", "s1"])
      return result
    }
    expect(await outcome({ instance: 1, stored: 1 })).toEqual({ delivered: false, duplicate: true })
    expect(await outcome({ instance: 0, stored: 0 })).toEqual({ delivered: false, duplicate: true })
    expect(await outcome({ instance: 1, stored: null })).toEqual({ delivered: false, duplicate: false })
    expect(await outcome({ instance: null, stored: 1 })).toEqual({ delivered: false, duplicate: false })
    expect(await outcome(null)).toEqual({ delivered: false, duplicate: false })
    expect(await outcome({ instance: 1, stored: 1 }, {})).toEqual({ delivered: false, duplicate: true })
    expect(await outcome({ instance: 1, stored: 1 }, { meta: { changes: 2 } })).toEqual({ delivered: false, duplicate: true })
    const none = stub({ batch: () => [], first: () => ({ instance: 1, stored: 1 }) })
    expect(await none.store.deliverSignal(signal)).toEqual({ delivered: false, duplicate: true })
  })

  it("cancels only when exactly one live row changed", async () => {
    for (const [result, expected] of [[{ success: true, meta: { changes: 1 } }, true], [{ success: true, meta: { changes: 0 } }, false], [{ success: true, meta: {} }, false], [{ success: true }, false]] as const) {
      const f = stub({ run: () => result })
      expect(await f.store.cancel("wf1")).toBe(expected)
      expect(f.prepared[0]!.binds).toEqual(["wf1"])
    }
  })

  it("starts an instance with durable variables and reads it back", async () => {
    const f = stub({ first: () => baseRow })
    const started = await f.store.start({ id: "wf1", workflowType: "order", workflowVersion: 2, executionScope: { kind: "system", systemKey: "framework" } as never, initialStep: "reserve", variables: { n: 1 } })
    expect(started.id).toBe("wf1")
    expect(f.prepared[0]!.binds).toEqual(["wf1", "order", 2, '{"kind":"system","systemKey":"framework"}', "reserve", '{"n":1}'])
    expect(f.prepared[1]!.binds).toEqual(["wf1"])
  })
})
