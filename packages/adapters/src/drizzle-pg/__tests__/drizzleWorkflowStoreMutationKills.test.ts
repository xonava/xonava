import { describe, expect, it } from "vitest"
import { ConflictError } from "@xonava/core/domain"
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
  id: "wf1", workflowType: "order", workflowVersion: 1, executionScope: scope as never, status: "running", currentStep: "charge", variables: { n: 2 }, stepAttempt: 1, compensationStack: ["undo"] as never,
  waitingSignal: null, wakeAt: null, outcome: null, revision: 3, resumeSignalId: null, failure: null, leaseOwner: "w1", claimToken: "tok", leaseExpiresAt: NOW, createdAt: NOW, updatedAt: NOW, ...overrides,
}) as WorkflowInstance
const build = (respond: PoolResponder, schema?: string) => {
  const scripted = createScriptedPgPool(respond)
  return { store: new DrizzlePgWorkflowStore(scripted.pool as never, schema === undefined ? {} : { schema }), ...scripted }
}
const norm = (sql: string) => sql.replace(/\s+/g, " ").trim()
const statements = (calls: PoolCall[]) => calls.map((call) => [norm(call.sql), call.params])
const none: PoolResponder = () => ({ rows: [], rowCount: 0 })
const one: PoolResponder = () => ({ rows: [{}], rowCount: 1 })

const LOCK = "SELECT 1 FROM public.workflows WHERE id=$1 AND lease_owner=$2 AND claim_token=$3 AND revision=$4 AND lease_expires_at>clock_timestamp() FOR UPDATE"
const CONSUME = "UPDATE public.workflow_signals SET consumed_at=clock_timestamp(),consumed_revision=$3 WHERE id=(SELECT id FROM public.workflow_signals WHERE instance_id=$1 AND name=$2 AND consumed_at IS NULL ORDER BY seq LIMIT 1) RETURNING id"
const COMMIT_UPDATE = "UPDATE public.workflows SET workflow_version=$1,status=$2,current_step=$3,variables=$4,step_attempt=$5,compensation_stack=$6,waiting_signal=$7,wake_at=$8,outcome=$9,failure=$14,resume_signal_id=$15,revision=revision+1,lease_owner=NULL,claim_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$10 AND lease_owner=$11 AND claim_token=$12 AND revision=$13"

