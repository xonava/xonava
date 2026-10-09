import { describe, expect, it } from "vitest"
import { createRng, forAll, type Rng } from "./harness"
import { DIFFERENTIAL_FIELDS, type DifferentialField, fieldValue, generateCondition, generatePredicate, generateRecord, shrinkPredicate, shrinkRecord } from "./arbitraries"
import {
  assertSameTruth, generateAnyRecord, generateWildRecord, kleene, nodeCount, shrinkCase, shrinkList, wildValue,
} from "./predicateArbitraries"
import { Predicate, type PredicateNode, type PredicatePrimitive } from "../../domain/predicate"
import { evaluatePredicate, evaluatePredicateTruth, MAX_PREDICATE_EVALUATION_DEPTH } from "../../domain/evaluatePredicate"
import { isAlwaysFalse, isAlwaysTrue, simplifyPredicate } from "../../domain/predicateSimplifier"
import { ValidationError } from "../../domain/errors"

/**
 * Property/differential suite for the normative predicate semantics
 * (docs/spec/persistence/predicates.md). Each property is checked over
 * generated predicates and records; failures are replayable with the
 * DIFFERENTIAL_SEED / DIFFERENTIAL_RUN printed by the harness.
 */

type Truth = boolean | null
const truth = (record: Record<string, unknown>, node: PredicateNode): Truth => evaluatePredicateTruth(record, node)

interface NodeCase { node: PredicateNode; record: Record<string, unknown> }
const shrinkNodeCase = shrinkCase<NodeCase>({ node: shrinkPredicate, record: shrinkRecord })

interface ListCase { children: PredicateNode[]; record: Record<string, unknown> }
const shrinkListCase = shrinkCase<ListCase>({ children: shrinkList(shrinkPredicate), record: shrinkRecord })

const subtree = (rng: Rng, portable = rng.bool()): PredicateNode => generatePredicate(rng, { portable, maxDepth: 3 })
const children = (rng: Rng, max = 4): PredicateNode[] => Array.from({ length: rng.int(max + 1) }, () => subtree(rng))

describe("predicate semantics — 1. root collapse", () => {
  it.each([
    ["portable predicates, typed records", true, 0],
    ["full operator set, typed records", false, 0],
    ["full operator set, wild records", false, 1],
  ] as const)("evaluatePredicate === (truth === TRUE): %s", (_label, portable, wildRate) => {
    forAll(`root collapse ${_label}`, (rng) => ({ node: generatePredicate(rng, { portable }), record: generateAnyRecord(rng, wildRate) }), ({ node, record }) => {
      expect(evaluatePredicate(record, node)).toBe(truth(record, node) === true)
    }, { runs: 1500, shrink: shrinkNodeCase })
  })
})

