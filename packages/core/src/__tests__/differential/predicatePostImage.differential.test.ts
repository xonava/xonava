import { describe, expect, it } from "vitest"
import { forAllAsync } from "./harness"
import { DIFFERENTIAL_FIELDS, generatePredicate, generateRecord, shrinkPredicate, shrinkRecord } from "./arbitraries"
import { assertSameTruth, generatePatch, shrinkCase, shrinkList } from "./predicateArbitraries"
import { Predicate, type PredicateNode } from "../../domain/predicate"
import { evaluatePredicate, evaluatePredicateTruth } from "../../domain/evaluatePredicate"
import { ForbiddenError } from "../../domain/errors"
import type { PersistenceProvider } from "../../persistence"
import { createAuthorizedExecutionPlan } from "../../security"
import { createPlanConstrainedPersistenceProvider } from "../../operation/authorizationPlanEnforcement"

/**
 * Property 7: conditional updates through a plan-constrained repository.
 *
 * authorizationPlanEnforcement rewrites the mandatory resource predicate M for
 * the post-image of an update (postImagePredicate/postImageFilter): conditions
 * on written fields are decided by the written values, the residual R mentions
 * only unwritten fields, and WHERE = caller ∧ M ∧ R. Its documented claim is:
 *
 *   for every stored row r:  truth(R, r) = truth(M, post(r))   (exactly, 3-valued)
 *
 * where post(r) is the row after the adapter applied the patch, and a patch
 * that makes a written-field condition UNKNOWN, or makes M FALSE for every
 * row, is rejected with ForbiddenError (fail closed).
 *
 * post(r) follows the real adapters: drizzle's `.set()` skips keys whose value
 * is `undefined` (drizzle-orm mapUpdateSet), so such a key is NOT written.
 *
 * End to end: the rows actually updated are exactly
 *   { r | caller(r) ∧ M(r) ∧ M(post(r)) }   (2-valued, at the WHERE root).
 */

type Row = Record<string, unknown>

const principal = {
  id: "user-1", kind: "human",
  authentication: { kind: "authenticated", method: "session", authenticatedAt: "2026-09-10T00:00:00.000Z" },
} as const
const scope = { kind: "tenant", tenantId: "tenant-1" } as const
const capabilities = {
  interactiveTransactions: false, atomicBatch: false, returningInsert: false, readSessions: false,
  jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100,
  maxBindParams: 100, maxStatementBytes: 100_000,
} as const
const writable = new Set(DIFFERENTIAL_FIELDS.map((field) => field.key))

/** The adapter's write: undefined values are skipped (drizzle `.set()`), everything else overwrites. */
function applyPatch(row: Row, patch: Row): Row {
  const next: Row = { ...row }
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) next[key] = value
  return next
}

/** An in-memory table standing in for a SQL repository (evaluates WHERE with the normative evaluator). */
function table(initial: Row[]) {
  const rows: Row[] = initial.map((row, index) => ({ ...row, id: `r${index}` }))
  const filters: PredicateNode[] = []
  const updatedIds: unknown[] = []
  const repository = {
    findById: async () => null,
    findMany: async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 10 }),
    insert: async () => { throw new Error("unused") },
    update: async () => { throw new Error("unused") },
    delete: async () => { throw new Error("unused") },
    updateManyWhere: async (filter: PredicateNode, data: Row): Promise<number> => {
      filters.push(filter)
      let count = 0
      for (let index = 0; index < rows.length; index++) {
        if (!evaluatePredicate(rows[index]!, filter)) continue
        updatedIds.push(rows[index]!.id)
        rows[index] = applyPatch(rows[index]!, data)
        count++
      }
      return count
    },
    updateOneWhereReturning: async (filter: PredicateNode, data: Row): Promise<Row | null> => {
      filters.push(filter)
      const index = rows.findIndex((row) => evaluatePredicate(row, filter))
      if (index < 0) return null
      rows[index] = applyPatch(rows[index]!, data)
      return rows[index]!
    },
  }
  return { rows, filters, updatedIds, repository }
}

