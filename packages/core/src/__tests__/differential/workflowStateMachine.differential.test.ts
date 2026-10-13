import { describe, expect, it, vi } from "vitest"
import { forAll, scaledRuns, type Rng } from "./harness"
import {
  isTerminalStatus, refApply, refDurableBytes, REF_MAX_DURABLE_BYTES,
  type RefEvent, type RefFailure, type RefInstance, type RefResult, type RefStatus,
} from "./workflowModel"
import {
  applyWorkflowStep, cancelWorkflow, completeCompensation, createWorkflowFailure, deliverWorkflowSignal, failCompensation, failWorkflowStep,
  isStalledWorkflowAttempt, isWorkflowTerminal, markWorkflowAttemptStalled, MAX_WORKFLOW_FAILURE_MESSAGE_LENGTH, releaseWorkflowClaim, resumeWorkflowFromBufferedSignal, scheduleWorkflowRetry,
} from "../../workflow/workflowStateMachine"
import { WorkflowDefinitionError, WorkflowStateError } from "../../workflow/workflowErrors"
import type { WorkflowFailure, WorkflowInstance, WorkflowStepResult } from "../../workflow/types"

// Property runs scale with DIFFERENTIAL_SCALE; so does the time they may take.
vi.setConfig({ testTimeout: 60_000 * Math.max(1, scaledRuns(100) / 100) })

/**
 * The workflow state machine against an independent reference transition table
 * (workflowModel.ts, written from docs/spec/workflow.md): random event
 * sequences over every status, illegal events included.
 */

const STEPS = ["a", "b", "c"] as const
const UNDO = ["undo-a", "undo-b"] as const
const SIGNALS = ["go", "stop"] as const
const T0 = Date.UTC(2026, 9, 1)

type RawResult =
  | { kind: "next"; step: string; compensation?: string; vars?: VarSpec }
  | { kind: "wait"; signal: string; vars?: VarSpec }
  | { kind: "sleep"; wakeAt: number; vars?: VarSpec }
  | { kind: "complete"; vars?: VarSpec }
  | { kind: "retry"; error: string }
  | { kind: "fail"; error: string }

/** Variables are resolved at run time so a "big" payload can land exactly on the durable-size boundary. */
type VarSpec = { small: Record<string, number | string> } | { big: -1 | 0 | 1; multibyte: boolean }

type RawEvent =
  | { t: "claim"; leaseMs: number; dt: number }
  | { t: "step"; result: RawResult; dt: number }
  | { t: "retryAt"; wakeDelta: number | "invalid"; dt: number }
  | { t: "failStep"; code: string; dt: number }
  | { t: "failComp"; code: string; dt: number }
  | { t: "stall"; wakeDelta: number | "invalid"; dt: number }
  | { t: "signal"; name: string; dt: number }
  | { t: "buffered"; dt: number }
  | { t: "release"; dt: number }
  | { t: "cancel"; dt: number }
  | { t: "completeComp"; dt: number }

interface MachineCase { start: { step: string; stack: string[] }; events: RawEvent[] }

const LONG_ERROR = "x".repeat(MAX_WORKFLOW_FAILURE_MESSAGE_LENGTH + 40)
const ASTRAL_ERROR = "😀".repeat(MAX_WORKFLOW_FAILURE_MESSAGE_LENGTH + 3)

function generateVars(rng: Rng): VarSpec | undefined {
  const roll = rng.int(10)
  if (roll < 4) return undefined
  if (roll < 9) return { small: Object.fromEntries(rng.subset(["k1", "k2", "k3"], 0.6).map((key) => [key, rng.bool() ? rng.int(5) : rng.pick(["x", "y", "é"])])) }
  return { big: rng.pick([-1, 0, 1] as const), multibyte: rng.bool() }
}

