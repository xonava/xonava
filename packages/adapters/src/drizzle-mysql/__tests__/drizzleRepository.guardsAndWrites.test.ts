import { describe, expect, it } from "vitest"
import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { ConfigurationError, ConflictError, NotFoundError, OptimisticConcurrencyError, Predicate, ValidationError } from "@xonava/core/domain"
import { createDrizzleMySqlRepository } from "../drizzleRepository"
import { createScriptedDb, renderSql, type ScriptedHandler, type ScriptedOp } from "../../__tests__/support/scriptedDb"

const widgets = mysqlTable("widgets", { id: varchar("id", { length: 36 }).primaryKey(), name: varchar("name", { length: 64 }).notNull(), score: int("score"), version: int("version").notNull(), createdAt: int("created_at") })
const notes = mysqlTable("notes", { id: varchar("id", { length: 36 }).primaryKey(), body: varchar("body", { length: 64 }).notNull() })
const slugs = mysqlTable("slugs", { slug: varchar("slug", { length: 36 }).primaryKey(), id: varchar("id", { length: 36 }), label: varchar("label", { length: 36 }) })
const widgetColumns = { id: widgets.id, name: widgets.name, score: widgets.score, version: widgets.version, createdAt: widgets.createdAt }
const widgetEntity = { name: "widget", primaryKey: "id", versionField: "version", fields: {} }
const noteEntity = { name: "note", primaryKey: "id", fields: {} }

type Repo = Record<string, (...args: unknown[]) => Promise<unknown>>
type Kind = "widget" | "note"
function build(handler: ScriptedHandler, extra: Record<string, unknown> = {}, kind: Kind = "widget") {
  const scripted = createScriptedDb("mysql", handler)
  const repo = createDrizzleMySqlRepository({
    db: scripted.db as never,
    table: (kind === "widget" ? widgets : notes) as never,
    entity: (kind === "widget" ? widgetEntity : noteEntity) as never,
    columnMap: (kind === "widget" ? widgetColumns : { id: notes.id, body: notes.body }) as never,
    ...extra,
  } as never) as unknown as Repo
  return { repo, ops: scripted.ops }
}
const row = (overrides: Record<string, unknown> = {}) => ({ id: "w1", name: "alpha", score: 1, version: 1, createdAt: 1, ...overrides })
const changed = (affectedRows: number) => [{ affectedRows }, undefined]
const oc = (expectedVersion: unknown = 3) => ({ optimisticConcurrency: { expectedVersion } })
const mysqlError = (errno: number, code: string, sqlMessage?: string) => Object.assign(new Error("provider text"), { errno, code, ...(sqlMessage === undefined ? {} : { sqlMessage }) })
const settle = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error)

/** A database whose select builder records every orderBy argument, so tie-breakers can be asserted. */
function capture(rows: unknown[], total: unknown = rows.length) {
  const selects: { count: boolean; where?: unknown; order: unknown[]; limit?: number; offset?: number }[] = []
  const db = {
    select: (fields?: unknown) => {
      const state: { count: boolean; where?: unknown; order: unknown[]; limit?: number; offset?: number } = { count: fields !== undefined, order: [] }
      selects.push(state)
      const builder: Record<string, unknown> = {
        from: () => builder,
        where: (where: unknown) => { state.where = where; return builder },
        orderBy: (...order: unknown[]) => { state.order = order; return builder },
        limit: (limit: number) => { state.limit = limit; return builder },
        offset: (offset: number) => { state.offset = offset; return builder },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(fields !== undefined ? (total === undefined ? [] : [{ value: total }]) : rows).then(resolve, reject),
      }
      return builder
    },
  }
  const repo = createDrizzleMySqlRepository({ db: db as never, table: widgets as never, entity: widgetEntity as never, columnMap: widgetColumns as never }) as unknown as Repo
  const page = () => selects.find((select) => !select.count)!
  const orderSql = () => page().order.map((item) => renderSql("mysql", item)!.sql)
  return { repo, selects, page, orderSql }
}

