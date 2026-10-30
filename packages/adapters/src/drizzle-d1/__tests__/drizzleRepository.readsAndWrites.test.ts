import { describe, expect, it } from "vitest"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ConfigurationError, NotFoundError, OptimisticConcurrencyError, Predicate, ValidationError } from "@xonava/core/domain"
import type { PredicateNode } from "@xonava/core/domain"
import { createDrizzleRepository } from "../drizzleRepository"
import { createScriptedDb, renderSql, type ScriptedHandler, type ScriptedOp } from "../../__tests__/support/scriptedDb"

const widgets = sqliteTable("widgets", { id: text("id").primaryKey(), name: text("name").notNull(), score: integer("score"), version: integer("version").notNull(), createdAt: integer("created_at") })
const notes = sqliteTable("notes", { id: text("id").primaryKey(), body: text("body").notNull() })
const slugs = sqliteTable("slugs", { slug: text("slug").primaryKey(), id: text("id"), label: text("label") })
const widgetColumns = { id: widgets.id, name: widgets.name, score: widgets.score, version: widgets.version, createdAt: widgets.createdAt }
const noteColumns = { id: notes.id, body: notes.body }
const widgetEntity = { name: "widget", primaryKey: "id", versionField: "version", fields: {} }
const noteEntity = { name: "note", primaryKey: "id", fields: {} }

type Repo = Record<string, (...args: unknown[]) => Promise<unknown>>
type Kind = "widget" | "note"
interface Returning { readonly set: Record<string, unknown>; readonly where: { sql: string; params: readonly unknown[] } }
function build(handler: ScriptedHandler, extra: Record<string, unknown> = {}, kind: Kind = "widget", returningRows?: (call: Returning) => unknown[]) {
  const scripted = createScriptedDb("sqlite", handler)
  const calls: Returning[] = []
  const db = returningRows
    ? {
        ...scripted.db,
        updateReturning: async (_table: unknown, set: Record<string, unknown>, where: unknown) => {
          const call = { set, where: renderSql("sqlite", where)! }
          calls.push(call)
          return returningRows(call)
        },
      }
    : scripted.db
  const repo = createDrizzleRepository({
    db: db as never,
    table: (kind === "widget" ? widgets : notes) as never,
    entity: (kind === "widget" ? widgetEntity : noteEntity) as never,
    columnMap: (kind === "widget" ? widgetColumns : noteColumns) as never,
    ...extra,
  } as never) as unknown as Repo
  return { repo, ops: scripted.ops, calls }
}
const row = (overrides: Record<string, unknown> = {}) => ({ id: "w1", name: "alpha", score: 1, version: 1, createdAt: 1, ...overrides })
const norm = (sql: string | undefined) => (sql ?? "").replace(/\s+/g, " ")
const whereOf = (op: ScriptedOp | undefined) => ({ sql: norm(op?.where?.sql), params: op?.where?.params })
const setSql = (set: unknown, key: string) => { const r = renderSql("sqlite", (set as Record<string, unknown>)[key]); return { sql: norm(r?.sql), params: r?.params } }
const oc = (expectedVersion: unknown = 3) => ({ optimisticConcurrency: { expectedVersion } })
const countThen = (rows: unknown[], count: unknown = 0): ScriptedHandler => (op) => (op.fields && "count" in (op.fields as object) ? [{ count }] : rows)
const pageOp = (ops: ScriptedOp[]) => ops.find((op) => op.offset !== undefined)!
const changes = (n: number) => ({ meta: { changes: n } })