function generateResult(rng: Rng): RawResult {
  const vars = generateVars(rng)
  const withVars = vars === undefined ? {} : { vars }
  switch (rng.int(8)) {
    case 0:
    case 1: return { kind: "next", step: rng.pick(STEPS), ...(rng.bool(0.5) ? { compensation: rng.pick(UNDO) } : {}), ...withVars }
    case 2: return { kind: "wait", signal: rng.pick(SIGNALS), ...withVars }
    case 3: return { kind: "sleep", wakeAt: T0 + rng.int(200) - 20, ...withVars }
    case 4: return { kind: "complete", ...withVars }
    case 5: return { kind: "retry", error: "again" }
    default: return { kind: "fail", error: rng.pick(["boom", "denied", LONG_ERROR, ASTRAL_ERROR]) }
  }
}

function generateEvent(rng: Rng): RawEvent {
  const dt = rng.int(4)
  switch (rng.int(20)) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4: return { t: "claim", leaseMs: 50 + rng.int(50), dt }
    case 5:
    case 6:
    case 7:
    case 8:
    case 9:
    case 10: return { t: "step", result: generateResult(rng), dt }
    case 11: return { t: "retryAt", wakeDelta: rng.bool(0.1) ? "invalid" : rng.int(100) - 10, dt }
    case 12: return { t: "failStep", code: rng.pick(["RETRY_EXHAUSTED", "TIMEOUT", "STEP_ERROR"]), dt }
    case 13: return { t: "failComp", code: rng.pick(["RETRY_EXHAUSTED", "ATTEMPTS_EXHAUSTED"]), dt }
    case 14: return { t: "stall", wakeDelta: rng.bool(0.1) ? "invalid" : rng.int(100), dt }
    case 15: return { t: "signal", name: rng.pick(SIGNALS), dt }
    case 16: return rng.bool(0.5) ? { t: "signal", name: rng.pick(SIGNALS), dt } : { t: "buffered", dt }
    case 17: return rng.bool(0.5) ? { t: "release", dt } : { t: "cancel", dt }
    case 18: return { t: "cancel", dt }
    default: return { t: "completeComp", dt }
  }
}

function generateCase(rng: Rng): MachineCase {
  return {
    start: { step: rng.pick(STEPS), stack: Array.from({ length: rng.int(3) }, () => rng.pick(UNDO)) },
    events: Array.from({ length: 1 + rng.int(40) }, () => generateEvent(rng)),
  }
}

function* shrinkMachineCase(value: MachineCase): Iterable<MachineCase> {
  for (let index = 0; index < value.events.length; index++) yield { ...value, events: value.events.filter((_, position) => position !== index) }
  if (value.start.stack.length > 0) yield { ...value, start: { ...value.start, stack: value.start.stack.slice(1) } }
}

const describeCase = (value: MachineCase): string => JSON.stringify(value, (_key, item: unknown) => (typeof item === "string" && item.length > 24 ? `${item.slice(0, 8)}...(${item.length})` : item))

function resolveVars(spec: VarSpec | undefined, current: Record<string, unknown>): Record<string, unknown> | undefined {
  if (spec === undefined) return undefined
  if ("small" in spec) return spec.small
  const { big: _dropped, ...rest } = current
  const overhead = refDurableBytes({ ...rest, big: "" })
  const need = REF_MAX_DURABLE_BYTES + spec.big - overhead
  if (need < 0) return { k1: 1 }
  const wide = spec.multibyte ? Math.floor(need / 2) : 0
  return { big: "é".repeat(wide) + "a".repeat(need - wide * 2) }
}

interface Resolved { event: RefEvent; now: number }

