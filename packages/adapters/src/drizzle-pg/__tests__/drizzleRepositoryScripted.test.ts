import { describe, expect, it } from "vitest"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { ConfigurationError, ConflictError, NotFoundError, OptimisticConcurrencyError, PersistenceError, Predicate, RetryablePersistenceError, ValidationError } from "@xonava/core/domain"
import { createDrizzleRepository, type DrizzleColumnMap } from "../drizzleRepository"
import { createScriptedDb, type ScriptedHandler } from "../../__tests__/support/scriptedDb"

const widgets = pgTable("widgets", { id: text("id").primaryKey(), name: text("name").notNull(), score: integer("score"), version: integer("version").notNull(), createdAt: integer("created_at") })
const notes = pgTable("notes", { id: text("id").primaryKey(), body: text("body").notNull() })
const widgetColumns = { id: widgets.id, name: widgets.name, score: widgets.score, version: widgets.version, createdAt: widgets.createdAt } satisfies DrizzleColumnMap
const widgetEntity = { name: "widget", primaryKey: "id", versionField: "version", fields: { id: { type: "string" }, name: { type: "string" }, score: { type: "number", nullable: true }, version: { type: "number" }, createdAt: { type: "number", nullable: true } } } as const
const noteEntity = { name: "note", primaryKey: "id", fields: { id: { type: "string" }, body: { type: "string" } } } as const

type Repo = Record<string, (...args: unknown[]) => Promise<any>>
function build(handler: ScriptedHandler, extra: Record<string, unknown> = {}, kind: "widget" | "note" = "widget") {
  const scripted = createScriptedDb("pg", handler)
  const repo = createDrizzleRepository({
    db: scripted.db as never,
    table: kind === "widget" ? widgets : notes,
    entity: (kind === "widget" ? widgetEntity : noteEntity) as never,
    columnMap: kind === "widget" ? widgetColumns : { id: notes.id, body: notes.body },
    ...extra,
  }) as unknown as Repo
  return { repo, ops: scripted.ops }
}
const row = (overrides: Record<string, unknown> = {}) => ({ id: "w1", name: "alpha", score: 1, version: 1, createdAt: 1, ...overrides })
const providerError = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error("provider text: widgets_name_key"), { code, ...extra })

