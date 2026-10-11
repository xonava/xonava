import { describe, expect, it, vi } from "vitest"
import { forAll, scaledRuns, type Rng } from "./harness"
import { createWorkflowRegistry } from "../../workflow/workflowRegistry"
import { defineWorkflow } from "../../workflow/workflowDefinition"
import { WorkflowDefinitionError, WorkflowVersionError } from "../../workflow/workflowErrors"
import type { WorkflowDefinition, WorkflowUpcaster } from "../../workflow/types"

// Property runs scale with DIFFERENTIAL_SCALE; so does the time they may take.
vi.setConfig({ testTimeout: 60_000 * Math.max(1, scaledRuns(100) / 100) })

/**
 * Definition validation and version decoding (docs/spec/workflow.md: "Version
 * migration MUST be deterministic and reject unsupported state versions")
 * against a table-driven reference.
 */

// ---------------------------------------------------------------------------
// defineWorkflow

type Wild = string | number | boolean | null | undefined | object

interface StepDraft { key: string; name: Wild; datasource: Wild; execute: "fn" | Wild; compensate: "fn" | undefined | Wild; idempotent: Wild; retry: Wild }
interface DefinitionDraft { type: Wild; version: Wild; initialStep: Wild; steps: StepDraft[] }

const GOOD_POLICY = { maxAttempts: 3, initialDelayMs: 10, backoffMultiplier: 2, maxDelayMs: 100, jitter: "none" }
const BAD_POLICIES: Wild[] = [{ ...GOOD_POLICY, maxAttempts: 0 }, { ...GOOD_POLICY, maxAttempts: 101 }, { ...GOOD_POLICY, maxDelayMs: 1 }, { ...GOOD_POLICY, backoffMultiplier: 0.5 }, { ...GOOD_POLICY, jitter: "full" }, null, [], "x", { ...GOOD_POLICY, initialDelayMs: -1 }]

function generateStep(rng: Rng, key: string): StepDraft {
  const flaw = rng.bool(0.25)
  return {
    key,
    name: flaw && rng.bool(0.2) ? "other" : key,
    datasource: flaw && rng.bool(0.3) ? rng.pick(["", "  ", 5, undefined, null]) : rng.pick(["primary", "billing"]),
    execute: flaw && rng.bool(0.25) ? rng.pick([undefined, "not a function", 5, null]) : "fn",
    compensate: flaw && rng.bool(0.25) ? rng.pick(["nope", 5, null, undefined]) : rng.pick(["fn", undefined]),
    idempotent: flaw && rng.bool(0.25) ? rng.pick(["yes", 1, null]) : rng.pick([true, false, undefined]),
    retry: flaw && rng.bool(0.25) ? rng.pick(BAD_POLICIES) : rng.pick([undefined, GOOD_POLICY]),
  }
}

function generateDraft(rng: Rng): DefinitionDraft {
  const keys = rng.subset(["a", "b", "c", "constructor", "toString"], 0.6)
  if (keys.length === 0) keys.push("a")
  const flaw = rng.bool(0.4)
  return {
    type: flaw && rng.bool(0.25) ? rng.pick(["", "   ", 5, undefined, null]) : rng.pick(["order", "invoice"]),
    version: flaw && rng.bool(0.3) ? rng.pick([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, "1", undefined, null]) : rng.pick([1, 2, 7, Number.MAX_SAFE_INTEGER]),
    initialStep: flaw && rng.bool(0.3) ? rng.pick(["missing", "constructor", "toString", "__proto__", "hasOwnProperty", 5, undefined]) : rng.pick(keys),
    steps: keys.map((key) => generateStep(rng, key)),
  }
}

const noop = async (): Promise<{ kind: "complete" }> => ({ kind: "complete" })

function materialize(draft: DefinitionDraft): WorkflowDefinition {
  const steps: Record<string, unknown> = {}
  for (const step of draft.steps) {
    steps[step.key] = {
      name: step.name, datasource: step.datasource, execute: step.execute === "fn" ? noop : step.execute,
      ...(step.compensate === undefined ? {} : { compensate: step.compensate === "fn" ? noop : step.compensate }),
      ...(step.idempotent === undefined ? {} : { idempotent: step.idempotent }), ...(step.retry === undefined ? {} : { retry: step.retry }),
    }
  }
  return { type: draft.type, version: draft.version, initialStep: draft.initialStep, steps, decodeVariables: (value: unknown) => value as Record<string, unknown> } as unknown as WorkflowDefinition
}

