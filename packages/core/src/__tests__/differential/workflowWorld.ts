/**
 * Scripted workflow "worlds" for the dispatcher differentials: step behaviours
 * are data, so the production dispatcher and the reference model consume the
 * very same script and their invocation logs can be compared exactly.
 */
import type { Rng } from "./harness"
import type { ManualClock } from "./workflowFixtures"
import type { MemoryWorkflowStore } from "./workflowFixtures"
import { defineWorkflow } from "../../workflow/workflowDefinition"
import { createWorkflowRegistry, type WorkflowRegistry } from "../../workflow/workflowRegistry"
import { WorkflowLeaseLostError } from "../../workflow/workflowErrors"
import type { WorkflowStepContext, WorkflowStepDefinition, WorkflowStepResult } from "../../workflow/types"
import type { RefPolicy } from "./workflowModel"

export const STEP_NAMES = ["a", "b", "c", "d"] as const
export const SIGNAL_NAMES = ["go", "stop"] as const
export const COMPENSATIONS = ["a", "b", "c", "d"] as const
/** Deadline used by every world; the model's timeline is derived from it. */
export const STEP_TIMEOUT_MS = 50
export const LEASE_MS = 1000

export type ThrowKind = "plain" | "coded" | "codedBad" | "retryable" | "kindRetryable" | "retryableCoded" | "string" | "null" | "undefined" | "number" | "object" | "leaseLost"
export type Vars = Record<string, string | number | boolean>

export type Behavior =
  | { k: "next"; to: string; comp?: string; vars?: Vars }
  | { k: "wait"; sig: string; vars?: Vars }
  | { k: "sleep"; delay: number; vars?: Vars }
  | { k: "complete"; vars?: Vars }
  | { k: "retry" }
  | { k: "fail" }
  | { k: "junk" }
  | { k: "malformed" }
  | { k: "throw"; err: ThrowKind }
  | { k: "coopAbort" }
  | { k: "coopResolve" }
  | { k: "stall" }
  | { k: "slow"; ms: number; then: Behavior }
  | { k: "cancelSelf" }
  | { k: "signalSelf"; name: string; then: Behavior }
  /** Blocks until the test releases it (interleaving scenarios only; the reference model never sees it). */
  | { k: "gate"; then: Behavior }

export interface StepSpec {
  retry: RefPolicy | undefined
  compensationRetry: RefPolicy | undefined
  idempotent: boolean | undefined
  hasCompensate: boolean
  exec: Behavior[]
  comp: Behavior[]
}

export interface WorldSpec {
  graceMs: number
  /** Lease and step deadline, in fake milliseconds (defaults: LEASE_MS, STEP_TIMEOUT_MS). */
  leaseMs?: number
  timeoutMs?: number
  steps: Record<string, StepSpec>
  /** When set, a version 2 definition is registered (with a 1->2 upcaster) lacking these steps / compensations. */
  v2: { missing: string[]; noCompensate: string[] } | null
}

export interface InvocationRecord { id: string; step: string; phase: "execute" | "compensate"; defVersion: number; attempt: number; signalId: string | null; vars: string }

export interface World {
  readonly registry: WorkflowRegistry
  readonly log: InvocationRecord[]
  readonly counters: Map<string, number>
  /** Awaited by `gate` behaviours. */
  gate?: (record: InvocationRecord, context: WorkflowStepContext) => Promise<void>
}

export function stableJson(value: Readonly<Record<string, unknown>>): string { return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))) }

export function behaviorAt(script: readonly Behavior[], index: number): Behavior { return script[Math.min(index, script.length - 1)]! }

function thrown(kind: ThrowKind): unknown {
  switch (kind) {
    case "plain": return new Error("plain boom")
    case "coded": return Object.assign(new Error("service down"), { code: "E_DOWN" })
    case "codedBad": return Object.assign(new Error("odd code"), { code: "lower" })
    case "retryable": return Object.assign(new Error("try later"), { retryable: true })
    case "kindRetryable": return Object.assign(new Error("kind later"), { kind: "retryable" })
    case "retryableCoded": return Object.assign(new Error("busy"), { retryable: true, code: "E_BUSY" })
    case "string": return "oops"
    case "null": return null
    case "undefined": return undefined
    case "number": return 42
    case "object": return { retryable: true }
    case "leaseLost": return new WorkflowLeaseLostError()
  }
}