describe("PostgreSQL repository reads", () => {
  it("finds by id and by predicate, compiling the filter into the issued SQL", async () => {
    const { repo, ops } = build(() => [row()])
    expect(await repo.findById!("w1")).toEqual(row())
    expect(ops[0]).toMatchObject({ kind: "select", limit: 1 })
    expect(ops[0]!.where).toEqual({ sql: '"widgets"."id" = $1', params: ["w1"] })
    expect((await repo.findOneWhere!(Predicate.eq("name", "alpha")))?.id).toBe("w1")
    expect(ops[1]!.where!.sql).toContain('"widgets"."name"')
    await expect(repo.findOneWhere!(undefined)).rejects.toBeInstanceOf(ValidationError)
    const empty = build(() => [])
    expect(await empty.repo.findById!("x")).toBeNull()
  })

  it("normalizes provider read failures without leaking provider text", async () => {
    const { repo } = build(() => { throw providerError("40001") })
    const error = await repo.findById!("w1").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RetryablePersistenceError)
    expect(String((error as Error).message)).not.toContain("widgets_name_key")
    const other = build(() => { throw providerError("XX000") })
    await expect(other.repo.findMany!()).rejects.toBeInstanceOf(PersistenceError)
  })

  it("lists with count and page rows, projection, explicit sort and defaults", async () => {
    const handler: ScriptedHandler = (op) => (op.fields && "count" in (op.fields as object) ? [{ count: 7 }] : [row(), row({ id: "w2" })])
    const { repo, ops } = build(handler)
    const result = await repo.findMany!({ filter: Predicate.eq("name", "alpha"), sort: [{ field: "score", direction: "desc" }], projection: { fields: ["id", "score"] }, pagination: { kind: "offset", page: 2, pageSize: 5 } })
    expect(result).toMatchObject({ rowCount: 7, page: 2, pageSize: 5 })
    expect(result.rows).toHaveLength(2)
    const page = ops.find((op) => op.offset !== undefined)!
    expect(page).toMatchObject({ limit: 5, offset: 5 })
    expect(page.orderBy!.sql).toContain("desc")
    expect(Object.keys(page.fields as object)).toEqual(["id", "score"])
    const defaults = build(handler)
    await defaults.repo.findMany!()
    const defaultPage = defaults.ops.find((op) => op.offset !== undefined)!
    expect(defaultPage).toMatchObject({ limit: 20, offset: 0 })
    expect(defaultPage.orderBy!.sql).toContain('"created_at"')
    expect(defaultPage.orderBy!.sql).toContain('"id"')
  })

  it("sorts by the primary key alone with no tie-breaker and honours NULLS ordering", async () => {
    const handler: ScriptedHandler = (op) => (op.fields && "count" in (op.fields as object) ? [{ count: 0 }] : [])
    const byId = build(handler)
    await byId.repo.findMany!({ sort: [{ field: "id", direction: "asc" }] })
    expect(byId.ops.find((op) => op.offset !== undefined)!.orderBy!.sql).not.toContain(",")
    const nulls = build(handler)
    await nulls.repo.findMany!({ sort: [{ field: "score", direction: "asc", nulls: "first" }, { field: "name", direction: "desc", nulls: "last" }] })
    const sql = nulls.ops.find((op) => op.offset !== undefined)!.orderBy!.sql
    expect(sql).toContain("NULLS FIRST")
    expect(sql).toContain("NULLS LAST")
    expect(sql).toMatch(/"id" (asc|desc)/i)
  })

  it("keysets cursor pages with the sort tuple and reports page info", async () => {
    const handler: ScriptedHandler = (op) => (op.fields && "count" in (op.fields as object) ? [{ count: 3 }] : [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })])
    const { repo, ops } = build(handler)
    const sort = [{ field: "name", direction: "asc" as const }, { field: "id", direction: "asc" as const }]
    const forward = await repo.findMany!({ sort, pagination: { kind: "cursor", direction: "after", limit: 2, values: ["alpha", "w1"] } })
    expect(forward.rows.map((r: { id: string }) => r.id)).toEqual(["a", "b"])
    expect(forward.pageInfo).toEqual({ kind: "cursor", hasNextPage: true, hasPreviousPage: true })
    expect(ops.find((op) => op.offset !== undefined)).toMatchObject({ limit: 3 })
    const backward = await repo.findMany!({ filter: Predicate.eq("score", 1), sort, pagination: { kind: "cursor", direction: "before", limit: 2, values: ["zeta", "w9"] } })
    expect(backward.rows.map((r: { id: string }) => r.id)).toEqual(["b", "a"])
    await expect(repo.findMany!({ pagination: { kind: "cursor", direction: "after", limit: 2 } })).rejects.toThrow("explicit stable sort")
  })

  it("rejects bad sort or projection fields, unsupported consistency and invalid paging", async () => {
    const handler: ScriptedHandler = (op) => (op.fields && "count" in (op.fields as object) ? [{ count: 0 }] : [])
    const { repo } = build(handler, { maxPageSize: 10, maxOffset: 20 })
    await expect(repo.findMany!({ sort: [{ field: "nope", direction: "asc" }] })).rejects.toThrow('Unknown sort field: "nope"')
    await expect(repo.findMany!({ projection: { fields: ["nope"] } })).rejects.toThrow('Unknown projection field: "nope"')
    await expect(repo.findMany!({ consistency: "eventual" })).rejects.toBeInstanceOf(Error)
    await expect(repo.findMany!({ pagination: { kind: "offset", page: 1000, pageSize: 10 } })).rejects.toThrow("exceeds the configured maximum")
    const clamped = await repo.findMany!({ pagination: { kind: "offset", page: 1, pageSize: 500 } })
    expect(clamped.pageSize).toBe(10)
  })

  it("validates construction arguments", () => {
    const noop = () => []
    expect(() => build(noop, { maxPageSize: 0 })).toThrow(ConfigurationError)
    expect(() => build(noop, { maxOffset: -1 })).toThrow("maxOffset")
    expect(() => createDrizzleRepository({ db: createScriptedDb("pg", noop).db as never, table: widgets, entity: widgetEntity as never, columnMap: { name: widgets.name } })).toThrow("missing primary key column")
  })
})

