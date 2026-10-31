import { describe, expect, it } from "vitest"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { BusinessRuleError, ConfigurationError, ConflictError, NotFoundError, OptimisticConcurrencyError, Predicate, ValidationError } from "@xonava/core/domain"
import type { PredicateNode } from "@xonava/core/domain"
import { createDrizzleRepository } from "../drizzleRepository"
import { createScriptedDb, renderSql, type ScriptedHandler, type ScriptedOp } from "../../__tests__/support/scriptedDb"

const widgets = pgTable("widgets", { id: text("id").primaryKey(), name: text("name").notNull(), score: integer("score"), version: integer("version").notNull(), createdAt: integer("created_at") })
const notes = pgTable("notes", { id: text("id").primaryKey(), body: text("body").notNull() })
const slugs = pgTable("slugs", { slug: text("slug").primaryKey(), id: text("id"), label: text("label") })
const widgetColumns = { id: widgets.id, name: widgets.name, score: widgets.score, version: widgets.version, createdAt: widgets.createdAt }
const noteColumns = { id: notes.id, body: notes.body }
const widgetEntity = { name: "widget", primaryKey: "id", versionField: "version", fields: {} }
const noteEntity = { name: "note", primaryKey: "id", fields: {} }

type Repo = Record<string, (...args: unknown[]) => Promise<unknown>>
type Kind = "widget" | "note"
function build(handler: ScriptedHandler, extra: Record<string, unknown> = {}, kind: Kind = "widget") {
  const scripted = createScriptedDb("pg", handler)
  const repo = createDrizzleRepository({
    db: scripted.db as never,
    table: (kind === "widget" ? widgets : notes) as never,
    entity: (kind === "widget" ? widgetEntity : noteEntity) as never,
    columnMap: (kind === "widget" ? widgetColumns : noteColumns) as never,
    ...extra,
  } as never) as unknown as Repo
  return { repo, ops: scripted.ops }
}
const row = (overrides: Record<string, unknown> = {}) => ({ id: "w1", name: "alpha", score: 1, version: 1, createdAt: 1, ...overrides })
const norm = (sql: string | undefined) => (sql ?? "").replace(/\s+/g, " ")
const whereOf = (op: ScriptedOp | undefined) => ({ sql: norm(op?.where?.sql), params: op?.where?.params })
const setSql = (op: ScriptedOp | undefined, key: string) => { const r = renderSql("pg", (op?.set as Record<string, unknown>)[key]); return { sql: norm(r?.sql), params: r?.params } }
const providerError = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error("provider text"), { code, ...extra })
const MAX = "9007199254740991"
const oc = (expectedVersion: unknown = 3) => ({ optimisticConcurrency: { expectedVersion } })
const countThen = (rows: unknown[], count: unknown = 0): ScriptedHandler => (op) => (op.fields && "count" in (op.fields as object) ? [{ count }] : rows)
const pageOp = (ops: ScriptedOp[]) => ops.find((op) => op.offset !== undefined)!

describe("repository construction", () => {
  const noop = () => []
  const make = (extra: Record<string, unknown>, entity: Record<string, unknown> = widgetEntity, columnMap: Record<string, unknown> = widgetColumns) =>
    createDrizzleRepository({ db: createScriptedDb("pg", noop).db as never, table: widgets as never, entity: entity as never, columnMap: columnMap as never, ...extra } as never)

  it("resolves the primary key from the descriptor, defaulting to id", async () => {
    const scripted = createScriptedDb("pg", () => [{ slug: "s1" }])
    const custom = createDrizzleRepository({ db: scripted.db as never, table: slugs as never, entity: { name: "slugged", primaryKey: "slug", fields: {} } as never, columnMap: { slug: slugs.slug, id: slugs.id, label: slugs.label } as never }) as unknown as Repo
    await custom.findById!("s1")
    expect(whereOf(scripted.ops[0])).toEqual({ sql: '"slugs"."slug" = $1', params: ["s1"] })
    const implicit = createDrizzleRepository({ db: scripted.db as never, table: slugs as never, entity: { name: "slugged", fields: {} } as never, columnMap: { slug: slugs.slug, id: slugs.id } as never }) as unknown as Repo
    await implicit.findById!("i1")
    expect(whereOf(scripted.ops[1])).toEqual({ sql: '"slugs"."id" = $1', params: ["i1"] })
    expect(() => make({}, { name: "slugged", fields: {} }, { slug: slugs.slug })).toThrow(new Error('Entity slugged is missing primary key column "id"'))
  })

  it("validates page-size and offset bounds with exact messages", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => make({ maxPageSize: bad })).toThrow(new ConfigurationError("PostgreSQL maxPageSize must be a finite positive integer"))
    expect(() => make({ maxPageSize: 1 })).not.toThrow()
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => make({ maxOffset: bad })).toThrow(new ConfigurationError("PostgreSQL maxOffset must be a finite non-negative integer"))
    expect(() => make({ maxOffset: 0 })).not.toThrow()
    expect(() => make({ maxOffset: undefined })).not.toThrow()
  })

  it("compiles predicates with the PostgreSQL dialect by default", async () => {
    const { repo, ops } = build(() => [row()])
    await repo.findOneWhere!(Predicate.gt("name", "al"))
    expect(whereOf(ops[0]).sql).toContain('COLLATE "C"')
  })
})

