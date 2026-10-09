import { describe, expect, it, vi } from "vitest"
import { forAllAsync } from "./harness"
import { ABAC_PROPERTY_TIMEOUT_MS,
  ABAC_ACTIONS, ABAC_CAPABILITIES, FOREIGN_MODULE, POLICY_CASE_OPTIONS, bindPolicies, generatePolicies, generatePolicy, generateRows,
  type PolicyOptions,
} from "./abacArbitraries"
import {
  PROBED_CAPABILITIES, actionPolicies, capabilityScope, generateWriteCases, observeBundle, referenceRecordDecision, referenceTier,
  type WriteCase,
} from "./abacOracle"
import { DIFFERENTIAL_FIELDS, generatePredicate } from "./arbitraries"
import { DEFAULT_QUERY_BUDGET, validateQueryPlan } from "../../query/queryBudget"
import { markTrustedPredicate } from "../../domain/trustedPredicate"
import { Predicate, type PredicateNode } from "../../domain/predicate"
import { createAbacAuthorizer } from "../../domain/abacAuthorizer"
import { evaluateAbacActionForCollection, evaluateAbacRecordAction, evaluateAbacRecordCapability } from "../../domain/abacDecision"
import { buildActionScope } from "../../domain/abacReadScope"
import { resolveGrantedGlobalCapabilities } from "../../domain/abacCapabilities"
import { evaluatePredicate, evaluatePredicateTruth } from "../../domain/evaluatePredicate"
import { assertFrameworkAuthorization } from "../../domain/frameworkAuthorization"
import { simplifyPredicate } from "../../domain/predicateSimplifier"
import type { NormalizedAbacPolicy } from "../../domain/abacTypes"

/**
 * Differential/property suite for ABAC record, collection, capability and
 * ordering semantics. Every property runs over thousands of generated policy
 * bundles (scaled by DIFFERENTIAL_SCALE); failures print a replayable seed and
 * a shrunk counterexample.
 */

vi.setConfig({ testTimeout: ABAC_PROPERTY_TIMEOUT_MS })

interface PolicyCase {
  policies: NormalizedAbacPolicy[]
  rows: Array<Record<string, unknown>>
}

type OrderCase = PolicyCase & { writes: WriteCase[]; order: number[] }
type ForeignCase = PolicyCase & { writes: WriteCase[]; foreign: NormalizedAbacPolicy[] }

const SCENARIOS: Array<{ name: string; options: PolicyOptions & { min?: number; max?: number } }> = [
  { name: "mixed bundles", options: {} },
  { name: "conditional-only bundles with heavy ties", options: { unconditionalRate: 0, min: 2, max: 7 } },
  { name: "two-field bundles (UNKNOWN-heavy)", options: { fields: DIFFERENTIAL_FIELDS.filter((field) => field.key === "ownerId" || field.key === "amount"), unconditionalRate: 0.25, min: 1, max: 5 } },
  { name: "deny-heavy bundles", options: { unconditionalRate: 0.6, min: 2, max: 6 } },
]

function generateCase(options: PolicyOptions & { min?: number; max?: number }) {
  return (rng: Parameters<typeof generatePolicies>[0]): PolicyCase => ({ policies: generatePolicies(rng, options), rows: generateRows(rng, 10) })
}


function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