/** Turns a raw event into the model's event, given the current (shared) variable state. */
function resolve(raw: RawEvent, vars: Record<string, unknown>, now: number): RefEvent {
  const failure = (code: string, phase: "execute" | "compensate"): RefFailure => ({ code, step: "a", phase, attempt: 2, at: now, message: "bad thing" })
  switch (raw.t) {
    case "claim": return { t: "claim", leaseMs: raw.leaseMs }
    case "step": {
      const { result } = raw
      const variables = "vars" in result ? resolveVars(result.vars, vars) : undefined
      const withVars = variables === undefined ? {} : { variables }
      let converted: RefResult
      switch (result.kind) {
        case "next": converted = { kind: "next", step: result.step, ...(result.compensation !== undefined ? { compensation: result.compensation } : {}), ...withVars }; break
        case "wait": converted = { kind: "wait", signal: result.signal, ...withVars }; break
        case "sleep": converted = { kind: "sleep", wakeAt: result.wakeAt, ...withVars }; break
        case "complete": converted = { kind: "complete", ...withVars }; break
        default: converted = result
      }
      return { t: "step", result: converted }
    }
    case "retryAt": return { t: "retryAt", wakeAt: raw.wakeDelta === "invalid" ? "invalid" : now + raw.wakeDelta }
    case "failStep": return { t: "failStep", failure: failure(raw.code, "execute") }
    case "failComp": return { t: "failComp", failure: failure(raw.code, "compensate") }
    case "stall": return { t: "stall", failure: failure("TIMEOUT", "execute"), wakeAt: raw.wakeDelta === "invalid" ? "invalid" : now + raw.wakeDelta }
    case "signal": return { t: "signal", name: raw.name, id: `s${now}` }
    case "buffered": return { t: "buffered", id: `b${now}` }
    case "release": return { t: "release" }
    case "cancel": return { t: "cancel" }
    case "completeComp": return { t: "completeComp" }
  }
}

function toRefResult(result: RefResult): WorkflowStepResult {
  switch (result.kind) {
    case "sleep": return { ...result, wakeAt: new Date(result.wakeAt) }
    default: return result
  }
}

function produce(refStart: RefInstance): WorkflowInstance {
  const at = new Date(T0)
  return {
    id: "wf", workflowType: "order", workflowVersion: 1, executionScope: { kind: "tenant", tenantId: "t1" },
    status: refStart.status, currentStep: refStart.step, variables: refStart.vars, stepAttempt: refStart.attempt, compensationStack: refStart.stack,
    waitingSignal: refStart.signal, resumeSignalId: refStart.resume, wakeAt: refStart.wakeAt === null ? null : new Date(refStart.wakeAt), outcome: refStart.outcome, revision: refStart.revision,
    failure: null, leaseOwner: null, claimToken: null, leaseExpiresAt: null, createdAt: at, updatedAt: at,
  }
}

function toFailure(failure: RefFailure): WorkflowFailure {
  return createWorkflowFailure({ code: failure.code, message: failure.message ?? "failure", step: failure.step, phase: failure.phase, attempt: failure.attempt, at: new Date(failure.at) })
}

/** What the store does when it claims an instance (core only sees the result). */
function storeClaim(instance: WorkflowInstance, leaseMs: number, now: number): WorkflowInstance {
  return { ...instance, status: instance.status === "waiting" ? "pending" : instance.status, leaseOwner: "w", claimToken: `t${instance.revision}`, leaseExpiresAt: new Date(now + leaseMs), stepAttempt: instance.stepAttempt + 1, revision: instance.revision + 1 }
}

function claimable(model: RefInstance, now: number): boolean {
  if (model.leased) return false
  if (model.status === "pending") return true
  if (model.status === "compensating") return model.wakeAt === null || model.wakeAt <= now
  if (model.status === "waiting") return model.wakeAt !== null && model.wakeAt <= now
  return false
}

function run(prod: WorkflowInstance, event: RefEvent, now: number): WorkflowInstance {
  const at = new Date(now)
  switch (event.t) {
    case "claim": return storeClaim(prod, event.leaseMs, now)
    case "step": return applyWorkflowStep(prod, toRefResult(event.result), at)
    case "retryAt": return scheduleWorkflowRetry(prod, new Date(event.wakeAt === "invalid" ? Number.NaN : event.wakeAt), at)
    case "failStep": return failWorkflowStep(prod, toFailure(event.failure), at)
    case "failComp": return failCompensation(prod, toFailure(event.failure), at)
    case "stall": return markWorkflowAttemptStalled(prod, toFailure(event.failure), new Date(event.wakeAt === "invalid" ? Number.NaN : event.wakeAt), at)
    case "signal": return deliverWorkflowSignal(prod, { id: event.id, instanceId: "wf", name: event.name, payload: {}, deliveredAt: at }, at)
    case "buffered": return resumeWorkflowFromBufferedSignal(prod, { id: event.id, instanceId: "wf", name: prod.waitingSignal ?? "go", payload: {}, deliveredAt: at }, at)
    case "release": return releaseWorkflowClaim(prod, at)
    case "cancel": return cancelWorkflow(prod, at)
    case "completeComp": return completeCompensation(prod, at)
  }
}