describe("predicate semantics — 2. Kleene laws", () => {
  it("and / or / not follow the Kleene truth tables (vs an independent reference), including empty groups", () => {
    forAll("kleene truth tables", (rng) => ({ children: children(rng), record: generateAnyRecord(rng) }), ({ children: list, record }) => {
      const truths = list.map((child) => truth(record, child))
      assertSameTruth(truth(record, Predicate.and(...list)), kleene.and(truths), "and")
      assertSameTruth(truth(record, Predicate.or(...list)), kleene.or(truths), "or")
      for (const child of list) assertSameTruth(truth(record, Predicate.not(child)), kleene.not(truth(record, child)), "not")
      if (list.length === 0) {
        assertSameTruth(truth(record, Predicate.and()), true, "empty and")
        assertSameTruth(truth(record, Predicate.or()), false, "empty or")
      }
      if (list.length === 1) {
        assertSameTruth(truth(record, Predicate.and(list[0]!)), truths[0]!, "singleton and")
        assertSameTruth(truth(record, Predicate.or(list[0]!)), truths[0]!, "singleton or")
      }
    }, { runs: 1500, shrink: shrinkListCase })
  })

  it("De Morgan (n-ary, both directions) and double negation", () => {
    forAll("de morgan", (rng) => ({ children: children(rng), record: generateAnyRecord(rng) }), ({ children: list, record }) => {
      const negated = list.map((child) => Predicate.not(child))
      assertSameTruth(truth(record, Predicate.not(Predicate.and(...list))), truth(record, Predicate.or(...negated)), "not(and) = or(not)")
      assertSameTruth(truth(record, Predicate.not(Predicate.or(...list))), truth(record, Predicate.and(...negated)), "not(or) = and(not)")
      for (const child of list) assertSameTruth(truth(record, Predicate.not(Predicate.not(child))), truth(record, child), "not(not p) = p")
    }, { runs: 1500, shrink: shrinkListCase })
  })

  it("commutativity (any reordering), associativity (any regrouping) and idempotence", () => {
    forAll("commutative associative idempotent", (rng) => {
      const list = children(rng, 5)
      const split = list.length === 0 ? 0 : rng.int(list.length + 1)
      return { list, shuffleSeed: rng.next(), split, record: generateAnyRecord(rng) }
    }, ({ list, shuffleSeed, split, record }) => {
      for (const kind of ["and", "or"] as const) {
        const group = (filters: PredicateNode[]): PredicateNode => ({ kind, filters })
        const expected = truth(record, group(list))
        assertSameTruth(truth(record, group(createRng(shuffleSeed).shuffle(list))), expected, `${kind} commutativity`)
        assertSameTruth(truth(record, group([group(list.slice(0, split)), group(list.slice(split))])), expected, `${kind} associativity (split ${split})`)
        assertSameTruth(truth(record, group([...list, ...list])), expected, `${kind} idempotence (p ${kind} p)`)
      }
    }, { runs: 1500 })
  })

  it("absorption, distributivity, and the weak excluded middle of Kleene logic", () => {
    forAll("absorption distributivity", (rng) => ({ p: subtree(rng), q: subtree(rng), r: subtree(rng), record: generateAnyRecord(rng) }), ({ p, q, r, record }) => {
      const tp = truth(record, p)
      assertSameTruth(truth(record, Predicate.and(p, Predicate.or(p, q))), tp, "p and (p or q) = p")
      assertSameTruth(truth(record, Predicate.or(p, Predicate.and(p, q))), tp, "p or (p and q) = p")
      assertSameTruth(truth(record, Predicate.and(p, Predicate.or(q, r))), truth(record, Predicate.or(Predicate.and(p, q), Predicate.and(p, r))), "and distributes over or")
      assertSameTruth(truth(record, Predicate.or(p, Predicate.and(q, r))), truth(record, Predicate.and(Predicate.or(p, q), Predicate.or(p, r))), "or distributes over and")
      // Kleene has no law of excluded middle: p or not p is UNKNOWN exactly when p is.
      assertSameTruth(truth(record, Predicate.or(p, Predicate.not(p))), tp === null ? null : true, "p or not p")
      assertSameTruth(truth(record, Predicate.and(p, Predicate.not(p))), tp === null ? null : false, "p and not p")
      assertSameTruth(truth(record, Predicate.and(p, Predicate.literal(true))), tp, "p and TRUE")
      assertSameTruth(truth(record, Predicate.or(p, Predicate.literal(false))), tp, "p or FALSE")
      assertSameTruth(truth(record, Predicate.and(p, Predicate.alwaysFalse())), false, "p and FALSE")
      assertSameTruth(truth(record, Predicate.or(p, Predicate.alwaysTrue())), true, "p or TRUE")
    }, { runs: 1500, shrink: shrinkCase({ p: shrinkPredicate, q: shrinkPredicate, r: shrinkPredicate, record: shrinkRecord }) })
  })
})