describe("d1 repository construction", () => {
  const make = (extra: Record<string, unknown>, entity: Record<string, unknown> = widgetEntity, columnMap: Record<string, unknown> = widgetColumns) =>
    createDrizzleRepository({ db: createScriptedDb("sqlite", () => []).db as never, table: widgets as never, entity: entity as never, columnMap: columnMap as never, ...extra } as never)

  it("resolves the primary key from the descriptor, defaulting to id, and reports a missing column", async () => {
    const scripted = createScriptedDb("sqlite", () => [{ slug: "s1" }])
    const custom = createDrizzleRepository({ db: scripted.db as never, table: slugs as never, entity: { name: "slugged", primaryKey: "slug", fields: {} } as never, columnMap: { slug: slugs.slug, id: slugs.id, label: slugs.label } as never }) as unknown as Repo
    await custom.findById!("s1")
    expect(whereOf(scripted.ops[0])).toEqual({ sql: '"slugs"."slug" = ?', params: ["s1"] })
    const implicit = createDrizzleRepository({ db: scripted.db as never, table: slugs as never, entity: { name: "slugged", fields: {} } as never, columnMap: { slug: slugs.slug, id: slugs.id } as never }) as unknown as Repo
    await implicit.findById!("i1")
    expect(whereOf(scripted.ops[1])).toEqual({ sql: '"slugs"."id" = ?', params: ["i1"] })
    expect(() => make({}, { name: "slugged", fields: {} }, { slug: slugs.slug })).toThrow(new Error('Entity slugged is missing primary key column "id"'))
  })

  it("validates page-size and offset bounds with exact messages", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => make({ maxPageSize: bad })).toThrow(new ConfigurationError("D1 maxPageSize must be a finite positive integer"))
    expect(() => make({ maxPageSize: 1 })).not.toThrow()
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => make({ maxOffset: bad })).toThrow(new ConfigurationError("D1 maxOffset must be a finite non-negative integer"))
    expect(() => make({ maxOffset: 0 })).not.toThrow()
    expect(() => make({ maxOffset: undefined })).not.toThrow()
  })

  it("orders by the creation column when one is mapped, and by the key alone otherwise", async () => {
    const withCreated = build(countThen([]))
    await withCreated.repo.findMany!()
    expect(norm(pageOp(withCreated.ops).orderBy!.sql)).toBe('"widgets"."created_at" asc, "widgets"."id" asc')
    const noCreated = build(countThen([]), {}, "note")
    await noCreated.repo.findMany!()
    expect(norm(pageOp(noCreated.ops).orderBy!.sql)).toBe('"notes"."id"')
  })
})

