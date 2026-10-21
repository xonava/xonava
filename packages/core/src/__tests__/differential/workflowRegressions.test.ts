import { describe, expect, it } from "vitest"
import { drive, flush, ManualClock, MemoryWorkflowStore } from "./workflowFixtures"
import { buildWorld, type Behavior, type StepSpec, type WorldSpec } from "./workflowWorld"
import { expectNearLinear } from "../timing"
import { dispatchWorkflows } from "../../workflow/workflowDispatcher"
import { defineWorkflow } from "../../workflow/workflowDefinition"
import { applyWorkflowStep, createWorkflowFailure } from "../../workflow/workflowStateMachine"
import { WorkflowDefinitionError, WorkflowStateError } from "../../workflow/workflowErrors"
import type { WorkflowDefinition, WorkflowInstance, WorkflowStepResult } from "../../workflow/types"

/**
 * Minimal counterexamples found by the workflow differentials, kept as named
 * examples so the fixes cannot silently regress.
 */

const SCOPE = { kind: "tenant", tenantId: "t1" } as const
const at = new Date("2026-10-01T00:00:00.000Z")

function instance(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    id: "wf", workflowType: "order", workflowVersion: 1, executionScope: SCOPE, status: "pending", currentStep: "a", variables: {}, stepAttempt: 1, compensationStack: [], waitingSignal: null, wakeAt: null,
    outcome: null, revision: 1, leaseOwner: "w", claimToken: "t", leaseExpiresAt: at, createdAt: at, updatedAt: at, failure: null, ...overrides,
  }
}

function step(exec: Behavior[], extra: Partial<StepSpec> = {}): StepSpec {
  return { retry: undefined, compensationRetry: undefined, idempotent: undefined, hasCompensate: true, exec, comp: [{ k: "complete" }], ...extra }
}

function world(a: StepSpec): WorldSpec {
  return { graceMs: 20, steps: { a, b: step([{ k: "complete" }]), c: step([{ k: "complete" }]), d: step([{ k: "complete" }]) }, v2: null }
}

async function runOnce(spec: WorldSpec, prepare?: (store: MemoryWorkflowStore) => Promise<void> | void, extra: { currentStep?: string } = {}) {
  const clock = new ManualClock()
  const store = new MemoryWorkflowStore(clock)
  const built = buildWorld(spec, clock, store)
  await store.start({ id: "i0", workflowType: "order", workflowVersion: 1, executionScope: SCOPE, initialStep: extra.currentStep ?? "a", variables: {} })
  await prepare?.(store)
  const result = await drive(dispatchWorkflows({ store, registry: built.registry, workerId: "w1", claimLimit: 1, leaseDurationMs: 1000, stepTimeoutMs: 50, cancellationGraceMs: 20, clock, random: () => 0.5 }), clock)
  return { clock, store, built, result, row: store.rows.get("i0")! }
}

