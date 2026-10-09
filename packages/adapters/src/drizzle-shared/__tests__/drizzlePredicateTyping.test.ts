import { describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core/dialect"
import { MySqlDialect } from "drizzle-orm/mysql-core/dialect"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core/dialect"
import { boolean, date, doublePrecision, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { datetime, decimal, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { integer, sqliteTable, text as sqliteText } from "drizzle-orm/sqlite-core"
import { Predicate } from "core/domain"
import { sortExpression } from "../predicateCompiler"
import { compileDrizzlePredicate as compilePg } from "../../drizzle-pg/postgresPredicate"
import { compileDrizzlePredicate as compileMySql } from "../../drizzle-mysql/mysqlPredicate"
import { compileDrizzlePredicate as compileSqlite } from "../../drizzle-d1/sqlitePredicate"

/**
 * Regressions found by the real-database differential
 * (packages/testing/integration/{pg,mysql,d1}/richParity.integration.test.ts):
 * literals are typed exactly as the core evaluator types them, and text
 * semantics apply only to columns whose SQL type is character data.
 */
const pg = new PgDialect()
const my = new MySqlDialect()
const lite = new SQLiteSyncDialect()

const pgRows = pgTable("rows", {
  name: text("name"),
  amount: doublePrecision("amount"),
  active: boolean("active"),
  dueOn: date("due_on"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }),
  price: numeric("price", { precision: 40, scale: 20 }),
  key: uuid("key"),
})
const pgMap = { name: pgRows.name, amount: pgRows.amount, active: pgRows.active, dueOn: pgRows.dueOn, updatedAt: pgRows.updatedAt, price: pgRows.price, key: pgRows.key }
const pgSql = (node: Parameters<typeof compilePg>[0]) => pg.sqlToQuery(compilePg(node, pgMap))

const myRows = mysqlTable("rows", { name: varchar("name", { length: 64 }), updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }), price: decimal("price", { precision: 40, scale: 20 }) })
const myMap = { name: myRows.name, updatedAt: myRows.updatedAt, price: myRows.price }

const liteRows = sqliteTable("rows", { name: sqliteText("name"), updatedAt: integer("updated_at", { mode: "timestamp_ms" }) })
const liteMap = { name: liteRows.name, updatedAt: liteRows.updatedAt }

describe("predicate compiler literal typing (core comparability)", () => {
  it("compares an instant column with a strict RFC 3339 string as that instant", () => {
    // Before: drizzle's timestamp encoder threw `value.toISOString is not a function`.
    expect(pgSql(Predicate.eq("updatedAt", "2026-01-01T05:30:00+05:30")).params).toEqual(["2026-01-01T00:00:00.000Z"])
    expect(my.sqlToQuery(compileMySql(Predicate.gte("updatedAt", "2026-01-01"), myMap)).params).toEqual(["2026-01-01 00:00:00.000"])
    expect(lite.sqlToQuery(compileSqlite(Predicate.lt("updatedAt", "2026-01-01T00:00:00.001Z"), liteMap)).params).toEqual([1767225600001])
  })

  it("accepts Date literals as scalars", () => {
    // Before: `Predicate operator eq requires a scalar value`.
    expect(pgSql(Predicate.eq("updatedAt", new Date("2026-01-01T00:00:00Z"))).params).toEqual(["2026-01-01T00:00:00.000Z"])
  })

  it("compiles an unparseable instant literal to UNKNOWN, which NOT keeps UNKNOWN", () => {
    for (const literal of ["2026-01-01T00:00:00", "2026-02-30T00:00:00Z", "yesterday"]) {
      expect(pgSql(Predicate.not(Predicate.eq("updatedAt", literal)))).toEqual({ sql: "COALESCE(not (1 = NULL), FALSE)", params: [] })
    }
  })

  it("never compares across value kinds (\"1\" is not 1, a number is not a boolean)", () => {
    expect(pgSql(Predicate.eq("amount", "1")).sql).toBe("COALESCE((1 = NULL), FALSE)")
    expect(pgSql(Predicate.eq("name", 1)).sql).toBe("COALESCE((1 = NULL), FALSE)")
    expect(pgSql(Predicate.eq("active", 1)).sql).toBe("COALESCE((1 = NULL), FALSE)")
    expect(pgSql(Predicate.isTrue("amount")).sql).toBe("COALESCE((1 = NULL), FALSE)")
    expect(pgSql(Predicate.contains("amount", "1")).sql).toBe("COALESCE((1 = NULL), FALSE)")
  })

  it("keeps comparable members of a mixed membership list and adds an UNKNOWN disjunct", () => {
    const query = pgSql(Predicate.in("amount", [1, "2", null]))
    expect(query.sql).toBe('COALESCE(("rows"."amount" in ($1) or (1 = NULL)), FALSE)')
    expect(query.params).toEqual([1])
    expect(pgSql(Predicate.in("amount", ["2"])).sql).toBe("COALESCE((1 = NULL), FALSE)")
  })
})