describe("repository reads", () => {
  it("rejects a missing filter with the operation and entity in the message", async () => {
    const { repo } = build(() => [])
    for (const filter of [undefined, null]) {
      await expect(repo.findOneWhere!(filter)).rejects.toThrow(
        new ValidationError("findOneWhere: cannot execute on widget without a filter predicate — empty predicates would match all rows."),
      )
    }
    await expect(build(() => [], {}, "note").repo.findOneWhere!(undefined)).rejects.toThrow("cannot execute on note without")
  })

  it("orders by creation time then id by default, and by the primary key alone when there is no creation column", async () => {
    const widget = build(countThen([]))
    await widget.repo.findMany!()
    expect(norm(pageOp(widget.ops).orderBy!.sql)).toBe('"widgets"."created_at" asc, "widgets"."id" asc')
    const note = build(countThen([]), {}, "note")
    await note.repo.findMany!()
    expect(norm(pageOp(note.ops).orderBy!.sql)).toBe('"notes"."id"')
    const empty = build(countThen([]))
    await empty.repo.findMany!({ sort: [] })
    expect(norm(pageOp(empty.ops).orderBy!.sql)).toBe('"widgets"."created_at" asc, "widgets"."id" asc')
  })

  it.each([
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

  it("accepts strong consistency and rejects weaker levels", async () => {
    const strong = build(countThen([row()], 1))
    expect((await strong.repo.findMany!({ consistency: "strong", pagination: { kind: "offset", page: 1, pageSize: 20, includeTotal: true } }) as { rowCount: number }).rowCount).toBe(1)
    await expect(build(countThen([])).repo.findMany!({ consistency: "eventual" })).rejects.toThrow()
  })

  it("validates the query plan before touching the database", async () => {
    const tooMany = Predicate.and(...Array.from({ length: 60 }, (_, i) => Predicate.eq("name", `n${i}`)))
    const cases: Record<string, unknown>[] = [
      { filter: tooMany },
      { sort: [{ field: "score", direction: "asc" }, { field: "score", direction: "desc" }] },
      { projection: { fields: ["id", "id"] } },
    ]
    for (const options of cases) {
      const f = build(countThen([]))
      await expect(f.repo.findMany!(options)).rejects.toBeInstanceOf(ValidationError)
      expect(f.ops).toEqual([])
    }
  })

  it("validates the consistency level as part of the query plan, and ignores unknown pagination kinds", async () => {
    const f = build(countThen([]))
    await expect(f.repo.findMany!({ consistency: "bogus" })).rejects.toThrow(new ValidationError("query consistency is invalid"))
    await expect(f.repo.findMany!({ consistency: "eventual" })).rejects.toThrow("read consistency eventual is not proven for the selected datasource topology")
    expect(f.ops).toEqual([])
    const g = build(countThen([]))
    const result = await g.repo.findMany!({ pagination: { kind: "other", page: 3, pageSize: 5 } }) as { page: number; pageSize: number }
    expect(result).toMatchObject({ page: 1, pageSize: 20 })
    expect(pageOp(g.ops)).toMatchObject({ limit: 20, offset: 0 })
  })

  it("requires a non-empty sort for cursor pagination and reads one extra row for the next-page probe", async () => {
    const f = build(countThen([]))
    const cursor = { kind: "cursor", limit: 3, direction: "after" }
    await expect(f.repo.findMany!({ pagination: cursor })).rejects.toThrow(new ValidationError("cursor pagination requires an explicit stable sort"))
    await expect(f.repo.findMany!({ sort: [], pagination: cursor })).rejects.toThrow("cursor pagination requires an explicit stable sort")
    expect(f.ops).toEqual([])
    const ok = build(countThen([row(), row({ id: "w2" }), row({ id: "w3" }), row({ id: "w4" })], 9))
    const result = await ok.repo.findMany!({ sort: [{ field: "name", direction: "asc" }], pagination: cursor }) as { rows: unknown[]; rowCount?: number; page: number; pageSize: number; pageInfo: unknown }
    expect(pageOp(ok.ops)).toMatchObject({ limit: 4, offset: 0 })
    expect(result.rows).toHaveLength(3)
    expect(result).toMatchObject({ page: 1, pageSize: 3, pageInfo: { kind: "cursor", hasNextPage: true, hasPreviousPage: false } })
    // Cursor pages never carry a total and never run a COUNT.
    expect(result).not.toHaveProperty("rowCount")
    expect(ok.ops.some((op) => op.fields && "count" in (op.fields as object))).toBe(false)
  })

  it("runs no COUNT and omits rowCount unless an offset request asks for the total", async () => {
    const none = build(countThen([row()], 99))
    const plain = await none.repo.findMany!({ pagination: { kind: "offset", page: 1, pageSize: 5 } })
    expect(plain).not.toHaveProperty("rowCount")
    expect(none.ops.some((op) => op.fields && "count" in (op.fields as object))).toBe(false)
    expect(none.ops).toHaveLength(1)
    const explicitOff = build(countThen([row()], 99))
    expect(await explicitOff.repo.findMany!({ pagination: { kind: "offset", page: 1, pageSize: 5, includeTotal: false } })).not.toHaveProperty("rowCount")
    expect(explicitOff.ops).toHaveLength(1)
    const asked = build(countThen([row()], 99))
    expect(await asked.repo.findMany!({ pagination: { kind: "offset", page: 1, pageSize: 5, includeTotal: true } })).toMatchObject({ rowCount: 99 })
    expect(asked.ops.filter((op) => op.fields && "count" in (op.fields as object))).toHaveLength(1)
  })

  it("counts the caller's filter only: the count carries the same WHERE as an offset page and a cursor page has no count", async () => {
    const filter = Predicate.eq("name", "alpha")
    const counted = build(countThen([row()], 4))
    await counted.repo.findMany!({ filter, pagination: { kind: "offset", page: 2, pageSize: 1, includeTotal: true } })
    const countOp = counted.ops.find((op) => op.fields && "count" in (op.fields as object))!
    expect(whereOf(countOp)).toEqual(whereOf(pageOp(counted.ops)))
    expect(countOp.offset).toBeUndefined()
    const cursored = build(countThen([row(), row({ id: "w2" })], 4))
    const sort = [{ field: "name", direction: "asc" }, { field: "id", direction: "asc" }]
    const page = (await cursored.repo.findMany!({ filter, sort, pagination: { kind: "cursor", direction: "after", values: ["alpha", "w1"], limit: 1 } })) as { rows: unknown[] }
    expect(page.rows).toHaveLength(1)
    expect(cursored.ops.some((op) => op.fields && "count" in (op.fields as object))).toBe(false)
    expect(norm(pageOp(cursored.ops).where?.sql)).not.toEqual(whereOf(countOp).sql)
  })

  it("countUpTo issues a bounded SELECT 1 under the given filter and returns the row count", async () => {
    const f = build((op) => (op.limit === 3 ? [{ one: 1 }, { one: 1 }, { one: 1 }] : []))
    const filter = Predicate.eq("name", "alpha")
    expect(await f.repo.countUpTo!(filter, 3)).toBe(3)
    expect(f.ops).toHaveLength(1)
    expect(f.ops[0]).toMatchObject({ limit: 3 })
    expect(f.ops[0]!.offset).toBeUndefined()
    expect(whereOf(f.ops[0]).sql).toContain("name")
    await expect(f.repo.countUpTo!(filter, 0)).rejects.toThrow("countUpTo limit must be a positive integer")
    await expect(f.repo.countUpTo!(undefined, 1.5)).rejects.toThrow(ValidationError)
  })

  it("reports a zero row count when the count query returns nothing, and numbers from text counts", async () => {
    const total = { pagination: { kind: "offset", page: 1, pageSize: 20, includeTotal: true } }
    const none = build((op) => (op.fields && "count" in (op.fields as object) ? [] : [row()]))
    expect(((await none.repo.findMany!(total)) as { rowCount: number }).rowCount).toBe(0)
    const text = build(countThen([row()], "12"))
    expect(((await text.repo.findMany!(total)) as { rowCount: number }).rowCount).toBe(12)
    const missing = build((op) => (op.fields && "count" in (op.fields as object) ? [{}] : []))
    expect(((await missing.repo.findMany!(total)) as { rowCount: number }).rowCount).toBe(0)
  })
})

describe("repository write guards", () => {
  it("a versioned update requires an expected version and rejects an unincrementable one before any SQL", async () => {
    const f = build(() => [row()])
    await expect(f.repo.update!("w1", { name: "x" })).rejects.toThrow(new ConfigurationError('Versioned entity "widget" requires optimisticConcurrency.expectedVersion'))
    await expect(f.repo.update!("w1", { name: "x" }, oc(Number.MAX_SAFE_INTEGER))).rejects.toThrow("Entity version cannot be incremented beyond the maximum safe integer.")
    await expect(f.repo.update!("w1", { version: 4 }, oc(1))).rejects.toThrow(new ConfigurationError('Cannot set version field "version" directly; the framework auto-increments it'))
    expect(f.ops).toEqual([])
  })

  it("an unversioned entity rejects optimistic concurrency with exact messages before any SQL", async () => {
    const f = build(() => [{ id: "n1", body: "x" }], {}, "note")
    const noVersion = new ConfigurationError('Entity "note" has no versionField configured. Optimistic concurrency requires a version column.')
    await expect(f.repo.update!("n1", { body: "x" }, oc(1))).rejects.toThrow(noVersion)
    await expect(f.repo.update!("n1", { body: "x" }, oc(Number.MAX_SAFE_INTEGER))).rejects.toThrow("Entity version cannot be incremented beyond the maximum safe integer.")
    const filter = Predicate.eq("body", "x")
    await expect(f.repo.updateOneWhere!(filter, { body: "y" }, oc(1))).rejects.toThrow(noVersion)
    await expect(f.repo.updateOneWhere!(filter, { body: "y" }, oc(Number.MAX_SAFE_INTEGER))).rejects.toThrow("Entity version cannot be incremented beyond the maximum safe integer.")
    await expect(f.repo.updateOneWhereReturning!(filter, { body: "y" }, oc(1))).rejects.toThrow(noVersion)
    await expect(f.repo.updateOneWhereReturning!(filter, { body: "y" }, oc(Number.MAX_SAFE_INTEGER))).rejects.toThrow("Entity version cannot be incremented beyond the maximum safe integer.")
    expect(f.ops).toEqual([])
  })

  it("updateOneWhere and updateOneWhereReturning enforce the version contract before any SQL", async () => {
    const f = build(() => [{ primaryKey: "w1" }])
    const filter = Predicate.eq("name", "x")
    for (const name of ["updateOneWhere", "updateOneWhereReturning"]) {
      await expect(f.repo[name]!(filter, { score: 1 })).rejects.toThrow('Versioned entity "widget" requires optimisticConcurrency.expectedVersion')
      await expect(f.repo[name]!(filter, { score: 1 }, oc(Number.MAX_SAFE_INTEGER))).rejects.toThrow("Entity version cannot be incremented beyond the maximum safe integer.")
      await expect(f.repo[name]!(filter, { version: 9 }, oc(1))).rejects.toThrow('Cannot set version field "version" directly')
    }
    expect(f.ops).toEqual([])
  })

  it("guards empty and all-row filters with the operation name in the message", async () => {
    const f = build(() => [{ primaryKey: "w1" }])
    for (const name of ["updateOneWhere", "updateOneWhereReturning"]) {
      await expect(f.repo[name]!(undefined, { score: 1 }, oc(1))).rejects.toThrow(`${name}: cannot execute on widget without a filter predicate`)
      await expect(f.repo[name]!(Predicate.alwaysTrue(), { score: 1 }, oc(1))).rejects.toThrow(new ConfigurationError(`All-row ${name} on entity "widget" is forbidden.`))
    }
    await expect(f.repo.deleteWhere!(undefined, oc(1))).rejects.toThrow("deleteWhere: cannot execute on widget without a filter predicate")
    await expect(f.repo.deleteWhere!(Predicate.alwaysTrue(), oc(1))).rejects.toThrow(new ConfigurationError('All-row deleteWhere on entity "widget" is forbidden.'))
    expect(f.ops).toEqual([])
  })
})

describe("all-row predicate classification", () => {
  const lit = (value: boolean): PredicateNode => Predicate.literal(value)
  const eq = Predicate.eq("body", "x")
  const forbidden: [string, PredicateNode][] = [
    ["literal true", lit(true)],
    ["empty and", Predicate.and()],
    ["and of tautologies", Predicate.and(lit(true), Predicate.and())],
    ["or containing a tautology", Predicate.or(eq, lit(true))],
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
    const { repo } = build(() => [], {}, "note")
    await expect(repo.deleteWhere!(filter)).resolves.toEqual({ deletedCount: 0 })
  })
})

describe("repository writes", () => {
  it("insert on an unversioned entity returns the row and rejects an empty RETURNING with the entity name", async () => {
    const ok = build(() => [{ id: "n1", body: "x" }], {}, "note")
    expect(await ok.repo.insert!({ id: "n1", body: "x" })).toEqual({ id: "n1", body: "x" })
    expect(ok.ops[0]!.values).toEqual({ id: "n1", body: "x" })
    const empty = build(() => [], {}, "note")
    await expect(empty.repo.insert!({ id: "n1", body: "x" })).rejects.toThrow(new ConfigurationError("note INSERT ... RETURNING returned no rows"))
    const bad = build(() => [row({ version: 0.5 })])
    await expect(bad.repo.insert!({ id: "w1", name: "a" })).rejects.toThrow()
  })

  it("update bumps the version in SQL and fences on the expected version and the maximum", async () => {
    const f = build(() => [row({ version: 4 })])
    expect(await f.repo.update!("w1", { name: "x" }, oc(3))).toMatchObject({ version: 4 })
    expect(whereOf(f.ops[0])).toEqual({ sql: `"widgets"."id" = $1 AND "widgets"."version" = $2 AND "widgets"."version" < ${MAX}`, params: ["w1", 3] })
    expect(Object.keys(f.ops[0]!.set as object)).toEqual(["name", "version"])
    expect(setSql(f.ops[0], "version")).toEqual({ sql: '"widgets"."version" + 1', params: [] })
    const plain = build(() => [{ id: "n1", body: "y" }], {}, "note")
    expect(await plain.repo.update!("n1", { body: "y" })).toEqual({ id: "n1", body: "y" })
    expect(whereOf(plain.ops[0])).toEqual({ sql: '"notes"."id" = $1', params: ["n1"] })
    expect(plain.ops[0]!.set).toEqual({ body: "y" })
  })

  it("update reports stale versions and missing rows with the entity name", async () => {
    const f = build(() => [])
    await expect(f.repo.update!("w1", { name: "x" }, oc(3))).rejects.toThrow(new OptimisticConcurrencyError("widget version mismatch: expected version 3"))
    const note = build(() => [], {}, "note")
    await expect(note.repo.update!("n1", { body: "x" })).rejects.toThrow(new NotFoundError("note record not found"))
    const corrupt = build(() => [row({ version: "x" })])
    await expect(corrupt.repo.update!("w1", { name: "x" }, oc(3))).rejects.toThrow()
    const unversionedExtra = build(() => [{ id: "n1", body: "x" }], {}, "note")
    expect(await unversionedExtra.repo.update!("n1", { body: "x" })).toEqual({ id: "n1", body: "x" })
  })

  it("maps constraints to fields only for conflicts that name a mapped constraint of their own", async () => {
    const mapped = { constraintMap: { widgets_name_key: "name" } }
    const unique = build(() => { throw providerError("23505", { constraint: "widgets_name_key" }) }, mapped)
    const conflict = (await unique.repo.insert!({ id: "w", name: "a" }).catch((e: unknown) => e)) as ConflictError
    expect(conflict).toBeInstanceOf(ConflictError)
    expect(conflict.message).toBe("A record with this value already exists")
    expect(conflict.details).toEqual({ dialect: "postgresql", providerCode: "23505", field: "name" })
    const foreign = build(() => { throw providerError("23503", { constraint: "widgets_name_key" }) }, mapped)
    const fk = (await foreign.repo.insert!({ id: "w", name: "a" }).catch((e: unknown) => e)) as Error
    expect(fk).toBeInstanceOf(BusinessRuleError)
    expect(fk).not.toBeInstanceOf(ConflictError)
    for (const inherited of ["toString", "constructor", "hasOwnProperty"]) {
      const f = build(() => { throw providerError("23505", { constraint: inherited }) }, mapped)
      const error = (await f.repo.insert!({ id: "w", name: "a" }).catch((e: unknown) => e)) as ConflictError
      expect(error).toBeInstanceOf(ConflictError)
      expect(error.details).toEqual({ dialect: "postgresql", providerCode: "23505" })
    }
    const undefinedKey = build(() => { throw providerError("23505") }, { constraintMap: { undefined: "ghost" } })
    expect(((await undefinedKey.repo.insert!({ id: "w", name: "a" }).catch((e: unknown) => e)) as ConflictError).details).toEqual({ dialect: "postgresql", providerCode: "23505" })
    const alreadyConflict = new ConflictError("already", { field: "keep" })
    const passthrough = build(() => { throw alreadyConflict }, mapped)
    expect(await passthrough.repo.insert!({ id: "w", name: "a" }).catch((e: unknown) => e)).toBe(alreadyConflict)
    const noConstraint = build(() => { throw providerError("23505") }, mapped)
    expect(((await noConstraint.repo.insert!({ id: "w", name: "a" }).catch((e: unknown) => e)) as ConflictError).details).toEqual({ dialect: "postgresql", providerCode: "23505" })
  })
})

describe("updateOneWhere", () => {
  const filter = Predicate.eq("name", "a")
  const versioned = (updateRows: unknown[] = [row({ version: 4 })], picked: unknown[] = [{ primaryKey: "w1" }]): ScriptedHandler => (op) => (op.kind === "select" ? picked : updateRows)

  it("looks up at most two candidate keys, then updates the single match under the version fence", async () => {
    const f = build(versioned())
    expect(await f.repo.updateOneWhere!(filter, { name: "x" }, oc(3))).toEqual({ updatedCount: 1 })
    expect(f.ops[0]).toMatchObject({ kind: "select", limit: 2 })
    expect(Object.keys(f.ops[0]!.fields as object)).toEqual(["primaryKey"])
    expect(whereOf(f.ops[0])).toEqual({ sql: '("widgets"."name" = $1)', params: ["a"] })
    expect(whereOf(f.ops[1])).toEqual({ sql: `("widgets"."name" = $1) AND "widgets"."id" = $2 AND "widgets"."version" = $3 AND "widgets"."version" < ${MAX}`, params: ["a", "w1", 3] })
    expect(Object.keys(f.ops[1]!.set as object)).toEqual(["name", "version"])
    expect(setSql(f.ops[1], "version")).toEqual({ sql: '"widgets"."version" + 1', params: [] })
    expect(f.ops[1]!.returning).toBe(true)
  })

  it("reports exact errors for multiple matches, no matches and a lost version race", async () => {
    await expect(build(versioned([], [{ primaryKey: "a" }, { primaryKey: "b" }])).repo.updateOneWhere!(filter, { name: "x" }, oc(3))).rejects.toThrow(new ValidationError("widget updateOneWhere matched multiple rows"))
    await expect(build(versioned([], [])).repo.updateOneWhere!(filter, { name: "x" }, oc(3))).rejects.toThrow(new OptimisticConcurrencyError("widget version mismatch: expected version 3"))
    await expect(build(versioned([])).repo.updateOneWhere!(filter, { name: "x" }, oc(3))).rejects.toThrow(new OptimisticConcurrencyError("widget version mismatch: expected version 3"))
    const failing = build((op) => { if (op.kind === "select") return [{ primaryKey: "w1" }]; throw providerError("40001") })
    await expect(failing.repo.updateOneWhere!(filter, { name: "x" }, oc(3))).rejects.toThrow("retry")
  })

  it("on an unversioned entity updates by filter and key without version predicates and counts rows", async () => {
    const noteFilter = Predicate.eq("body", "x")
    const f = build((op) => (op.kind === "select" ? [{ primaryKey: "n1" }] : [{ id: "n1", body: "y" }, { id: "n2", body: "y" }]), {}, "note")
    expect(await f.repo.updateOneWhere!(noteFilter, { body: "y" })).toEqual({ updatedCount: 2 })
    expect(whereOf(f.ops[1])).toEqual({ sql: '("notes"."body" = $1) AND "notes"."id" = $2', params: ["x", "n1"] })
    expect(f.ops[1]!.set).toEqual({ body: "y" })
    expect(await build(() => [], {}, "note").repo.updateOneWhere!(noteFilter, { body: "y" })).toEqual({ updatedCount: 0 })
  })

  it("rethrows optimistic-concurrency failures untouched and normalizes other update failures", async () => {
    const stale = new OptimisticConcurrencyError("raised by the driver layer")
    const f = build((op) => { if (op.kind === "select") return [{ primaryKey: "w1" }]; throw stale })
    expect(await f.repo.updateOneWhere!(filter, { name: "x" }, oc(3)).catch((e: unknown) => e)).toBe(stale)
    const unique = build((op) => { if (op.kind === "select") return [{ primaryKey: "w1" }]; throw providerError("23505", { constraint: "widgets_name_key" }) }, { constraintMap: { widgets_name_key: "name" } })
    const error = (await unique.repo.updateOneWhere!(filter, { name: "x" }, oc(3)).catch((e: unknown) => e)) as ConflictError
    expect(error.details).toMatchObject({ field: "name" })
  })
})

describe("updateOneWhereReturning", () => {
  const filter = Predicate.eq("name", "a")
  const versioned = (updateRows: unknown[] = [row({ version: 4 })], picked: unknown[] = [{ primaryKey: "w1" }]): ScriptedHandler => (op) => (op.kind === "select" ? picked : updateRows)

  it("returns the updated row from a fenced single-row update", async () => {
    const f = build(versioned())
    expect(await f.repo.updateOneWhereReturning!(filter, { name: "x" }, oc(3))).toMatchObject({ id: "w1", version: 4 })
    expect(f.ops[0]).toMatchObject({ kind: "select", limit: 2 })
    expect(Object.keys(f.ops[0]!.fields as object)).toEqual(["primaryKey"])
    expect(whereOf(f.ops[1])).toEqual({ sql: `("widgets"."name" = $1) AND "widgets"."id" = $2 AND "widgets"."version" = $3 AND "widgets"."version" < ${MAX}`, params: ["a", "w1", 3] })
    expect(Object.keys(f.ops[1]!.set as object)).toEqual(["name", "version"])
    expect(setSql(f.ops[1], "version")).toEqual({ sql: '"widgets"."version" + 1', params: [] })
  })

  it("reports exact errors for multiple matches, no matches and a lost version race", async () => {
    await expect(build(versioned([], [{ primaryKey: "a" }, { primaryKey: "b" }])).repo.updateOneWhereReturning!(filter, { name: "x" }, oc(3))).rejects.toThrow(new ValidationError("widget updateOneWhereReturning matched multiple rows"))
    await expect(build(versioned([], [])).repo.updateOneWhereReturning!(filter, { name: "x" }, oc(3))).rejects.toThrow(new OptimisticConcurrencyError("widget version mismatch: expected version 3"))
    await expect(build(versioned([])).repo.updateOneWhereReturning!(filter, { name: "x" }, oc(3))).rejects.toThrow(new OptimisticConcurrencyError("widget version mismatch: expected version 3"))
    expect(await build(() => [], {}, "note").repo.updateOneWhereReturning!(Predicate.eq("body", "x"), { body: "y" })).toBeNull()
  })

  it("on an unversioned entity returns the row or null without a version assertion", async () => {
    const noteFilter = Predicate.eq("body", "x")
    const hit = build((op) => (op.kind === "select" ? [{ primaryKey: "n1" }] : [{ id: "n1", body: "y" }]), {}, "note")
    expect(await hit.repo.updateOneWhereReturning!(noteFilter, { body: "y" })).toEqual({ id: "n1", body: "y" })
    expect(whereOf(hit.ops[1])).toEqual({ sql: '("notes"."body" = $1) AND "notes"."id" = $2', params: ["x", "n1"] })
    expect(hit.ops[1]!.set).toEqual({ body: "y" })
    const miss = build((op) => (op.kind === "select" ? [{ primaryKey: "n1" }] : []), {}, "note")
    expect(await miss.repo.updateOneWhereReturning!(noteFilter, { body: "y" })).toBeNull()
  })

  it("rejects a corrupt returned version, rethrows concurrency errors and maps constraint conflicts", async () => {
    await expect(build(versioned([row({ version: "x" })])).repo.updateOneWhereReturning!(filter, { name: "x" }, oc(3))).rejects.toThrow()
    const stale = new OptimisticConcurrencyError("raised by the driver layer")
    const f = build((op) => { if (op.kind === "select") return [{ primaryKey: "w1" }]; throw stale })
    expect(await f.repo.updateOneWhereReturning!(filter, { name: "x" }, oc(3)).catch((e: unknown) => e)).toBe(stale)
    const unique = build((op) => { if (op.kind === "select") return [{ primaryKey: "w1" }]; throw providerError("23505", { constraint: "widgets_name_key" }) }, { constraintMap: { widgets_name_key: "name" } })
    expect(((await unique.repo.updateOneWhereReturning!(filter, { name: "x" }, oc(3)).catch((e: unknown) => e)) as ConflictError).details).toMatchObject({ field: "name" })
  })
})

describe("delete and deleteWhere", () => {
  it("delete fences on the expected version, otherwise on the key alone", async () => {
    const f = build(() => [row()])
    await f.repo.delete!("w1", oc(3))
    expect(whereOf(f.ops[0])).toEqual({ sql: '("widgets"."id" = $1 and "widgets"."version" = $2)', params: ["w1", 3] })
    expect(f.ops[0]!.returning).toBe(true)
    const note = build(() => [{ id: "n1" }], {}, "note")
    await note.repo.delete!("n1")
    expect(whereOf(note.ops[0])).toEqual({ sql: '"notes"."id" = $1', params: ["n1"] })
    await expect(f.repo.delete!("w1")).rejects.toThrow('Versioned entity "widget" requires optimisticConcurrency.expectedVersion')
    await f.repo.delete!("w1", oc(Number.MAX_SAFE_INTEGER))
  })

  it("delete distinguishes a stale version from a missing row and honours idempotent deletes", async () => {
    const stale = build((op) => (op.kind === "select" ? [{ primaryKey: "w1" }] : []))
    await expect(stale.repo.delete!("w1", oc(3))).rejects.toThrow(new OptimisticConcurrencyError("widget version mismatch: expected version 3"))
    expect(stale.ops[1]).toMatchObject({ kind: "select", limit: 2 })
    expect(Object.keys(stale.ops[1]!.fields as object)).toEqual(["primaryKey"])
    expect(whereOf(stale.ops[1])).toEqual({ sql: '"widgets"."id" = $1', params: ["w1"] })
    const gone = build(() => [])
    await expect(gone.repo.delete!("w1", oc(3))).rejects.toThrow(new NotFoundError("widget record not found"))
    await expect(gone.repo.delete!("w1", { ...oc(3), idempotent: false })).rejects.toThrow("widget record not found")
    await expect(gone.repo.delete!("w1", { ...oc(3), idempotent: true })).resolves.toBeUndefined()
    const note = build(() => [], {}, "note")
    await expect(note.repo.delete!("n1")).rejects.toThrow(new NotFoundError("note record not found"))
    await expect(note.repo.delete!("n1", { idempotent: true })).resolves.toBeUndefined()
    const visible = build((op) => (op.kind === "select" ? [{ primaryKey: "n1" }] : []), {}, "note")
    await expect(visible.repo.delete!("n1")).rejects.toThrow(new NotFoundError("note record not found"))
    expect(visible.ops.map((op) => op.kind)).toEqual(["delete"])
    const failing = build(() => { throw providerError("40001") })
    await expect(failing.repo.delete!("w1", oc(3))).rejects.toThrow("retry")
    await expect(note.repo.delete!("n1", oc(1))).rejects.toThrow(new ConfigurationError('Optimistic concurrency for "note" requires a mapped version field'))
  })

  it("deleteWhere fences on the version, counts deleted rows and classifies misses", async () => {
    const filter = Predicate.eq("name", "a")
    const f = build(() => [row(), row({ id: "w2" })])
    expect(await f.repo.deleteWhere!(filter, oc(3))).toEqual({ deletedCount: 2 })
    expect(whereOf(f.ops[0])).toEqual({ sql: '(("widgets"."name" = $1) and "widgets"."version" = $2)', params: ["a", 3] })
    expect(f.ops[0]!.returning).toBe(true)
    const terminal = build(() => [row()])
    expect(await terminal.repo.deleteWhere!(filter, oc(Number.MAX_SAFE_INTEGER))).toEqual({ deletedCount: 1 })
    expect(terminal.ops[0]!.where!.params).toEqual(["a", Number.MAX_SAFE_INTEGER])
    const stale = build((op) => (op.kind === "select" ? [{ primaryKey: "w1" }] : []))
    await expect(stale.repo.deleteWhere!(filter, oc(3))).rejects.toThrow(new OptimisticConcurrencyError("widget version mismatch: expected version 3"))
    expect(whereOf(stale.ops[1])).toEqual({ sql: '("widgets"."name" = $1)', params: ["a"] })
    expect(Object.keys(stale.ops[1]!.fields as object)).toEqual(["primaryKey"])
    expect(stale.ops[1]).toMatchObject({ limit: 2 })
    const gone = build(() => [])
    await expect(gone.repo.deleteWhere!(filter, oc(3))).rejects.toThrow(new NotFoundError("widget record not found"))
    const note = build(() => [{ id: "n1" }], {}, "note")
    expect(await note.repo.deleteWhere!(Predicate.eq("body", "x"))).toEqual({ deletedCount: 1 })
    expect(whereOf(note.ops[0])).toEqual({ sql: '("notes"."body" = $1)', params: ["x"] })
    await expect(note.repo.deleteWhere!(Predicate.eq("body", "x"), oc(1))).rejects.toThrow(new ConfigurationError('Optimistic concurrency for "note" requires a mapped version field'))
    const unique = build(() => { throw providerError("23505", { constraint: "widgets_name_key" }) }, { constraintMap: { widgets_name_key: "name" } })
    expect(((await unique.repo.deleteWhere!(filter, oc(3)).catch((e: unknown) => e)) as ConflictError).details).toMatchObject({ field: "name" })
  })
})