describe("d1 repository reads", () => {
  it("rejects a missing filter with the operation and entity in the message", async () => {
    const { repo } = build(() => [])
    for (const filter of [undefined, null]) {
      await expect(repo.findOneWhere!(filter)).rejects.toThrow(
        new ValidationError("findOneWhere: cannot execute on widget without a filter predicate — empty predicates would match all rows."),
      )
    }
    await expect(build(() => [], {}, "note").repo.findOneWhere!(undefined)).rejects.toThrow("cannot execute on note without")
  })

  it.each([
    ["empty sort", [] as unknown[], '"widgets"."created_at" asc, "widgets"."id" asc'],
    ["ascending", [{ field: "score", direction: "asc" }], '"widgets"."score" asc, "widgets"."id" asc'],
    ["descending, with a descending tie-breaker", [{ field: "score", direction: "desc" }], '"widgets"."score" desc, "widgets"."id" desc'],
    ["ascending nulls first", [{ field: "score", direction: "asc", nulls: "first" }], '"widgets"."score" ASC NULLS FIRST, "widgets"."id" asc'],
    ["descending nulls last", [{ field: "score", direction: "desc", nulls: "last" }], '"widgets"."score" DESC NULLS LAST, "widgets"."id" desc'],
    ["descending nulls first then ascending", [{ field: "score", direction: "desc", nulls: "first" }, { field: "name", direction: "asc" }], '"widgets"."score" DESC NULLS FIRST, "widgets"."name" asc, "widgets"."id" asc'],
    ["the primary key alone", [{ field: "id", direction: "desc" }], '"widgets"."id" desc'],
    ["the primary key last", [{ field: "name", direction: "asc" }, { field: "id", direction: "asc" }], '"widgets"."name" asc, "widgets"."id" asc'],
    ["the primary key first", [{ field: "id", direction: "asc" }, { field: "name", direction: "desc" }], '"widgets"."id" asc, "widgets"."name" desc'],
  ])("sorts %s", async (_label, sort, expected) => {
    const { repo, ops } = build(countThen([]))
    await repo.findMany!({ sort })
    expect(norm(pageOp(ops).orderBy!.sql)).toBe(expected)
  })

  it("rejects an unknown sort field and an unknown projection field", async () => {
    const { repo } = build(countThen([]))
    await expect(repo.findMany!({ sort: [{ field: "ghost", direction: "asc" }] })).rejects.toThrow()
  })

  it("accepts strong consistency and rejects weaker levels", async () => {
    const strong = build(countThen([row()], 1))
    expect(((await strong.repo.findMany!({ consistency: "strong" })) as { rowCount: number }).rowCount).toBe(1)
    await expect(build(countThen([])).repo.findMany!({ consistency: "eventual" })).rejects.toThrow()
  })

  it("requires a non-empty sort for cursor pagination and reads one extra row for the next-page probe", async () => {
    const f = build(countThen([]))
    const cursor = { kind: "cursor", limit: 3, direction: "after" }
    await expect(f.repo.findMany!({ pagination: cursor })).rejects.toThrow(new ValidationError("cursor pagination requires an explicit stable sort"))
    await expect(f.repo.findMany!({ sort: [], pagination: cursor })).rejects.toThrow("cursor pagination requires an explicit stable sort")
    expect(f.ops).toEqual([])
    const ok = build(countThen([row(), row({ id: "w2" }), row({ id: "w3" }), row({ id: "w4" })], 9))
    const result = (await ok.repo.findMany!({ sort: [{ field: "name", direction: "asc" }], pagination: cursor })) as { rows: unknown[]; rowCount: number; page: number; pageSize: number; pageInfo: unknown }
    expect(pageOp(ok.ops)).toMatchObject({ limit: 4, offset: 0 })
    expect(result.rows).toHaveLength(3)
    expect(result).toMatchObject({ rowCount: 9, page: 1, pageSize: 3, pageInfo: { kind: "cursor", hasNextPage: true, hasPreviousPage: false } })
  })

  it("reports zero when the count query returns nothing and numbers text counts", async () => {
    const none = build((op) => (op.fields && "count" in (op.fields as object) ? [] : [row()]))
    expect(((await none.repo.findMany!()) as { rowCount: number }).rowCount).toBe(0)
    expect(((await build(countThen([row()], "12")).repo.findMany!()) as { rowCount: number }).rowCount).toBe(12)
    const missing = build((op) => (op.fields && "count" in (op.fields as object) ? [{}] : []))
    expect(((await missing.repo.findMany!()) as { rowCount: number }).rowCount).toBe(0)
  })
})

describe("d1 all-row predicate classification", () => {
  const lit = (value: boolean): PredicateNode => Predicate.literal(value)
  const eq = Predicate.eq("body", "x")
  const forbidden: [string, PredicateNode][] = [
    ["literal true", lit(true)],
    ["empty and", Predicate.and()],
    ["and of tautologies", Predicate.and(lit(true), Predicate.and())],
    ["and of a tautology and a comparison is not forbidden but or with a tautology is", Predicate.or(eq, lit(true))],
    ["not of a contradiction", Predicate.not(lit(false))],
    ["double negation of a tautology", Predicate.not(Predicate.not(lit(true)))],
    ["not of an empty or", Predicate.not(Predicate.or())],
    ["not of an and containing a contradiction (first)", Predicate.not(Predicate.and(lit(false), eq))],
    ["not of an and containing a contradiction (last)", Predicate.not(Predicate.and(eq, lit(false)))],
    ["not of an or of contradictions", Predicate.not(Predicate.or(lit(false), lit(false)))],
  ]
  const allowed: [string, PredicateNode][] = [
    ["literal false", lit(false)],
    ["a plain comparison", eq],
    ["not of a tautology", Predicate.not(lit(true))],
    ["and with a comparison", Predicate.and(lit(true), eq)],
    ["empty or", Predicate.or()],
    ["or of comparisons", Predicate.or(eq, eq)],
    ["or of contradictions", Predicate.or(lit(false), lit(false))],
    ["not of an empty and", Predicate.not(Predicate.and())],
    ["not of an and of comparisons", Predicate.not(Predicate.and(eq, eq))],
    ["not of an or with one comparison", Predicate.not(Predicate.or(lit(false), eq))],
    ["not of an or of one comparison", Predicate.not(Predicate.or(eq))],
    ["not of a comparison", Predicate.not(eq)],
    ["double negation of a contradiction", Predicate.not(Predicate.not(lit(false)))],
    ["double negation of a comparison", Predicate.not(Predicate.not(eq))],
    ["and of a contradiction", Predicate.and(lit(false), eq)],
  ]

  it.each(forbidden)("forbids %s", async (_label, filter) => {
    const { repo, ops } = build(() => [], {}, "note")
    await expect(repo.deleteWhere!(filter)).rejects.toThrow('All-row deleteWhere on entity "note" is forbidden.')
    expect(ops).toEqual([])
  })

  it.each(allowed)("allows %s", async (_label, filter) => {
    const { repo } = build(() => changes(0), {}, "note")
    await expect(repo.deleteWhere!(filter)).resolves.toEqual({ deletedCount: 0 })
  })
})