/** Runs one scripted behaviour inside a step. */
async function perform(behavior: Behavior, context: WorkflowStepContext, clock: ManualClock, store: MemoryWorkflowStore, record: InvocationRecord, world: World): Promise<WorkflowStepResult | void> {
  const varsOf = (vars: Vars | undefined): { variables?: Vars } => (vars === undefined ? {} : { variables: vars })
  switch (behavior.k) {
    case "next": return { kind: "next", step: behavior.to, ...(behavior.comp !== undefined ? { compensation: behavior.comp } : {}), ...varsOf(behavior.vars) }
    case "wait": return { kind: "wait", signal: behavior.sig, ...varsOf(behavior.vars) }
    case "sleep": return { kind: "sleep", wakeAt: new Date(clock.current + behavior.delay), ...varsOf(behavior.vars) }
    case "complete": return { kind: "complete", ...varsOf(behavior.vars) }
    case "retry": return { kind: "retry", error: "again" }
    case "fail": return { kind: "fail", error: "boom" }
    case "junk": return { kind: "bogus" } as unknown as WorkflowStepResult
    case "malformed": return { kind: "sleep" } as unknown as WorkflowStepResult
    case "throw": throw thrown(behavior.err)
    case "coopAbort": return await new Promise<never>((_resolve, reject) => { context.executionSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }) })
    case "coopResolve": return await new Promise<WorkflowStepResult>((resolve) => { context.executionSignal.addEventListener("abort", () => resolve({ kind: "complete" }), { once: true }) })
    case "stall": return await new Promise<never>(() => undefined)
    case "slow":
      await new Promise<void>((resolve) => { clock.setTimeout(resolve, behavior.ms) })
      return await perform(behavior.then, context, clock, store, record, world)
    case "cancelSelf":
      await store.cancel(context.instanceId)
      return { kind: "complete" }
    case "gate":
      await world.gate?.(record, context)
      return await perform(behavior.then, context, clock, store, record, world)
    case "signalSelf":
      await store.deliverSignal({ id: `self-${context.instanceId}-${context.attempt}-${behavior.name}`, instanceId: context.instanceId, name: behavior.name, payload: {} })
      return await perform(behavior.then, context, clock, store, record, world)
  }
}

export function buildWorld(spec: WorldSpec, clock: ManualClock, store: MemoryWorkflowStore): World {
  const log: InvocationRecord[] = []
  const counters = new Map<string, number>()
  const world: World = { registry: createWorkflowRegistry(spec.v2 ? [{ type: "order", from: 1, to: 2, upcast: (value) => ({ ...(value as Record<string, unknown>), upgraded: true }) }] : []), log, counters }
  const definitionFor = (version: 1 | 2) => {
    const steps: Record<string, WorkflowStepDefinition> = {}
    for (const name of STEP_NAMES) {
      const config = spec.steps[name]!
      if (version === 2 && spec.v2!.missing.includes(name)) continue
      const compensable = config.hasCompensate && !(version === 2 && spec.v2!.noCompensate.includes(name))
      const invoke = async (phase: "execute" | "compensate", context: WorkflowStepContext): Promise<WorkflowStepResult | void> => {
        const key = `${context.instanceId}/${name}/${phase}`
        const index = counters.get(key) ?? 0
        counters.set(key, index + 1)
        const record: InvocationRecord = { id: context.instanceId, step: name, phase, defVersion: version, attempt: context.attempt, signalId: context.signal?.id ?? null, vars: stableJson(context.variables) }
        log.push(record)
        return await perform(behaviorAt(phase === "execute" ? config.exec : config.comp, index), context, clock, store, record, world)
      }
      steps[name] = {
        name, datasource: "primary",
        ...(config.retry !== undefined ? { retry: config.retry } : {}),
        ...(config.compensationRetry !== undefined ? { compensationRetry: config.compensationRetry } : {}),
        ...(config.idempotent !== undefined ? { idempotent: config.idempotent } : {}),
        execute: async (context) => (await invoke("execute", context)) as WorkflowStepResult,
        ...(compensable ? { compensate: async (context: WorkflowStepContext) => { await invoke("compensate", context) } } : {}),
      }
    }
    return defineWorkflow({
      type: "order", version, initialStep: "a", steps,
      decodeVariables: (value) => {
        const record = value as Record<string, unknown>
        if (version === 2 && record.poison === true) throw new Error("poisoned variables")
        return record
      },
    })
  }
  world.registry.register(definitionFor(1))
  if (spec.v2) world.registry.register(definitionFor(2))
  return world
}