describe("MySQL repository construction and guards", () => {
  it("defaults the primary key to id and names a missing mapping", async () => {
    const scripted = createScriptedDb("mysql", () => [{ slug: "s1" }])
    const implicit = createDrizzleMySqlRepository({ db: scripted.db as never, table: slugs as never, entity: { name: "slugged", fields: {} } as never, columnMap: { slug: slugs.slug, id: slugs.id } as never }) as unknown as Repo
    await implicit.findById!("i1")
    expect(scripted.ops[0]!.where).toEqual({ sql: "`slugs`.`id` = ?", params: ["i1"] })
    const explicit = createDrizzleMySqlRepository({ db: scripted.db as never, table: slugs as never, entity: { name: "slugged", primaryKey: "slug", fields: {} } as never, columnMap: { slug: slugs.slug, id: slugs.id } as never }) as unknown as Repo
    await explicit.findById!("s1")
    expect(scripted.ops[1]!.where).toEqual({ sql: "`slugs`.`slug` = ?", params: ["s1"] })
    expect(() => createDrizzleMySqlRepository({ db: scripted.db as never, table: slugs as never, entity: { name: "slugged", fields: {} } as never, columnMap: { slug: slugs.slug } as never })).toThrow(new ConfigurationError("Entity slugged is missing its primary-key mapping"))
  })

  it("names the operation when a predicate is missing or matches everything", async () => {
    const f = build(() => [row()])
    const note = build(() => changed(1), {}, "note")
    const all = { kind: "literal", value: true } as never
    await expect(f.repo.findOneWhere!(undefined)).rejects.toThrow(new ValidationError("findOneWhere requires a predicate"))
    await expect(f.repo.findOneWhere!(all)).rejects.toThrow(new ConfigurationError("All-row findOneWhere is forbidden"))
    await expect(f.repo.updateOneWhereReturning!(undefined, { score: 1 }, oc(1))).rejects.toThrow(new ValidationError("updateOneWhere requires a predicate"))
    await expect(f.repo.updateOneWhere!(all, { score: 1 }, oc(1))).rejects.toThrow(new ConfigurationError("All-row updateOneWhere is forbidden"))
    await expect(note.repo.updateManyWhere!(undefined, { body: "x" })).rejects.toThrow(new ValidationError("updateManyWhere requires a predicate"))
    await expect(note.repo.updateManyWhere!(all, { body: "x" })).rejects.toThrow(new ConfigurationError("All-row updateManyWhere is forbidden"))
    await expect(f.repo.deleteWhere!(undefined, oc(1))).rejects.toThrow(new ValidationError("deleteWhere requires a predicate"))
    await expect(f.repo.deleteWhere!(all, oc(1))).rejects.toThrow(new ConfigurationError("All-row deleteWhere is forbidden"))
    expect(f.ops).toEqual([])
    expect(note.ops).toEqual([])
  })

  it("rejects every always-true predicate shape for all-row writes, like the PostgreSQL and D1 repositories", async () => {
    const note = build(() => changed(5), {}, "note")
    const allRows = [
      Predicate.alwaysTrue(),
      Predicate.and(),
      Predicate.not(Predicate.alwaysFalse()),
      Predicate.or(Predicate.eq("body", "a"), Predicate.alwaysTrue()),
      Predicate.and(Predicate.alwaysTrue(), Predicate.not(Predicate.or())),
    ]
    for (const filter of allRows) {
      await expect(note.repo.deleteWhere!(filter)).rejects.toThrow(new ConfigurationError("All-row deleteWhere is forbidden"))
      await expect(note.repo.updateManyWhere!(filter, { body: "x" })).rejects.toThrow(new ConfigurationError("All-row updateManyWhere is forbidden"))
      await expect(note.repo.updateOneWhere!(filter, { body: "x" })).rejects.toThrow(new ConfigurationError("All-row updateOneWhere is forbidden"))
    }
  })

  it("still accepts filters that are not always true", async () => {
    const note = build(() => changed(1), {}, "note")
    for (const filter of [Predicate.eq("body", "a"), Predicate.or(), Predicate.and(Predicate.alwaysTrue(), Predicate.eq("body", "a")), Predicate.not(Predicate.alwaysTrue())]) {
      await expect(note.repo.deleteWhere!(filter)).resolves.not.toThrow()
    }
  })

  it("reports the provider dialect and constraint field on normalized failures", async () => {
    const dup = (index: string) => () => { throw mysqlError(1062, "ER_DUP_ENTRY", `Duplicate entry 'a' for key '${index}'`) }
    const mapped = await settle(build(dup("widgets.widgets_name_uq"), { constraintMap: { widgets_name_uq: "name" } }).repo.insert!({ id: "w2", name: "a" }))
    expect(mapped).toBeInstanceOf(ConflictError)
    expect((mapped as ConflictError).message).toBe("A record with this value already exists")
    expect((mapped as ConflictError).details).toEqual({ dialect: "mysql", providerCode: "ER_DUP_ENTRY", field: "name" })
    const unmapped = await settle(build(dup("widgets.other_uq"), { constraintMap: { widgets_name_uq: "name" } }).repo.insert!({ id: "w2", name: "a" }))
    expect((unmapped as ConflictError).details).toEqual({ dialect: "mysql", providerCode: "ER_DUP_ENTRY" })
    const plain = await settle(build(dup("widgets.widgets_name_uq")).repo.insert!({ id: "w2", name: "a" }))
    expect((plain as ConflictError).details).toEqual({ dialect: "mysql", providerCode: "ER_DUP_ENTRY" })
    const already = new ConflictError("already framework", { x: 1 })
    expect(await settle(build(() => { throw already }, { constraintMap: { widgets_name_uq: "name" } }).repo.insert!({ id: "w2", name: "a" }))).toBe(already)
  })
})

