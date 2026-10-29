import { describe, expect, it } from "vitest"
import { Predicate } from "../../domain/predicate"
import { encodeExecutionScopeId } from "../../domain/executionScope"
import { DEFAULT_QUERY_BUDGET } from "../../query/queryBudget"
import {
  defineReadModel, executeReadModel, MAX_READ_MODEL_TIMEOUT_MS,
  type CompiledMultiSourceReadPlan, type CompiledReadJoin, type CompiledReadSourcePlan, type ReadModelExecutionContext, type ReadSourceExecutor, type ReadSourceResult,
} from ".."

const scope = { kind: "tenant", tenantId: "t1" } as const
const authority = { scope, scopeId: encodeExecutionScopeId(scope) }
const src = (sourceKey: string, extra: Partial<CompiledReadSourcePlan> = {}): CompiledReadSourcePlan => ({
  sourceKey, datasourceKey: sourceKey, authority, mandatoryPredicate: Predicate.eq("tenantId", "t1"),
  readableFields: new Set(["id", "tenantId", "k", "constructor"]), filterableFields: new Set(["id"]), sortableFields: new Set(["id"]),
  aggregatableFields: new Set(["amount"]), consistency: "eventual", maxStalenessMs: 100, ...extra,
})
const join = (extra: Partial<CompiledReadJoin> = {}): CompiledReadJoin => ({
  leftSourceKey: "a", rightSourceKey: "b", type: "inner", leftKey: "k", rightKey: "k", cardinality: "one-to-many", maxExpansion: 5, ...extra,
})
const plan = (o: Partial<CompiledMultiSourceReadPlan> = {}) => defineReadModel({
  key: "rm", version: 1, sources: [src("a"), src("b")], joins: [join()], consistency: { kind: "eventual" },
  partialFailurePolicy: "fail-whole-read", aggregatePermissions: [], budget: DEFAULT_QUERY_BUDGET, maxSourceRows: 100, maxOutputRows: 100, ...o,
})
const rows = (...r: Record<string, unknown>[]) => r.map(x => ({ tenantId: "t1", ...x }))
const ex = (sourceKey: string, r: readonly Record<string, unknown>[], extra: Partial<ReadSourceResult> = {}): ReadSourceExecutor =>
  ({ sourceKey, execute: async () => ({ consistency: "eventual", rows: r, ...extra }) })
const fail = (sourceKey: string): ReadSourceExecutor => ({ sourceKey, execute: async () => { throw new Error("down") } })
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const joined = async (left: unknown, right: unknown) => {
  const result = await executeReadModel(plan(), [ex("a", rows({ id: "l", k: left })), ex("b", rows({ id: "r", k: right }))])
  return result.rows.length
}

describe("executeReadModel projection", () => {
  it("copies only readable fields the row actually owns", async () => {
    const result = await executeReadModel(plan({ sources: [src("a")], joins: [] }), [ex("a", rows({ id: "1", secret: "x" }))])
    expect(result.rows).toStrictEqual([{ a: { tenantId: "t1", id: "1" } }])
  })
  it("projects the right-hand rows with the right-hand source's own fields", async () => {
    const result = await executeReadModel(plan({ sources: [src("a"), src("b", { readableFields: new Set(["k", "tenantId"]) })] }),
      [ex("a", rows({ id: "l", k: 1 })), ex("b", rows({ id: "r", k: 1 }))])
    expect(result.rows).toStrictEqual([{ a: { tenantId: "t1", id: "l", k: 1 }, b: { tenantId: "t1", k: 1 } }])
  })
})

