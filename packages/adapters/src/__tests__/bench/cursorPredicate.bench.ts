import { describe } from "vitest"
import { PgDialect } from "drizzle-orm/pg-core/dialect"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core/dialect"
import { doublePrecision, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { integer, real, sqliteTable, text as sqliteText } from "drizzle-orm/sqlite-core"
import type { SortSpec } from "@xonava/core/query"
import { compileCursorPredicate, executionSort } from "../../drizzle-shared/cursorPagination"
import { compileDrizzlePredicate, type DrizzleColumnMap } from "../../drizzle-shared/predicateCompiler"
import { bench, BENCH_OPTIONS } from "./benchOptions"

const pgRows = pgTable("orders", { id: text("id"), status: text("status"), amount: doublePrecision("amount"), createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }) })
const liteRows = sqliteTable("orders", { id: sqliteText("id"), status: sqliteText("status"), amount: real("amount"), createdAt: integer("created_at", { mode: "timestamp_ms" }) })
const pgColumns: DrizzleColumnMap = { id: pgRows.id, status: pgRows.status, amount: pgRows.amount, createdAt: pgRows.createdAt }
const liteColumns: DrizzleColumnMap = { id: liteRows.id, status: liteRows.status, amount: liteRows.amount, createdAt: liteRows.createdAt }
const pgDialect = new PgDialect()
const liteDialect = new SQLiteSyncDialect()

const singleKey: readonly SortSpec[] = [{ field: "id", direction: "asc" }]
const twoKeys: readonly SortSpec[] = [{ field: "createdAt", direction: "desc" }, { field: "id", direction: "asc" }]
const threeKeysNullable: readonly SortSpec[] = [
  { field: "status", direction: "asc", nulls: "last" },
  { field: "amount", direction: "desc", nulls: "first" },
  { field: "id", direction: "asc" },
]

describe("cursor predicates", () => {
  bench("build keyset predicate, one sort key", () => { compileCursorPredicate(singleKey, { direction: "after", values: ["ord_000123"] }) }, BENCH_OPTIONS)
  bench("build keyset predicate, two sort keys", () => { compileCursorPredicate(twoKeys, { direction: "after", values: ["2026-03-15T12:00:00Z", "ord_000123"] }) }, BENCH_OPTIONS)
  bench("build keyset predicate, three nullable sort keys", () => {
    compileCursorPredicate(threeKeysNullable, { direction: "before", values: ["open", null, "ord_000123"] })
  }, BENCH_OPTIONS)
  bench("reverse the sort for a before page", () => { executionSort(threeKeysNullable, "before") }, BENCH_OPTIONS)
  bench("build and compile keyset predicate to PostgreSQL SQL", () => {
    const predicate = compileCursorPredicate(twoKeys, { direction: "after", values: ["2026-03-15T12:00:00Z", "ord_000123"] })
    pgDialect.sqlToQuery(compileDrizzlePredicate(predicate, pgColumns, { dialect: "postgres" }))
  }, BENCH_OPTIONS)
  bench("build and compile three-key nullable keyset predicate to SQLite SQL", () => {
    const predicate = compileCursorPredicate(threeKeysNullable, { direction: "after", values: ["open", 1250.5, "ord_000123"] })
    liteDialect.sqlToQuery(compileDrizzlePredicate(predicate, liteColumns, { dialect: "sqlite" }))
  }, BENCH_OPTIONS)
})
