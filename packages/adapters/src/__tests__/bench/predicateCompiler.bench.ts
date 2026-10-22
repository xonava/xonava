import { bench, describe } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core/dialect"
import { MySqlDialect } from "drizzle-orm/mysql-core/dialect"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core/dialect"
import { boolean, doublePrecision, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { datetime, double, mysqlTable, tinyint, varchar } from "drizzle-orm/mysql-core"
import { integer, real, sqliteTable, text as sqliteText } from "drizzle-orm/sqlite-core"
import { Predicate, type PredicateNode } from "@xonava/core/domain"
import { DrizzlePredicateCompiler, compileDrizzlePredicate, type DrizzleColumnMap, type PredicateDialect } from "../../drizzle-shared/predicateCompiler"
import { BENCH_OPTIONS } from "./benchOptions"

const pgRows = pgTable("orders", {
  id: uuid("id"), status: text("status"), region: text("region"), ownerId: text("owner_id"), name: text("name"),
  amount: doublePrecision("amount"), archived: boolean("archived"), createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }), deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
})
const myRows = mysqlTable("orders", {
  id: varchar("id", { length: 36 }), status: varchar("status", { length: 32 }), region: varchar("region", { length: 32 }), ownerId: varchar("owner_id", { length: 64 }), name: varchar("name", { length: 255 }),
  amount: double("amount"), archived: tinyint("archived"), createdAt: datetime("created_at", { mode: "date", fsp: 3 }), deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
})
const liteRows = sqliteTable("orders", {
  id: sqliteText("id"), status: sqliteText("status"), region: sqliteText("region"), ownerId: sqliteText("owner_id"), name: sqliteText("name"),
  amount: real("amount"), archived: integer("archived", { mode: "boolean" }), createdAt: integer("created_at", { mode: "timestamp_ms" }), deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
})

const simple = Predicate.eq("status", "open")
const conjunction = Predicate.and(
  Predicate.eq("status", "open"),
  Predicate.gte("amount", 1000),
  Predicate.lt("amount", 5000),
  Predicate.isFalse("archived"),
  Predicate.isNull("deletedAt"),
)
const textual = Predicate.and(
  Predicate.contains("name", "maintenance"),
  Predicate.startsWith("name", "Quarterly"),
  Predicate.or(Predicate.endsWith("name", "renewal"), Predicate.neq("region", "apac")),
)
const nested = Predicate.and(
  Predicate.or(Predicate.eq("region", "emea"), Predicate.eq("region", "apac"), Predicate.eq("ownerId", "user-42")),
  Predicate.not(Predicate.and(Predicate.eq("status", "closed"), Predicate.eq("archived", true))),
  Predicate.between("amount", [100, 5000]),
  Predicate.in("ownerId", Array.from({ length: 50 }, (_, index) => `user-${index}`)),
  Predicate.gte("createdAt", "2026-01-01T00:00:00Z"),
)
const predicates: ReadonlyArray<readonly [string, PredicateNode]> = [
  ["equality", simple],
  ["five-way conjunction", conjunction],
  ["text operators", textual],
  ["nested with in(50) and RFC 3339 range", nested],
]

interface DialectCase {
  readonly dialect: PredicateDialect
  readonly columns: DrizzleColumnMap
  readonly render: (sql: ReturnType<typeof compileDrizzlePredicate>) => unknown
}
const pgDialect = new PgDialect()
const myDialect = new MySqlDialect()
const liteDialect = new SQLiteSyncDialect()
const cases: readonly DialectCase[] = [
  { dialect: "generic", columns: getTableColumns(liteRows), render: (sql) => liteDialect.sqlToQuery(sql) },
  { dialect: "sqlite", columns: getTableColumns(liteRows), render: (sql) => liteDialect.sqlToQuery(sql) },
  { dialect: "postgres", columns: getTableColumns(pgRows), render: (sql) => pgDialect.sqlToQuery(sql) },
  { dialect: "mysql", columns: getTableColumns(myRows), render: (sql) => myDialect.sqlToQuery(sql) },
]

for (const { dialect, columns, render } of cases) {
  describe(`predicate compiler (${dialect})`, () => {
    for (const [label, predicate] of predicates) {
      bench(`compile ${label}`, () => { compileDrizzlePredicate(predicate, columns, { dialect }) }, BENCH_OPTIONS)
    }
    const compiler = new DrizzlePredicateCompiler(columns, { dialect })
    bench("compile WHERE clause for the nested predicate", () => { compiler.compileWhere(nested) }, BENCH_OPTIONS)
    bench("compile and render the nested predicate to SQL text", () => { render(compileDrizzlePredicate(nested, columns, { dialect })) }, BENCH_OPTIONS)
  })
}