describe("executeReadModel join key semantics", () => {
  it("joins equal strings only", async () => {
    expect(await joined("x", "x")).toBe(1)
    expect(await joined("x", "y")).toBe(0)
    expect(await joined("1", 1)).toBe(0)
  })
  it("joins equal numbers only and never NaN", async () => {
    expect(await joined(1, 1)).toBe(1)
    expect(await joined(1, 2)).toBe(0)
    expect(await joined(Number.NaN, Number.NaN)).toBe(0)
  })
  it("joins equal booleans only", async () => {
    expect(await joined(true, true)).toBe(1)
    expect(await joined(false, false)).toBe(1)
    expect(await joined(true, false)).toBe(0)
    expect(await joined(true, "true")).toBe(0)
  })
  it("joins equal bigints only", async () => {
    expect(await joined(1n, 1n)).toBe(1)
    expect(await joined(1n, 2n)).toBe(0)
    expect(await joined(1n, 1)).toBe(0)
  })
  it("joins dates by instant and never invalid dates", async () => {
    expect(await joined(new Date(5), new Date(5))).toBe(1)
    expect(await joined(new Date(5), new Date(6))).toBe(0)
    expect(await joined(new Date(Number.NaN), new Date(Number.NaN))).toBe(0)
    expect(await joined(new Date(5), 5)).toBe(0)
  })
  it("joins other objects by identity and never null or undefined", async () => {
    const o = {}
    expect(await joined(o, o)).toBe(1)
    expect(await joined({}, {})).toBe(0)
    expect(await joined(null, null)).toBe(0)
    expect(await joined(undefined, undefined)).toBe(0)
  })
  it("ignores inherited properties on both sides", async () => {
    const plain = plan({ joins: [join({ leftKey: "constructor", rightKey: "constructor" })] })
    const withOwn = await executeReadModel(plain, [ex("a", rows({ id: "l", constructor: Object })), ex("b", rows({ id: "r" }))])
    expect(withOwn.rows).toEqual([])
    const leftInherited = await executeReadModel(plain, [ex("a", rows({ id: "l" })), ex("b", rows({ id: "r", constructor: Object }))])
    expect(leftInherited.rows).toEqual([])
    const both = await executeReadModel(plain, [ex("a", rows({ id: "l", constructor: Object })), ex("b", rows({ id: "r", constructor: Object }))])
    expect(both.rows).toHaveLength(1)
  })
})