function constrained(mandatory: PredicateNode, repository: unknown) {
  const plan = createAuthorizedExecutionPlan({
    identity: { actor: principal, subject: principal }, scope, action: "records.update", operationKind: "mutation",
    readableFields: writable, writableFields: writable, obligations: [], dynamicFacts: [],
    policy: { key: "policy", version: 1, digest: "a".repeat(64) }, mandatoryResourcePredicate: mandatory,
  } as never)
  return createPlanConstrainedPersistenceProvider({ dialect: "test", capabilities, repository: () => repository } as unknown as PersistenceProvider, plan)
    .repository({ name: "records", fields: {} } as never) as unknown as {
      updateManyWhere(filter: PredicateNode, data: Row): Promise<number>
      updateOneWhereReturning(filter: PredicateNode, data: Row): Promise<Row | null>
    }
}

function conditions(node: PredicateNode, out: Extract<PredicateNode, { kind: "condition" }>[] = []) {
  if (node.kind === "condition") out.push(node)
  else if (node.kind === "not") conditions(node.filter, out)
  else if (node.kind === "and" || node.kind === "or") for (const child of node.filters) conditions(child, out)
  return out
}

/** Forbidden is justified when a written condition is UNKNOWN on the patch, or M(post) holds for no row. */
function forbiddenIsJustified(mandatory: PredicateNode, patch: Row, rows: Row[]): boolean {
  const written = Object.entries(patch).filter(([, value]) => value !== undefined).map(([key]) => key)
  const unknownWrite = conditions(mandatory).some((condition) => written.includes(condition.field) && evaluatePredicateTruth(applyPatch({}, patch), condition) === null)
  return unknownWrite || rows.every((row) => !evaluatePredicate(applyPatch(row, patch), mandatory))
}

interface PostImageCase { mandatory: PredicateNode; caller: PredicateNode; patch: Row; rows: Row[] }

const generateCase = (portable: boolean, undefinedRate: number) => (rng: Parameters<typeof generatePredicate>[0]): PostImageCase => ({
  mandatory: generatePredicate(rng, { portable, maxDepth: 3 }),
  caller: rng.bool(0.5) ? Predicate.literal(true) : generatePredicate(rng, { portable, maxDepth: 2 }),
  patch: generatePatch(rng, { undefinedRate }),
  rows: Array.from({ length: 6 }, () => generateRecord(rng)),
})
/** JSON drops `undefined`, which is exactly the value under test; spell it out. */
const describeCase = (value: PostImageCase): string =>
  JSON.stringify(value, (_key, item: unknown) => (item === undefined ? "<undefined>" : item instanceof Date ? `Date(${item.toISOString()})` : item), 2)
const shrinkPostImage = shrinkCase<PostImageCase>({ mandatory: shrinkPredicate, caller: shrinkPredicate, patch: shrinkRecord, rows: shrinkList(shrinkRecord) })