// ---------------------------------------------------------------------------
// Generators

function generatePolicy(rng: Rng): RefPolicy | undefined {
  if (rng.bool(0.3)) return undefined
  const initialDelayMs = rng.pick([0, 10, 100, 250])
  return { maxAttempts: rng.pick([1, 1, 2, 3, 4]), initialDelayMs, backoffMultiplier: rng.pick([1, 1.5, 2, 3]), maxDelayMs: initialDelayMs + rng.pick([0, 50, 400, 2000]), jitter: rng.pick(["none", "equal"] as const) }
}

function generateVars(rng: Rng): Vars | undefined {
  if (rng.bool(0.6)) return undefined
  const vars: Vars = {}
  for (const key of rng.subset(["k1", "k2", "poison"], 0.5)) vars[key] = key === "poison" ? rng.bool(0.5) : rng.int(3)
  return vars
}

function generateLeaf(rng: Rng, kinds: "exec" | "comp", coop: boolean, quiet = false): Behavior {
  const throws: ThrowKind[] = ["plain", "coded", "codedBad", "retryable", "kindRetryable", "retryableCoded", "string", "null", "undefined", "number", "object", "leaseLost"]
  const roll = rng.int(100)
  if (kinds === "comp") {
    if (roll < 55) return { k: "complete" }
    if (roll < 80) return { k: "throw", err: rng.pick(throws.filter((kind) => kind !== "leaseLost")) }
    if (roll < 86) return coop ? { k: "coopAbort" } : { k: "stall" }
    if (roll < 92 || quiet) return { k: "stall" }
    return { k: "cancelSelf" }
  }
  if (roll < 22) return { k: "next", to: rng.pick([...STEP_NAMES, "zz", "constructor", "toString", "__proto__"]), ...(rng.bool(0.5) ? { comp: rng.pick(COMPENSATIONS) } : {}), ...optional(generateVars(rng)) }
  if (roll < 29) return { k: "wait", sig: rng.pick(SIGNAL_NAMES), ...optional(generateVars(rng)) }
  if (roll < 35) return { k: "sleep", delay: rng.pick([0, 30, 500, 3000]), ...optional(generateVars(rng)) }
  if (roll < 44) return { k: "complete", ...optional(generateVars(rng)) }
  if (roll < 54) return { k: "retry" }
  if (roll < 60) return { k: "fail" }
  if (roll < 63) return { k: "junk" }
  if (roll < 66) return { k: "malformed" }
  if (roll < 80) return { k: "throw", err: rng.pick(throws) }
  if (roll < 86) return coop ? { k: rng.pick(["coopAbort", "coopResolve"] as const) } : { k: "stall" }
  if (roll < 90) return { k: "stall" }
  if (roll < 94 && !quiet) return { k: "cancelSelf" }
  if (roll < 98) return { k: "throw", err: "leaseLost" }
  return { k: "complete" }
}

const optional = (vars: Vars | undefined): { vars?: Vars } => (vars === undefined ? {} : { vars })

