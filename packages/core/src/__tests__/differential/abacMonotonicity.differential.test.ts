import { describe, expect, it, vi } from "vitest"
import { forAllAsync, type Rng } from "./harness"
import { ABAC_PROPERTY_TIMEOUT_MS,
  ABAC_ACTIONS, ABAC_CAPABILITIES, ABAC_PRIORITIES, FIELD_KEYS, POLICY_CASE_OPTIONS, bindPolicies, generatePolicies, generatePolicy, generateRows,
  makePolicy, shrinkPolicy, shrinkPolicyCase, type PolicyOptions,
} from "./abacArbitraries"
import { PROBED_CAPABILITIES, RESTRICTIVENESS, effectiveReadMode, generateWriteCases, observeBundle, type BundleObservation, type WriteCase } from "./abacOracle"
import type { NormalizedAbacPolicy } from "../../domain/abacTypes"

/**
 * Monotonicity: adding a deny never grants anything new, and adding an
 * unconditional allow strictly below every existing tier never takes anything
 * away. Conditional allows at higher tiers are deliberately NOT asserted
 * monotone: an UNKNOWN allow claims its tier by design.
 */

vi.setConfig({ testTimeout: ABAC_PROPERTY_TIMEOUT_MS })

interface MonotoneCase {
  policies: NormalizedAbacPolicy[]
  rows: Array<Record<string, unknown>>
  added: NormalizedAbacPolicy
  writes: WriteCase[]
}

/** `smaller` grants no more than `larger`, observation by observation. */
function expectNoLooser(smaller: BundleObservation, larger: BundleObservation, label: string): void {
  for (const action of ABAC_ACTIONS) {
    smaller.actions[action]!.forEach((decision, row) => {
      if (decision.allowed) expect(larger.actions[action]![row]!.allowed, `${label}: ${action} decision, row ${row}`).toBe(true)
    })
    smaller.scopes[action]!.forEach((inScope, row) => {
      if (inScope) expect(larger.scopes[action]![row], `${label}: ${action} scope, row ${row}`).toBe(true)
    })
    smaller.collection[action]!.rows.forEach((inScope, row) => {
      if (inScope) expect(larger.collection[action]!.rows[row], `${label}: ${action} collection scope, row ${row}`).toBe(true)
    })
  }
  for (const capability of PROBED_CAPABILITIES) {
    if (smaller.globalCapabilities[capability]) expect(larger.globalCapabilities[capability], `${label}: global ${capability}`).toBe(true)
    smaller.recordCapabilities[capability]!.forEach((allowed, row) => {
      if (allowed) expect(larger.recordCapabilities[capability]![row], `${label}: record ${capability}, row ${row}`).toBe(true)
    })
  }
  smaller.writes.forEach((outcome, index) => {
    if (outcome === "ok") expect(larger.writes[index], `${label}: write #${index}`).toBe("ok")
  })
}

/** Field visibility/queryability of `smaller` is no wider than `larger`'s. */
function expectFieldsNoLooser(smaller: BundleObservation, larger: BundleObservation, label: string): void {
  smaller.readPlans.forEach((plan, row) => {
    for (const field of FIELD_KEYS) {
      const narrow = effectiveReadMode(plan, field)
      const wide = effectiveReadMode(larger.readPlans[row]!, field)
      expect(RESTRICTIVENESS[narrow], `${label}: read ${field}, row ${row} (${narrow} vs ${wide})`).toBeGreaterThanOrEqual(RESTRICTIVENESS[wide])
    }
  })
  for (const mode of ["filter", "search", "sort"] as const) {
    for (const field of larger.queryDenials[mode]) expect(smaller.queryDenials[mode], `${label}: ${mode} denial of ${field}`).toContain(field)
  }
}

function* shrinkMonotoneCase(value: MonotoneCase): Generator<MonotoneCase> {
  yield* shrinkPolicyCase(value)
  for (const added of shrinkPolicy(value.added)) yield { ...value, added }
  if (value.writes.length > 1) for (const write of value.writes) yield { ...value, writes: [write] }
  for (let index = 0; index < value.writes.length; index++) yield { ...value, writes: value.writes.filter((_, position) => position !== index) }
}

const monotoneOptions = { ...POLICY_CASE_OPTIONS, shrink: shrinkMonotoneCase }

