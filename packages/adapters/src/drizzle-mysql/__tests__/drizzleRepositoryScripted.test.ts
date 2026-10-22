import { describe, expect, it } from "vitest"
import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { ConfigurationError, ConflictError, NotFoundError, OptimisticConcurrencyError, PersistenceError, Predicate, RetryablePersistenceError, ValidationError } from "@xonava/core/domain"
import { createDrizzleMySqlRepository } from "../drizzleRepository"
import type { DrizzleColumnMap } from "../../drizzle-shared/predicateCompiler"
import { createScriptedDb, type ScriptedHandler } from "../../__tests__/support/scriptedDb"

const widgets = mysqlTable("widgets", { id: varchar("id", { length: 36 }).primaryKey(), name: varchar("name", { length: 64 }).notNull(), score: int("score"), version: int("version").notNull(), createdAt: int("created_at") })
const notes = mysqlTable("notes", { id: varchar("id", { length: 36 }).primaryKey(), body: varchar("body", { length: 64 }).notNull() })
const widgetColumns = { id: widgets.id, name: widgets.name, score: widgets.score, version: widgets.version, createdAt: widgets.createdAt } satisfies DrizzleColumnMap
const widgetEntity = { name: "widget", primaryKey: "id", versionField: "version", fields: { id: { type: "string" }, name: { type: "string" }, score: { type: "number", nullable: true }, version: { type: "number" }, createdAt: { type: "number", nullable: true } } } as const
const noteEntity = { name: "note", primaryKey: "id", fields: { id: { type: "string" }, body: { type: "string" } } } as const

type Repo = Record<string, (...args: unknown[]) => Promise<any>>
function build(handler: ScriptedHandler, extra: Record<string, unknown> = {}, kind: "widget" | "note" = "widget") {
  const scripted = createScriptedDb("mysql", handler)
  const repo = createDrizzleMySqlRepository({
    db: scripted.db as never,
    table: (kind === "widget" ? widgets : notes) as never,
    entity: (kind === "widget" ? widgetEntity : noteEntity) as never,
    columnMap: kind === "widget" ? widgetColumns : { id: notes.id, body: notes.body },
    ...extra,
  }) as unknown as Repo
  return { repo, ops: scripted.ops }
}
const row = (overrides: Record<string, unknown> = {}) => ({ id: "w1", name: "alpha", score: 1, version: 1, createdAt: 1, ...overrides })
const mysqlError = (errno: number, code: string, sqlMessage?: string) => Object.assign(new Error("provider text"), { errno, code, ...(sqlMessage === undefined ? {} : { sqlMessage }) })
const isCount = (op: { fields?: unknown }) => op.fields !== undefined && "value" in (op.fields as object)
const changed = (affectedRows: number) => [{ affectedRows }, undefined]
const allRows = { kind: "literal", value: true } as never
const noRows: ScriptedHandler = (op) => (op.kind === "select" ? [] : changed(0))