describe("d1 repository write guards", () => {
  it("guards empty and all-row filters with the operation name in the message", async () => {
    const f = build(() => [{ primaryKey: "w1" }], {}, "widget", () => [])
    for (const name of ["updateOneWhere", "updateOneWhereReturning"]) {
      await expect(f.repo[name]!(undefined, { score: 1 }, oc(1))).rejects.toThrow(`${name}: cannot execute on widget without a filter predicate`)
      await expect(f.repo[name]!(Predicate.alwaysTrue(), { score: 1 }, oc(1))).rejects.toThrow(new ConfigurationError(`All-row ${name} on entity "widget" is forbidden.`))
    }
    await expect(f.repo.deleteWhere!(undefined, oc(1))).rejects.toThrow("deleteWhere: cannot execute on widget without a filter predicate")
    await expect(f.repo.deleteWhere!(Predicate.alwaysTrue(), oc(1))).rejects.toThrow(new ConfigurationError('All-row deleteWhere on entity "widget" is forbidden.'))
    expect(f.ops).toEqual([])
  })

  it("a versioned update requires an expected version and rejects an unincrementable one before any SQL", async () => {
    const f = build(() => [row()], {}, "widget", () => [row()])
    const filter = Predicate.eq("name", "x")
    await expect(f.repo.update!("w1", { name: "x" })).rejects.toThrow(new ConfigurationError('Versioned entity "widget" requires optimisticConcurrency.expectedVersion'))
    for (const name of ["update", "updateOneWhere", "updateOneWhereReturning"]) {
      const target = name === "update" ? "w1" : filter
      await expect(f.repo[name]!(target, { name: "x" }, oc(Number.MAX_SAFE_INTEGER))).rejects.toThrow("Entity version cannot be incremented beyond the maximum safe integer.")
      await expect(f.repo[name]!(target, { version: 4 }, oc(1))).rejects.toThrow(new ConfigurationError('Cannot set version field "version" directly; the framework auto-increments it'))
    }
    expect(f.ops).toEqual([])
  })

  it("an unversioned entity rejects optimistic concurrency with exact messages before any SQL", async () => {
    const f = build(() => [{ id: "n1", body: "x" }], {}, "note", () => [])
    const noVersion = new ConfigurationError('Entity "note" has no versionField configured. Optimistic concurrency requires a version column.')
    const filter = Predicate.eq("body", "x")
    await expect(f.repo.update!("n1", { body: "x" }, oc(1))).rejects.toThrow(noVersion)
    await expect(f.repo.updateOneWhere!(filter, { body: "y" }, oc(1))).rejects.toThrow(noVersion)
    await expect(f.repo.updateOneWhereReturning!(filter, { body: "y" }, oc(1))).rejects.toThrow(noVersion)
    expect(f.ops).toEqual([])
  })

  it("update requires updateOneWhereReturning support", async () => {
    const f = build(() => [])
    await expect(f.repo.update!("w1", { name: "x" }, oc(1))).rejects.toThrow(new ConfigurationError('Entity "widget" requires updateOneWhereReturning for update(id)'))
  })
})