describe("predicate semantics — 3. simplifier", () => {
  interface SimplifyCase { node: PredicateNode; records: Record<string, unknown>[] }
  const shrinkSimplify = shrinkCase<SimplifyCase>({ node: shrinkPredicate, records: shrinkList(shrinkRecord) })
  const literalsOnlyAtRoot = (node: PredicateNode, root = true): boolean => {
    if (node.kind === "literal") return root
    if (node.kind === "not") return literalsOnlyAtRoot(node.filter, false)
    if (node.kind === "and" || node.kind === "or") return node.filters.length >= 2 && node.filters.every((child) => literalsOnlyAtRoot(child, false))
    return true
  }

  it.each([
    ["few literals", 0.05],
    ["literal-heavy", 0.3],
  ] as const)("is sound in three-valued logic at every record, idempotent, and only shrinks (%s)", (_label, literalRate) => {
    forAll(`simplifier ${_label}`, (rng) => ({
      node: generatePredicate(rng, { portable: rng.bool(), literalRate }),
      records: Array.from({ length: 8 }, () => generateAnyRecord(rng)),
    }), ({ node, records }) => {
      const simplified = simplifyPredicate(node)
      for (const record of records) assertSameTruth(truth(record, simplified), truth(record, node), "truth(simplify(p)) = truth(p)")
      if (isAlwaysTrue(simplified) || isAlwaysTrue(node)) for (const record of records) assertSameTruth(truth(record, node), true, "isAlwaysTrue ⇒ TRUE")
      if (isAlwaysFalse(simplified) || isAlwaysFalse(node)) for (const record of records) assertSameTruth(truth(record, node), false, "isAlwaysFalse ⇒ FALSE")
      expect(simplifyPredicate(simplified)).toEqual(simplified)
      expect(nodeCount(simplified)).toBeLessThanOrEqual(nodeCount(node))
      // Fully folded: literals survive only as the whole result, groups keep ≥ 2 children.
      expect(literalsOnlyAtRoot(simplified)).toBe(true)
    }, { runs: 800, shrink: shrinkSimplify })
  })

  it("a predicate built only from literals and groups simplifies to the literal it evaluates to", () => {
    const literalTree = (rng: Rng, depth: number): PredicateNode => {
      const roll = rng.int(depth >= 4 ? 2 : 5)
      if (roll === 0) return Predicate.literal(rng.bool())
      if (roll === 1) return rng.bool() ? Predicate.alwaysTrue() : Predicate.alwaysFalse()
      if (roll === 2) return Predicate.not(literalTree(rng, depth + 1))
      const list = Array.from({ length: rng.int(4) }, () => literalTree(rng, depth + 1))
      return roll === 3 ? Predicate.and(...list) : Predicate.or(...list)
    }
    forAll("simplifier folds constant trees", (rng) => literalTree(rng, 0), (node) => {
      const value = truth({}, node)
      expect(simplifyPredicate(node)).toEqual(Predicate.literal(value === true))
    }, { runs: 800, shrink: shrinkPredicate })
  })
})