describe("MySQL repository reads", () => {
  it("finds by id and by predicate, and requires a predicate", async () => {
    const { repo, ops } = build(() => [row()])
    expect(await repo.findById!("w1")).toEqual(row())
    expect(ops[0]).toMatchObject({ kind: "select", limit: 1 })
    expect(ops[0]!.where).toEqual({ sql: "`widgets`.`id` = ?", params: ["w1"] })
    expect((await repo.findOneWhere!(Predicate.eq("name", "alpha")))?.id).toBe("w1")
    await expect(repo.findOneWhere!(undefined)).rejects.toBeInstanceOf(ValidationError)
    await expect(repo.findOneWhere!(allRows)).rejects.toThrow("All-row findOneWhere is forbidden")
    expect(await build(() => []).repo.findById!("none")).toBeNull()
  })

  it("normalizes provider failures on reads", async () => {
    const retry = build(() => { throw mysqlError(1213, "ER_LOCK_DEADLOCK") })
    const error = await retry.repo.findById!("w1").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RetryablePersistenceError)
    expect(String((error as Error).message)).not.toContain("provider text")
    await expect(build(() => { throw mysqlError(1, "ER_OTHER") }).repo.findOneWhere!(Predicate.eq("name", "x"))).rejects.toBeInstanceOf(PersistenceError)
    await expect(build(() => { throw mysqlError(1, "ER_OTHER") }).repo.findMany!()).rejects.toBeInstanceOf(PersistenceError)
  })

  it("lists with a count, native order for offset pages and primary-key tie-breaking", async () => {
    const { repo, ops } = build((op) => (isCount(op) ? [{ value: "9" }] : [row(), row({ id: "w2" })]))
    const result = await repo.findMany!({ filter: Predicate.eq("name", "alpha"), sort: [{ field: "score", direction: "desc" }], pagination: { kind: "offset", page: 3, pageSize: 4 } })
    expect(result).toMatchObject({ rowCount: 9, page: 3, pageSize: 4 })
    expect(result.rows).toHaveLength(2)
    expect(result).not.toHaveProperty("pageInfo")
    const page = ops.find((op) => op.offset !== undefined)!
    expect(page).toMatchObject({ limit: 4, offset: 8 })
    expect(page.orderBy!.sql).toContain("`score`")
  })

  it("sorts by primary key by default and does not duplicate it when sorted explicitly", async () => {
    const handler: ScriptedHandler = (op) => (isCount(op) ? [] : [])
    const byDefault = build(handler)
    const empty = await byDefault.repo.findMany!()
    expect(empty).toMatchObject({ rowCount: 0, rows: [] })
    expect(byDefault.ops.find((op) => op.offset !== undefined)!.orderBy!.sql).toContain("`id`")
    const byId = build(handler)
    await byId.repo.findMany!({ sort: [{ field: "id", direction: "desc" }] })
    expect(byId.ops.find((op) => op.offset !== undefined)!.orderBy!.sql).toContain("desc")
  })

  it("rejects NULLS ordering, unknown sort fields, unsupported consistency and bad cursor requests", async () => {
    const { repo } = build(() => [])
    await expect(repo.findMany!({ sort: [{ field: "score", direction: "asc", nulls: "first" }] })).rejects.toThrow("does not support explicit NULL ordering")
    await expect(repo.findMany!({ sort: [{ field: "nope", direction: "asc" }] })).rejects.toBeInstanceOf(ValidationError)
    await expect(repo.findMany!({ consistency: "eventual" })).rejects.toBeInstanceOf(Error)
    await expect(repo.findMany!({ pagination: { kind: "cursor", direction: "after", limit: 2 } })).rejects.toThrow("explicit stable sort")
  })

  it("keysets cursor pages and reports page info for both directions", async () => {
    const handler: ScriptedHandler = (op) => (isCount(op) ? [{ value: 3 }] : [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })])
    const { repo, ops } = build(handler)
    const sort = [{ field: "name", direction: "asc" as const }, { field: "id", direction: "asc" as const }]
    const first = await repo.findMany!({ sort, pagination: { kind: "cursor", direction: "after", limit: 2 } })
    expect(first.rows.map((r: { id: string }) => r.id)).toEqual(["a", "b"])
    expect(first.pageInfo).toEqual({ kind: "cursor", hasNextPage: true, hasPreviousPage: false })
    expect(ops.find((op) => op.offset !== undefined)).toMatchObject({ limit: 3 })
    const filtered = await repo.findMany!({ filter: Predicate.eq("score", 1), sort, pagination: { kind: "cursor", direction: "after", limit: 2, values: ["alpha", "w1"] } })
    expect(filtered.pageInfo).toMatchObject({ hasPreviousPage: true })
    const back = await repo.findMany!({ sort, pagination: { kind: "cursor", direction: "before", limit: 2, values: ["zeta", "w9"] } })
    expect(back.rows.map((r: { id: string }) => r.id)).toEqual(["b", "a"])
  })

  it("applies binary collation to string comparisons only when requested", async () => {
    const plain = build(() => [row()])
    await plain.repo.findOneWhere!(Predicate.eq("name", "alpha"))
    const binary = build(() => [row()], { mysqlBinaryCollation: true })
    await binary.repo.findOneWhere!(Predicate.eq("name", "alpha"))
    expect(plain.ops[0]!.where!.sql).toContain("COLLATE utf8mb4_0900_bin")
    expect(binary.ops[0]!.where!.sql).toBe("(`widgets`.`name` = ?)")
    const explicitOff = build(() => [row()], { mysqlBinaryCollation: false })
    await explicitOff.repo.findOneWhere!(Predicate.eq("name", "alpha"))
    expect(explicitOff.ops[0]!.where!.sql).toBe(plain.ops[0]!.where!.sql)
  })

  it("validates the constraint map and primary key at construction", () => {
    expect(() => build(() => [], { constraintMap: [] })).toThrow("constraintMap must be an object")
    expect(() => createDrizzleMySqlRepository({ db: createScriptedDb("mysql", () => []).db as never, table: widgets as never, entity: widgetEntity as never, columnMap: { name: widgets.name } })).toThrow("missing its primary-key mapping")
  })
})