describe("d1 updateOneWhere", () => {
  const filter = Predicate.eq("name", "a")
  const versioned = (picked: unknown[] = [{ primaryKey: "w1" }], updated: unknown = changes(1)): ScriptedHandler => (op) => (op.kind === "select" ? picked : updated)

  it("looks up at most two candidate keys, then updates the single match under the version fence", async () => {
    const f = build(versioned())
    expect(await f.repo.updateOneWhere!(filter, { name: "x" }, oc(3))).toEqual({ updatedCount: 1 })
    expect(f.ops[0]).toMatchObject({ kind: "select", limit: 2 })
    expect(Object.keys(f.ops[0]!.fields as object)).toEqual(["primaryKey"])
    expect(whereOf(f.ops[0])).toEqual({ sql: '("widgets"."name" = ?)', params: ["a"] })
    expect(whereOf(f.ops[1])).toEqual({ sql: `("widgets"."name" = ?) AND "widgets"."id" = ? AND "widgets"."version" = ? AND "widgets"."version" < ?`, params: ["a", "w1", 3, Number.MAX_SAFE_INTEGER] })
    expect(Object.keys(f.ops[1]!.set as object)).toEqual(["name", "version"])
    expect(setSql(f.ops[1]!.set, "version")).toEqual({ sql: '"widgets"."version" + 1', params: [] })
  })

  it("reports exact errors for multiple matches, no matches and a lost version race", async () => {
    await expect(build(versioned([{ primaryKey: "a" }, { primaryKey: "b" }])).repo.updateOneWhere!(filter, { name: "x" }, oc(3))).rejects.toThrow(new ValidationError("widget updateOneWhere matched multiple rows"))
    await expect(build(versioned([])).repo.updateOneWhere!(filter, { name: "x" }, oc(3))).rejects.toThrow(new OptimisticConcurrencyError("widget version mismatch: expected version 3"))
    await expect(build(versioned(undefined, changes(0))).repo.updateOneWhere!(filter, { name: "x" }, oc(3))).rejects.toThrow(new OptimisticConcurrencyError("widget version mismatch: expected version 3"))
  })

  it("on an unversioned entity updates by filter and key without version predicates and counts rows", async () => {
    const noteFilter = Predicate.eq("body", "x")
    const f = build((op) => (op.kind === "select" ? [{ primaryKey: "n1" }] : changes(2)), {}, "note")
    expect(await f.repo.updateOneWhere!(noteFilter, { body: "y" })).toEqual({ updatedCount: 2 })
    expect(whereOf(f.ops[1])).toEqual({ sql: '("notes"."body" = ?) AND "notes"."id" = ?', params: ["x", "n1"] })
    expect(f.ops[1]!.set).toEqual({ body: "y" })
    const none = build((op) => (op.kind === "select" ? [{ primaryKey: "n1" }] : changes(0)), {}, "note")
    expect(await none.repo.updateOneWhere!(noteFilter, { body: "y" })).toEqual({ updatedCount: 0 })
    expect(await build(() => [], {}, "note").repo.updateOneWhere!(noteFilter, { body: "y" })).toEqual({ updatedCount: 0 })
  })

  it("rethrows optimistic-concurrency failures untouched", async () => {
    const stale = new OptimisticConcurrencyError("raised by the driver layer")
    const f = build((op) => { if (op.kind === "select") return [{ primaryKey: "w1" }]; throw stale })
    expect(await f.repo.updateOneWhere!(filter, { name: "x" }, oc(3)).catch((e: unknown) => e)).toBe(stale)
  })
})