function generateBehavior(rng: Rng, kinds: "exec" | "comp", coop: boolean, quietWorld = false): Behavior {
  const roll = rng.int(100)
  if (quietWorld) {
    const leaf = generateLeaf(rng, kinds, false)
    return leaf.k === "stall" ? { k: "throw", err: "retryable" } : leaf
  }
  if (roll < 8) {
    const ms = coop ? rng.pick([10, 49, 60, 100]) : rng.pick([10, 49, 100])
    return { k: "slow", ms, then: generateLeaf(rng, kinds, false, true) }
  }
  if (roll < 12 && kinds === "exec") return { k: "signalSelf", name: rng.pick(SIGNAL_NAMES), then: generateLeaf(rng, kinds, false) }
  return generateLeaf(rng, kinds, coop)
}

export function generateWorld(rng: Rng, options: { quiet?: boolean } = {}): WorldSpec {
  const graceMs = rng.pick([20, 20, 0])
  const coop = graceMs > 0
  const steps: Record<string, StepSpec> = {}
  for (const name of STEP_NAMES) {
    steps[name] = {
      retry: generatePolicy(rng), compensationRetry: generatePolicy(rng), idempotent: rng.pick([undefined, true, false]), hasCompensate: rng.bool(0.8),
      exec: Array.from({ length: 1 + rng.int(4) }, () => generateBehavior(rng, "exec", coop, options.quiet)),
      comp: Array.from({ length: 1 + rng.int(3) }, () => generateBehavior(rng, "comp", coop, options.quiet)),
    }
  }
  if (rng.bool(0.4)) {
    // A saga: a -> b -> c, each registering its compensation, then a failing last step (so compensation actually runs).
    steps.a!.exec[0] = { k: "next", to: "b", comp: "a" }
    steps.b!.exec[0] = { k: "next", to: "c", comp: "b" }
    steps.c!.exec[0] = rng.pick([{ k: "fail" }, { k: "throw", err: "plain" }, { k: "junk" }] as Behavior[])
    for (const name of ["a", "b"]) { steps[name]!.hasCompensate = true; steps[name]!.comp[0] = rng.bool(0.8) ? { k: "complete" } : steps[name]!.comp[0]! }
  }
  return { graceMs, steps, v2: rng.bool(0.4) ? { missing: rng.subset(STEP_NAMES, 0.15).filter((name) => name !== "a"), noCompensate: rng.subset(STEP_NAMES, 0.2) } : null }
}

/**
 * A signal-heavy world: most behaviours wait for, or self-deliver, one of two signal names, so receipts are buffered, consumed in
 * order across successive waits, and left pending for names nobody awaits. The reference model consumes the same script.
 */
export function generateSignalWorld(rng: Rng): WorldSpec {
  const names = [...SIGNAL_NAMES, "go"] as const
  const exec = (): Behavior[] => Array.from({ length: 2 + rng.int(4) }, (): Behavior => {
    const roll = rng.int(100)
    if (roll < 42) return { k: "wait", sig: rng.pick(names), ...optional(generateVars(rng)) }
    if (roll < 54) return { k: "signalSelf", name: rng.pick(names), then: rng.bool(0.7) ? { k: "wait", sig: rng.pick(names) } : { k: "complete" } }
    if (roll < 66) return { k: "next", to: rng.pick(STEP_NAMES), ...(rng.bool(0.4) ? { comp: rng.pick(COMPENSATIONS) } : {}) }
    if (roll < 76) return { k: "complete" }
    if (roll < 82) return { k: "throw", err: "retryable" }
    if (roll < 87) return { k: "retry" }
    if (roll < 92) return { k: "sleep", delay: rng.pick([0, 30, 500]) }
    if (roll < 95) return { k: "fail" }
    if (roll < 97) return { k: "cancelSelf" }
    return { k: "slow", ms: rng.pick([10, 49]), then: { k: "wait", sig: rng.pick(names) } }
  })
  const steps: Record<string, StepSpec> = {}
  for (const name of STEP_NAMES) {
    steps[name] = {
      retry: { maxAttempts: rng.pick([2, 3, 4]), initialDelayMs: rng.pick([0, 10, 100]), backoffMultiplier: 2, maxDelayMs: 400, jitter: "none" },
      compensationRetry: undefined, idempotent: rng.pick([undefined, true]), hasCompensate: true, exec: exec(), comp: [{ k: "complete" }],
    }
  }
  return { graceMs: 20, steps, v2: null }
}
