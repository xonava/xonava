import { describe, expect, it } from "vitest"
import { forAll, type Rng } from "./harness"
import { JobDefinitionUnavailableError, createJobRegistry } from "../../execution/jobRegistry"
import type { JobDefinition } from "../../execution/types"

/** Job registry against a plain Map/array model: registration, lookup, validation and the upcast chain. */

const MAX_TIMER = 2_147_483_647

function definition(type: string, version: number, extra: Partial<JobDefinition> = {}): JobDefinition {
  return {
    type, version, scope: "system", maxAttempts: 3, retryDelayMs: 0, retryBackoffMultiplier: 1,
    decodePayload: (input) => ({ ...(input as Record<string, unknown>), decodedBy: version }), execute: async () => ({ success: true }), ...extra,
  }
}

interface ChainCase {
  versions: number[]
  upcasters: Array<{ type: string; from: number; to: number }>
  stored: number
  target: number | undefined
  rejectVersion: number | undefined
  throwingUpcaster: number | undefined
}

function generateChain(rng: Rng): ChainCase {
  const versions = rng.subset([1, 2, 3, 4, 5], 0.6)
  const upcasters: ChainCase["upcasters"] = []
  for (let from = 0; from <= 5; from++) {
    if (rng.bool(0.7)) upcasters.push({ type: "t", from, to: from + 1 })
    if (rng.bool(0.1)) upcasters.push({ type: "other", from, to: from + 1 })
    if (rng.bool(0.05)) upcasters.push({ type: "t", from, to: from + 2 })
    if (rng.bool(0.05)) upcasters.push({ type: "t", from, to: from + 1 })
  }
  return {
    versions, upcasters, stored: rng.int(7), target: rng.bool(0.4) ? undefined : rng.int(7),
    rejectVersion: rng.bool(0.2) ? rng.pick([1, 2, 3, 4, 5]) : undefined, throwingUpcaster: rng.bool(0.1) ? rng.int(6) : undefined,
  }
}

function* shrinkChain(value: ChainCase): Generator<ChainCase> {
  for (let index = 0; index < value.upcasters.length; index++) yield { ...value, upcasters: value.upcasters.filter((_, position) => position !== index) }
  for (const version of value.versions) yield { ...value, versions: value.versions.filter((candidate) => candidate !== version) }
  if (value.rejectVersion !== undefined) yield { ...value, rejectVersion: undefined }
  if (value.throwingUpcaster !== undefined) yield { ...value, throwingUpcaster: undefined }
}