function policyIsValid(policy: unknown): boolean {
  if (policy === undefined) return true
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return false
  const p = policy as Record<string, unknown>
  const int = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x)
  return int(p.maxAttempts) && p.maxAttempts >= 1 && p.maxAttempts <= 100 && int(p.initialDelayMs) && p.initialDelayMs >= 0 && p.initialDelayMs <= 604_800_000 &&
    int(p.maxDelayMs) && p.maxDelayMs >= p.initialDelayMs && p.maxDelayMs <= 604_800_000 && typeof p.backoffMultiplier === "number" && Number.isFinite(p.backoffMultiplier) &&
    p.backoffMultiplier >= 1 && p.backoffMultiplier <= 10 && (p.jitter === "none" || p.jitter === "equal")
}

/** The documented validity rules, in the order the spec lists them. */
function draftIsValid(draft: DefinitionDraft): boolean {
  if (typeof draft.type !== "string" || draft.type.trim() === "") return false
  if (typeof draft.version !== "number" || !Number.isSafeInteger(draft.version) || draft.version < 1) return false
  if (typeof draft.initialStep !== "string" || !draft.steps.some((step) => step.key === draft.initialStep)) return false
  return draft.steps.every((step) => {
    if (step.key !== step.name) return false
    if (typeof step.datasource !== "string" || step.datasource.trim() === "") return false
    if (step.execute !== "fn") return false
    if (step.compensate !== undefined && step.compensate !== "fn") return false
    if (step.idempotent !== undefined && typeof step.idempotent !== "boolean") return false
    return policyIsValid(step.retry)
  })
}

describe("workflow definition — validation differential", () => {
  it("defineWorkflow accepts exactly the valid definitions and rejects every other with WorkflowDefinitionError", () => {
    forAll("workflow defineWorkflow validity", generateDraft, (draft) => {
      const valid = draftIsValid(draft)
      let thrown: unknown
      let defined: WorkflowDefinition | undefined
      try { defined = defineWorkflow(materialize(draft)) } catch (error) { thrown = error }
      if (valid) {
        expect(thrown, `valid definition rejected: ${String(thrown)}`).toBeUndefined()
        expect(Object.isFrozen(defined), "a defined workflow is frozen").toBe(true)
        expect(Object.isFrozen(defined!.steps)).toBe(true)
        expect(Object.keys(defined!.steps).sort()).toEqual(draft.steps.map((step) => step.key).sort())
      } else {
        expect(thrown, "invalid definition accepted").toBeDefined()
        expect(thrown, `rejected with the wrong error: ${String(thrown)}`).toBeInstanceOf(WorkflowDefinitionError)
      }
    }, { runs: 400, describe: (draft) => JSON.stringify(draft, (_key, value: unknown) => (typeof value === "number" && !Number.isFinite(value) ? String(value) : value)) })
  })

  it("a defined workflow is isolated from later mutation of its source", () => {
    forAll("workflow definition isolation", (rng) => ({ keys: rng.subset(["a", "b", "c"], 0.7).concat(["a"]).filter((key, index, all) => all.indexOf(key) === index) }), ({ keys }) => {
      const source = {
        type: "order", version: 1, initialStep: keys[0]!, decodeVariables: (value: unknown) => value as Record<string, unknown>,
        steps: Object.fromEntries(keys.map((key) => [key, { name: key, datasource: "primary", execute: noop }])),
      } as unknown as { steps: Record<string, { datasource: string }> } & WorkflowDefinition
      const defined = defineWorkflow(source)
      source.steps[keys[0]!]!.datasource = "tampered"
      ;(source.steps as Record<string, unknown>).injected = { name: "injected", datasource: "x", execute: noop }
      expect(defined.steps[keys[0]!]!.datasource).toBe("primary")
      expect(Object.keys(defined.steps)).toEqual(keys)
      expect(() => { (defined.steps as Record<string, unknown>).late = {} }).toThrow()
    }, { runs: 60 })
  })
})

// ---------------------------------------------------------------------------
// Registry decode