function project(instance: WorkflowInstance): RefInstance {
  const failure = instance.failure ?? null
  const leased = instance.leaseOwner !== null
  expect([instance.claimToken !== null, instance.leaseExpiresAt !== null], "lease fields are all-or-nothing").toEqual([leased, leased])
  return {
    status: instance.status as RefStatus, step: instance.currentStep, vars: { ...instance.variables }, attempt: instance.stepAttempt, stack: [...instance.compensationStack],
    signal: instance.waitingSignal, resume: instance.resumeSignalId ?? null, wakeAt: instance.wakeAt === null ? null : instance.wakeAt.getTime(), outcome: instance.outcome, revision: instance.revision,
    failure: failure === null ? null : { code: failure.code, step: failure.step, phase: failure.phase, attempt: failure.attempt, at: failure.at.getTime(), message: failure.message },
    leased,
  }
}

function expectedMessage(raw: string): string { return Array.from(raw).slice(0, MAX_WORKFLOW_FAILURE_MESSAGE_LENGTH).join("") }

function expectSame(actual: RefInstance, expected: RefInstance, label: string): void {
  const { failure: actualFailure, ...actualRest } = actual
  const { failure: expectedFailure, ...expectedRest } = expected
  expect(actualRest, label).toEqual(expectedRest)
  if (expectedFailure === null) { expect(actualFailure, `${label}: failure`).toBeNull(); return }
  expect(actualFailure, `${label}: failure`).not.toBeNull()
  const { message, ...actualFields } = actualFailure!
  const { message: expectedText, ...expectedFields } = expectedFailure
  expect(actualFields, `${label}: failure fields`).toEqual(expectedFields)
  if (expectedText !== undefined) expect(message, `${label}: failure message`).toBe(expectedMessage(expectedText))
}

const FRESH = (start: MachineCase["start"]): RefInstance => ({ status: "pending", step: start.step, vars: {}, attempt: 0, stack: [...start.stack], signal: null, resume: null, wakeAt: null, outcome: null, revision: 0, failure: null, leased: false })

function unwrap(outcome: ReturnType<typeof refApply>): RefInstance {
  if ("err" in outcome) throw new Error("unexpected rejection")
  return outcome.ok
}