describe("regressions found by the workflow differentials", () => {
  it("a compensating instance rejects forward results instead of resuming the workflow", () => {
    // Found by "workflow state machine table": applyWorkflowStep(compensating, next) produced a pending instance
    // that kept its compensation stack, abandoning the rollback; a complete result produced `succeeded`.
    const compensating = instance({ status: "compensating", compensationStack: ["undo"], failure: null })
    for (const result of [{ kind: "next", step: "b" }, { kind: "wait", signal: "go" }, { kind: "sleep", wakeAt: at }, { kind: "complete" }] as WorkflowStepResult[]) {
      expect(() => applyWorkflowStep(compensating, result, at), result.kind).toThrow(WorkflowStateError)
    }
    expect(applyWorkflowStep(compensating, { kind: "retry", error: "x" }, at)).toMatchObject({ status: "compensating", compensationStack: ["undo"] })
    expect(applyWorkflowStep(compensating, { kind: "fail", error: "x" }, at)).toMatchObject({ status: "compensation_failed", outcome: "failed", compensationStack: ["undo"] })
  })

  it("malformed step results are rejected before they reach durable state", async () => {
    // Found by "workflow state machine malformed results": a sleep without a valid Date stored `wakeAt: undefined/5/"2026"`, a wait
    // without a signal name waited for nothing; no store would ever claim such an instance again.
    const malformed: Array<[string, unknown]> = [
      ["sleep without wakeAt", { kind: "sleep" }], ["sleep with a number", { kind: "sleep", wakeAt: 5 }], ["sleep with a string", { kind: "sleep", wakeAt: "2026-01-01" }],
      ["sleep with an invalid date", { kind: "sleep", wakeAt: new Date(Number.NaN) }], ["wait without a signal", { kind: "wait" }], ["wait with an empty signal", { kind: "wait", signal: "" }],
      ["wait with a numeric signal", { kind: "wait", signal: 5 }], ["next without a step", { kind: "next" }], ["next with an empty step", { kind: "next", step: "" }],
      ["next with a numeric step", { kind: "next", step: 5 }], ["next with a numeric compensation", { kind: "next", step: "b", compensation: 5 }],
      ["array variables", { kind: "complete", variables: [1] }], ["string variables", { kind: "complete", variables: "x" }],
    ]
    for (const [label, result] of malformed) expect(() => applyWorkflowStep(instance(), result as WorkflowStepResult, at), label).toThrow(WorkflowStateError)

    // End to end: the dispatcher records a failure for the step instead of parking the instance.
    const { row, result } = await runOnce(world(step([{ k: "malformed" }])))
    expect(result).toMatchObject({ claimed: 1, failed: 1, advanced: 0 })
    expect(row).toMatchObject({ status: "failed", outcome: "failed", failure: { code: "INVALID_STEP_RESULT", step: "a" } })
  })

  it("a null, undefined or empty compensation means none; a non-string truthy compensation stays malformed", () => {
    // Before the fix { kind: "next", compensation: null | "" } failed the workflow with INVALID_STEP_RESULT; a falsy compensation used to mean "none".
    for (const compensation of [null, undefined, ""]) {
      const next = applyWorkflowStep(instance(), { kind: "next", step: "b", compensation } as unknown as WorkflowStepResult, at)
      expect(next, String(compensation)).toMatchObject({ status: "pending", currentStep: "b", compensationStack: [] })
    }
    expect(applyWorkflowStep(instance(), { kind: "next", step: "b", compensation: "undo" }, at)).toMatchObject({ compensationStack: ["undo"] })
    for (const compensation of [5, true, {}, ["undo"]]) expect(() => applyWorkflowStep(instance(), { kind: "next", step: "b", compensation } as unknown as WorkflowStepResult, at)).toThrow(WorkflowStateError)
  })

  it("a step named like an Object.prototype member is undefined, not inherited", async () => {
    // Found by "workflow dispatcher model equivalence": next -> "constructor" ran Object.execute (TypeError: not a function)
    // and recorded STEP_ERROR; defineWorkflow({ initialStep: "toString" }) was accepted.
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const { row } = await runOnce(world(step([{ k: "complete" }])), undefined, { currentStep: name })
      expect(row, name).toMatchObject({ status: "failed", failure: { code: "STEP_NOT_DEFINED", step: name } })
    }
    const base = { type: "order", version: 1, decodeVariables: (value: unknown) => value as Record<string, unknown>, steps: { a: { name: "a", datasource: "primary", execute: async () => ({ kind: "complete" as const }) } } }
    for (const initialStep of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) expect(() => defineWorkflow({ ...base, initialStep } as WorkflowDefinition), initialStep).toThrow(WorkflowDefinitionError)
    expect(() => defineWorkflow({ ...base, initialStep: "a" } as WorkflowDefinition)).not.toThrow()
  })

  it("a deadline that expires before the step started is retried even for a non-idempotent step", async () => {
    // Found by "workflow dispatcher store faults": a slow signal read (store.getSignal hanging past the step deadline) failed the
    // instance with TIMEOUT - and started compensation - although the step never ran and so could not have had an external effect.
    const clock = new ManualClock()
    const store = new MemoryWorkflowStore(clock)
    const spec = world(step([{ k: "complete" }], { idempotent: false }))
    const built = buildWorld(spec, clock, store)
    await store.start({ id: "i0", workflowType: "order", workflowVersion: 1, executionScope: SCOPE, initialStep: "a", variables: {} })
    store.rows.set("i0", { ...store.rows.get("i0")!, waitingSignal: "go", compensationStack: ["a"] })
    const wrapped = {
      start: store.start.bind(store), get: store.get.bind(store), claimDue: store.claimDue.bind(store), assertLease: store.assertLease.bind(store), renewLease: store.renewLease.bind(store),
      commit: store.commit.bind(store), deliverSignal: store.deliverSignal.bind(store), cancel: store.cancel.bind(store), getSignal: () => new Promise<never>(() => undefined),
    }
    const result = await drive(dispatchWorkflows({ store: wrapped, registry: built.registry, workerId: "w1", claimLimit: 1, leaseDurationMs: 1000, stepTimeoutMs: 50, cancellationGraceMs: 20, clock }), clock)
    expect(result).toMatchObject({ retried: 1, failed: 0 })
    expect(built.log, "the step never started").toEqual([])
    expect(store.rows.get("i0")).toMatchObject({ status: "waiting", stepAttempt: 1, failure: null, compensationStack: ["a"] })
    await flush()
  })

  it("defineWorkflow reports every malformed field as a WorkflowDefinitionError, never a TypeError", () => {
    // Found by "workflow defineWorkflow validity": a missing type/datasource/steps surfaced as `Cannot read properties of undefined (reading 'trim')`.
    const good = { name: "a", datasource: "primary", execute: async () => ({ kind: "complete" as const }) }
    const make = (overrides: Record<string, unknown>) => ({ type: "order", version: 1, initialStep: "a", steps: { a: good }, decodeVariables: (value: unknown) => value, ...overrides }) as unknown as WorkflowDefinition
    for (const overrides of [{ type: undefined }, { type: 5 }, { steps: undefined }, { steps: null }, { steps: [] }, { initialStep: undefined }, { steps: { a: { ...good, datasource: undefined } } }, { steps: { a: null } }, { decodeVariables: undefined }]) {
      expect(() => defineWorkflow(make(overrides)), JSON.stringify(Object.keys(overrides))).toThrow(WorkflowDefinitionError)
    }
    expect(() => defineWorkflow(undefined as unknown as WorkflowDefinition)).toThrow(WorkflowDefinitionError)
  })

  it("a forward result clears a failure recorded for an earlier attempt, and nothing else does", () => {
    // Found by review: after a stalled attempt recorded a TIMEOUT failure and the idempotent step was re-run successfully, the
    // instance advanced (or succeeded) while `failure` still held the stale TIMEOUT record.
    const timeout = createWorkflowFailure({ code: "TIMEOUT", message: "late", step: "a", phase: "execute", attempt: 1, at })
    const stalled = instance({ status: "pending", stepAttempt: 2, failure: timeout })
    for (const result of [{ kind: "next", step: "b" }, { kind: "wait", signal: "go" }, { kind: "sleep", wakeAt: at }, { kind: "complete" }] as WorkflowStepResult[]) {
      expect(applyWorkflowStep(stalled, result, at).failure, result.kind).toBeNull()
    }
    // A retry has not succeeded: the record (and so stalled-attempt detection) survives it.
    expect(applyWorkflowStep(stalled, { kind: "retry", error: "x" }, at).failure).toEqual(timeout)
    // Failure and compensation keep or replace the record.
    const compensating = instance({ status: "compensating", compensationStack: ["undo"], failure: timeout })
    expect(applyWorkflowStep(compensating, { kind: "retry", error: "x" }, at).failure).toEqual(timeout)
    expect(applyWorkflowStep(stalled, { kind: "fail", error: "x" }, at).failure).toMatchObject({ code: "STEP_FAILED" })
  })

  it("a stalled attempt's TIMEOUT failure is cleared once the resumed idempotent step succeeds", async () => {
    for (const outcome of [{ k: "next", to: "b" }, { k: "wait", sig: "go" }, { k: "sleep", delay: 5000 }, { k: "complete" }] as Behavior[]) {
      const { store, built, clock } = await runOnce(world(step([{ k: "stall" }, outcome], { idempotent: true })))
      expect(store.rows.get("i0"), "stalled first").toMatchObject({ status: "waiting", failure: { code: "TIMEOUT", phase: "execute", step: "a", attempt: 1 } })
      await clock.jumpTo(clock.current + 10_000)
      await drive(dispatchWorkflows({ store, registry: built.registry, workerId: "w1", claimLimit: 1, leaseDurationMs: 1000, stepTimeoutMs: 50, cancellationGraceMs: 20, clock, random: () => 0.5 }), clock)
      const row = store.rows.get("i0")!
      expect(built.log.filter((entry) => entry.step === "a" && entry.phase === "execute"), outcome.k).toHaveLength(2)
      expect(row.status, outcome.k).not.toBe("failed")
      expect(row.failure, outcome.k).toBeNull()
    }
  })

  // Found by the workflow differentials: a signal delivered while the instance was still running its previous step was recorded
  // as a receipt but woke nothing; the step's own `wait` for that name then parked the instance, and re-sending the same signal
  // id was reported as a duplicate, so the wake-up was lost for good. Receipts are now buffered (docs/spec/workflow.md,
  // "Signals"): the commit of the `wait` consumes the pending receipt and leaves the instance resumed.
  it("a signal received before the instance reaches its wait is not lost", async () => {
    const spec = world(step([{ k: "signalSelf", name: "go", then: { k: "wait", sig: "go" } }, { k: "complete" }]))
    const { store, built, clock } = await runOnce(spec)
    const signalId = store.receipts[0]!.id
    // The wait found the buffered receipt: the instance is already resumed by it, not parked.
    expect(store.rows.get("i0")).toMatchObject({ status: "pending", waitingSignal: "go", resumeSignalId: signalId })
    expect(store.consumptions).toEqual([{ signalId, instanceId: "i0", via: "commit", revision: 2 }])
    expect(await store.deliverSignal({ id: signalId, instanceId: "i0", name: "go", payload: {} })).toEqual({ delivered: false, duplicate: true })
    await drive(dispatchWorkflows({ store, registry: built.registry, workerId: "w1", claimLimit: 1, leaseDurationMs: 1000, stepTimeoutMs: 50, cancellationGraceMs: 20, clock }), clock)
    // The early signal satisfied the wait, so the resumed step ran (with exactly that receipt) and the workflow finished.
    expect(store.rows.get("i0")).toMatchObject({ status: "succeeded", resumeSignalId: null })
    expect(built.log.at(-1)).toMatchObject({ step: "a", signalId })
  })

  it("the resumed step receives the receipt that resumed it, not the latest receipt of that name", async () => {
    // Before: getSignal(name) returned the latest receipt, so a signal buffered after the one that woke the step replaced it.
    const spec = world(step([{ k: "wait", sig: "go" }, { k: "complete" }]))
    const { store, built, clock } = await runOnce(spec)
    expect(store.rows.get("i0")).toMatchObject({ status: "waiting", waitingSignal: "go" })
    await store.deliverSignal({ id: "first", instanceId: "i0", name: "go", payload: { n: 1 } })
    await store.deliverSignal({ id: "second", instanceId: "i0", name: "go", payload: { n: 2 } })
    expect(store.rows.get("i0")).toMatchObject({ status: "pending", resumeSignalId: "first" })
    expect(store.pending("i0", "go").map((receipt) => receipt.id)).toEqual(["second"])
    await drive(dispatchWorkflows({ store, registry: built.registry, workerId: "w1", claimLimit: 1, leaseDurationMs: 1000, stepTimeoutMs: 50, cancellationGraceMs: 20, clock }), clock)
    expect(built.log.at(-1)).toMatchObject({ signalId: "first" })
    expect(store.pending("i0", "go").map((receipt) => receipt.id), "the later receipt is still pending, never consumed by the resumed step").toEqual(["second"])
  })
})