describe("job registry properties", () => {
  it("decodes along the first matching upcaster chain and reports every gap as an unavailable definition", () => {
    forAll("job registry: decode follows the upcast chain exactly", generateChain, (c) => {
      const registry = createJobRegistry({
        upcasters: c.upcasters.map((step) => ({
          type: step.type, from: step.from, to: step.to,
          upcast: (payload: unknown) => {
            if (c.throwingUpcaster === step.from) throw new RangeError(`upcaster ${step.from} exploded`)
            return { ...(payload as { steps?: string[] }), steps: [...((payload as { steps?: string[] }).steps ?? []), `${step.from}>${step.to}`] }
          },
        })),
      })
      for (const version of c.versions) {
        registry.register(definition("t", version, c.rejectVersion === version ? { decodePayload: () => { throw new SyntaxError("schema rejects payload") } } : {}))
        registry.register(definition("other", version))
      }

      // Reference: walk the chain with the *first* adjacent upcaster of the type, as documented by the registry contract.
      const target = c.target ?? (c.versions.length === 0 ? undefined : Math.max(...c.versions))
      let expected: { kind: "ok"; steps: string[]; decodedBy: number } | { kind: "unavailable" } | { kind: "error"; name: string }
      if (target === undefined) expected = { kind: "unavailable" }
      else {
        const steps: string[] = []
        let current = c.stored
        let failure: typeof expected | undefined
        while (current < target) {
          const step = c.upcasters.find((candidate) => candidate.type === "t" && candidate.from === current && candidate.to === current + 1)
          if (!step) { failure = { kind: "unavailable" }; break }
          if (c.throwingUpcaster === step.from) { failure = { kind: "error", name: "RangeError" }; break }
          steps.push(`${step.from}>${step.to}`)
          current++
        }
        if (failure) expected = failure
        else if (current !== target) expected = { kind: "unavailable" }
        else if (!c.versions.includes(target)) expected = { kind: "unavailable" }
        else if (c.rejectVersion === target) expected = { kind: "error", name: "SyntaxError" }
        else expected = { kind: "ok", steps, decodedBy: target }
      }

      let actual: unknown
      let thrown: unknown
      try { actual = registry.decode("t", c.stored, {}, c.target) } catch (error) { thrown = error }
      if (expected.kind === "ok") {
        expect(thrown, String(thrown)).toBeUndefined()
        const decoded = actual as { definition: JobDefinition; payload: { steps?: string[]; decodedBy: number } }
        expect(decoded.definition.version).toBe(expected.decodedBy)
        expect(decoded.payload.decodedBy).toBe(expected.decodedBy)
        expect(decoded.payload.steps ?? []).toEqual(expected.steps)
      } else if (expected.kind === "unavailable") {
        expect(thrown, `expected unavailable, got ${String(thrown)}`).toBeInstanceOf(JobDefinitionUnavailableError)
      } else {
        expect(thrown).toBeInstanceOf(Error)
        expect(thrown).not.toBeInstanceOf(JobDefinitionUnavailableError)
        expect((thrown as Error).name).toBe(expected.name)
      }
    }, { runs: 300, shrink: shrinkChain, describe: (value) => JSON.stringify(value) })
  })

  it("registers, looks up and lists definitions like a map keyed by (type, version)", () => {
    const TYPES = ["a", "a@1", "a@1@2", "", "é", "t ", "t"]
    interface Op { type: string; version: number }
    forAll("job registry: register/get/has/list match a map model", (rng) => Array.from({ length: 1 + rng.int(12) }, (): Op => ({ type: rng.pick(TYPES), version: rng.pick([1, 2, 12, 1e21, 0, -1, 1.5, Number.NaN]) })), (ops) => {
      const registry = createJobRegistry({ now: () => new Date(0) })
      const model = new Map<string, JobDefinition>()
      const order: string[] = []
      for (const op of ops) {
        const key = JSON.stringify([op.type, op.version])
        const valid = op.type.trim().length > 0 && Number.isInteger(op.version) && op.version >= 1
        const duplicate = model.has(key)
        const candidate = definition(op.type, op.version)
        if (!valid || duplicate) { expect(() => registry.register(candidate), key).toThrow() } else {
          registry.register(candidate)
          model.set(key, candidate)
          order.push(key)
        }
        for (const probe of ops) {
          const probeKey = JSON.stringify([probe.type, probe.version])
          expect(registry.has(probe.type, probe.version), `has ${probeKey}`).toBe(model.has(probeKey))
          expect(registry.get(probe.type, probe.version)?.version, `get ${probeKey}`).toBe(model.get(probeKey)?.version)
        }
      }
      expect(registry.list().map((entry) => JSON.stringify([entry.definition.type, entry.definition.version]))).toEqual(order)
    }, { runs: 200 })
  })

  it("validates definitions field by field", () => {
    const bad: Array<Partial<JobDefinition>> = [
      { type: "" }, { type: "  " }, { version: 0 }, { version: -1 }, { version: 1.5 }, { version: Number.NaN }, { maxAttempts: 0 }, { maxAttempts: 2.5 }, { maxAttempts: Number.POSITIVE_INFINITY },
      { retryDelayMs: -1 }, { retryDelayMs: Number.NaN }, { retryDelayMs: Number.POSITIVE_INFINITY }, { retryBackoffMultiplier: 0 }, { retryBackoffMultiplier: -1 },
      { retryBackoffMultiplier: Number.NaN }, { retryBackoffMultiplier: Number.POSITIVE_INFINITY }, { timeoutMs: 0 }, { timeoutMs: -5 }, { timeoutMs: Number.NaN },
      { timeoutMs: Number.POSITIVE_INFINITY }, { timeoutMs: MAX_TIMER + 1 }, { decodePayload: undefined as never }, { execute: undefined as never },
    ]
    const good: Array<Partial<JobDefinition>> = [{}, { timeoutMs: 1 }, { timeoutMs: MAX_TIMER }, { retryDelayMs: 0 }, { retryDelayMs: 1e12 }, { retryBackoffMultiplier: 1e-9 }, { retryBackoffMultiplier: 1e9 }, { maxAttempts: 1 }, { maxAttempts: Number.MAX_SAFE_INTEGER }, { version: Number.MAX_SAFE_INTEGER }]
    forAll("job registry: definition validation", (rng) => ({ overrides: rng.bool(0.6) ? rng.pick(bad) : rng.pick(good), isBad: false }), ({ overrides }) => {
      const isBad = bad.includes(overrides)
      const registry = createJobRegistry()
      if (isBad) expect(() => registry.register(definition("v", 1, overrides))).toThrow()
      else {
        registry.register(definition("v", 1, overrides))
        expect(Object.isFrozen(registry.get("v", 1))).toBe(true)
      }
    }, { runs: 150 })
  })
})