describe("workflow state machine — differential against the reference transition table", () => {
  it("every event on every reachable status matches the reference (state, failure record, error type)", () => {
    forAll("workflow state machine table", generateCase, (value) => {
      let model = FRESH(value.start)
      let prod = produce(model)
      let now = T0
      value.events.forEach((raw, index) => {
        now += raw.dt
        const event = resolve(raw, model.vars, now)
        if (event.t === "claim" && !claimable(model, now)) return
        const label = `event #${index} ${raw.t} on ${model.status}`
        const expected = refApply(model, event, now)
        const before = JSON.stringify(prod)
        let actual: WorkflowInstance | undefined
        let thrown: unknown
        try { actual = run(prod, event, now) } catch (error) { thrown = error }
        expect(JSON.stringify(prod), `${label}: input must not be mutated`).toBe(before)
        if ("err" in expected) {
          expect(thrown, `${label}: expected a ${expected.err} rejection, got ${actual ? `status ${actual.status}` : "a different error"}`).toBeDefined()
          const type = expected.err === "state" ? WorkflowStateError : WorkflowDefinitionError
          expect(thrown, `${label}: rejection type`).toBeInstanceOf(type)
          return
        }
        if (thrown !== undefined) throw new Error(`${label}: unexpected rejection ${String(thrown instanceof Error ? thrown.message : thrown)}`)
        expectSame(project(actual!), expected.ok, label)
        model = expected.ok
        prod = actual!
      })
    }, { runs: 400, shrink: shrinkMachineCase, describe: describeCase })
  })

  it("invariants: terminal states are sticky, revisions advance by exactly one, outcomes match status, stack only grows by next and shrinks by completeCompensation", () => {
    forAll("workflow state machine invariants", generateCase, (value) => {
      let model = FRESH(value.start)
      let prod = produce(model)
      let now = T0
      for (const raw of value.events) {
        now += raw.dt
        const event = resolve(raw, model.vars, now)
        if (event.t === "claim" && !claimable(model, now)) continue
        const before = project(prod)
        let next: WorkflowInstance | undefined
        try { next = run(prod, event, now) } catch (error) {
          expect(error, "illegal transitions are rejected with a typed error").toSatisfy((e: unknown) => e instanceof WorkflowStateError || e instanceof WorkflowDefinitionError)
          continue
        }
        const after = project(next)
        if (isTerminalStatus(before.status)) {
          // Terminal states are sticky: only a (no-op) cancel returns, and it returns the very same instance.
          expect(event.t, "only cancel may succeed on a terminal instance").toBe("cancel")
          expect(next).toBe(prod)
          continue
        }
        if (event.t === "cancel" && before.status === "compensating") { expect(next).toBe(prod); continue }
        // A buffered-signal resume is part of the commit that parked the instance: it does not advance the revision again.
        expect(after.revision, `${event.t}: revision`).toBe(before.revision + (event.t === "buffered" ? 0 : 1))
        // resumeSignalId: set by consuming a receipt, cleared by forward/failure/cancel transitions, otherwise untouched.
        if (event.t === "signal" || event.t === "buffered") expect(after.resume, `${event.t}: names the consumed receipt`).toBe(event.id)
        else if ((event.t === "step" && event.result.kind !== "retry") || event.t === "failStep" || event.t === "failComp" || event.t === "cancel") expect(after.resume, `${event.t}: clears the resume receipt`).toBeNull()
        else expect(after.resume, `${event.t}: keeps the resume receipt`).toBe(before.resume)
        expect(after.leased, `${event.t}: lease`).toBe(event.t === "claim")
        expect(after.outcome !== null, "outcome is set exactly when the status is terminal").toBe(isTerminalStatus(after.status))
        const expectedOutcome = { succeeded: "succeeded", failed: "failed", cancelled: "cancelled", compensation_failed: "failed" } as const
        if (isTerminalStatus(after.status)) expect(after.outcome).toBe(expectedOutcome[after.status as keyof typeof expectedOutcome])
        if (event.t === "step" && event.result.kind === "next" && event.result.compensation) expect(after.stack).toEqual([...before.stack, event.result.compensation])
        else if (event.t === "completeComp") expect(after.stack).toEqual(before.stack.slice(0, -1))
        else expect(after.stack, `${event.t}: compensation stack untouched`).toEqual(before.stack)
        if (event.t !== "claim" && event.t !== "release") expect(after.attempt, `${event.t}: attempt never grows outside a claim`).toBeLessThanOrEqual(before.attempt)
        expect(isWorkflowTerminal(next)).toBe(isTerminalStatus(after.status))
        model = unwrap(refApply(model, event, now))
        prod = next
      }
    }, { runs: 300, shrink: shrinkMachineCase, describe: describeCase })
  })

  it("is deterministic and never mutates or aliases its input", () => {
    forAll("workflow state machine determinism", generateCase, (value) => {
      let model = FRESH(value.start)
      let prod = produce(model)
      let now = T0
      for (const raw of value.events) {
        now += raw.dt
        const event = resolve(raw, model.vars, now)
        if (event.t === "claim" && !claimable(model, now)) continue
        const outcome = (): string => {
          try { return JSON.stringify(run(prod, event, now)) } catch (error) { return `throws ${(error as Error).constructor.name}` }
        }
        const first = outcome()
        expect(outcome(), `${event.t}: same input, same output`).toBe(first)
        const expected = refApply(model, event, now)
        if ("err" in expected) continue
        model = expected.ok
        prod = run(prod, event, now)
      }
    }, { runs: 150, shrink: shrinkMachineCase, describe: describeCase })
  })
})