describe("failure recording is bounded in time and space", () => {
  it("a huge adversarial error message neither stalls the dispatcher nor leaks a cut-off contact detail", async () => {
    // Found by "workflow failure record": defaultAuditSanitizer backtracks quadratically on "a.a.a.…" (32 kB took 2.4 s, 100 kB ~25 s),
    // and createWorkflowFailure sanitized the whole message before truncating it to 512 characters.
    await expectNearLinear((size) => () => createWorkflowFailure({ code: "STEP_FAILED", message: "a.".repeat(size / 2), step: "a", phase: "execute", attempt: 1, at }), { size: 400_000 })
    const failure = createWorkflowFailure({ code: "STEP_FAILED", message: "a.".repeat(200_000), step: "a", phase: "execute", attempt: 1, at })
    expect(Array.from(failure.message).length).toBeLessThanOrEqual(512)
    // A contact detail that straddles the cut must not survive as a recognisable prefix of itself: sixteen 250-character addresses
    // shrink to 10 characters each, so the cut token would otherwise be part of the stored message.
    const address = `${"a".repeat(60)}@${"b".repeat(180)}.com`
    const cut = `${`${address} `.repeat(16)}${"secret".repeat(40)}@example.com ${"y".repeat(5_000)}`
    const message = createWorkflowFailure({ code: "STEP_FAILED", message: cut, step: "a", phase: "execute", attempt: 1, at }).message
    expect(message).not.toContain("secret")
    expect(message.startsWith("[redacted] [redacted]")).toBe(true)
    const cutPhone = `${`${address} `.repeat(16)}${"q ".repeat(76)}+1 555 123 4567 and more text ${"y".repeat(5_000)}`
    expect(createWorkflowFailure({ code: "STEP_FAILED", message: cutPhone, step: "a", phase: "execute", attempt: 1, at }).message).not.toMatch(/555/)
  })
})
