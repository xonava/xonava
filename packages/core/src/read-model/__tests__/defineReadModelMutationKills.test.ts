import { describe, expect, it } from "vitest"
import { Predicate } from "../../domain/predicate"
import { encodeExecutionScopeId } from "../../domain/executionScope"
import { DEFAULT_QUERY_BUDGET } from "../../query/queryBudget"
import { defineReadModel, MAX_READ_MODEL_JOINS, MAX_READ_MODEL_SOURCE_ROWS, MAX_READ_MODEL_OUTPUT_ROWS, MAX_READ_MODEL_SOURCES, type CompiledMultiSourceReadPlan, type CompiledReadSourcePlan, type CompiledReadJoin } from ".."

const scope = { kind: "tenant", tenantId: "t1" } as const
const authority = { scope, scopeId: encodeExecutionScopeId(scope) }
const src = (sourceKey: string, extra: Partial<CompiledReadSourcePlan> = {}): CompiledReadSourcePlan => ({
  sourceKey, datasourceKey: sourceKey, authority, mandatoryPredicate: Predicate.eq("tenantId", "t1"),
  readableFields: new Set(["id", "fk", "name"]), filterableFields: new Set(["id"]), sortableFields: new Set(["id"]),
  aggregatableFields: new Set(["amount", "region"]), consistency: "eventual", maxStalenessMs: 100, ...extra,
})
const join = (extra: Partial<CompiledReadJoin> = {}): CompiledReadJoin => ({
  leftSourceKey: "a", rightSourceKey: "b", type: "inner", leftKey: "id", rightKey: "id", cardinality: "one-to-one", maxExpansion: 1, ...extra,
})
const base = (o: Partial<CompiledMultiSourceReadPlan> = {}): CompiledMultiSourceReadPlan => ({
  key: "rm", version: 1, sources: [src("a"), src("b")], joins: [join()], consistency: { kind: "eventual" },
  partialFailurePolicy: "fail-whole-read", aggregatePermissions: [], budget: DEFAULT_QUERY_BUDGET, maxSourceRows: 10, maxOutputRows: 10, ...o,
})
const one = (o: Partial<CompiledMultiSourceReadPlan> = {}) => base({ sources: [src("a")], joins: [], ...o })
const rejects = (p: CompiledMultiSourceReadPlan, message: string) => {
  expect(() => defineReadModel(p)).toThrow(message)
  try { defineReadModel(p) } catch (e) { expect((e as Error).message).toBe(message); expect((e as Error).name).toBe("ConfigurationError") }
}