describe("d1 updateOneWhereReturning", () => {
  const filter = Predicate.eq("name", "a")
  const pick = (picked: unknown[] = [{ primaryKey: "w1" }]): ScriptedHandler => () => picked

  it("returns the updated row from a fenced single-row update", async () => {
    const f = build(pick(), {}, "widget", () => [row({ version: 4 })])
    expect(await f.repo.updateOneWhereReturning!(filter, { name: "x" }, oc(3))).toMatchObject({ id: "w1", version: 4 })
    expect(f.ops[0]).toMatchObject({ kind: "select", limit: 2 })
    expect(Object.keys(f.ops[0]!.fields as object)).toEqual(["primaryKey"])
    expect(whereOf(f.ops[0])).toEqual({ sql: '("widgets"."name" = ?)', params: ["a"] })
    expect(f.calls[0]!.where).toEqual({ sql: norm(`("widgets"."name" = ?) AND "widgets"."id" = ? AND "widgets"."version" = ? AND "widgets"."version" < ?`), params: ["a", "w1", 3, Number.MAX_SAFE_INTEGER] })
    expect(Object.keys(f.calls[0]!.set)).toEqual(["name", "version"])
    expect(setSql(f.calls[0]!.set, "version")).toEqual({ sql: '"widgets"."version" + 1', params: [] })
  })

  it("reports exact errors for multiple matches, no matches and a lost version race", async () => {
    await expect(build(pick([{ primaryKey: "a" }, { primaryKey: "b" }]), {}, "widget", () => []).repo.updateOneWhereReturning!(filter, { name: "x" }, oc(3))).rejects.toThrow(new ValidationError("widget updateOneWhereReturning matched multiple rows"))
    await expect(build(pick([]), {}, "widget", () => []).repo.updateOneWhereReturning!(filter, { name: "x" }, oc(3))).rejects.toThrow(new OptimisticConcurrencyError("widget version mismatch: expected version 3"))
    await expect(build(pick(), {}, "widget", () => []).repo.updateOneWhereReturning!(filter, { name: "x" }, oc(3))).rejects.toThrow(new OptimisticConcurrencyError("widget version mismatch: expected version 3"))
    expect(await build(pick([]), {}, "note", () => []).repo.updateOneWhereReturning!(Predicate.eq("body", "x"), { body: "y" })).toBeNull()
  })

  it("on an unversioned entity returns the row or null without a version assertion", async () => {
    const noteFilter = Predicate.eq("body", "x")
    const hit = build(pick([{ primaryKey: "n1" }]), {}, "note", () => [{ id: "n1", body: "y" }])
    expect(await hit.repo.updateOneWhereReturning!(noteFilter, { body: "y" })).toEqual({ id: "n1", body: "y" })
    expect(hit.calls[0]!.where).toEqual({ sql: '("notes"."body" = ?) AND "notes"."id" = ?', params: ["x", "n1"] })
    expect(hit.calls[0]!.set).toEqual({ body: "y" })
    const miss = build(pick([{ primaryKey: "n1" }]), {}, "note", () => [])
    expect(await miss.repo.updateOneWhereReturning!(noteFilter, { body: "y" })).toBeNull()
  })

  it("rejects a corrupt returned version and rethrows concurrency errors", async () => {
    await expect(build(pick(), {}, "widget", () => [row({ version: "x" })]).repo.updateOneWhereReturning!(filter, { name: "x" }, oc(3))).rejects.toThrow()
    const stale = new OptimisticConcurrencyError("raised by the driver layer")
    const f = build(pick(), {}, "widget", () => { throw stale })
    expect(await f.repo.updateOneWhereReturning!(filter, { name: "x" }, oc(3)).catch((e: unknown) => e)).toBe(stale)
  })

  it("update(id) returns the row, or reports a missing row with the entity name", async () => {
    const f = build(pick(), {}, "widget", () => [row({ version: 4 })])
    expect(await f.repo.update!("w1", { name: "x" }, oc(3))).toMatchObject({ version: 4 })
    const note = build(pick([]), {}, "note", () => [])
    await expect(note.repo.update!("n1", { body: "x" })).rejects.toThrow(new NotFoundError("note record not found"))
  })
})