describe("predicate semantics — 7. post-image rewrite (authorizationPlanEnforcement)", () => {
  it.each([
    ["portable mandatory predicates, patches with NULL", true, 0],
    ["full operator set, patches with NULL", false, 0],
    ["portable mandatory predicates, patches with NULL and undefined", true, 0.25],
  ] as const)("updateManyWhere updates exactly { r | caller(r) ∧ M(r) ∧ M(post(r)) }, the residual is exact, and rejections are justified (%s)", async (label, portable, undefinedRate) => {
    let accepted = 0
    let updatedRows = 0
    let rejected = 0
    await forAllAsync(`post-image updateManyWhere ${label}`, generateCase(portable, undefinedRate), async ({ mandatory, caller, patch, rows }) => {
      const store = table(rows)
      const before = store.rows.map((row) => ({ ...row }))
      const expected = before.filter((row) => evaluatePredicate(row, caller) && evaluatePredicate(row, mandatory) && evaluatePredicate(applyPatch(row, patch), mandatory)).map((row) => row.id)
      let count: number
      try {
        count = await constrained(mandatory, store.repository).updateManyWhere(caller, patch)
      } catch (error) {
        if (!(error instanceof ForbiddenError)) throw error
        if (!forbiddenIsJustified(mandatory, patch, before)) throw new Error("ForbiddenError without an UNKNOWN written condition or a universally failing post-image")
        rejected++
        return
      }
      accepted++
      expect(count).toBe(expected.length)
      expect(store.updatedIds).toEqual(expected)
      updatedRows += count
      for (const row of store.rows) if (expected.includes(row.id as string)) expect(evaluatePredicate(row, mandatory)).toBe(true)

      // The residual alone, three-valued, against every pre-image row.
      const where = store.filters[0]!
      const residual = where.kind === "and" && where.filters.length === 2 && where.filters[0]!.kind === "and" && where.filters[0]!.filters[0] === caller
        ? where.filters[1]!
        : Predicate.literal(true)
      const writtenKeys = Object.keys(patch).filter((key) => patch[key] !== undefined)
      for (const condition of conditions(residual)) expect(writtenKeys, `residual mentions written field ${condition.field}`).not.toContain(condition.field)
      for (const row of before) {
        assertSameTruth(evaluatePredicateTruth(row, residual), evaluatePredicateTruth(applyPatch(row, patch), mandatory), `residual vs M(post) for ${String(row.id)}`)
      }
    }, { runs: 1200, shrink: shrinkPostImage, describe: describeCase })
    expect(accepted).toBeGreaterThan(100)
    expect(rejected).toBeGreaterThan(20)
    expect(updatedRows).toBeGreaterThan(50)
  })

  it("updateOneWhereReturning never returns (or leaves) a row outside the mandatory predicate", async () => {
    await forAllAsync("post-image updateOneWhereReturning", generateCase(true, 0.2), async ({ mandatory, caller, patch, rows }) => {
      const store = table(rows)
      const before = store.rows.map((row) => ({ ...row }))
      let returned: Row | null
      try {
        returned = await constrained(mandatory, store.repository).updateOneWhereReturning(caller, patch)
      } catch (error) {
        if (!(error instanceof ForbiddenError)) throw error
        if (!forbiddenIsJustified(mandatory, patch, before)) throw new Error("unjustified ForbiddenError")
        return
      }
      for (let index = 0; index < store.rows.length; index++) {
        if (JSON.stringify(store.rows[index]) === JSON.stringify(before[index])) continue
        expect(evaluatePredicate(before[index]!, mandatory), "pre-image satisfied M").toBe(true)
        expect(evaluatePredicate(store.rows[index]!, mandatory), "post-image satisfies M").toBe(true)
      }
      if (returned) expect(evaluatePredicate(returned, mandatory)).toBe(true)
    }, { runs: 800, shrink: shrinkPostImage, describe: describeCase })
  })
})

describe("regression: post-image of a patch with undefined values (found by the post-image differential)", () => {
  // drizzle's .set() skips undefined keys, so `{ dueOn: undefined }` leaves
  // dueOn unchanged. postImagePredicate used to decide `isNull(dueOn)` as TRUE
  // for it (undefined read as NULL), dropping the condition from the WHERE.
  const mandatory = Predicate.or(Predicate.isNull("dueOn"), Predicate.eq("ownerId", "u1"))

  it("does not let an undefined write satisfy the mandatory predicate (fail-open)", async () => {
    const store = table([{ dueOn: "2026-01-01", ownerId: "u1" }])
    await constrained(mandatory, store.repository).updateManyWhere(Predicate.literal(true), { dueOn: undefined, ownerId: "u2" })
    expect(store.rows.every((row) => evaluatePredicate(row, mandatory))).toBe(true)
    expect(store.updatedIds).toEqual([])
  })

  it("does not reject an update whose undefined key leaves a satisfied field untouched", async () => {
    const store = table([{ active: true }])
    await expect(constrained(Predicate.eq("active", true), store.repository).updateManyWhere(Predicate.literal(true), { active: undefined, name: "a" })).resolves.toBe(1)
  })
})