describe("workflow state machine — failure records and stall detection", () => {
  interface FailureCase { code: unknown; message: unknown; step: string; attempt: number; phase: "execute" | "compensate" }
  const PII = ["bob@example.com", "2026-03-04", "+1 555 123 4567", "4111 1111 1111 1111"] as const

  it("failure messages are bounded, redacted, never split a code point, and codes fall back to STEP_ERROR", () => {
    forAll("workflow failure record", (rng): FailureCase & { prefix: string; pii: string; suffix: number } => ({
      code: rng.pick(["STEP_FAILED", "RETRY_EXHAUSTED", "lower", "", "A".repeat(65), "A".repeat(64), "X-1.2:3", 42, undefined, null]),
      message: rng.pick(["plain", "stack\n    at x (file.js:1:1)"]),
      step: rng.pick(STEPS), attempt: rng.pick([0, 1, 7, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]), phase: rng.pick(["execute", "compensate"] as const),
      prefix: rng.pick(["ok ", "😀", "é", ""]).repeat(rng.int(400)), pii: rng.pick(PII), suffix: rng.int(600),
    }), (value) => {
      const text = `${value.prefix} ${value.pii} ${"z".repeat(value.suffix)}`
      const failure = createWorkflowFailure({ code: value.code as string, message: text, step: value.step, phase: value.phase, attempt: value.attempt, at: new Date(T0) })
      const valid = typeof value.code === "string" && /^[A-Z][A-Z0-9_.:-]{0,63}$/.test(value.code)
      expect(failure.code).toBe(valid ? value.code : "STEP_ERROR")
      expect(Array.from(failure.message).length).toBeLessThanOrEqual(MAX_WORKFLOW_FAILURE_MESSAGE_LENGTH)
      for (const secret of PII) expect(failure.message, "contact details and dates are redacted").not.toContain(secret)
      expect(failure.message, "no lone surrogate halves").not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
      expect(failure.attempt).toBe(Number.isSafeInteger(value.attempt) && value.attempt >= 0 ? value.attempt : 0)
      expect(failure.at.getTime()).toBe(T0)
      expect(Object.isFrozen(failure)).toBe(true)
      const fromError = createWorkflowFailure({ code: "STEP_FAILED", message: new Error("with stack"), step: value.step, phase: value.phase, attempt: 1, at: new Date(T0) })
      expect(fromError.message).toBe("with stack")
      expect(createWorkflowFailure({ code: "STEP_FAILED", message: { not: "a string" }, step: value.step, phase: value.phase, attempt: 1, at: new Date(T0) }).message).toBe("Workflow step failed")
    }, { runs: 300 })
  })

  it("isStalledWorkflowAttempt matches its definition for every failure/attempt combination", () => {
    forAll("workflow stalled attempt predicate", (rng) => ({
      status: rng.pick(["pending", "waiting", "compensating", "running"] as const), step: rng.pick(STEPS), attempt: rng.int(5),
      failure: rng.bool(0.8) ? { code: rng.pick(["TIMEOUT", "STEP_FAILED"]), step: rng.pick(STEPS), phase: rng.pick(["execute", "compensate"] as const), attempt: rng.int(5) } : null,
    }), (value) => {
      const base = produce({ ...FRESH({ step: value.step, stack: [] }), status: value.status, attempt: value.attempt })
      const instance: WorkflowInstance = { ...base, failure: value.failure === null ? null : createWorkflowFailure({ ...value.failure, message: "m", at: new Date(T0) }) }
      const expected = value.failure !== null && value.status !== "compensating" && value.failure.code === "TIMEOUT" && value.failure.phase === "execute" &&
        value.failure.step === value.step && value.failure.attempt >= 1 && value.failure.attempt < value.attempt
      expect(isStalledWorkflowAttempt(instance)).toBe(expected)
    }, { runs: 300 })
  })

  it("durable variable size limit is exact at the byte boundary and counts UTF-8 bytes", () => {
    forAll("workflow durable size boundary", (rng) => ({ delta: rng.pick([-2, -1, 0, 1, 2]), multibyte: rng.bool(), kind: rng.pick(["next", "wait", "sleep", "complete"] as const) }), (value) => {
      const spec: VarSpec = { big: 0, multibyte: value.multibyte }
      const target = resolveVars(spec, {})!.big as string
      const text = value.delta < 0 ? target.slice(0, target.length + value.delta) : `${target}${"a".repeat(value.delta)}`
      const variables = { big: text }
      const instance = produce(FRESH({ step: "a", stack: [] }))
      const result: WorkflowStepResult = value.kind === "next" ? { kind: "next", step: "b", variables } : value.kind === "wait" ? { kind: "wait", signal: "go", variables } : value.kind === "sleep" ? { kind: "sleep", wakeAt: new Date(T0 + 5), variables } : { kind: "complete", variables }
      const total = refDurableBytes(variables)
      if (total > REF_MAX_DURABLE_BYTES) expect(() => applyWorkflowStep(instance, result, new Date(T0))).toThrow(WorkflowDefinitionError)
      else expect(applyWorkflowStep(instance, result, new Date(T0)).variables).toEqual(variables)
    }, { runs: 100 })
  })
})