describe("defineReadModel validation", () => {
  it("pins the hard limits", () => {
    expect([MAX_READ_MODEL_SOURCES, MAX_READ_MODEL_JOINS, MAX_READ_MODEL_SOURCE_ROWS, MAX_READ_MODEL_OUTPUT_ROWS]).toEqual([32, 31, 100_000, 100_000])
  })
  it("requires a non-blank string key and a positive safe integer version", () => {
    const m = "Read model key and positive version are required"
    rejects(base({ key: "" }), m)
    rejects(base({ key: "   " }), m)
    rejects(base({ key: 5 as never }), m)
    rejects(base({ version: 0 }), m)
    rejects(base({ version: 1.5 }), m)
    rejects(base({ version: Number.NaN }), m)
    expect(defineReadModel(base({ version: 1 })).version).toBe(1)
    expect(defineReadModel(base({ key: " k " })).key).toBe(" k ")
  })
  it("enforces source and join count limits inclusively", () => {
    const keys = Array.from({ length: 32 }, (_, i) => `s${i}`)
    const chain = (n: number) => keys.slice(1, n).map((k, i) => join({ leftSourceKey: keys[i]!, rightSourceKey: k }))
    expect(defineReadModel(base({ sources: keys.map(k => src(k)), joins: chain(32) })).sources).toHaveLength(32)
    rejects(base({ sources: [...keys, "s32"].map(k => src(k)), joins: chain(32) }), "Read model source count exceeds the hard limit of 32")
    const many = Array.from({ length: 32 }, () => join())
    rejects(base({ sources: [src("a")], joins: many }), "Read model join count exceeds the hard limit of 31")
  })
  it("requires non-empty, uniquely keyed sources", () => {
    const m = "Read model sources must be non-empty and uniquely keyed"
    rejects(base({ sources: [], joins: [] }), m)
    rejects(base({ sources: [src("a"), src("a")], joins: [] }), m)
    expect(defineReadModel(one()).sources).toHaveLength(1)
  })
  it("validates the source envelope", () => {
    rejects(one({ sources: [src("a", { datasourceKey: "  " })] }), "Invalid source envelope: a")
    rejects(one({ sources: [src("a", { authority: { scope, scopeId: "other" } })] }), "Invalid source envelope: a")
    expect(defineReadModel(one()).sources[0]!.datasourceKey).toBe("a")
  })
  it("rejects unknown policies and consistency kinds", () => {
    rejects(one({ partialFailurePolicy: "x" as never }), "Invalid partial source failure policy")
    expect(defineReadModel(one({ partialFailurePolicy: "allow-partial-with-explicit-metadata" })).partialFailurePolicy).toBe("allow-partial-with-explicit-metadata")
    rejects(one({ consistency: { kind: "x" } as never }), "Invalid multi-source consistency")
  })
  it("validates source key, consistency and staleness proof", () => {
    const m = "Invalid source key or consistency"
    rejects(one({ sources: [src("", { datasourceKey: "d" })] }), m)
    rejects(one({ sources: [src(" ", { datasourceKey: "d" })] }), m)
    rejects(one({ sources: [src(5 as never, { datasourceKey: "d" })] }), m)
    rejects(one({ sources: [src("a", { consistency: "x" as never })] }), m)
    for (const c of ["strong", "session", "eventual"] as const) expect(defineReadModel(one({ sources: [src("a", { consistency: c })] })).sources[0]!.consistency).toBe(c)
    const s = "Invalid source bounded-staleness proof"
    rejects(one({ sources: [src("a", { maxStalenessMs: -1 })] }), s)
    rejects(one({ sources: [src("a", { maxStalenessMs: 0.5 })] }), s)
    rejects(one({ sources: [src("a", { maxStalenessMs: Number.NaN })] }), s)
    expect(defineReadModel(one({ sources: [src("a", { maxStalenessMs: 0 })] })).sources[0]!.maxStalenessMs).toBe(0)
    expect(defineReadModel(one({ sources: [src("a", { maxStalenessMs: undefined })] })).sources[0]!.maxStalenessMs).toBeUndefined()
  })
  it("validates join type, cardinality and connectivity", () => {
    const m = "Invalid join type or cardinality"
    rejects(base({ joins: [join({ type: "x" as never })] }), m)
    rejects(base({ joins: [join({ cardinality: "x" as never })] }), m)
    for (const type of ["inner", "left"] as const) for (const cardinality of ["one-to-one", "one-to-many", "many-to-one"] as const) {
      expect(defineReadModel(base({ joins: [join({ type, cardinality, maxExpansion: 2 })] })).joins[0]).toMatchObject({ type, cardinality })
    }
    const t = "Joins must form an ordered, connected source tree"
    rejects(base({ joins: [join({ leftSourceKey: "b", rightSourceKey: "a" })] }), t)
    rejects(base({ joins: [join({ leftSourceKey: "a", rightSourceKey: "a" })] }), t)
    rejects(base({ sources: [src("a"), src("b"), src("c")], joins: [join(), join({ leftSourceKey: "a", rightSourceKey: "b" })] }), t)
    rejects(base({ joins: [] }), "Every read-model source requires a supported join")
    rejects(base({ joins: [join({ rightSourceKey: "ghost" })] }), "Join references an unknown source")
  })
  it("authorizes join keys on both sides and requires a positive maxExpansion", () => {
    const k = "Join key is not authorized"
    rejects(base({ joins: [join({ leftKey: "secret" })] }), k)
    rejects(base({ joins: [join({ rightKey: "secret" })] }), k)
    rejects(base({ sources: [src("a"), src("b", { readableFields: new Set(["fk"]) })], joins: [join({ leftKey: "id", rightKey: "id" })] }), k)
    rejects(base({ sources: [src("a", { readableFields: new Set(["fk"]) }), src("b")], joins: [join({ leftKey: "id", rightKey: "id" })] }), k)
    const e = "Join maxExpansion must be positive"
    rejects(base({ joins: [join({ maxExpansion: 0 })] }), e)
    rejects(base({ joins: [join({ maxExpansion: 1.5 })] }), e)
    rejects(base({ joins: [join({ maxExpansion: -1 })] }), e)
    expect(defineReadModel(base({ joins: [join({ maxExpansion: 1 })] })).joins[0]!.maxExpansion).toBe(1)
  })
  it("validates aggregate permissions", () => {
    rejects(base({ aggregatePermissions: [{ operation: "count", sourceKey: "ghost" }] }), "Aggregate references an unknown source")
    rejects(base({ aggregatePermissions: [{ operation: "sum", sourceKey: "a", field: "id" }] }), "Aggregate field is not authorized")
    rejects(base({ aggregatePermissions: [{ operation: "count", sourceKey: "a", groupBy: ["amount", "id"] }] }), "Aggregate grouping field is not authorized")
    const ok = defineReadModel(base({ aggregatePermissions: [{ operation: "count", sourceKey: "a" }, { operation: "sum", sourceKey: "a", field: "amount", groupBy: ["region"] }] }))
    expect(ok.aggregatePermissions).toHaveLength(2)
  })
  it("proves bounded staleness per source", () => {
    const m = "Sources do not prove the bounded-staleness requirement"
    const c = (maxStalenessMs: number) => ({ kind: "bounded-staleness", maxStalenessMs }) as const
    rejects(one({ consistency: c(-1) }), m)
    rejects(one({ consistency: c(Number.NaN) }), m)
    rejects(one({ consistency: c(1.5) }), m)
    rejects(one({ consistency: c(99) }), m)
    rejects(one({ consistency: c(100), sources: [src("a", { maxStalenessMs: undefined })] }), m)
    rejects(base({ consistency: c(100), sources: [src("a", { maxStalenessMs: 100 }), src("b", { maxStalenessMs: 101 })] }), m)
    rejects(base({ consistency: c(100), sources: [src("a", { maxStalenessMs: 100 }), src("b", { maxStalenessMs: undefined })] }), m)
    expect(defineReadModel(one({ consistency: c(100) })).consistency).toEqual(c(100))
    expect(defineReadModel(one({ consistency: c(0), sources: [src("a", { maxStalenessMs: 0 })] })).consistency).toEqual(c(0))
  })
  it("requires a coordinator, token format and per-source coordinator support for snapshots", () => {
    const m = "Snapshot coordinator and token format are required"
    const snap = (coordinatorKey: unknown, snapshotTokenFormat: unknown) => ({ kind: "application-defined-snapshot", coordinatorKey, snapshotTokenFormat }) as never
    const keys = new Set(["coord"])
    const s = (extra: Partial<CompiledReadSourcePlan> = {}) => src("a", { snapshotCoordinatorKeys: keys, ...extra })
    rejects(one({ consistency: snap("", "fmt"), sources: [s()] }), m)
    rejects(one({ consistency: snap("  ", "fmt"), sources: [s()] }), m)
    rejects(one({ consistency: snap(7, "fmt"), sources: [s()] }), m)
    rejects(one({ consistency: snap("coord", ""), sources: [s()] }), m)
    rejects(one({ consistency: snap("coord", "  "), sources: [s()] }), m)
    rejects(one({ consistency: snap("coord", 3), sources: [s()] }), m)
    const n = "Snapshot coordinator is not supported by every source"
    rejects(one({ consistency: snap("coord", "fmt") }), n)
    rejects(one({ consistency: snap("coord", "fmt"), sources: [s({ snapshotCoordinatorKeys: new Set(["other"]) })] }), n)
    rejects(base({ consistency: snap("coord", "fmt"), sources: [s(), src("b")] }), n)
    const ok = defineReadModel(one({ consistency: snap("coord", "fmt"), sources: [s()] }))
    expect(ok.sources[0]!.snapshotCoordinatorKeys?.has("coord")).toBe(true)
    expect((ok.sources[0]!.snapshotCoordinatorKeys as Set<string>).add).toBeUndefined()
  })
  it("omits snapshotCoordinatorKeys when absent", () => {
    expect("snapshotCoordinatorKeys" in defineReadModel(one()).sources[0]!).toBe(false)
  })
  it("validates the row budgets inclusively", () => {
    const m = "Read model row budgets must be positive"
    rejects(one({ maxSourceRows: 0 }), m)
    rejects(one({ maxOutputRows: 0 }), m)
    rejects(one({ maxSourceRows: Number.NaN }), m)
    rejects(one({ maxOutputRows: 1.5 }), m)
    expect(defineReadModel(one({ maxSourceRows: 1, maxOutputRows: 1 })).maxSourceRows).toBe(1)
    rejects(one({ maxSourceRows: 100_001 }), "Read model source row budget exceeds the hard limit of 100000")
    rejects(one({ maxOutputRows: 100_001 }), "Read model output row budget exceeds the hard limit of 100000")
    const top = defineReadModel(one({ maxSourceRows: 100_000, maxOutputRows: 100_000 }))
    expect([top.maxSourceRows, top.maxOutputRows]).toEqual([100_000, 100_000])
  })
  it("validates the query budget", () => {
    expect(() => defineReadModel(one({ budget: { ...DEFAULT_QUERY_BUDGET, maxSortFields: 0 } }))).toThrow()
  })
  it("returns a frozen deep copy with readonly field sets", () => {
    const input = one()
    const out = defineReadModel(input)
    expect(out).not.toBe(input)
    expect(Object.isFrozen(out)).toBe(true)
    for (const f of ["readableFields", "filterableFields", "sortableFields", "aggregatableFields"] as const) {
      expect((out.sources[0]![f] as Set<string>).add).toBeUndefined()
      expect([...out.sources[0]![f]]).toEqual([...input.sources[0]![f]])
    }
    expect(out.sources[0]!.sourceKey).toBe("a")
  })
})