describe("ABAC differential: record decision ≡ query scope", () => {
  for (const scenario of SCENARIOS) {
    it(`agrees for every action and row (${scenario.name})`, async () => {
      await forAllAsync(`abac record≡scope ${scenario.name}`, generateCase(scenario.options), async ({ policies, rows }) => {
        const bundle = await bindPolicies(policies)
        const authorizer = createAbacAuthorizer(bundle)
        for (const action of ABAC_ACTIONS) {
          const scope = buildActionScope({ bundle, action }).filter
          expect(authorizer.buildActionScope(action).filter).toEqual(scope)
          for (const row of rows) {
            const decision = evaluateAbacRecordAction({ bundle, action, record: row })
            const inScope = evaluatePredicate(row, scope)
            const reference = referenceRecordDecision(bundle, action, row)
            const context = `${action} on ${JSON.stringify(row)}`
            expect(decision.allowed, `decision vs scope: ${context}`).toBe(inScope)
            expect(decision.allowed, `decision vs reference: ${context}`).toBe(reference.allowed)
            expect(decision.priority, `deciding tier: ${context}`).toBe(reference.priority)
            expect(authorizer.canRecordAction(action, row)).toBe(decision.allowed)
            expect(throws(() => authorizer.assertRecordAction(action, row))).toBe(!decision.allowed)
            // The decision is internally coherent: reason and evidence follow the outcome.
            expect(decision.reasonCode === "ALLOW_POLICY_MATCHED").toBe(decision.allowed)
            if (decision.reasonCode === "DENY_POLICY_MATCHED") expect(decision.evidence[0]?.effect).toBe("deny")
            if (decision.allowed) expect(decision.evidence.every((item) => item.effect === "allow")).toBe(true)
          }
        }
      }, { runs: 250, ...POLICY_CASE_OPTIONS })
    })

    it(`record capabilities agree with the tiered capability scope (${scenario.name})`, async () => {
      await forAllAsync(`abac capability≡scope ${scenario.name}`, generateCase(scenario.options), async ({ policies, rows }) => {
        const bundle = await bindPolicies(policies)
        const authorizer = createAbacAuthorizer(bundle)
        for (const capability of PROBED_CAPABILITIES) {
          const scope = capabilityScope(bundle, capability)
          for (const row of rows) {
            const allowed = evaluateAbacRecordCapability({ bundle, capability, record: row }).allowed
            const reference = referenceTier(bundle.policies.filter((policy) => policy.payload.capabilities.includes(capability)), (policy) => evaluatePredicateTruth(row, policy.compiledConditions))
            expect(allowed, `${capability} vs scope on ${JSON.stringify(row)}`).toBe(evaluatePredicate(row, scope))
            expect(allowed, `${capability} vs reference on ${JSON.stringify(row)}`).toBe(reference.allowed)
            expect(authorizer.canRecordCapability(capability, row)).toBe(allowed)
            expect(throws(() => authorizer.assertRecordCapability(capability, row))).toBe(!allowed)
          }
        }
      }, { runs: 200, ...POLICY_CASE_OPTIONS })
    })
  }
})

describe("ABAC differential: collection decision vs per-row decisions", () => {
  for (const scenario of SCENARIOS) {
    it(`never rejects a collection containing a permitted row, and its scope is the action scope (${scenario.name})`, async () => {
      await forAllAsync(`abac collection ${scenario.name}`, generateCase(scenario.options), async ({ policies, rows }) => {
        const bundle = await bindPolicies(policies)
        const authorizer = createAbacAuthorizer(bundle)
        for (const action of ABAC_ACTIONS) {
          const collection = evaluateAbacActionForCollection({ bundle, action })
          const rawScope = buildActionScope({ bundle, action }).filter
          const hasAllow = actionPolicies(bundle, action).some((policy) => policy.effect === "allow")
          if (!hasAllow) expect(collection.allowed).toBe(false)
          if (collection.reasonCode === "NO_ALLOW_POLICY") expect(hasAllow).toBe(false)
          for (const row of rows) {
            const allowed = evaluateAbacRecordAction({ bundle, action, record: row }).allowed
            // The simplified scope handed to persistence is three-valued-equivalent to the raw scope.
            expect(evaluatePredicateTruth(row, collection.scope), `simplified scope on ${JSON.stringify(row)}`).toBe(evaluatePredicateTruth(row, rawScope))
            expect(evaluatePredicateTruth(row, simplifyPredicate(rawScope))).toBe(evaluatePredicateTruth(row, rawScope))
            if (allowed) expect(collection.allowed, `${action} row ${JSON.stringify(row)} is allowed but the collection is ${collection.reasonCode}`).toBe(true)
            if (collection.allowed) expect(evaluatePredicate(row, collection.scope)).toBe(allowed)
          }
          expect(throws(() => authorizer.assertCollectionAction(action))).toBe(!collection.allowed)
          expect(authorizer.authorizeCollection(action)).toEqual(collection)
          const framework = () => assertFrameworkAuthorization({
            facts: { scope: "application", ownerAuthority: false, impersonated: false },
            moduleKey: bundle.moduleKey, action, bundle,
          })
          expect(throws(framework), `framework ${action}`).toBe(!collection.allowed)
        }
      }, { runs: 200, ...POLICY_CASE_OPTIONS })
    })
  }
})