describe("executeReadModel join budgets", () => {
  const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ tenantId: "t1", id: `${prefix}${i}` }))
  it("enforces the cumulative indexed row budget exactly", async () => {
    const chain = (c: number) => plan({
      sources: [src("a"), src("b"), src("c"), src("d")], maxSourceRows: 100_000, maxOutputRows: 100,
      joins: [join({ rightSourceKey: "b" }), join({ rightSourceKey: "c" }), join({ rightSourceKey: "d" })],
    })
    const run = (d: number) => executeReadModel(chain(d), [ex("a", rows({ id: "l", k: 1 })), ex("b", many(100_000, "b")), ex("c", many(100_000, "c")), ex("d", many(d, "d"))])
    const ok = await run(50_000)
    expect(ok.rows).toEqual([])
    await expect(run(50_001)).rejects.toThrow("Read-model indexed row budget exceeded (250000)")
  }, 60_000)
  it("rejects expansion beyond maxExpansion or beyond one match unless one-to-many", async () => {
    const two = [ex("a", rows({ id: "l", k: 1 })), ex("b", rows({ id: "r1", k: 1 }, { id: "r2", k: 1 }))]
    const m = "Read-model join expansion budget exceeded"
    await expect(executeReadModel(plan({ joins: [join({ maxExpansion: 1 })] }), two)).rejects.toThrow(m)
    expect((await executeReadModel(plan({ joins: [join({ maxExpansion: 2 })] }), two)).rows).toHaveLength(2)
    await expect(executeReadModel(plan({ joins: [join({ cardinality: "one-to-one", maxExpansion: 5 })] }), two)).rejects.toThrow(m)
    await expect(executeReadModel(plan({ joins: [join({ cardinality: "many-to-one", maxExpansion: 5 })] }), two)).rejects.toThrow(m)
    const one = [ex("a", rows({ id: "l", k: 1 })), ex("b", rows({ id: "r1", k: 1 }))]
    expect((await executeReadModel(plan({ joins: [join({ cardinality: "one-to-one", maxExpansion: 1 })] }), one)).rows).toHaveLength(1)
  })
  it("keeps unmatched left rows only for left joins", async () => {
    const e = [ex("a", rows({ id: "l", k: 1 }, { id: "m", k: 2 })), ex("b", rows({ id: "r", k: 1 }))]
    const inner = await executeReadModel(plan(), e)
    expect(inner.rows).toHaveLength(1)
    const left = await executeReadModel(plan({ joins: [join({ type: "left" })] }), e)
    expect(left.rows).toStrictEqual([
      { a: { tenantId: "t1", id: "l", k: 1 }, b: { tenantId: "t1", id: "r", k: 1 } },
      { a: { tenantId: "t1", id: "m", k: 2 }, b: {} },
    ])
    expect(Object.isFrozen(left.rows[1]!["b"])).toBe(true)
  })
  it("checks the output budget row by row before later rows' expansion", async () => {
    const left = rows({ id: "1", k: 1 }, { id: "2", k: 2 }, { id: "3", k: 3 })
    const right = rows({ id: "r1", k: 1 }, { id: "r2", k: 2 }, { id: "r3", k: 3 }, { id: "r4", k: 3 }, { id: "r5", k: 3 })
    const out = "Read-model output row budget exceeded"
    const run = (j: Partial<CompiledReadJoin>, max: number) => executeReadModel(plan({ maxOutputRows: max, joins: [join({ maxExpansion: 2, cardinality: "one-to-one", ...j })] }), [ex("a", left), ex("b", right)])
    // row 2 overflows the budget before row 3 would overflow the expansion
    await expect(run({}, 1)).rejects.toThrow(out)
    // exactly at the budget passes (rows 1 and 2 only)
    const exact = await executeReadModel(plan({ maxOutputRows: 2, joins: [join({ cardinality: "one-to-one" })] }), [ex("a", left.slice(0, 2)), ex("b", right)])
    expect(exact.rows).toHaveLength(2)
    // a left join counts an unmatched row as one output row
    const unmatched = rows({ id: "1", k: 1 }, { id: "2", k: 9 }, { id: "3", k: 3 })
    await expect(executeReadModel(plan({ maxOutputRows: 1, joins: [join({ type: "left", cardinality: "one-to-one", maxExpansion: 2 })] }), [ex("a", unmatched), ex("b", right)])).rejects.toThrow(out)
    // an unmatched inner row counts as zero output rows
    const inner = await executeReadModel(plan({ maxOutputRows: 1, joins: [join({ cardinality: "one-to-one", maxExpansion: 2 })] }), [ex("a", rows({ id: "1", k: 1 }, { id: "2", k: 9 })), ex("b", right)])
    expect(inner.rows).toHaveLength(1)
    // multiple matches count fully
    await expect(executeReadModel(plan({ maxOutputRows: 2, joins: [join({ maxExpansion: 3 })] }), [ex("a", rows({ id: "3", k: 3 })), ex("b", right)])).rejects.toThrow(out)
  })
  it("accepts exactly maxOutputRows from a single source and rejects one more", async () => {
    const one = (max: number) => plan({ sources: [src("a")], joins: [], maxOutputRows: max })
    expect((await executeReadModel(one(2), [ex("a", rows({ id: "1" }, { id: "2" }))])).rows).toHaveLength(2)
    await expect(executeReadModel(one(2), [ex("a", rows({ id: "1" }, { id: "2" }, { id: "3" }))])).rejects.toThrow("Read-model output row budget exceeded")
  })
})