describe("MySQL repository findMany", () => {
  const rows = [row(), row({ id: "w2" }), row({ id: "w3" }), row({ id: "w4" })]

  it("adds the primary key as the last sort key unless it is already sorted on", async () => {
    const cases: [unknown, string[]][] = [
      [undefined, ["`widgets`.`id` asc", "`widgets`.`id` asc"]],
      [{ sort: [] }, ["`widgets`.`id` asc", "`widgets`.`id` asc"]],
      [{ sort: [{ field: "score", direction: "desc" }] }, ["`widgets`.`score` desc", "`widgets`.`id` asc"]],
      [{ sort: [{ field: "id", direction: "desc" }] }, ["`widgets`.`id` desc"]],
      [{ sort: [{ field: "name", direction: "asc" }, { field: "id", direction: "asc" }] }, ["`widgets`.`name` asc", "`widgets`.`id` asc"]],
      [{ sort: [{ field: "id", direction: "asc" }, { field: "name", direction: "desc" }] }, ["`widgets`.`id` asc", "`widgets`.`name` desc"]],
    ]
    for (const [options, expected] of cases) {
      const f = capture([])
      await f.repo.findMany!(options)
      expect(f.orderSql()).toEqual(expected)
    }
  })

  it("counts with the filter and pages with the resolved limit and offset", async () => {
    const f = capture(rows, "12")
    const result = await f.repo.findMany!({ filter: Predicate.eq("score", 1), pagination: { kind: "offset", page: 3, pageSize: 4 } }) as { rowCount: number; page: number; pageSize: number; rows: unknown[] }
    expect(result).toMatchObject({ rowCount: 12, page: 3, pageSize: 4 })
    expect(result.rows).toHaveLength(4)
    expect(f.selects.map((select) => select.count)).toEqual([true, false])
    expect(f.page()).toMatchObject({ limit: 4, offset: 8 })
    expect(renderSql("mysql", f.selects[0]!.where)).toEqual({ sql: "(`widgets`.`score` = ?)", params: [1] })
    expect(renderSql("mysql", f.page().where)).toEqual({ sql: "(`widgets`.`score` = ?)", params: [1] })
    const defaults = capture([])
    await defaults.repo.findMany!()
    expect(defaults.page()).toMatchObject({ limit: 20, offset: 0 })
    expect(defaults.selects[0]!.where).toBeUndefined()
    expect(defaults.page().where).toBeUndefined()
    const none = capture([], undefined)
    expect(await none.repo.findMany!()).toMatchObject({ rowCount: 0 })
  })

  it("applies the configured maximum page size", async () => {
    const repo = createDrizzleMySqlRepository({ db: { select: () => { throw new Error("unused") } } as never, table: widgets as never, entity: widgetEntity as never, columnMap: widgetColumns as never, maxPageSize: 7 }) as unknown as Repo
    await expect(repo.findMany!({ pagination: { kind: "offset", page: 1, pageSize: 8 } })).rejects.toThrow()
  })

  it("probes one extra row for cursor pages and keysets on the sort key", async () => {
    const f = capture(rows, 9)
    const sort = [{ field: "name", direction: "asc" }]
    const result = await f.repo.findMany!({ sort, pagination: { kind: "cursor", direction: "after", limit: 3 } }) as { rows: unknown[]; rowCount: number; page: number; pageSize: number; pageInfo: unknown }
    expect(f.page()).toMatchObject({ limit: 4, offset: 0 })
    expect(f.orderSql()).toEqual(["(CONVERT(`widgets`.`name` USING utf8mb4) COLLATE utf8mb4_0900_bin) asc", "(CONVERT(`widgets`.`id` USING utf8mb4) COLLATE utf8mb4_0900_bin) asc"])
    expect(result.rows).toHaveLength(3)
    expect(result).toMatchObject({ rowCount: 9, page: 1, pageSize: 3, pageInfo: { kind: "cursor", hasNextPage: true, hasPreviousPage: false } })
    const after = capture(rows.slice(0, 2), 2)
    const next = await after.repo.findMany!({ sort, pagination: { kind: "cursor", direction: "after", limit: 3, values: ["alpha"] } }) as { pageInfo: unknown }
    expect(next.pageInfo).toEqual({ kind: "cursor", hasNextPage: false, hasPreviousPage: true })
    expect(renderSql("mysql", after.page().where)).toEqual({ sql: "((((CONVERT(`widgets`.`name` USING utf8mb4) COLLATE utf8mb4_0900_bin) > ?)))", params: ["alpha"] })
    expect(renderSql("mysql", after.selects[0]!.where)).toEqual(renderSql("mysql", after.page().where))
    const filtered = capture(rows.slice(0, 1), 1)
    await filtered.repo.findMany!({ filter: Predicate.eq("score", 1), sort, pagination: { kind: "cursor", direction: "before", limit: 2, values: ["alpha"] } })
    expect(renderSql("mysql", filtered.page().where)).toEqual({ sql: "((`widgets`.`score` = ? and (((CONVERT(`widgets`.`name` USING utf8mb4) COLLATE utf8mb4_0900_bin) < ?))))", params: [1, "alpha"] })
    expect(filtered.orderSql()[0]).toBe("(CONVERT(`widgets`.`name` USING utf8mb4) COLLATE utf8mb4_0900_bin) desc")
  })

  it("requires an explicit sort for cursor pages and rejects bad sorts with exact messages", async () => {
    const f = capture([])
    const cursor = { kind: "cursor", limit: 3, direction: "after" }
    await expect(f.repo.findMany!({ pagination: cursor })).rejects.toThrow(new ValidationError("cursor pagination requires an explicit stable sort"))
    await expect(f.repo.findMany!({ sort: [], pagination: cursor })).rejects.toThrow(new ValidationError("cursor pagination requires an explicit stable sort"))
    await expect(f.repo.findMany!({ sort: [{ field: "score", direction: "asc", nulls: "first" }] })).rejects.toThrow(new ValidationError("MySQL adapter does not support explicit NULL ordering"))
    await expect(f.repo.findMany!({ sort: [{ field: "nope", direction: "asc" }] })).rejects.toThrow(new ValidationError("Unknown sort field: nope"))
    expect(f.selects.filter((select) => !select.count)).toEqual([])
  })

  it("validates every part of the query plan before touching the database", async () => {
    const tooMany = Predicate.and(...Array.from({ length: 60 }, (_, i) => Predicate.eq("name", `n${i}`)))
    const cases: Record<string, unknown>[] = [
      { filter: tooMany },
      { sort: [{ field: "score", direction: "asc" }, { field: "score", direction: "desc" }] },
      { projection: { fields: ["id", "id"] } },
      { consistency: "bogus" },
    ]
    for (const options of cases) {
      const f = capture([])
      await expect(f.repo.findMany!(options)).rejects.toBeInstanceOf(ValidationError)
      expect(f.selects).toEqual([])
    }
    const f = capture([])
    await expect(f.repo.findMany!({ consistency: "bogus" })).rejects.toThrow(new ValidationError("query consistency is invalid"))
    await expect(f.repo.findMany!({ consistency: "eventual" })).rejects.toThrow("read consistency eventual is not proven for the selected datasource topology")
    expect(f.selects).toEqual([])
    const strong = capture(rows, 4)
    expect(await strong.repo.findMany!({ consistency: "strong" })).toMatchObject({ rowCount: 4 })
  })

  it("ignores an unknown pagination kind", async () => {
    const g = capture([])
    expect(await g.repo.findMany!({ pagination: { kind: "other", page: 3, pageSize: 5 } })).toMatchObject({ page: 1, pageSize: 20 })
    expect(g.page()).toMatchObject({ limit: 20, offset: 0 })
  })
})