describe("ABAC differential: global grants are never looser than record grants", () => {
  for (const scenario of SCENARIOS) {
    it(`a granted global capability holds for every row (${scenario.name})`, async () => {
      await forAllAsync(`abac global⇒record ${scenario.name}`, generateCase(scenario.options), async ({ policies, rows }) => {
        const bundle = await bindPolicies(policies)
        const authorizer = createAbacAuthorizer(bundle)
        const granted = resolveGrantedGlobalCapabilities({ bundle })
        for (const capability of PROBED_CAPABILITIES) {
          const global = authorizer.canGlobalCapability(capability)
          expect(granted.has(capability), `resolveGrantedGlobalCapabilities(${capability})`).toBe(global)
          expect(throws(() => authorizer.assertGlobalCapability(capability))).toBe(!global)
          const framework = () => assertFrameworkAuthorization({
            facts: { scope: "application", ownerAuthority: false, impersonated: false },
            moduleKey: bundle.moduleKey, action: "read", capabilityKey: capability, bundle, evaluateAbacAction: false,
          })
          expect(throws(framework), `framework capability ${capability}`).toBe(!global)
          if (!global) continue
          for (const row of rows) {
            expect(authorizer.canRecordCapability(capability, row), `global ${capability} granted but denied for ${JSON.stringify(row)}`).toBe(true)
          }
        }
        for (const capability of granted) expect(PROBED_CAPABILITIES).toContain(capability)
      }, { runs: 300, ...POLICY_CASE_OPTIONS })
    })
  }
})

describe("ABAC differential: policy order independence", () => {
  for (const scenario of SCENARIOS) {
    it(`shuffling and re-binding never changes any outcome (${scenario.name})`, async () => {
      await forAllAsync<OrderCase>(`abac order independence ${scenario.name}`, (rng) => {
        const base = generateCase(scenario.options)(rng)
        return { ...base, writes: generateWriteCases(rng, base.rows), order: rng.shuffle(base.policies.map((_, index) => index)) }
      }, async ({ policies, rows, writes, order }) => {
        const shuffledPolicies = order.filter((index) => index < policies.length).map((index) => policies[index]!)
        const reversed = [...policies].reverse()
        const original = observeBundle(await bindPolicies(policies), rows, writes)
        expect(observeBundle(await bindPolicies(shuffledPolicies), rows, writes)).toEqual(original)
        expect(observeBundle(await bindPolicies(reversed), rows, writes)).toEqual(original)
      }, { runs: 150, ...POLICY_CASE_OPTIONS })
    })
  }
})

describe("ABAC differential: other modules' policies are inert", () => {
  it("adding policies for another module changes nothing", async () => {
    await forAllAsync<ForeignCase>("abac foreign module inert", (rng) => {
      const base = generateCase({})(rng)
      const foreign = Array.from({ length: 1 + rng.int(3) }, (_, index) => generatePolicy(rng, `f${index}`, { foreignRate: 1 }))
      return { ...base, foreign, writes: generateWriteCases(rng, base.rows) }
    }, async ({ policies, rows, foreign, writes }) => {
      expect(foreign.every((policy) => policy.moduleKey === FOREIGN_MODULE)).toBe(true)
      const before = observeBundle(await bindPolicies(policies), rows, writes)
      const after = observeBundle(await bindPolicies([...foreign, ...policies]), rows, writes)
      expect(after).toEqual(before)
    }, { runs: 150, ...POLICY_CASE_OPTIONS })
  })
})

describe("ABAC differential: capability keys only come from policies", () => {
  it("never grants a capability no policy names", async () => {
    await forAllAsync("abac unnamed capability", generateCase({}), async ({ policies, rows }) => {
      const bundle = await bindPolicies(policies)
      const named = new Set(policies.flatMap((policy) => policy.payload.capabilities))
      for (const capability of [...ABAC_CAPABILITIES, "neverGranted"]) {
        if (named.has(capability)) continue
        expect(createAbacAuthorizer(bundle).canGlobalCapability(capability)).toBe(false)
        for (const row of rows) expect(evaluateAbacRecordCapability({ bundle, capability, record: row }).allowed).toBe(false)
      }
    }, { runs: 100, ...POLICY_CASE_OPTIONS })
  })
})