interface DecodeCase {
  registered: Array<{ type: string; version: number }>
  upcasters: Array<{ type: string; from: number; to: number }>
  query: { type: string; version: number; target: number | undefined }
}

function generateDecode(rng: Rng): DecodeCase {
  const types = ["t", "u"]
  const registered: DecodeCase["registered"] = []
  for (const type of types) for (const version of rng.subset([1, 2, 3, 4, 5], 0.5)) registered.push({ type, version })
  const upcasters: DecodeCase["upcasters"] = []
  for (const type of types) for (let from = 0; from <= 5; from++) if (rng.bool(0.6)) upcasters.push({ type, from, to: rng.bool(0.9) ? from + 1 : from + 2 })
  return {
    registered, upcasters,
    query: {
      type: rng.pick(["t", "u", "ghost"]), version: rng.pick([0, 1, 2, 3, 4, 5, 6, -1, 1.5, Number.NaN]),
      target: rng.pick([undefined, undefined, 1, 2, 3, 4, 5, 6, Number.NaN]),
    },
  }
}

function referenceDecode(value: DecodeCase): { ok: true; target: number; trail: string[] } | { ok: false; error: "version" } {
  const versions = value.registered.filter((entry) => entry.type === value.query.type).map((entry) => entry.version)
  const target = value.query.target ?? (versions.length === 0 ? Number.NaN : Math.max(...versions))
  if (Number.isNaN(target)) return { ok: false, error: "version" }
  const trail: string[] = []
  let current = value.query.version
  while (current < target) {
    if (!value.upcasters.some((upcaster) => upcaster.type === value.query.type && upcaster.from === current && upcaster.to === current + 1)) return { ok: false, error: "version" }
    trail.push(`${current}>${current + 1}`)
    current += 1
  }
  if (current !== target || !value.registered.some((entry) => entry.type === value.query.type && entry.version === target)) return { ok: false, error: "version" }
  return { ok: true, target, trail }
}

describe("workflow registry — decode differential", () => {
  it("upcasts one version at a time, rejects missing upcasters, downcasts and unknown definitions with WorkflowVersionError", () => {
    forAll("workflow registry decode", generateDecode, (value) => {
      const upcasters: WorkflowUpcaster[] = value.upcasters.map((entry) => ({
        type: entry.type, from: entry.from, to: entry.to, upcast: (input) => ({ ...(input as { trail: string[] }), trail: [...(input as { trail: string[] }).trail, `${entry.from}>${entry.to}`] }),
      }))
      const registry = createWorkflowRegistry(upcasters)
      for (const entry of value.registered) {
        registry.register(defineWorkflow({
          type: entry.type, version: entry.version, initialStep: "s", steps: { s: { name: "s", datasource: "primary", execute: noop } },
          decodeVariables: (input) => ({ ...(input as Record<string, unknown>), decodedAs: entry.version }),
        }))
      }
      const expected = referenceDecode(value)
      const run = () => registry.decode(value.query.type, value.query.version, { trail: [] }, value.query.target)
      if (!expected.ok) {
        expect(run).toThrow(WorkflowVersionError)
        return
      }
      const decoded = run()
      expect(decoded.definition.version).toBe(expected.target)
      expect(decoded.variables).toEqual({ trail: expected.trail, decodedAs: expected.target })
      expect(run(), "decoding is deterministic").toEqual(decoded)
    }, { runs: 400 })
  })

  it("registering the same type and version twice is rejected and leaves the first definition intact", () => {
    forAll("workflow registry duplicates", (rng) => ({ version: rng.pick([1, 2, 3]), others: rng.subset([1, 2, 3], 0.5) }), ({ version, others }) => {
      const registry = createWorkflowRegistry()
      const make = (v: number, marker: string) => defineWorkflow({ type: "t", version: v, initialStep: "s", steps: { s: { name: "s", datasource: marker, execute: noop } }, decodeVariables: (input) => input as Record<string, unknown> })
      registry.register(make(version, "first"))
      for (const other of others.filter((o) => o !== version)) registry.register(make(other, "other"))
      expect(() => registry.register(make(version, "second"))).toThrow(WorkflowDefinitionError)
      expect(registry.get("t", version)!.steps.s!.datasource).toBe("first")
      expect(registry.get("u", version)).toBeUndefined()
    }, { runs: 60 })
  })
})