describe("predicate semantics — 4. missing key ≡ NULL, own fields only", () => {
  it.each([
    ["typed records, portable", true, false],
    ["typed records, full operator set", false, false],
    ["wild records, full operator set", false, true],
  ] as const)("removing a key and setting it to null give the same truth (%s)", (_label, portable, wild) => {
    forAll(`missing is null ${_label}`, (rng) => ({ node: generatePredicate(rng, { portable }), record: wild ? generateWildRecord(rng) : generateRecord(rng) }), ({ node, record }) => {
      for (const field of DIFFERENTIAL_FIELDS) {
        const { [field.key]: _dropped, ...missing } = record
        const nulled = { ...record, [field.key]: null }
        assertSameTruth(truth(missing, node), truth(nulled, node), `field ${field.key}`)
        const undef = { ...record, [field.key]: undefined }
        assertSameTruth(truth(undef, node), truth(nulled, node), `field ${field.key} = undefined`)
      }
    }, { runs: 800, shrink: shrinkNodeCase })
  })

  it("every single operator treats missing and NULL alike", () => {
    forAll("missing is null per operator", (rng) => ({ node: generateCondition(rng, { portable: false }), record: generateAnyRecord(rng) }), ({ node, record }) => {
      if (node.kind !== "condition") return
      const { [node.field]: _dropped, ...missing } = record
      assertSameTruth(truth(missing, node), truth({ ...record, [node.field]: null }, node), node.op)
    }, { runs: 2000, shrink: shrinkNodeCase })
  })

  const PROTOTYPE_FIELDS: readonly DifferentialField[] = [
    { key: "constructor", type: "string" }, { key: "toString", type: "string" }, { key: "valueOf", type: "number" },
    { key: "hasOwnProperty", type: "boolean" }, { key: "name", type: "string" }, { key: "amount", type: "number" },
  ]

  it("inherited properties (including Object.prototype members) are never read", () => {
    forAll("own fields only", (rng) => {
      const fields = PROTOTYPE_FIELDS
      return {
        node: generatePredicate(rng, { portable: false, fields: [...fields, { key: "__proto__", type: "string" }] }),
        own: generateRecord(rng, { fields, missingRate: 0.5 }),
        inherited: generateRecord(rng, { fields, missingRate: 0 }),
      }
    }, ({ node, own, inherited }) => {
      const record = Object.assign(Object.create(inherited) as Record<string, unknown>, own)
      assertSameTruth(truth(record, node), truth({ ...own }, node), "record with prototype vs own-only record")
      const bare = Object.assign(Object.create(null) as Record<string, unknown>, own)
      assertSameTruth(truth(bare, node), truth({ ...own }, node), "null-prototype record")
    }, { runs: 800, shrink: shrinkCase({ node: shrinkPredicate, own: shrinkRecord }) })
  })
})