describe("MySQL repository writes", () => {
  it("insert needs a supplied key, reads the row back and checks its version", async () => {
    const f = build((op) => (op.kind === "insert" ? changed(1) : [row()]))
    await f.repo.insert!({ id: "w1", name: "a", version: 1 })
    expect(f.ops.map((op) => op.kind)).toEqual(["insert", "select"])
    expect(f.ops[1]!.where).toEqual({ sql: "`widgets`.`id` = ?", params: ["w1"] })
    await expect(build(() => changed(1)).repo.insert!({ name: "a", version: 1 })).rejects.toThrow(new ConfigurationError("MySQL inserts require an application-supplied primary key for deterministic readback"))
    const lost = build((op) => (op.kind === "insert" ? changed(1) : []))
    await expect(lost.repo.insert!({ id: "w1", name: "a", version: 1 })).rejects.toThrow(new ConfigurationError("MySQL insert readback returned no row"))
    const corrupt = build((op) => (op.kind === "insert" ? changed(1) : [row({ version: "x" })]))
    await expect(corrupt.repo.insert!({ id: "w1", name: "a", version: 1 })).rejects.toThrow()
    const unversioned = build((op) => (op.kind === "insert" ? changed(1) : [{ id: "n1", body: "x" }]), {}, "note")
    expect(await unversioned.repo.insert!({ id: "n1", body: "x" })).toEqual({ id: "n1", body: "x" })
  })

  it("update increments the version under the expected version and uses plain assignment otherwise", async () => {
    const f = build((op) => (op.kind === "update" ? changed(1) : [row({ version: 2 })]))
    await f.repo.update!("w1", { name: "beta" }, oc(1))
    const update = f.ops.find((op) => op.kind === "update")!
    expect(update.where).toEqual({ sql: "(`widgets`.`id` = ? and `widgets`.`version` = ?)", params: ["w1", 1] })
    expect(Object.keys(update.set as object)).toEqual(["name", "version"])
    expect(renderSql("mysql", (update.set as Record<string, unknown>).version)).toEqual({ sql: "`widgets`.`version`+1", params: [] })
    expect(f.ops.at(-1)).toMatchObject({ kind: "select", limit: 1 })
    expect(f.ops.at(-1)!.where).toEqual({ sql: "`widgets`.`id` = ?", params: ["w1"] })
    const note = build((op) => (op.kind === "update" ? changed(1) : [{ id: "n1", body: "y" }]), {}, "note")
    await note.repo.update!("n1", { body: "y" })
    const noteUpdate = note.ops.find((op) => op.kind === "update")!
    expect(noteUpdate.set).toEqual({ body: "y" })
    expect(noteUpdate.where).toEqual({ sql: "`notes`.`id` = ?", params: ["n1"] })
  })

  it("update reports the exact missing-row and version-mismatch messages", async () => {
    expect(await settle(build(() => changed(0)).repo.update!("w1", { name: "b" }, oc(9)))).toEqual(new OptimisticConcurrencyError("widget version mismatch"))
    expect(await settle(build(() => changed(0), {}, "note").repo.update!("n1", { body: "x" }))).toEqual(new NotFoundError("note record not found"))
    expect(await settle(build(() => changed(2), {}, "note").repo.update!("n1", { body: "x" }))).toEqual(new NotFoundError("note record not found"))
  })

  const matchThenUpdate = (ids: string[], affected: number, fresh: unknown = row({ version: 2 })): ScriptedHandler => (op) => {
    if (op.kind === "update") return changed(affected)
    if (op.limit === 2) return ids.map((id) => ({ id }))
    return fresh ? [fresh] : []
  }
  const summary = (ops: ScriptedOp[]) => ops.map((op) => [op.kind, op.where, op.limit])

  it("updateOneWhereReturning looks up at most two candidates and re-evaluates the predicate in the update", async () => {
    const f = build(matchThenUpdate(["w1"], 1))
    await f.repo.updateOneWhereReturning!(Predicate.eq("name", "a"), { score: 1 }, oc(1))
    expect(summary(f.ops)).toEqual([
      ["select", { sql: "((CONVERT(`widgets`.`name` USING utf8mb4) COLLATE utf8mb4_0900_bin) = ?)", params: ["a"] }, 2],
      ["update", { sql: "((`widgets`.`id` = ? and ((CONVERT(`widgets`.`name` USING utf8mb4) COLLATE utf8mb4_0900_bin) = ?)) and `widgets`.`version` = ?)", params: ["w1", "a", 1] }, undefined],
      ["select", { sql: "`widgets`.`id` = ?", params: ["w1"] }, 1],
    ])
    expect(f.ops[0]!.fields).toEqual({ id: widgets.id })
    expect(Object.keys(f.ops[1]!.set as object)).toEqual(["score", "version"])
    const note = build(matchThenUpdate(["n1"], 1, { id: "n1", body: "y" }), {}, "note")
    await note.repo.updateOneWhereReturning!(Predicate.eq("body", "x"), { body: "y" })
    expect(note.ops[1]!.set).toEqual({ body: "y" })
    expect(note.ops[1]!.where!.params).toEqual(["n1", "x"])
  })

  it("updateOneWhereReturning names ambiguity, version mismatches and misses", async () => {
    expect(await settle(build(matchThenUpdate(["a", "b"], 1)).repo.updateOneWhereReturning!(Predicate.eq("name", "x"), { score: 5 }, oc(1)))).toEqual(new ValidationError("widget updateOneWhere matched multiple rows"))
    expect(await settle(build(matchThenUpdate([], 1)).repo.updateOneWhereReturning!(Predicate.eq("name", "x"), { score: 5 }, oc(1)))).toEqual(new OptimisticConcurrencyError("widget version mismatch"))
    expect(await settle(build(matchThenUpdate(["w1"], 2)).repo.updateOneWhereReturning!(Predicate.eq("name", "x"), { score: 5 }, oc(1)))).toEqual(new OptimisticConcurrencyError("widget version mismatch"))
    const none = build(matchThenUpdate([], 0), {}, "note")
    expect(await none.repo.updateOneWhereReturning!(Predicate.eq("body", "x"), { body: "y" })).toBeNull()
    expect(none.ops.map((op) => op.kind)).toEqual(["select"])
    expect(await build(matchThenUpdate(["n1"], 0), {}, "note").repo.updateOneWhereReturning!(Predicate.eq("body", "x"), { body: "y" })).toBeNull()
    expect(await build(matchThenUpdate(["n1"], 2), {}, "note").repo.updateOneWhereReturning!(Predicate.eq("body", "x"), { body: "y" })).toBeNull()
  })

  it("updateManyWhere updates by predicate and counts affected rows", async () => {
    const f = build(() => changed(3), {}, "note")
    expect(await f.repo.updateManyWhere!(Predicate.eq("body", "x"), { body: "y" })).toBe(3)
    expect(f.ops[0]!.where).toEqual({ sql: "((CONVERT(`notes`.`body` USING utf8mb4) COLLATE utf8mb4_0900_bin) = ?)", params: ["x"] })
    expect(f.ops[0]!.set).toEqual({ body: "y" })
  })

  it("delete uses exact statements and messages", async () => {
    const ok = build(() => changed(1))
    await ok.repo.delete!("w1", oc(4))
    expect(ok.ops[0]!.where).toEqual({ sql: "(`widgets`.`id` = ? and `widgets`.`version` = ?)", params: ["w1", 4] })
    const note = build(() => changed(1), {}, "note")
    await note.repo.delete!("n1")
    expect(note.ops[0]!.where).toEqual({ sql: "`notes`.`id` = ?", params: ["n1"] })
    const mismatch = build((op) => (op.kind === "delete" ? changed(0) : [row()]))
    expect(await settle(mismatch.repo.delete!("w1", oc(9)))).toEqual(new OptimisticConcurrencyError("widget version mismatch"))
    expect(mismatch.ops[1]).toMatchObject({ kind: "select" })
    expect(mismatch.ops[1]!.where).toEqual({ sql: "`widgets`.`id` = ?", params: ["w1"] })
    const missing = build((op) => (op.kind === "select" ? [] : changed(0)))
    expect(await settle(missing.repo.delete!("w1", oc(9)))).toEqual(new NotFoundError("widget record not found"))
    expect(await settle(missing.repo.delete!("w1", { idempotent: true, ...oc(9) }))).toBeNull()
    expect(await settle(build(() => changed(0), {}, "note").repo.delete!("n1"))).toEqual(new NotFoundError("note record not found"))
    expect(await settle(build(() => changed(0), {}, "note").repo.delete!("n1", { idempotent: true }))).toBeNull()
    expect(await settle(build(() => changed(0), {}, "note").repo.delete!("n1", { idempotent: false }))).toEqual(new NotFoundError("note record not found"))
  })

  it("deleteWhere uses exact statements and messages", async () => {
    const f = build(() => changed(2))
    expect(await f.repo.deleteWhere!(Predicate.eq("name", "a"), oc(4))).toEqual({ deletedCount: 2 })
    expect(f.ops[0]!.where).toEqual({ sql: "(((CONVERT(`widgets`.`name` USING utf8mb4) COLLATE utf8mb4_0900_bin) = ?) and `widgets`.`version` = ?)", params: ["a", 4] })
    const note = build(() => changed(1), {}, "note")
    await note.repo.deleteWhere!(Predicate.eq("body", "x"))
    expect(note.ops[0]!.where).toEqual({ sql: "((CONVERT(`notes`.`body` USING utf8mb4) COLLATE utf8mb4_0900_bin) = ?)", params: ["x"] })
    const mismatch = build((op) => (op.kind === "delete" ? changed(0) : [row()]))
    expect(await settle(mismatch.repo.deleteWhere!(Predicate.eq("name", "a"), oc(4)))).toEqual(new OptimisticConcurrencyError("widget version mismatch"))
    expect(mismatch.ops[1]!.where).toEqual({ sql: "((CONVERT(`widgets`.`name` USING utf8mb4) COLLATE utf8mb4_0900_bin) = ?)", params: ["a"] })
    const miss = build((op) => (op.kind === "select" ? [] : changed(0)))
    expect(await settle(miss.repo.deleteWhere!(Predicate.eq("name", "a"), oc(4)))).toEqual(new NotFoundError("widget record not found"))
  })
})