describe("d1 delete and deleteWhere", () => {
  it("delete fences on the expected version, otherwise on the key alone", async () => {
    const f = build(() => changes(1))
    await f.repo.delete!("w1", oc(3))
    expect(f.ops[0]).toMatchObject({ kind: "delete" })
    expect(whereOf(f.ops[0])).toEqual({ sql: '("widgets"."id" = ? and "widgets"."version" = ?)', params: ["w1", 3] })
    const note = build(() => changes(1), {}, "note")
    await note.repo.delete!("n1")
    expect(whereOf(note.ops[0])).toEqual({ sql: '"notes"."id" = ?', params: ["n1"] })
    await expect(f.repo.delete!("w1")).rejects.toThrow('Versioned entity "widget" requires optimisticConcurrency.expectedVersion')
  })

  it("delete distinguishes a stale version from a missing row and honours idempotent deletes", async () => {
    const stale = build((op) => (op.kind === "select" ? [{ primaryKey: "w1" }] : changes(0)))
    await expect(stale.repo.delete!("w1", oc(3))).rejects.toThrow(new OptimisticConcurrencyError("widget version mismatch: expected version 3"))
    expect(stale.ops[1]).toMatchObject({ kind: "select", limit: 2 })
    expect(Object.keys(stale.ops[1]!.fields as object)).toEqual(["primaryKey"])
    expect(whereOf(stale.ops[1])).toEqual({ sql: '"widgets"."id" = ?', params: ["w1"] })
    const gone = build((op) => (op.kind === "select" ? [] : changes(0)))
    await expect(gone.repo.delete!("w1", oc(3))).rejects.toThrow(new NotFoundError("widget record not found"))
    await expect(gone.repo.delete!("w1", { ...oc(3), idempotent: false })).rejects.toThrow("widget record not found")
    await expect(gone.repo.delete!("w1", { ...oc(3), idempotent: true })).resolves.toBeUndefined()
    const note = build(() => changes(0), {}, "note")
    await expect(note.repo.delete!("n1")).rejects.toThrow(new NotFoundError("note record not found"))
    await expect(note.repo.delete!("n1", { idempotent: true })).resolves.toBeUndefined()
    const visible = build((op) => (op.kind === "select" ? [{ primaryKey: "n1" }] : changes(0)), {}, "note")
    await expect(visible.repo.delete!("n1")).rejects.toThrow(new NotFoundError("note record not found"))
    expect(visible.ops.map((op) => op.kind)).toEqual(["delete"])
    await expect(note.repo.delete!("n1", oc(1))).rejects.toThrow(new ConfigurationError('Optimistic concurrency for "note" requires a mapped version field'))
  })

  it("deleteWhere fences on the version, counts deleted rows and classifies misses", async () => {
    const filter = Predicate.eq("name", "a")
    const f = build(() => changes(2))
    expect(await f.repo.deleteWhere!(filter, oc(3))).toEqual({ deletedCount: 2 })
    expect(whereOf(f.ops[0])).toEqual({ sql: '(("widgets"."name" = ?) and "widgets"."version" = ?)', params: ["a", 3] })
    const stale = build((op) => (op.kind === "select" ? [{ primaryKey: "w1" }] : changes(0)))
    await expect(stale.repo.deleteWhere!(filter, oc(3))).rejects.toThrow(new OptimisticConcurrencyError("widget version mismatch: expected version 3"))
    expect(whereOf(stale.ops[1])).toEqual({ sql: '("widgets"."name" = ?)', params: ["a"] })
    expect(Object.keys(stale.ops[1]!.fields as object)).toEqual(["primaryKey"])
    expect(stale.ops[1]).toMatchObject({ limit: 2 })
    const gone = build((op) => (op.kind === "select" ? [] : changes(0)))
    await expect(gone.repo.deleteWhere!(filter, oc(3))).rejects.toThrow(new NotFoundError("widget record not found"))
    const note = build(() => changes(1), {}, "note")
    expect(await note.repo.deleteWhere!(Predicate.eq("body", "x"))).toEqual({ deletedCount: 1 })
    expect(whereOf(note.ops[0])).toEqual({ sql: '("notes"."body" = ?)', params: ["x"] })
    await expect(note.repo.deleteWhere!(Predicate.eq("body", "x"), oc(1))).rejects.toThrow(new ConfigurationError('Optimistic concurrency for "note" requires a mapped version field'))
  })
})