describe("MySQL repository writes", () => {
  it("inserts then reads back the row by its application-supplied key", async () => {
    const { repo, ops } = build((op) => (op.kind === "insert" ? changed(1) : [row()]))
    expect(await repo.insert!({ id: "w1", name: "alpha", version: 1 })).toMatchObject({ id: "w1", version: 1 })
    expect(ops.map((op) => op.kind)).toEqual(["insert", "select"])
    await expect(repo.insert!({ name: "alpha", version: 1 })).rejects.toThrow("application-supplied primary key")
    await expect(repo.insert!({ id: "w1", name: "alpha", version: 1.5 })).rejects.toBeInstanceOf(Error)
    const lost = build((op) => (op.kind === "insert" ? changed(1) : []))
    await expect(lost.repo.insert!({ id: "w1", name: "alpha" })).rejects.toThrow("readback returned no row")
    const corrupt = build((op) => (op.kind === "insert" ? changed(1) : [row({ version: "x" })]))
    await expect(corrupt.repo.insert!({ id: "w1", name: "alpha" })).rejects.toBeInstanceOf(Error)
  })

  it("maps duplicate-key errors to ConflictError and surfaces the mapped field only for mapped indexes", async () => {
    const duplicate = (index: string) => () => { throw mysqlError(1062, "ER_DUP_ENTRY", `Duplicate entry 'alpha' for key '${index}'`) }
    const mapped = build(duplicate("widgets.widgets_name_uq"), { constraintMap: { widgets_name_uq: "name" } })
    const error = await mapped.repo.insert!({ id: "w2", name: "alpha" }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).details).toMatchObject({ field: "name" })
    expect(String((error as Error).message)).not.toContain("alpha")
    const unmapped = build(duplicate("widgets.other_uq"), { constraintMap: { widgets_name_uq: "name" } })
    const plain = await unmapped.repo.insert!({ id: "w2", name: "alpha" }).catch((e: unknown) => e)
    expect(plain).toBeInstanceOf(ConflictError)
    expect((plain as ConflictError).details).not.toHaveProperty("field")
    const noMap = build(duplicate("widgets.widgets_name_uq"))
    expect(await noMap.repo.insert!({ id: "w2", name: "alpha" }).catch((e: unknown) => e)).toBeInstanceOf(ConflictError)
  })

  it("updates one row by id with a version predicate and re-reads it", async () => {
    const { repo, ops } = build((op) => (op.kind === "update" ? changed(1) : [row({ version: 2, name: "beta" })]))
    expect(await repo.update!("w1", { name: "beta" }, { optimisticConcurrency: { expectedVersion: 1 } })).toMatchObject({ name: "beta", version: 2 })
    const update = ops.find((op) => op.kind === "update")!
    expect(update.where!.sql).toContain("`version` =")
    expect(update.where!.params).toEqual(["w1", 1])
    await expect(build(() => changed(0)).repo.update!("w1", { name: "beta" }, { optimisticConcurrency: { expectedVersion: 9 } })).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    await expect(build(() => changed(0), {}, "note").repo.update!("n1", { body: "x" })).rejects.toBeInstanceOf(NotFoundError)
    await expect(build(() => changed(1)).repo.update!("w1", { name: "x" })).rejects.toBeInstanceOf(Error)
    await expect(build(() => changed(1)).repo.update!("w1", { version: 3 }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(build(() => changed(1), {}, "note").repo.update!("n1", { body: "x" }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(Error)
    const failing = build(() => { throw mysqlError(1062, "ER_DUP_ENTRY") })
    await expect(failing.repo.update!("w1", { name: "x" }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(ConflictError)
    const unversioned = build((op) => (op.kind === "update" ? changed(1) : [{ id: "n1", body: "x" }]), {}, "note")
    expect(await unversioned.repo.update!("n1", { body: "x" })).toEqual({ id: "n1", body: "x" })
  })

  const matchThenUpdate = (ids: string[], affected: number, fresh: unknown = row({ version: 2 })): ScriptedHandler => (op) => {
    if (op.kind === "update") return changed(affected)
    if (op.limit === 2) return ids.map((id) => ({ id }))
    return fresh ? [fresh] : []
  }

  it("updateOneWhereReturning updates the single match with the predicate re-evaluated in the UPDATE", async () => {
    const opts = { optimisticConcurrency: { expectedVersion: 1 } }
    const { repo, ops } = build(matchThenUpdate(["w1"], 1))
    expect(await repo.updateOneWhereReturning!(Predicate.eq("name", "alpha"), { score: 5 }, opts)).toMatchObject({ version: 2 })
    const update = ops.find((op) => op.kind === "update")!
    expect(update.where!.sql).toContain("`name`")
    expect(update.where!.sql).toContain("`version` =")
    await expect(build(matchThenUpdate(["a", "b"], 1)).repo.updateOneWhereReturning!(Predicate.eq("name", "x"), { score: 5 }, opts)).rejects.toBeInstanceOf(ValidationError)
    await expect(build(matchThenUpdate([], 1)).repo.updateOneWhereReturning!(Predicate.eq("name", "x"), { score: 5 }, opts)).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    await expect(build(matchThenUpdate(["w1"], 0)).repo.updateOneWhereReturning!(Predicate.eq("name", "x"), { score: 5 }, opts)).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    expect(await build(matchThenUpdate([], 0), {}, "note").repo.updateOneWhereReturning!(Predicate.eq("body", "x"), { body: "y" })).toBeNull()
    expect(await build(matchThenUpdate(["n1"], 0, null), {}, "note").repo.updateOneWhereReturning!(Predicate.eq("body", "x"), { body: "y" })).toBeNull()
    await expect(build(matchThenUpdate(["w1"], 1)).repo.updateOneWhereReturning!(undefined, { score: 5 }, opts)).rejects.toBeInstanceOf(ValidationError)
    await expect(build(matchThenUpdate(["w1"], 1)).repo.updateOneWhereReturning!(Predicate.eq("name", "x"), { score: 5 })).rejects.toBeInstanceOf(Error)
    await expect(build(matchThenUpdate(["w1"], 1)).repo.updateOneWhereReturning!(Predicate.eq("name", "x"), { version: 5 }, opts)).rejects.toBeInstanceOf(ConfigurationError)
    const failing = build((op) => { if (op.kind === "update") throw mysqlError(1062, "ER_DUP_ENTRY"); return [{ id: "w1" }] })
    await expect(failing.repo.updateOneWhereReturning!(Predicate.eq("name", "x"), { score: 5 }, opts)).rejects.toBeInstanceOf(ConflictError)
  })

  it("updateOneWhere reports 1 or 0 depending on whether a row was returned", async () => {
    const opts = { optimisticConcurrency: { expectedVersion: 1 } }
    expect(await build(matchThenUpdate(["w1"], 1)).repo.updateOneWhere!(Predicate.eq("name", "alpha"), { score: 5 }, opts)).toEqual({ updatedCount: 1 })
    expect(await build(matchThenUpdate([], 0), {}, "note").repo.updateOneWhere!(Predicate.eq("body", "x"), { body: "y" })).toEqual({ updatedCount: 0 })
  })

  it("updateManyWhere exists only for unversioned entities and counts affected rows", async () => {
    expect(build(() => []).repo.updateManyWhere).toBeUndefined()
    const { repo, ops } = build(() => changed(3), {}, "note")
    expect(await repo.updateManyWhere!(Predicate.eq("body", "x"), { body: "y" })).toBe(3)
    expect(ops[0]!.where!.sql).toContain("`body`")
    await expect(repo.updateManyWhere!(undefined, { body: "y" })).rejects.toBeInstanceOf(ValidationError)
    await expect(repo.updateManyWhere!(allRows, { body: "y" })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(build(() => { throw mysqlError(1213, "ER_LOCK_DEADLOCK") }, {}, "note").repo.updateManyWhere!(Predicate.eq("body", "x"), { body: "y" })).rejects.toBeInstanceOf(RetryablePersistenceError)
  })

  it("delete distinguishes missing rows, version mismatches and idempotent repeats", async () => {
    const ok = build(() => changed(1))
    await expect(ok.repo.delete!("w1", { optimisticConcurrency: { expectedVersion: 1 } })).resolves.toBeUndefined()
    expect(ok.ops[0]!.where!.params).toEqual(["w1", 1])
    const missing = build(noRows)
    await expect(missing.repo.delete!("w1", { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(NotFoundError)
    await expect(missing.repo.delete!("w1", { idempotent: true, optimisticConcurrency: { expectedVersion: 1 } })).resolves.toBeUndefined()
    const mismatch = build((op) => (op.kind === "delete" ? changed(0) : [row()]))
    await expect(mismatch.repo.delete!("w1", { optimisticConcurrency: { expectedVersion: 9 } })).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    await expect(missing.repo.delete!("w1")).rejects.toBeInstanceOf(Error)
    const plain = build(noRows, {}, "note")
    await expect(plain.repo.delete!("n1")).rejects.toBeInstanceOf(NotFoundError)
    await expect(plain.repo.delete!("n1", { idempotent: true })).resolves.toBeUndefined()
    await expect(build(() => { throw mysqlError(1213, "ER_LOCK_DEADLOCK") }).repo.delete!("w1", { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(RetryablePersistenceError)
    const readbackFails = build((op) => { if (op.kind === "delete") return changed(0); throw mysqlError(1213, "ER_LOCK_DEADLOCK") })
    await expect(readbackFails.repo.delete!("w1", { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(RetryablePersistenceError)
  })

  it("deleteWhere returns counts and distinguishes version mismatches from misses", async () => {
    const opts = { optimisticConcurrency: { expectedVersion: 1 } }
    const { repo, ops } = build(() => changed(2))
    expect(await repo.deleteWhere!(Predicate.eq("name", "alpha"), opts)).toEqual({ deletedCount: 2 })
    expect(ops[0]!.where!.sql).toContain("`version` =")
    await expect(repo.deleteWhere!(undefined, opts)).rejects.toBeInstanceOf(ValidationError)
    await expect(repo.deleteWhere!(allRows, opts)).rejects.toThrow("All-row deleteWhere is forbidden")
    const mismatch = build((op) => (op.kind === "delete" ? changed(0) : [row()]))
    await expect(mismatch.repo.deleteWhere!(Predicate.eq("name", "alpha"), opts)).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    const none = build(noRows)
    await expect(none.repo.deleteWhere!(Predicate.eq("name", "alpha"), opts)).rejects.toBeInstanceOf(NotFoundError)
    expect(await build(noRows, {}, "note").repo.deleteWhere!(Predicate.eq("body", "x"))).toEqual({ deletedCount: 0 })
    await expect(build(() => { throw mysqlError(1213, "ER_LOCK_DEADLOCK") }, {}, "note").repo.deleteWhere!(Predicate.eq("body", "x"))).rejects.toBeInstanceOf(RetryablePersistenceError)
    const readbackFails = build((op) => { if (op.kind === "delete") return changed(0); throw mysqlError(1213, "ER_LOCK_DEADLOCK") })
    await expect(readbackFails.repo.deleteWhere!(Predicate.eq("name", "alpha"), opts)).rejects.toBeInstanceOf(RetryablePersistenceError)
  })
})