describe("workflow store reads and claims", () => {
  it("start inserts a pending instance and decodes every column", async () => {
    const { store, calls } = build(() => [workflowRow({ failure: { code: "X", message: "m", step: "s", phase: "execute", attempt: 1, at: NOW.toISOString() }, wake_at: NOW.toISOString(), lease_expires_at: NOW, resume_signal_id: "s1", waiting_signal: "go", outcome: "failed", lease_owner: "w", claim_token: "t", revision: "7", step_attempt: "2" })])
    const started = await store.start({ id: "wf1", workflowType: "order", workflowVersion: 1, executionScope: scope as never, initialStep: "reserve", variables: { n: 1 } })
    expect(statements(calls)).toEqual([["INSERT INTO public.workflows (id,workflow_type,workflow_version,execution_scope,status,current_step,variables) VALUES ($1,$2,$3,$4,'pending',$5,$6) RETURNING *", ["wf1", "order", 1, JSON.stringify(scope), "reserve", '{"n":1}']]])
    expect(started).toMatchObject({ id: "wf1", workflowType: "order", workflowVersion: 1, executionScope: scope, status: "pending", currentStep: "reserve", variables: { n: 1 }, stepAttempt: 2, compensationStack: [], waitingSignal: "go", outcome: "failed", revision: 7, resumeSignalId: "s1", leaseOwner: "w", claimToken: "t" })
    expect(started.wakeAt).toEqual(NOW)
    expect(started.leaseExpiresAt).toEqual(NOW)
    expect(started.createdAt).toEqual(NOW)
    expect(started.failure).toMatchObject({ code: "X", attempt: 1 })
  })

  it("decodes absent optional columns as null", async () => {
    const { store } = build(() => [workflowRow()])
    const loaded = await store.get("wf1")
    expect(loaded).toMatchObject({ waitingSignal: null, wakeAt: null, outcome: null, resumeSignalId: null, failure: null, leaseOwner: null, claimToken: null, leaseExpiresAt: null })
  })

  it("rejects non-durable variables before any SQL", async () => {
    const { store, calls } = build(() => [workflowRow()])
    await expect(store.start({ id: "x", workflowType: "o", workflowVersion: 1, executionScope: scope as never, initialStep: "s", variables: [] as never })).rejects.toThrow("Workflow variables must be an object")
    expect(calls).toEqual([])
  })

  it("get selects by id in the configured schema and returns null for no row", async () => {
    const found = build(() => [workflowRow()], "tenant_a")
    expect((await found.store.get("wf1"))?.id).toBe("wf1")
    expect(statements(found.calls)).toEqual([["SELECT * FROM tenant_a.workflows WHERE id=$1", ["wf1"]]])
    expect(await build(() => []).store.get("nope")).toBeNull()
  })

  it("claimDue claims due instances under a skip-locked row lock using the database clock", async () => {
    const { store, calls } = build(() => [workflowRow({ status: "pending", claim_token: "ct", lease_owner: "w1" })])
    const claims = await store.claimDue({ workerId: "w1", limit: 4, leaseDurationMs: 30_000 })
    expect(statements(calls)).toEqual([[
      "WITH due AS (SELECT id FROM public.workflows WHERE (status='pending' OR (status='compensating' AND (wake_at IS NULL OR wake_at<=clock_timestamp())) OR (status='waiting' AND wake_at IS NOT NULL AND wake_at<=clock_timestamp())) AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE public.workflows w SET status=CASE WHEN w.status='waiting' THEN 'pending' ELSE w.status END, lease_owner=$2,claim_token=gen_random_uuid()::text,lease_expires_at=clock_timestamp()+($3*interval '1 millisecond'),step_attempt=step_attempt+1,revision=revision+1,updated_at=clock_timestamp() FROM due WHERE w.id=due.id RETURNING w.*",
      [4, "w1", 30_000],
    ]])
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({ workerId: "w1", claimToken: "ct" })
    expect(claims[0]!.instance.id).toBe("wf1")
  })

  it("claimDue claims nothing for unusable limits or lease durations, but accepts a zero lease", async () => {
    const { store, calls } = build(() => [])
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(await store.claimDue({ workerId: "w", limit, leaseDurationMs: 1 })).toEqual([])
    for (const leaseDurationMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(await store.claimDue({ workerId: "w", limit: 1, leaseDurationMs })).toEqual([])
    expect(calls).toEqual([])
    expect(await store.claimDue({ workerId: "w", limit: 1, leaseDurationMs: 0 })).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it("assertLease and renewLease are fenced on owner, token, revision and a live lease", async () => {
    const live = build(() => ({ rows: [{}], rowCount: 1 }))
    expect(await live.store.assertLease(fence)).toBe(true)
    expect(await live.store.renewLease(fence, 500)).toBe(true)
    expect(statements(live.calls)).toEqual([
      ["SELECT 1 FROM public.workflows WHERE id=$1 AND lease_owner=$2 AND claim_token=$3 AND revision=$4 AND lease_expires_at>clock_timestamp()", ["wf1", "w1", "tok", 3]],
      ["UPDATE public.workflows SET lease_expires_at=GREATEST(lease_expires_at,clock_timestamp()+($5*interval '1 millisecond')) WHERE id=$1 AND lease_owner=$2 AND claim_token=$3 AND revision=$4 AND lease_expires_at>clock_timestamp()", ["wf1", "w1", "tok", 3, 500]],
    ])
    const lost = build(none)
    expect(await lost.store.assertLease(fence)).toBe(false)
    expect(await lost.store.renewLease(fence, 500)).toBe(false)
    const two = build(() => ({ rows: [], rowCount: 2 }))
    expect(await two.store.assertLease(fence)).toBe(false)
    expect(await two.store.renewLease(fence, 500)).toBe(false)
    const invalid = build(one)
    for (const extend of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(await invalid.store.renewLease(fence, extend)).toBe(false)
    expect(invalid.calls).toEqual([])
  })

  it("cancel moves the instance to compensation or cancelled unless it is already finished", async () => {
    const { store, calls } = build(one)
    expect(await store.cancel("wf1")).toBe(true)
    expect(statements(calls)).toEqual([[
      "UPDATE public.workflows SET status=CASE WHEN jsonb_array_length(compensation_stack)>0 THEN 'compensating' ELSE 'cancelled' END,outcome=CASE WHEN jsonb_array_length(compensation_stack)>0 THEN NULL ELSE 'cancelled' END,failure=jsonb_build_object('code','CANCELLED','message','Workflow was cancelled','step',current_step,'phase','execute','attempt',step_attempt,'at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')),step_attempt=0,waiting_signal=NULL,resume_signal_id=NULL,wake_at=NULL,revision=revision+1,lease_owner=NULL,claim_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status NOT IN ('succeeded','failed','cancelled','compensation_failed','compensating')",
      ["wf1"],
    ]])
    expect(await build(none).store.cancel("wf1")).toBe(false)
    expect(await build(() => ({ rows: [], rowCount: 2 })).store.cancel("wf1")).toBe(false)
  })
})

describe("workflow store signal lookups", () => {
  const signalRow = (overrides: Record<string, unknown> = {}) => ({ id: "sig1", instance_id: "wf1", name: "go", payload: '{"a":1}', delivered_at: NOW, ...overrides })

  it("getSignal returns the latest receipt of a name, getSignalById a specific receipt", async () => {
    const { store, calls } = build(() => [signalRow()])
    expect(await store.getSignal("wf1", "go")).toEqual({ id: "sig1", instanceId: "wf1", name: "go", payload: { a: 1 }, deliveredAt: NOW })
    expect(await store.getSignalById("wf1", "sig1")).toEqual({ id: "sig1", instanceId: "wf1", name: "go", payload: { a: 1 }, deliveredAt: NOW })
    expect(statements(calls)).toEqual([
      ["SELECT id,instance_id,name,payload,delivered_at FROM public.workflow_signals WHERE instance_id=$1 AND name=$2 ORDER BY seq DESC LIMIT 1", ["wf1", "go"]],
      ["SELECT id,instance_id,name,payload,delivered_at FROM public.workflow_signals WHERE instance_id=$1 AND id=$2", ["wf1", "sig1"]],
    ])
  })

  it("accepts object payloads and treats missing rows and non-object payloads as no signal", async () => {
    expect((await build(() => [signalRow({ payload: { b: 2 } })]).store.getSignal("wf1", "go"))?.payload).toEqual({ b: 2 })
    expect(await build(() => []).store.getSignal("wf1", "go")).toBeNull()
    for (const payload of [null, undefined, "[1]", [1], "null", 5, "5", "\"text\""]) {
      expect(await build(() => [signalRow({ payload })]).store.getSignalById("wf1", "sig1")).toBeNull()
    }
  })
})

describe("workflow store commit", () => {
  const sequence = (calls: PoolCall[]) => calls.map((call) => norm(call.sql).split(" ")[0])

  it("commits a non-signal transition: lock, update, commit, release", async () => {
    const { store, calls, events } = build((call) => (call.sql.includes("FOR UPDATE") ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 1 }))
    const next = instance({ status: "waiting", waitingSignal: null, wakeAt: new Date("2026-02-02T00:00:00.000Z"), outcome: null, resumeSignalId: "old" })
    expect(await store.commit(fence, next)).toBe(true)
    expect(statements(calls)).toEqual([
      ["BEGIN", []],
      [LOCK, ["wf1", "w1", "tok", 3]],
      [COMMIT_UPDATE, [1, "waiting", "charge", '{"n":2}', 1, '["undo"]', null, next.wakeAt, null, "wf1", "w1", "tok", 3, null, "old"]],
      ["COMMIT", []],
    ])
    expect(events.at(-1)).toBe("release")
  })

  it("writes the encoded failure and outcome", async () => {
    const { store, calls } = build((call) => (call.sql.includes("FOR UPDATE") ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 1 }))
    const failure = { code: "BOOM", message: "m", step: "charge", phase: "execute", attempt: 2, at: NOW } as never
    await store.commit(fence, instance({ status: "failed", outcome: "failed", failure }))
    const update = calls.find((call) => norm(call.sql) === COMMIT_UPDATE)!
    expect(update.params[8]).toBe("failed")
    expect(update.params[13]).toBe(JSON.stringify({ code: "BOOM", message: "m", step: "charge", phase: "execute", attempt: 2, at: NOW.toISOString() }))
  })

  it("rolls back and reports false when the fence no longer holds", async () => {
    const { store, calls, events } = build(none)
    expect(await store.commit(fence, instance())).toBe(false)
    expect(sequence(calls)).toEqual(["BEGIN", "SELECT", "ROLLBACK"])
    expect(events.at(-1)).toBe("release")
    const two = build(() => ({ rows: [{}], rowCount: 2 }))
    expect(await two.store.commit(fence, instance())).toBe(false)
    expect(sequence(two.calls)).toEqual(["BEGIN", "SELECT", "ROLLBACK"])
  })

  it("consumes the oldest buffered signal when the new state waits for a signal, resuming as pending", async () => {
    const { store, calls } = build((call) => {
      if (call.sql.includes("FOR UPDATE")) return { rows: [{}], rowCount: 1 }
      if (call.sql.includes("RETURNING id")) return { rows: [{ id: "sig9" }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    const waiting = instance({ status: "waiting", waitingSignal: "go", wakeAt: null, stepAttempt: 4 })
    expect(await store.commit(fence, waiting)).toBe(true)
    expect(statements(calls)).toEqual([
      ["BEGIN", []],
      [LOCK, ["wf1", "w1", "tok", 3]],
      [CONSUME, ["wf1", "go", 4]],
      [COMMIT_UPDATE, [1, "pending", "charge", '{"n":2}', 0, '["undo"]', "go", null, null, "wf1", "w1", "tok", 3, null, "sig9"]],
      ["COMMIT", []],
    ])
  })

  it("keeps the waiting state when no buffered signal exists", async () => {
    const { store, calls } = build((call) => {
      if (call.sql.includes("FOR UPDATE")) return { rows: [{}], rowCount: 1 }
      if (call.sql.includes("RETURNING id")) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 1 }
    })
    const waiting = instance({ status: "waiting", waitingSignal: "go", wakeAt: null, stepAttempt: 4, resumeSignalId: "prior" })
    await store.commit(fence, waiting)
    expect(calls.find((call) => norm(call.sql) === COMMIT_UPDATE)!.params).toEqual([1, "waiting", "charge", '{"n":2}', 4, '["undo"]', "go", null, null, "wf1", "w1", "tok", 3, null, "prior"])
  })

  it("does not look for buffered signals unless the new state waits for one", async () => {
    const { store, calls } = build((call) => (call.sql.includes("FOR UPDATE") ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 1 }))
    await store.commit(fence, instance({ status: "pending", waitingSignal: null }))
    await store.commit(fence, instance({ status: "waiting", waitingSignal: "go", wakeAt: NOW }))
    await store.commit(fence, instance({ status: "waiting", waitingSignal: null, wakeAt: null }))
    await store.commit(fence, instance({ status: "running", waitingSignal: "go", wakeAt: null }))
    expect(calls.some((call) => call.sql.includes("workflow_signals"))).toBe(false)
  })

  it("rolls back, swallows a failing rollback, rethrows the original error and always releases", async () => {
    const failure = new Error("update failed")
    const failing = build((call) => {
      if (call.sql.includes("FOR UPDATE")) return { rows: [{}], rowCount: 1 }
      if (call.sql.startsWith("UPDATE")) throw failure
      if (call.sql === "ROLLBACK") throw new Error("rollback failed")
      return { rows: [], rowCount: 1 }
    })
    await expect(failing.store.commit(fence, instance())).rejects.toBe(failure)
    expect(sequence(failing.calls)).toEqual(["BEGIN", "SELECT", "UPDATE", "ROLLBACK"])
    expect(failing.events.at(-1)).toBe("release")
  })

  it("works with a connection that has no release method", async () => {
    const queries: string[] = []
    const client = { query: async (text: string) => { queries.push(norm(text).split(" ")[0]!); return { rows: [{}], rowCount: 1 } } }
    const pool = { connect: async () => client, query: async () => ({ rows: [], rowCount: 0 }) }
    const store = new DrizzlePgWorkflowStore(pool as never)
    expect(await store.commit(fence, instance())).toBe(true)
    const failing = { query: async (text: string) => { if (text.startsWith("UPDATE")) throw new Error("x"); return { rows: [{}], rowCount: 1 } } }
    await expect(new DrizzlePgWorkflowStore({ connect: async () => failing, query: async () => ({ rows: [], rowCount: 0 }) } as never).commit(fence, instance())).rejects.toThrow("x")
    expect(queries).toEqual(["BEGIN", "SELECT", "UPDATE", "COMMIT"])
  })
})

describe("workflow store signal delivery", () => {
  const signal = { id: "sig1", instanceId: "wf1", name: "go", payload: { a: 1 } }
  const INSTANCE = "SELECT status,wake_at,waiting_signal,revision FROM public.workflows WHERE id=$1 FOR UPDATE"
  const DUPLICATE = "SELECT 1 FROM public.workflow_signals WHERE id=$1"
  const INSERT = "INSERT INTO public.workflow_signals (id,instance_id,name,payload) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING id"
  const WAKE = "UPDATE public.workflows SET status='pending',wake_at=NULL,step_attempt=0,resume_signal_id=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1"

  interface Script { instance?: Record<string, unknown> | null; duplicate?: boolean; inserted?: boolean }
  const respond = (script: Script): PoolResponder => (call) => {
    const text = norm(call.sql)
    if (text === INSTANCE) return script.instance === null ? { rows: [], rowCount: 0 } : { rows: [script.instance ?? { status: "pending", wake_at: null, waiting_signal: null, revision: 5 }], rowCount: 1 }
    if (text === DUPLICATE) return { rows: [], rowCount: script.duplicate ? 1 : 0 }
    if (text === INSERT) return { rows: [], rowCount: script.inserted === false ? 0 : 1 }
    if (text === CONSUME) return { rows: [{ id: "sig1" }], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  }

  it("delivers to a non-waiting instance: lock, duplicate check, insert, commit", async () => {
    const { store, calls, events } = build(respond({}))
    expect(await store.deliverSignal(signal)).toEqual({ delivered: true, duplicate: false })
    expect(statements(calls)).toEqual([
      ["BEGIN", []],
      [INSTANCE, ["wf1"]],
      [DUPLICATE, ["sig1"]],
      [INSERT, ["sig1", "wf1", "go", '{"a":1}']],
      ["COMMIT", []],
    ])
    expect(events.at(-1)).toBe("release")
  })

  it("wakes an instance that is waiting for exactly this signal with no timer", async () => {
    const { store, calls } = build(respond({ instance: { status: "waiting", wake_at: null, waiting_signal: "go", revision: "5" } }))
    expect(await store.deliverSignal(signal)).toEqual({ delivered: true, duplicate: false })
    expect(statements(calls).slice(4)).toEqual([[CONSUME, ["wf1", "go", 6]], [WAKE, ["wf1", "sig1"]], ["COMMIT", []]])
  })

  it.each([
    ["a different awaited signal", { status: "waiting", wake_at: null, waiting_signal: "other", revision: 5 }],
    ["a timer", { status: "waiting", wake_at: NOW, waiting_signal: "go", revision: 5 }],
    ["a non-waiting status", { status: "pending", wake_at: null, waiting_signal: "go", revision: 5 }],
    ["a running status", { status: "running", wake_at: null, waiting_signal: "go", revision: 5 }],
  ])("only stores the receipt when the instance waits with %s", async (_label, row) => {
    const { store, calls } = build(respond({ instance: row }))
    expect(await store.deliverSignal(signal)).toEqual({ delivered: true, duplicate: false })
    expect(calls.some((call) => norm(call.sql) === WAKE)).toBe(false)
  })

  it("reports an unknown instance without storing anything", async () => {
    const { store, calls } = build(respond({ instance: null }))
    expect(await store.deliverSignal(signal)).toEqual({ delivered: false, duplicate: false })
    expect(statements(calls)).toEqual([["BEGIN", []], [INSTANCE, ["wf1"]], ["ROLLBACK", []]])
  })

  it("reports a receipt id that already exists as a duplicate, even for a terminal instance", async () => {
    const dup = build(respond({ duplicate: true, instance: { status: "succeeded", wake_at: null, waiting_signal: null, revision: 1 } }))
    expect(await dup.store.deliverSignal(signal)).toEqual({ delivered: false, duplicate: true })
    expect(statements(dup.calls)).toEqual([["BEGIN", []], [INSTANCE, ["wf1"]], [DUPLICATE, ["sig1"]], ["ROLLBACK", []]])
  })

  it.each(["succeeded", "failed", "cancelled", "compensation_failed"])("stores nothing for a %s instance", async (status) => {
    const { store, calls } = build(respond({ instance: { status, wake_at: null, waiting_signal: null, revision: 1 } }))
    expect(await store.deliverSignal(signal)).toEqual({ delivered: false, duplicate: false })
    expect(statements(calls)).toEqual([["BEGIN", []], [INSTANCE, ["wf1"]], [DUPLICATE, ["sig1"]], ["ROLLBACK", []]])
  })

  it("keeps compensating and waiting instances open for signals", async () => {
    for (const status of ["compensating", "waiting", "pending", "running"]) {
      const { store } = build(respond({ instance: { status, wake_at: null, waiting_signal: null, revision: 1 } }))
      expect(await store.deliverSignal(signal)).toEqual({ delivered: true, duplicate: false })
    }
  })

  it("treats a lost insert race as a duplicate", async () => {
    const { store, calls } = build(respond({ inserted: false }))
    expect(await store.deliverSignal(signal)).toEqual({ delivered: false, duplicate: true })
    expect(statements(calls).at(-1)).toEqual(["ROLLBACK", []])
  })

  it("normalizes provider failures, tolerates a failing rollback and releases the connection", async () => {
    const failing = build((call) => {
      if (norm(call.sql) === INSERT) throw Object.assign(new Error("provider text"), { code: "23505" })
      if (call.sql === "ROLLBACK") throw new Error("rollback failed")
      return respond({})(call)
    })
    const error = await failing.store.deliverSignal(signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as Error).message).toBe("A record with this value already exists")
    expect(failing.events.at(-1)).toBe("release")
    const noRelease = { query: async (text: string) => { if (norm(text) === INSTANCE) throw new Error("x"); return { rows: [], rowCount: 0 } } }
    await expect(new DrizzlePgWorkflowStore({ connect: async () => noRelease, query: async () => ({ rows: [], rowCount: 0 }) } as never).deliverSignal(signal)).rejects.toThrow()
    const okNoRelease = { query: async (text: string) => (norm(text) === INSTANCE ? { rows: [{ status: "pending", wake_at: null, waiting_signal: null, revision: 1 }], rowCount: 1 } : { rows: [], rowCount: norm(text) === DUPLICATE ? 0 : 1 }) }
    expect(await new DrizzlePgWorkflowStore({ connect: async () => okNoRelease, query: async () => ({ rows: [], rowCount: 0 }) } as never).deliverSignal(signal)).toEqual({ delivered: true, duplicate: false })
  })
})