function generateDenyCase(options: PolicyOptions & { min?: number; max?: number }, addedOptions: PolicyOptions = {}) {
  return (rng: Rng): MonotoneCase => {
    const policies = generatePolicies(rng, options)
    const rows = generateRows(rng, 8)
    return { policies, rows, added: generatePolicy(rng, "added-deny", { ...options, ...addedOptions, effect: "deny" }), writes: generateWriteCases(rng, rows) }
  }
}

const DENY_SCENARIOS: Array<{ name: string; options: PolicyOptions & { min?: number; max?: number }; added?: PolicyOptions }> = [
  { name: "random deny", options: {} },
  { name: "conditional deny into tied tiers", options: { unconditionalRate: 0.2, min: 2 }, added: { unconditionalRate: 0 } },
  { name: "deny with field access", options: { fieldAccessRate: 0.7 }, added: { fieldAccessRate: 1 } },
  { name: "deny at the top tier", options: {}, added: { priority: Math.max(...ABAC_PRIORITIES) } },
]

describe("ABAC differential: deny monotonicity", () => {
  for (const scenario of DENY_SCENARIOS) {
    it(`adding a deny never grants anything new (${scenario.name})`, async () => {
      await forAllAsync(`abac deny monotone ${scenario.name}`, generateDenyCase(scenario.options, scenario.added), async ({ policies, rows, added, writes }) => {
        const before = observeBundle(await bindPolicies(policies), rows, writes)
        const after = observeBundle(await bindPolicies([...policies, added]), rows, writes)
        expectNoLooser(after, before, "deny added")
        expectFieldsNoLooser(after, before, "deny added")
      }, { runs: 250, ...monotoneOptions })
    })
  }
})

function lowestAllow(rng: Rng, policies: readonly NormalizedAbacPolicy[], withFieldAccess: boolean): NormalizedAbacPolicy {
  const template = generatePolicy(rng, "added-allow", { effect: "allow", unconditionalRate: 1, fieldAccessRate: withFieldAccess ? 1 : 0 })
  const floor = Math.min(0, ...policies.map((policy) => policy.priority)) - 1
  return makePolicy({
    id: "added-allow",
    effect: "allow",
    priority: floor,
    actions: rng.bool(0.3) ? [...ABAC_ACTIONS] : template.payload.actions,
    capabilities: rng.bool(0.3) ? [...ABAC_CAPABILITIES] : template.payload.capabilities,
    ...(template.payload.fieldAccess ? { fieldAccess: template.payload.fieldAccess } : {}),
  })
}

describe("ABAC differential: a lowest-tier unconditional allow never removes access", () => {
  it("keeps every decision, scope row, capability, write, read plan and query grant", async () => {
    await forAllAsync("abac lowest allow monotone", (rng): MonotoneCase => {
      const policies = generatePolicies(rng)
      const rows = generateRows(rng, 8)
      return { policies, rows, added: lowestAllow(rng, policies, false), writes: generateWriteCases(rng, rows) }
    }, async ({ policies, rows, added, writes }) => {
      const floor = Math.min(...policies.map((policy) => policy.priority))
      if (added.priority >= floor || !(added.compiledConditions.kind === "and" && added.compiledConditions.filters.length === 0)) return
      const before = observeBundle(await bindPolicies(policies), rows, writes)
      const after = observeBundle(await bindPolicies([...policies, added]), rows, writes)
      expectNoLooser(before, after, "lowest allow added")
      expectFieldsNoLooser(before, after, "lowest allow added")
    }, { runs: 300, ...monotoneOptions })
  })

  it("keeps every decision, scope row, capability and write even when the allow carries field access", async () => {
    // Field visibility is NOT asserted here: an allow's read map is an
    // allowlist (resolveFieldReadOverrides) and any declared read restriction
    // is conservatively query-denied (collectDeniedQueryFields), regardless of
    // which tier decided the row. Adding such a policy narrows fields by design.
    await forAllAsync("abac lowest allow with field access monotone", (rng): MonotoneCase => {
      const policies = generatePolicies(rng)
      const rows = generateRows(rng, 8)
      return { policies, rows, added: lowestAllow(rng, policies, true), writes: generateWriteCases(rng, rows) }
    }, async ({ policies, rows, added, writes }) => {
      const floor = Math.min(...policies.map((policy) => policy.priority))
      if (added.priority >= floor || !(added.compiledConditions.kind === "and" && added.compiledConditions.filters.length === 0)) return
      const before = observeBundle(await bindPolicies(policies), rows, writes)
      const after = observeBundle(await bindPolicies([...policies, added]), rows, writes)
      expectNoLooser(before, after, "lowest allow (field access) added")
    }, { runs: 300, ...monotoneOptions })
  })
})