describe("predicate semantics — 6. metamorphic operator laws", () => {
  const SCALAR_FIELDS = DIFFERENTIAL_FIELDS.filter((field) => field.type !== "string-array")
  interface OpCase { field: DifferentialField; a: PredicatePrimitive; b: PredicatePrimitive; list: PredicatePrimitive[]; record: Record<string, unknown> }
  const scalarOf = (rng: Rng, field: DifferentialField): PredicatePrimitive => fieldValue(rng, field.type) as PredicatePrimitive
  const opCase = (rng: Rng): OpCase => {
    const field = rng.pick(SCALAR_FIELDS)
    // Predicate values are PredicatePrimitive: `undefined` is not a value (an
    // undefined between bound means "no bound"), so wild values exclude it.
    const value = (): PredicatePrimitive => (rng.bool(0.1) ? null : rng.bool(0.1) ? ((wildValue(rng) ?? null) as PredicatePrimitive) : scalarOf(rng, field))
    return { field, a: value(), b: value(), list: Array.from({ length: rng.int(5) }, value), record: generateAnyRecord(rng, 0.3) }
  }
  const shrinkOpCase = shrinkCase<OpCase>({ list: shrinkList<PredicatePrimitive>(), record: shrinkRecord })
  const RUNS = 2500

  it("between(x, {from: a, to: b}) ≡ gte(x, a) AND lte(x, b); one-sided between ≡ gte / lte", () => {
    forAll("between law", opCase, ({ field: { key }, a, b, record }) => {
      assertSameTruth(truth(record, Predicate.between(key, { from: a, to: b })), truth(record, Predicate.and(Predicate.gte(key, a), Predicate.lte(key, b))), "between both")
      assertSameTruth(truth(record, Predicate.between(key, { from: a })), truth(record, Predicate.gte(key, a)), "between from")
      assertSameTruth(truth(record, Predicate.between(key, { to: b })), truth(record, Predicate.lte(key, b)), "between to")
      // Spec vector between-no-bounds-is-false: a range with no bounds is FALSE, not the empty AND.
      assertSameTruth(truth(record, Predicate.between(key, {})), false, "between {}")
    }, { runs: RUNS, shrink: shrinkOpCase })
  })

  it("neq ≡ not eq for every value (two-valued null tests included); eq(x, null) ≡ isNull; neq(x, null) ≡ isNotNull", () => {
    forAll("neq law", opCase, ({ field: { key }, a, record }) => {
      assertSameTruth(truth(record, Predicate.neq(key, a)), truth(record, Predicate.not(Predicate.eq(key, a))), `neq(${String(a)})`)
      assertSameTruth(truth(record, Predicate.eq(key, null)), truth(record, Predicate.isNull(key)), "eq null")
      assertSameTruth(truth(record, Predicate.neq(key, null)), truth(record, Predicate.isNotNull(key)), "neq null")
      assertSameTruth(truth(record, Predicate.isNotNull(key)), kleene.not(truth(record, Predicate.isNull(key))), "isNotNull = not isNull")
      assertSameTruth(truth(record, Predicate.isNotEmpty(key)), kleene.not(truth(record, Predicate.isEmpty(key))), "isNotEmpty = not isEmpty")
      for (const op of [Predicate.isNull(key), Predicate.isNotNull(key), Predicate.isEmpty(key), Predicate.isNotEmpty(key), Predicate.eq(key, null), Predicate.neq(key, null)]) {
        expect(truth(record, op), `${op.op} is two-valued`).not.toBeNull()
      }
    }, { runs: RUNS, shrink: shrinkOpCase })
  })

  it("in(x, L) ≡ OR of eq(x, m) over the non-null members of L (NULL members ignored; empty ⇒ FALSE even for NULL x)", () => {
    // Spec "Membership": `in` is field = ANY(list); NULL members are ignored and
    // an empty list (after removing NULLs) is FALSE. eq(x, null) is the two-valued
    // null test, so the law must drop NULL members rather than map them to eq.
    forAll("in law", opCase, ({ field: { key }, list, record }) => {
      const members = list.filter((member) => member !== null)
      assertSameTruth(truth(record, Predicate.in(key, list)), truth(record, Predicate.or(...members.map((member) => Predicate.eq(key, member)))), "in vs or(eq)")
    }, { runs: RUNS, shrink: shrinkOpCase })
  })

  it("in with an empty (or all-NULL) list is FALSE for every field value, including arrays and incomparable values", () => {
    forAll("in empty list", (rng) => ({ value: rng.bool(0.5) ? wildValue(rng) : rng.pick([["x"], [], { a: 1 }, Number.NaN, null]), nulls: rng.int(3) }), ({ value, nulls }) => {
      const record = value === undefined ? {} : { x: value }
      assertSameTruth(truth(record, Predicate.in("x", Array.from({ length: nulls }, () => null))), false, `in(${JSON.stringify(value)}, [${nulls} nulls])`)
    }, { runs: 400 })
  })

  it("gt ≡ not lte and lt ≡ not gte exactly (both UNKNOWN together); eq ≡ gte AND lte; trichotomy for comparable values", () => {
    forAll("order laws", opCase, ({ field: { key }, a, record }) => {
      const gt = truth(record, Predicate.gt(key, a))
      const lt = truth(record, Predicate.lt(key, a))
      const gte = truth(record, Predicate.gte(key, a))
      const lte = truth(record, Predicate.lte(key, a))
      assertSameTruth(gt, kleene.not(lte), "gt = not lte")
      assertSameTruth(lt, kleene.not(gte), "lt = not gte")
      if (a !== null) assertSameTruth(truth(record, Predicate.eq(key, a)), kleene.and([gte, lte]), "eq = gte and lte")
      if (gt !== null) {
        const eq = truth(record, Predicate.eq(key, a))
        expect([gt, eq, lt].filter((value) => value === true)).toHaveLength(1)
      }
    }, { runs: RUNS, shrink: shrinkOpCase })
  })

  it("isTrue ≡ eq(x, true); isFalse ≡ eq(x, false)", () => {
    forAll("boolean tests", opCase, ({ field: { key }, record }) => {
      assertSameTruth(truth(record, Predicate.isTrue(key)), truth(record, Predicate.eq(key, true)), "isTrue")
      assertSameTruth(truth(record, Predicate.isFalse(key)), truth(record, Predicate.eq(key, false)), "isFalse")
    }, { runs: RUNS, shrink: shrinkOpCase })
  })

  it("incomparable operands are never equal: eq and neq are both UNKNOWN", () => {
    forAll("incomparable", (rng) => ({ actual: wildValue(rng), expected: wildValue(rng) as PredicatePrimitive }), ({ actual, expected }) => {
      if (expected === null || actual === null || actual === undefined) return
      const eq = truth({ x: actual }, Predicate.eq("x", expected))
      const neq = truth({ x: actual }, Predicate.neq("x", expected))
      assertSameTruth(neq, kleene.not(eq), "neq = not eq")
      const kinds = new Set([actual instanceof Date ? "instant" : Array.isArray(actual) ? "array" : typeof actual, expected instanceof Date ? "instant" : typeof expected])
      const numberNaN = (typeof actual === "number" && Number.isNaN(actual)) || (typeof expected === "number" && Number.isNaN(expected))
      if (numberNaN || kinds.has("array") || kinds.has("object") || (kinds.size > 1 && !(kinds.has("instant") && kinds.has("string")))) {
        assertSameTruth(eq, null, `eq(${String(actual)}, ${String(expected)})`)
      }
    }, { runs: 1500 })
  })

  it("contains / startsWith / endsWith: UNKNOWN on NULL, missing and non-string fields; startsWith ⇒ contains; endsWith ⇒ contains; empty needle matches every string", () => {
    forAll("text matching", (rng) => {
      const field = rng.pick(DIFFERENTIAL_FIELDS)
      return { key: field.key, needle: String(rng.pick(["", "a", "A", "ab", "%", "_", "\\", "é", "😀", "b", "draft"])), record: generateAnyRecord(rng, 0.3) }
    }, ({ key, needle, record }) => {
      const value = Object.hasOwn(record, key) ? record[key] : undefined
      const contains = truth(record, Predicate.contains(key, needle))
      const starts = truth(record, Predicate.startsWith(key, needle))
      const ends = truth(record, Predicate.endsWith(key, needle))
      if (typeof value !== "string") {
        for (const [name, result] of [["contains", contains], ["startsWith", starts], ["endsWith", ends]] as const) assertSameTruth(result, null, `${name} on non-string ${JSON.stringify(value)}`)
        expect(evaluatePredicate(record, Predicate.not(Predicate.contains(key, needle)))).toBe(false)
        return
      }
      if (starts === true || ends === true) assertSameTruth(contains, true, "startsWith/endsWith ⇒ contains")
      if (needle === "") for (const result of [contains, starts, ends]) assertSameTruth(result, true, "empty needle")
      // Literal, case-sensitive matching (no LIKE wildcards, no case folding).
      assertSameTruth(contains, value.includes(needle), "contains is literal includes")
    }, { runs: RUNS })
  })

  it("list member order never changes in / includesAny / includesAll", () => {
    forAll("list order", (rng) => {
      const pool: PredicatePrimitive[] = ["x", "y", "z", "X", null, 1]
      const list = Array.from({ length: rng.int(5) }, () => rng.pick(pool))
      return { list, shuffleSeed: rng.next(), record: { tags: rng.bool(0.15) ? null : rng.subset(["x", "y", "z", null]), name: rng.pick(["x", "y", null, 1]) } as Record<string, unknown> }
    }, ({ list, shuffleSeed, record }) => {
      const reordered = createRng(shuffleSeed).shuffle(list)
      for (const make of [(values: PredicatePrimitive[]) => Predicate.in("name", values), (values: PredicatePrimitive[]) => Predicate.includesAny("tags", values), (values: PredicatePrimitive[]) => Predicate.includesAll("tags", values)]) {
        const original = make(list)
        assertSameTruth(truth(record, make(reordered)), truth(record, original), `${original.op} reordered`)
      }
    }, { runs: 1500, shrink: shrinkCase({ list: shrinkList<PredicatePrimitive>(), record: shrinkRecord }) })
  })

  it("includesAny(x, L) ≡ OR and includesAll(x, L) ≡ AND of the single-member tests", () => {
    forAll("includes decomposition", (rng) => ({
      list: Array.from({ length: rng.int(4) }, () => rng.pick<PredicatePrimitive>(["x", "y", "X", null])),
      record: { tags: rng.bool(0.15) ? rng.pick([null, "x", 3]) : rng.subset(["x", "y", "z", null]) } as Record<string, unknown>,
    }), ({ list, record }) => {
      // includesAny/includesAll are not in the normative spec (non-portable). A
      // non-array field is UNKNOWN for any list, like Postgres `NULL && ARRAY[]`,
      // so the OR/AND decomposition (whose empty case is FALSE/TRUE) applies to
      // array fields only. Corrected after the property failed on {} with [].
      if (!Array.isArray(record.tags)) {
        assertSameTruth(truth(record, Predicate.includesAny("tags", list)), null, "includesAny on non-array")
        assertSameTruth(truth(record, Predicate.includesAll("tags", list)), null, "includesAll on non-array")
        return
      }
      assertSameTruth(truth(record, Predicate.includesAny("tags", list)), kleene.or(list.filter((member) => member !== null).map((member) => truth(record, Predicate.includesAny("tags", [member])))), "includesAny")
      assertSameTruth(truth(record, Predicate.includesAll("tags", list)), kleene.and(list.map((member) => truth(record, Predicate.includesAll("tags", [member])))), "includesAll")
    }, { runs: 1500, shrink: shrinkCase({ list: shrinkList<PredicatePrimitive>(), record: shrinkRecord }) })
  })
})