describe("executeReadModel source settlement", () => {
  it("waits for every source before joining", async () => {
    const slow: ReadSourceExecutor = { sourceKey: "b", execute: async () => { await delay(10); return { consistency: "eventual", rows: rows({ id: "r", k: 1 }) } } }
    const result = await executeReadModel(plan(), [ex("a", rows({ id: "l", k: 1 })), slow])
    expect(result.rows).toHaveLength(1)
  })
  it("waits for a slow source after a fast failure", async () => {
    const slow: ReadSourceExecutor = { sourceKey: "b", execute: async () => { await delay(10); return { consistency: "session", rows: [] } } }
    const result = await executeReadModel(plan({ partialFailurePolicy: "allow-partial-with-explicit-metadata" }), [fail("a"), slow])
    expect(result.metadata.sourceConsistency).toEqual({ b: "session" })
    expect(result.metadata.failedSources).toEqual(["a"])
  })
  it("returns an empty result when every source failed under the partial policy", async () => {
    const result = await executeReadModel(plan({ partialFailurePolicy: "allow-partial-with-explicit-metadata", consistency: { kind: "application-defined-snapshot", coordinatorKey: "c", snapshotTokenFormat: "f" }, sources: [src("a", { snapshotCoordinatorKeys: new Set(["c"]) }), src("b", { snapshotCoordinatorKeys: new Set(["c"]) })] }), [fail("a"), fail("b")])
    expect(result.rows).toEqual([])
    expect(result.metadata.failedSources).toEqual(["a", "b"])
    expect(result.metadata.sourceConsistency).toEqual({})
    expect(result.metadata.missingData).toBe(true)
  })
  it("skips joins that touch a failed source on either side", async () => {
    const partial = { partialFailurePolicy: "allow-partial-with-explicit-metadata" } as const
    // the left side failed, so the first available source is the right side
    const leftFailed = await executeReadModel(plan(partial), [fail("a"), ex("b", rows({ id: "r", k: 1 }))])
    expect(leftFailed.rows).toStrictEqual([{ b: { tenantId: "t1", id: "r", k: 1 } }])
    const rightFailed = await executeReadModel(plan(partial), [ex("a", rows({ id: "l", k: 1 })), fail("b")])
    expect(rightFailed.rows).toStrictEqual([{ a: { tenantId: "t1", id: "l", k: 1 } }])
  })
  it("reports exact failure and completeness metadata", async () => {
    const allow = { partialFailurePolicy: "allow-partial-with-explicit-metadata" } as const
    const agg = [{ operation: "count", sourceKey: "a" }] as const
    const okRows = [ex("a", rows({ id: "l", k: 1 })), ex("b", rows({ id: "r", k: 1 }))]
    const clean = await executeReadModel(plan({ aggregatePermissions: agg }), okRows)
    expect(clean.metadata).toEqual({ consistency: { kind: "eventual" }, sourceConsistency: { a: "eventual", b: "eventual" }, failedSources: [], missingData: false, incompleteAggregates: false })
    const noAgg = await executeReadModel(plan(allow), [ex("a", rows({ id: "l", k: 1 })), fail("b")])
    expect([noAgg.metadata.missingData, noAgg.metadata.incompleteAggregates]).toEqual([true, false])
    const withAgg = await executeReadModel(plan({ ...allow, aggregatePermissions: agg }), [ex("a", rows({ id: "l", k: 1 })), fail("b")])
    expect([withAgg.metadata.missingData, withAgg.metadata.incompleteAggregates]).toEqual([true, true])
    expect(Object.isFrozen(withAgg.metadata)).toBe(true)
    expect(Object.isFrozen(withAgg.metadata.failedSources)).toBe(true)
    expect(Object.isFrozen(withAgg)).toBe(true)
  })
  it("names every failed source in the whole-read failure", async () => {
    await expect(executeReadModel(plan(), [fail("a"), fail("b")])).rejects.toThrow("Read-model source failure: a,b")
  })
  it("rejects malformed source results with the source key", async () => {
    const bad = async (result: unknown) => {
      const e: ReadSourceExecutor = { sourceKey: "a", execute: async () => result as never }
      await expect(executeReadModel(plan({ sources: [src("a")], joins: [] }), [e])).rejects.toThrow("Invalid source result or consistency: a")
    }
    await bad(undefined)
    await bad(null)
    await bad({ consistency: "eventual" })
    await bad({ consistency: "eventual", rows: "x" })
    await bad({ consistency: "toString", rows: [] })
    await bad({ consistency: undefined, rows: [] })
    await bad({ consistency: "eventual", rows: [null] })
    await bad({ consistency: "eventual", rows: [0] })
    await bad({ consistency: "eventual", rows: ["str"] })
    await bad({ consistency: "eventual", rows: [5] })
    await bad({ consistency: "eventual", rows: [[]] })
  })
  it("enforces source row and consistency requirements at the boundary", async () => {
    const one = (o: Partial<CompiledReadSourcePlan> = {}, max = 2) => plan({ sources: [src("a", o)], joins: [], maxSourceRows: max })
    expect((await executeReadModel(one(), [ex("a", rows({ id: "1" }, { id: "2" }))])).rows).toHaveLength(2)
    await expect(executeReadModel(one(), [ex("a", rows({ id: "1" }, { id: "2" }, { id: "3" }))])).rejects.toThrow("Source row budget exceeded: a")
    const strong = one({ consistency: "strong" })
    await expect(executeReadModel(strong, [ex("a", [], { consistency: "session" })])).rejects.toThrow("Source consistency requirement was not satisfied: a")
    await expect(executeReadModel(one({ consistency: "session" }), [ex("a", [], { consistency: "eventual" })])).rejects.toThrow("Source consistency requirement was not satisfied: a")
    expect((await executeReadModel(strong, [ex("a", [], { consistency: "strong" })])).metadata.sourceConsistency).toEqual({ a: "strong" })
    expect((await executeReadModel(one({ consistency: "session" }), [ex("a", [], { consistency: "strong" })])).metadata.sourceConsistency).toEqual({ a: "strong" })
  })
  it("requires one non-empty shared snapshot token among successful sources", async () => {
    const snap = (keys: string[]) => plan({
      consistency: { kind: "application-defined-snapshot", coordinatorKey: "c", snapshotTokenFormat: "f" }, partialFailurePolicy: "allow-partial-with-explicit-metadata",
      sources: keys.map(k => src(k, { snapshotCoordinatorKeys: new Set(["c"]) })), joins: keys.slice(1).map(k => join({ rightSourceKey: k })),
    })
    const m = "Application-defined snapshot token mismatch"
    const e = (k: string, token: unknown) => ex(k, [], { snapshotToken: token as never })
    await expect(executeReadModel(snap(["a", "b"]), [e("a", "t"), e("b", "u")])).rejects.toThrow(m)
    await expect(executeReadModel(snap(["a", "b"]), [e("a", ""), e("b", "")])).rejects.toThrow(m)
    await expect(executeReadModel(snap(["a", "b"]), [e("a", 5), e("b", 5)])).rejects.toThrow(m)
    await expect(executeReadModel(snap(["a", "b"]), [e("a", undefined), e("b", undefined)])).rejects.toThrow(m)
    await expect(executeReadModel(snap(["a"]), [e("a", undefined)])).rejects.toThrow(m)
    expect((await executeReadModel(snap(["a", "b"]), [e("a", "t"), e("b", "t")])).rows).toEqual([])
    expect((await executeReadModel(snap(["a", "b"]), [e("a", "t"), fail("b")])).metadata.failedSources).toEqual(["b"])
    // eventual consistency does not require tokens
    expect((await executeReadModel(plan({ sources: [src("a")], joins: [] }), [ex("a", [])])).rows).toEqual([])
  })
})