describe("PostgreSQL repository writes", () => {
  it("inserts with RETURNING, validating the returned version", async () => {
    const { repo, ops } = build((op) => (op.kind === "insert" ? [row({ version: 1 })] : []))
    expect(await repo.insert!({ id: "w1", name: "alpha", version: 1 })).toMatchObject({ id: "w1", version: 1 })
    expect(ops[0]).toMatchObject({ kind: "insert", returning: true })
    await expect(repo.insert!({ id: "w1", name: "alpha", version: 0.5 })).rejects.toBeInstanceOf(Error)
    const empty = build(() => [])
    await expect(empty.repo.insert!({ id: "w1", name: "alpha" })).rejects.toThrow("returned no rows")
    const badVersion = build(() => [row({ version: -3 })])
    await expect(badVersion.repo.insert!({ id: "w1", name: "alpha" })).rejects.toBeInstanceOf(Error)
  })

  it("maps unique violations to ConflictError with the mapped field only", async () => {
    const duplicate = () => { throw providerError("23505", { constraint: "widgets_name_key" }) }
    const mapped = build(duplicate, { constraintMap: { widgets_name_key: "name" } })
    const error = await mapped.repo.insert!({ id: "w2", name: "alpha" }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).details).toMatchObject({ field: "name" })
    expect(String((error as Error).message)).not.toContain("widgets_name_key")
    const unmapped = build(duplicate, { constraintMap: { other: "x" } })
    const plain = await unmapped.repo.insert!({ id: "w2", name: "alpha" }).catch((e: unknown) => e)
    expect(plain).toBeInstanceOf(ConflictError)
    expect((plain as ConflictError).details).not.toHaveProperty("field")
    const inherited = build(() => { throw providerError("23505", { constraint: "toString" }) }, { constraintMap: {} })
    expect((await inherited.repo.insert!({ id: "w3", name: "n" }).catch((e: unknown) => e))).toBeInstanceOf(ConflictError)
  })

  it("updates under optimistic concurrency, bumping the version in SQL", async () => {
    const { repo, ops } = build((op) => (op.kind === "update" ? [row({ version: 2, name: "beta" })] : []))
    const updated = await repo.update!("w1", { name: "beta" }, { optimisticConcurrency: { expectedVersion: 1 } })
    expect(updated).toMatchObject({ name: "beta", version: 2 })
    expect(ops[0]!.where!.sql).toContain('"widgets"."version" =')
    expect(ops[0]!.where!.params).toContain(1)
    expect((ops[0]!.set as Record<string, unknown>).version).toBeDefined()
    const mismatch = build(() => [])
    await expect(mismatch.repo.update!("w1", { name: "beta" }, { optimisticConcurrency: { expectedVersion: 9 } })).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    await expect(mismatch.repo.update!("w1", { name: "beta" })).rejects.toBeInstanceOf(Error)
    await expect(mismatch.repo.update!("w1", { version: 3 }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(ConfigurationError)
    const missing = build(() => [], {}, "note")
    await expect(missing.repo.update!("n1", { body: "x" })).rejects.toBeInstanceOf(NotFoundError)
    await expect(missing.repo.update!("n1", { body: "x" }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(ConfigurationError)
    const unversioned = build((op) => (op.kind === "update" ? [{ id: "n1", body: "x" }] : []), {}, "note")
    expect(await unversioned.repo.update!("n1", { body: "x" })).toEqual({ id: "n1", body: "x" })
  })

  it("update failures are normalized and a corrupt returned version is rejected", async () => {
    const failing = build(() => { throw providerError("23505") })
    await expect(failing.repo.update!("w1", { name: "x" }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(ConflictError)
    const corrupt = build(() => [row({ version: "x" })])
    await expect(corrupt.repo.update!("w1", { name: "x" }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(Error)
  })

  const selectIds = (...ids: string[]): ScriptedHandler => (op) => (op.kind === "select" ? ids.map((id) => ({ primaryKey: id })) : [row({ version: 2 })])

  it("updateOneWhere handles zero, one and many matches on versioned entities", async () => {
    const opts = { optimisticConcurrency: { expectedVersion: 1 } }
    await expect(build(selectIds("a", "b")).repo.updateOneWhere!(Predicate.eq("name", "x"), { score: 1 }, opts)).rejects.toBeInstanceOf(ValidationError)
    await expect(build(selectIds()).repo.updateOneWhere!(Predicate.eq("name", "x"), { score: 1 }, opts)).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    expect(await build(selectIds("a")).repo.updateOneWhere!(Predicate.eq("name", "x"), { score: 1 }, opts)).toEqual({ updatedCount: 1 })
    const none = build((op) => (op.kind === "select" ? [{ primaryKey: "a" }] : []))
    await expect(none.repo.updateOneWhere!(Predicate.eq("name", "x"), { score: 1 }, opts)).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    await expect(build(selectIds("a")).repo.updateOneWhere!(Predicate.eq("name", "x"), { score: 1 })).rejects.toBeInstanceOf(Error)
    await expect(build(selectIds("a")).repo.updateOneWhere!(Predicate.alwaysTrue(), { score: 1 }, opts)).rejects.toBeInstanceOf(ConfigurationError)
    await expect(build(selectIds("a")).repo.updateOneWhere!(undefined, { score: 1 }, opts)).rejects.toBeInstanceOf(ValidationError)
    const failing = build((op) => { if (op.kind === "select") return [{ primaryKey: "a" }]; throw providerError("23505") })
    await expect(failing.repo.updateOneWhere!(Predicate.eq("name", "x"), { score: 1 }, opts)).rejects.toBeInstanceOf(ConflictError)
  })

  it("updateOneWhere on unversioned entities updates without version predicates", async () => {
    const { repo, ops } = build((op) => (op.kind === "select" ? [{ primaryKey: "n1" }] : [{ id: "n1", body: "y" }]), {}, "note")
    expect(await repo.updateOneWhere!(Predicate.eq("body", "x"), { body: "y" })).toEqual({ updatedCount: 1 })
    expect(ops.find((op) => op.kind === "update")!.where!.sql).not.toContain("version")
    await expect(repo.updateOneWhere!(Predicate.eq("body", "x"), { body: "y" }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(ConfigurationError)
    const none = build(() => [], {}, "note")
    expect(await none.repo.updateOneWhere!(Predicate.eq("body", "x"), { body: "y" })).toEqual({ updatedCount: 0 })
    const failing = build((op) => { if (op.kind === "select") return [{ primaryKey: "n1" }]; throw providerError("23505") }, {}, "note")
    await expect(failing.repo.updateOneWhere!(Predicate.eq("body", "x"), { body: "y" })).rejects.toBeInstanceOf(ConflictError)
  })

  it("updateOneWhereReturning returns the updated row, null for a miss and conflicts for stale versions", async () => {
    const opts = { optimisticConcurrency: { expectedVersion: 1 } }
    const ok = build(selectIds("a"))
    expect(await ok.repo.updateOneWhereReturning!(Predicate.eq("name", "x"), { score: 2 }, opts)).toMatchObject({ version: 2 })
    expect(ok.ops.find((op) => op.kind === "update")!.where!.params).toContain(1)
    expect(await build(selectIds("a")).repo.updateOneWhereReturning!(Predicate.eq("name", "x"), { score: 2 }, undefined as never).catch((e: unknown) => e)).toBeInstanceOf(Error)
    await expect(build(selectIds("a", "b")).repo.updateOneWhereReturning!(Predicate.eq("name", "x"), { score: 2 }, opts)).rejects.toBeInstanceOf(ValidationError)
    await expect(build(selectIds()).repo.updateOneWhereReturning!(Predicate.eq("name", "x"), { score: 2 }, opts)).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    const stale = build((op) => (op.kind === "select" ? [{ primaryKey: "a" }] : []))
    await expect(stale.repo.updateOneWhereReturning!(Predicate.eq("name", "x"), { score: 2 }, opts)).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    const noteStore = build((op) => (op.kind === "select" ? [] : []), {}, "note")
    expect(await noteStore.repo.updateOneWhereReturning!(Predicate.eq("body", "x"), { body: "y" })).toBeNull()
    await expect(noteStore.repo.updateOneWhereReturning!(Predicate.eq("body", "x"), { body: "y" }, opts)).rejects.toBeInstanceOf(ConfigurationError)
    await expect(noteStore.repo.updateOneWhereReturning!(Predicate.alwaysTrue(), { body: "y" })).rejects.toBeInstanceOf(ConfigurationError)
    const unversionedMiss = build((op) => (op.kind === "select" ? [{ primaryKey: "n1" }] : []), {}, "note")
    expect(await unversionedMiss.repo.updateOneWhereReturning!(Predicate.eq("body", "x"), { body: "y" })).toBeNull()
    const failing = build((op) => { if (op.kind === "select") return [{ primaryKey: "a" }]; throw providerError("23505") })
    await expect(failing.repo.updateOneWhereReturning!(Predicate.eq("name", "x"), { score: 1 }, opts)).rejects.toBeInstanceOf(ConflictError)
  })

  it("delete distinguishes missing rows, version mismatches and idempotent repeats", async () => {
    const deleted = build((op) => (op.kind === "delete" ? [row()] : []))
    await expect(deleted.repo.delete!("w1", { optimisticConcurrency: { expectedVersion: 1 } })).resolves.toBeUndefined()
    expect(deleted.ops[0]!.where!.sql).toContain('"version" =')
    const missing = build(() => [])
    await expect(missing.repo.delete!("w1", { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(NotFoundError)
    await expect(missing.repo.delete!("w1", { idempotent: true, optimisticConcurrency: { expectedVersion: 1 } })).resolves.toBeUndefined()
    const mismatch = build((op) => (op.kind === "select" ? [{ primaryKey: "w1" }] : []))
    await expect(mismatch.repo.delete!("w1", { optimisticConcurrency: { expectedVersion: 9 } })).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    await expect(missing.repo.delete!("w1")).rejects.toBeInstanceOf(Error)
    const plain = build(() => [], {}, "note")
    await expect(plain.repo.delete!("n1")).rejects.toBeInstanceOf(NotFoundError)
    await expect(plain.repo.delete!("n1", { idempotent: true })).resolves.toBeUndefined()
    await expect(plain.repo.delete!("n1", { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(Error)
    const failing = build(() => { throw providerError("23503") })
    await expect(failing.repo.delete!("w1", { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toThrow()
  })

  it("deleteWhere returns counts and guards all-row, empty and version-mismatch cases", async () => {
    const two = build((op) => (op.kind === "delete" ? [row(), row({ id: "w2" })] : []))
    expect(await two.repo.deleteWhere!(Predicate.eq("name", "alpha"), { optimisticConcurrency: { expectedVersion: 1 } })).toEqual({ deletedCount: 2 })
    expect(two.ops[0]!.where!.sql).toContain('"version" =')
    await expect(two.repo.deleteWhere!(Predicate.alwaysTrue(), { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toThrow("All-row deleteWhere")
    await expect(two.repo.deleteWhere!(Predicate.eq("name", "x"))).rejects.toThrow("requires optimisticConcurrency.expectedVersion")
    await expect(two.repo.deleteWhere!(undefined)).rejects.toBeInstanceOf(ValidationError)
    const mismatch = build((op) => (op.kind === "select" ? [{ primaryKey: "w1" }] : []))
    await expect(mismatch.repo.deleteWhere!(Predicate.eq("name", "x"), { optimisticConcurrency: { expectedVersion: 9 } })).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    const none = build(() => [])
    await expect(none.repo.deleteWhere!(Predicate.eq("name", "x"), { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(NotFoundError)
    const plain = build(() => [], {}, "note")
    expect(await plain.repo.deleteWhere!(Predicate.eq("body", "x"))).toEqual({ deletedCount: 0 })
    await expect(plain.repo.deleteWhere!(Predicate.eq("body", "x"), { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(Error)
    const failing = build(() => { throw providerError("40001") })
    await expect(failing.repo.deleteWhere!(Predicate.eq("name", "x"), { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(RetryablePersistenceError)
  })

  it("treats not/or/and literals consistently when classifying all-row writes", async () => {
    const { repo } = build(() => [], {}, "note")
    const guarded = [
      Predicate.or(Predicate.alwaysTrue(), Predicate.eq("name", "x")),
      Predicate.not(Predicate.alwaysFalse()),
      Predicate.and(Predicate.alwaysTrue(), Predicate.alwaysTrue()),
    ]
    for (const filter of guarded) await expect(repo.deleteWhere!(filter)).rejects.toThrow("All-row deleteWhere")
    const allowed = [Predicate.alwaysFalse(), Predicate.and(Predicate.alwaysFalse(), Predicate.eq("body", "x")), Predicate.or(), Predicate.not(Predicate.alwaysTrue()), Predicate.eq("body", "x")]
    for (const filter of allowed) await expect(repo.deleteWhere!(filter)).resolves.toEqual({ deletedCount: 0 })
  })
})