describe("predicate compiler text semantics apply only to character columns", () => {
  it("PostgreSQL: ordered NUMERIC comparisons are numeric (COLLATE \"C\" on numeric is an error)", () => {
    expect(pgSql(Predicate.gte("price", 1))).toMatchObject({ sql: 'COALESCE("rows"."price" >= $1, FALSE)', params: [1] })
    expect(pgSql(Predicate.gte("price", "1")).sql).toBe("COALESCE((1 = NULL), FALSE)")
  })

  it("PostgreSQL: string-mode date and uuid columns compare natively for canonical literals, as text otherwise", () => {
    expect(pgSql(Predicate.gte("dueOn", "2026-01-01")).sql).toBe('COALESCE("rows"."due_on" >= $1, FALSE)')
    // Core compares the hydrated string "2026-01-01" with the literal by code point.
    expect(pgSql(Predicate.eq("dueOn", "2026-01-01T00:00:00.000Z")).sql).toBe('COALESCE(("rows"."due_on"::text COLLATE "C") = $1, FALSE)')
    expect(pgSql(Predicate.gt("key", "00000000-0000-4000-8000-000000000000")).sql).toBe('COALESCE("rows"."key" > $1, FALSE)')
    expect(pgSql(Predicate.eq("key", "ABC")).sql).toBe('COALESCE(("rows"."key"::text COLLATE "C") = $1, FALSE)')
    expect(pgSql(Predicate.gt("name", "a")).sql).toBe('COALESCE(("rows"."name" COLLATE "C") > $1, FALSE)')
  })

  it("MySQL: compares text through NO PAD utf8mb4_0900_bin and DECIMAL numerically", () => {
    // utf8mb4_bin is PAD SPACE: 'a' = 'a ' and 'a' > 'a\t' there, unlike code-point order.
    expect(my.sqlToQuery(compileMySql(Predicate.eq("name", "a "), myMap)).sql).toBe("COALESCE((CONVERT(`rows`.`name` USING utf8mb4) COLLATE utf8mb4_0900_bin) = ?, FALSE)")
    // Before: CONVERT(decimal) compared '10.000…' < '9' as strings.
    expect(my.sqlToQuery(compileMySql(Predicate.gt("price", 9), myMap)).sql).toBe("COALESCE(`rows`.`price` > ?, FALSE)")
  })

  it("isEmpty on a non-string column is exactly IS NULL", () => {
    expect(pgSql(Predicate.isEmpty("amount"))).toEqual({ sql: 'COALESCE("rows"."amount" is null, FALSE)', params: [] })
  })
})

describe("repository sort keys order exactly like predicate comparison", () => {
  // Regression (real-database differential): ORDER BY used the column collation while keyset
  // cursor predicates compare in code-point order, so pages skipped or repeated rows.
  it("PostgreSQL: character columns sort under COLLATE \"C\"; other columns sort natively", () => {
    expect(pg.sqlToQuery(sql`${sortExpression(pgRows.name, { dialect: "postgres" })}`).sql).toBe('("rows"."name" COLLATE "C")')
    for (const column of [pgRows.price, pgRows.dueOn, pgRows.key, pgRows.updatedAt, pgRows.amount]) expect(sortExpression(column, { dialect: "postgres" })).toBe(column)
  })

  it("MySQL: string columns sort through utf8mb4_0900_bin unless verified NO PAD binary", () => {
    expect(my.sqlToQuery(sql`${sortExpression(myRows.name, { dialect: "mysql" })}`).sql).toBe("(CONVERT(`rows`.`name` USING utf8mb4) COLLATE utf8mb4_0900_bin)")
    expect(sortExpression(myRows.name, { dialect: "mysql", mysqlBinaryCollation: true })).toBe(myRows.name)
    expect(sortExpression(myRows.price, { dialect: "mysql" })).toBe(myRows.price)
  })

  it("SQLite: the default BINARY collation is already code-point order", () => {
    expect(sortExpression(liteRows.name, { dialect: "sqlite" })).toBe(liteRows.name)
  })
})