describe("executeReadModel executors and options", () => {
  const solo = plan({ sources: [src("a")], joins: [] })
  const capture = async (options: Parameters<typeof executeReadModel>[2]) => {
    let seen: ReadModelExecutionContext | undefined
    await executeReadModel(solo, [{ sourceKey: "a", execute: async (_s, c) => { seen = c; return { consistency: "eventual", rows: [] } } }], options)
    return seen!
  }
  it("rejects duplicate and missing executors", async () => {
    await expect(executeReadModel(solo, [ex("a", []), ex("a", [])])).rejects.toThrow("Duplicate source executor")
    await expect(executeReadModel(solo, [])).rejects.toThrow("Missing source executor: a")
    await expect(executeReadModel(solo, [{ sourceKey: "a", execute: undefined as never }])).rejects.toThrow("Missing source executor: a")
    await expect(executeReadModel(solo, [{ sourceKey: "z", execute: async () => ({ consistency: "eventual", rows: [] }) }])).rejects.toThrow("Missing source executor: a")
  })
  it("validates now, clock, signal, deadline and timeout", async () => {
    await expect(executeReadModel(solo, [ex("a", [])], { now: 5 as never })).rejects.toThrow("Read-model now must be a function")
    await expect(executeReadModel(solo, [ex("a", [])], { now: () => Number.NaN })).rejects.toThrow("Read-model clock returned an invalid time")
    await expect(executeReadModel(solo, [ex("a", [])], { now: () => Number.POSITIVE_INFINITY })).rejects.toThrow("Read-model clock returned an invalid time")
    await expect(executeReadModel(solo, [ex("a", [])], { signal: {} as never })).rejects.toThrow("Read-model signal must be an AbortSignal")
    await expect(executeReadModel(solo, [ex("a", [])], { deadline: Number.NaN })).rejects.toThrow("Read-model deadline must be finite")
    await expect(executeReadModel(solo, [ex("a", [])], { deadline: Number.POSITIVE_INFINITY })).rejects.toThrow("Read-model deadline must be finite")
    const t = `Read-model timeout must be between 1 and ${MAX_READ_MODEL_TIMEOUT_MS} milliseconds`
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, MAX_READ_MODEL_TIMEOUT_MS + 1]) await expect(executeReadModel(solo, [ex("a", [])], { timeoutMs })).rejects.toThrow(t)
    expect((await executeReadModel(solo, [ex("a", [])], { timeoutMs: 1 })).rows).toEqual([])
    expect((await executeReadModel(solo, [ex("a", [])], { timeoutMs: MAX_READ_MODEL_TIMEOUT_MS })).rows).toEqual([])
    expect((await executeReadModel(solo, [ex("a", [])], { signal: new AbortController().signal })).rows).toEqual([])
  })
  it("derives the effective deadline from the clock, timeout and absolute deadline", async () => {
    const now = () => 1000
    expect((await capture({ now })).deadline).toBe(31_000)
    expect((await capture({ now, deadline: 101_000 })).deadline).toBe(101_000)
    expect((await capture({ now, deadline: 5_000 })).deadline).toBe(5_000)
    expect((await capture({ now, deadline: 1e9 })).deadline).toBe(1000 + MAX_READ_MODEL_TIMEOUT_MS)
    expect((await capture({ now, timeoutMs: 5000 })).deadline).toBe(6000)
    expect((await capture({ now, timeoutMs: 5000, deadline: 100_000 })).deadline).toBe(6000)
    expect((await capture({ now, timeoutMs: 50_000, deadline: 3000 })).deadline).toBe(3000)
    await expect(executeReadModel(solo, [ex("a", [])], { now, deadline: 1000 })).rejects.toMatchObject({ kind: "deadline-exceeded", deadline: 1000 })
  })
  it("exposes the injected clock on the provider context only when supplied", async () => {
    const now = () => 1000
    const withNow = await capture({ now })
    expect(withNow.now).toBe(now)
    expect(Object.isFrozen(withNow)).toBe(true)
    const without = await capture({})
    expect(Object.keys(without).sort()).toEqual(["deadline", "signal"])
    expect(without.signal.aborted).toBe(false)
  })
})
