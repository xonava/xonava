import { describe, expect, it } from "vitest"
import { forAll } from "./harness"
import { generatePredicate, generateRecord, shrinkPredicate, shrinkRecord } from "./arbitraries"
import { assertSameTruth, generateAnyRecord, hydrateRecord, mapPredicateValues, nodeCount, shrinkCase, shrinkList } from "./predicateArbitraries"
import type { PredicateNode } from "../../domain/predicate"
import { evaluatePredicateTruth } from "../../domain/evaluatePredicate"
import { ValidationError } from "../../domain/errors"
import { DEFAULT_QUERY_BUDGET, validateQueryPlan, type QueryBudget } from "../../query"
import { canonicalJsonString, decodeCanonicalJson } from "../../serialization/canonicalJson"
import { createAuthorizedExecutionPlan } from "../../security"

/**
 * Property 8: every path that copies, serializes or validates a predicate
 * must preserve its meaning (and validation must agree with its budget).
 */

const LARGE_BUDGET: QueryBudget = Object.freeze({ ...DEFAULT_QUERY_BUDGET, maxPredicateDepth: 64, maxPredicateNodes: 10_000, maxOrBranches: 10_000, maxInValues: 1000 })

interface Metrics { depth: number; nodes: number; orBranches: number; maxList: number }

/** Independent model of the query budget metrics (root depth is 1). */
function metrics(node: PredicateNode, depth = 1): Metrics {
  if (node.kind === "condition") return { depth, nodes: 1, orBranches: 0, maxList: Array.isArray(node.value) ? node.value.length : 0 }
  const children = node.kind === "not" ? [node.filter] : node.kind === "and" || node.kind === "or" ? node.filters : []
  const own: Metrics = { depth, nodes: 1, orBranches: node.kind === "or" ? children.length : 0, maxList: 0 }
  return children.map((child) => metrics(child, depth + 1)).reduce((sum, item) => ({
    depth: Math.max(sum.depth, item.depth), nodes: sum.nodes + item.nodes, orBranches: sum.orBranches + item.orBranches, maxList: Math.max(sum.maxList, item.maxList),
  }), own)
}

interface RecordsCase { node: PredicateNode; records: Record<string, unknown>[] }
const shrinkRecordsCase = shrinkCase<RecordsCase>({ node: shrinkPredicate, records: shrinkList(shrinkRecord) })

describe("predicate semantics — 8. validation and round trips", () => {
  it("validateQueryPlan accepts a predicate exactly when it fits the budget (depth, nodes, OR branches, list size)", () => {
    let accepted = 0
    let rejected = 0
    forAll("query budget verdict", (rng) => ({
      node: generatePredicate(rng, { portable: rng.bool(), maxDepth: 1 + rng.int(5) }),
      budget: { ...DEFAULT_QUERY_BUDGET, maxPredicateDepth: 1 + rng.int(6), maxPredicateNodes: 1 + rng.int(30), maxOrBranches: 1 + rng.int(10), maxInValues: 1 + rng.int(4) },
    }), ({ node, budget }) => {
      const m = metrics(node)
      const fits = m.depth <= budget.maxPredicateDepth && m.nodes <= budget.maxPredicateNodes && m.orBranches <= budget.maxOrBranches && m.maxList <= budget.maxInValues
      let error: unknown
      try { validateQueryPlan({ filter: node }, budget) } catch (caught) { error = caught }
      if (fits) {
        expect(error, `rejected a predicate within budget ${JSON.stringify(m)}`).toBeUndefined()
        accepted++
      } else {
        expect(error, `accepted a predicate over budget ${JSON.stringify(m)}`).toBeInstanceOf(ValidationError)
        rejected++
      }
    }, { runs: 3000, shrink: shrinkCase({ node: shrinkPredicate }) })
    expect(accepted).toBeGreaterThan(300)
    expect(rejected).toBeGreaterThan(300)
  })

  it("validateQueryPlan does not mutate the predicate", () => {
    forAll("query validation is pure", (rng) => ({ node: generatePredicate(rng, { portable: rng.bool() }), records: [generateAnyRecord(rng)] }), ({ node, records }) => {
      const before = structuredClone(node)
      const truthBefore = records.map((record) => evaluatePredicateTruth(record, node))
      validateQueryPlan({ filter: node }, LARGE_BUDGET)
      expect(node).toEqual(before)
      expect(records.map((record) => evaluatePredicateTruth(record, node))).toEqual(truthBefore)
    }, { runs: 500, shrink: shrinkRecordsCase })
  })

  it("canonical JSON round trip (instants as RFC 3339 strings) evaluates identically on hydrated records and re-validates", () => {
    forAll("canonical json round trip", (rng) => ({
      node: generatePredicate(rng, { portable: rng.bool() }),
      records: Array.from({ length: 6 }, () => hydrateRecord(generateRecord(rng))),
    }), ({ node, records }) => {
      // Canonical JSON refuses Date objects; the wire form of an instant is its RFC 3339 UTC string.
      const wire = mapPredicateValues(node, (_field, value) => (value instanceof Date ? value.toISOString() : value))
      const decoded = decodeCanonicalJson(canonicalJsonString(wire)) as PredicateNode
      expect(() => validateQueryPlan({ filter: decoded }, LARGE_BUDGET)).not.toThrow()
      expect(canonicalJsonString(decoded)).toBe(canonicalJsonString(wire))
      for (const record of records) assertSameTruth(evaluatePredicateTruth(record, decoded), evaluatePredicateTruth(record, node), "decoded vs original")
    }, { runs: 1000, shrink: shrinkRecordsCase })
  })

  it("an authorization plan's snapshot of the mandatory predicate evaluates identically and stays a valid query filter", () => {
    const principal = { id: "user-1", kind: "human", authentication: { kind: "authenticated", method: "session", authenticatedAt: "2026-09-10T00:00:00.000Z" } } as const
    forAll("plan snapshot", (rng) => ({
      node: generatePredicate(rng, { portable: rng.bool() }),
      records: Array.from({ length: 6 }, () => generateAnyRecord(rng, 0.3)),
    }), ({ node, records }) => {
      const plan = createAuthorizedExecutionPlan({
        identity: { actor: principal, subject: principal }, scope: { kind: "tenant", tenantId: "tenant-1" }, action: "records.read", operationKind: "read",
        readableFields: new Set(["id"]), writableFields: new Set<string>(), obligations: [], dynamicFacts: [],
        policy: { key: "policy", version: 1, digest: "a".repeat(64) }, mandatoryResourcePredicate: node,
      } as never)
      const snapshot = plan.mandatoryResourcePredicate!
      expect(snapshot).not.toBe(node)
      expect(nodeCount(snapshot)).toBe(nodeCount(node))
      expect(() => validateQueryPlan({ filter: snapshot }, LARGE_BUDGET)).not.toThrow()
      for (const record of records) assertSameTruth(evaluatePredicateTruth(record, snapshot), evaluatePredicateTruth(record, node), "snapshot vs original")
    }, { runs: 600, shrink: shrinkRecordsCase })
  })
})