/** Every `date` field written as its UTC-midnight Date instead of a "YYYY-MM-DD" string. */
function asDateHydrated(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row }
  for (const field of DIFFERENTIAL_FIELDS) {
    const value = out[field.key]
    if (field.type === "date" && typeof value === "string") out[field.key] = new Date(`${value}T00:00:00.000Z`)
  }
  return out
}

describe("ABAC differential: date-field hydration", () => {
  it("decides identically whether a date field is hydrated as \"YYYY-MM-DD\" or as the UTC-midnight Date", async () => {
    // Drizzle PG date() and SQLite text dates hydrate strings; other drivers
    // hydrate Dates. Normalized date literals must match both (regression: an
    // instant literal "…T00:00:00.000Z" never equals a string-hydrated date).
    const dateHeavy = { fields: DIFFERENTIAL_FIELDS.filter((field) => field.key === "dueOn" || field.key === "ownerId"), unconditionalRate: 0.2, min: 1 }
    await forAllAsync("abac date hydration", generateCase(dateHeavy), async ({ policies, rows }) => {
      const bundle = await bindPolicies(policies)
      const asStrings = observeBundle(bundle, rows, rows.map((row): WriteCase => ({ action: "create", record: row })))
      const dated = rows.map(asDateHydrated)
      const asDates = observeBundle(bundle, dated, dated.map((row): WriteCase => ({ action: "create", record: row })))
      expect(asDates).toEqual(asStrings)
    }, { runs: 300, ...POLICY_CASE_OPTIONS })
  })
})

/** A caller filter at the default budget's limits: maximum depth, node count and OR branches. */
function maxBudgetCallerFilter(): PredicateNode {
  const { maxPredicateDepth, maxPredicateNodes, maxOrBranches } = DEFAULT_QUERY_BUDGET
  let chain: PredicateNode = Predicate.eq("name", "a")
  for (let depth = 2; depth < maxPredicateDepth; depth++) chain = Predicate.and(chain, Predicate.isNotNull("code"))
  // root and + chain (2 nodes per level, 1 leaf) + an OR of leaves, filling the node budget.
  const used = 1 + (2 * (maxPredicateDepth - 2) + 1) + 1
  const leaves = Math.min(maxOrBranches, maxPredicateNodes - used)
  return Predicate.and(chain, Predicate.or(...Array.from({ length: leaves }, (_, index) => Predicate.eq("rank", index))))
}

describe("ABAC differential: trusted scopes never consume the caller's query budget", () => {
  it("accepts every generated scope conjoined with a max-budget caller filter on the repository path", async () => {
    const caller = maxBudgetCallerFilter()
    expect(() => validateQueryPlan({ filter: caller })).not.toThrow()
    expect(() => validateQueryPlan({ filter: Predicate.not(caller) })).toThrow()
    await forAllAsync<PolicyCase & { random: PredicateNode }>("abac scope query budget", (rng) => ({
      ...generateCase({ unconditionalRate: 0.2, min: 1, max: 8 })(rng),
      random: generatePredicate(rng, { maxDepth: 3 }),
    }), async ({ policies, random }) => {
      const bundle = await bindPolicies(policies)
      const structural = markTrustedPredicate(Predicate.and(Predicate.eq("tenantId", "t1"), Predicate.isNull("deletedAt")))
      const callers = [caller, ...(throws(() => validateQueryPlan({ filter: random })) ? [] : [random])]
      for (const action of ABAC_ACTIONS) {
        const scopes = [evaluateAbacActionForCollection({ bundle, action }).scope, buildActionScope({ bundle, action }).filter]
        for (const scope of scopes) {
          for (const filter of callers) {
            // authorizedRepository: and(structural, scope, caller); handlers: and(and(id, structural), scope).
            validateQueryPlan({ filter: Predicate.and(structural, scope, filter) })
            validateQueryPlan({ filter: Predicate.and(Predicate.and(filter, structural), scope) })
          }
          validateQueryPlan({ filter: scope })
        }
      }
    }, { runs: 200, ...POLICY_CASE_OPTIONS })
  })
})