describe("predicate semantics — resource limits", () => {
  const chain = (depth: number, leaf: PredicateNode): PredicateNode => {
    let node = leaf
    for (let index = 0; index < depth; index++) node = Predicate.not(node)
    return node
  }

  it("a predicate nested deeper than the limit is rejected for every record, whatever its siblings short-circuit to", () => {
    // Spec "Resource limits": evaluators MUST reject predicates nested more
    // deeply than 256 levels — a property of the predicate, not of the data.
    forAll("depth limit is data independent", (rng) => ({
      excess: 1 + rng.int(40),
      sibling: rng.pick([Predicate.literal(false), Predicate.literal(true), Predicate.eq("amount", 1), Predicate.isNull("amount")]),
      kind: rng.pick(["and", "or"] as const),
      siblingFirst: rng.bool(),
      record: generateRecord(rng),
    }), ({ excess, sibling, kind, siblingFirst, record }) => {
      const deep = chain(MAX_PREDICATE_EVALUATION_DEPTH + excess, Predicate.eq("amount", 1))
      const node: PredicateNode = { kind, filters: siblingFirst ? [sibling, deep] : [deep, sibling] }
      expect(() => evaluatePredicateTruth(record, node)).toThrow(ValidationError)
      expect(() => evaluatePredicate(record, node)).toThrow(ValidationError)
    }, { runs: 300 })
  })

  it("predicates within the limit never throw", () => {
    forAll("depth limit admits legal depth", (rng) => ({ depth: MAX_PREDICATE_EVALUATION_DEPTH - 1 - rng.int(20), record: generateRecord(rng) }), ({ depth, record }) => {
      const node = Predicate.and(Predicate.literal(true), chain(depth, Predicate.eq("amount", 1)))
      expect(() => evaluatePredicateTruth(record, node)).not.toThrow()
    }, { runs: 100 })
  })
})