describe("MySQL repository all-row guard shapes and terminal versions", () => {
  const T = Predicate.alwaysTrue()
  const F = Predicate.alwaysFalse()
  const eq = Predicate.eq("body", "x")
  const lit = (value: boolean) => ({ kind: "literal", value }) as never
  it("rejects every predicate that matches all rows", async () => {
    const note = build(() => changed(0), {}, "note")
    const shapes = [lit(true), T, Predicate.and(T, T), Predicate.and(), Predicate.or(eq, T), Predicate.not(F), Predicate.not(lit(false)), Predicate.and(Predicate.not(F))]
    for (const shape of shapes) {
      await expect(note.repo.deleteWhere!(shape)).rejects.toThrow(new ConfigurationError("All-row deleteWhere is forbidden"))
    }
    expect(note.ops).toEqual([])
  })

  it("lets predicates that do not match every row through", async () => {
    const note = build(() => changed(0), {}, "note")
    const shapes = [lit(false), F, Predicate.and(eq, T), Predicate.or(eq), Predicate.not(eq), Predicate.not(T), Predicate.and(F, T), Predicate.or(eq, F)]
    for (const shape of shapes) expect(await note.repo.deleteWhere!(shape)).toEqual({ deletedCount: 0 })
    expect(note.ops).toHaveLength(shapes.length)
  })

  it("allows deleting at the terminal safe version", async () => {
    const f = build(() => changed(1))
    await f.repo.delete!("w1", oc(Number.MAX_SAFE_INTEGER))
    await f.repo.deleteWhere!(Predicate.eq("name", "a"), oc(Number.MAX_SAFE_INTEGER))
    expect(f.ops.map((op) => op.kind)).toEqual(["delete", "delete"])
  })
})