describe("workflow state machine — step result well-formedness", () => {
  type Field = { present: boolean; value: unknown }
  const pickField = (rng: Rng, good: unknown, bad: readonly unknown[]): Field => (rng.bool(0.6) ? { present: true, value: good } : rng.bool(0.15) ? { present: false, value: undefined } : { present: true, value: rng.pick(bad) })
  const build = (kind: string, fields: Record<string, Field>): WorkflowStepResult => ({ kind, ...Object.fromEntries(Object.entries(fields).filter(([, field]) => field.present).map(([key, field]) => [key, field.value])) }) as unknown as WorkflowStepResult

  it("accepts exactly the well-formed results (valid step/signal names, valid Dates, object variables) and rejects the rest with WorkflowStateError", () => {
    forAll("workflow step result shape", (rng) => {
      const kind = rng.pick(["next", "wait", "sleep", "complete", "retry", "fail"] as const)
      const fields: Record<string, Field> = {
        step: pickField(rng, "b", ["", 5, null, {}]), signal: pickField(rng, "go", ["", 5, null, {}]),
        wakeAt: pickField(rng, new Date(T0 + 5), [new Date(Number.NaN), 5, "2026-01-01", null]),
        compensation: rng.bool(0.5) ? { present: false, value: undefined } : pickField(rng, "undo", ["", 5, null]),
        variables: rng.bool(0.4) ? { present: false, value: undefined } : pickField(rng, { k1: 1 }, [[1], "x", 5, true]),
      }
      return { kind, fields: JSON.stringify(Object.entries(fields)), build: () => build(kind, Object.fromEntries(Object.entries(fields).filter(([key]) => ({ next: ["step", "compensation", "variables"], wait: ["signal", "variables"], sleep: ["wakeAt", "variables"], complete: ["variables"], retry: [], fail: [] }[kind] as string[]).includes(key)))) }
    }, ({ kind, build: make }) => {
      const result = make() as unknown as Record<string, unknown>
      const valid = (field: string, check: (value: unknown) => boolean): boolean => !(field in result) || check(result[field])
      const text = (x: unknown): boolean => typeof x === "string" && x.length > 0
      const wellFormed = valid("variables", (x) => x === null || (typeof x === "object" && !Array.isArray(x))) &&
        (kind !== "next" || (("step" in result) && text(result.step) && valid("compensation", (x) => x === null || x === "" || text(x)))) &&
        (kind !== "wait" || (("signal" in result) && text(result.signal))) &&
        (kind !== "sleep" || (result.wakeAt instanceof Date && !Number.isNaN(result.wakeAt.getTime())))
      const instance = produce(FRESH({ step: "a", stack: [] }))
      if (wellFormed) expect(() => applyWorkflowStep(instance, result as unknown as WorkflowStepResult, new Date(T0))).not.toThrow()
      else expect(() => applyWorkflowStep(instance, result as unknown as WorkflowStepResult, new Date(T0))).toThrow(WorkflowStateError)
    }, { runs: 300 })
  })
})
