import { describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core/dialect"
import { MySqlDialect } from "drizzle-orm/mysql-core/dialect"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core/dialect"
import { boolean, date, doublePrecision, inet, numeric, pgEnum, pgTable, text, time, timestamp, uuid } from "drizzle-orm/pg-core"
import { date as mysqlDate, datetime, decimal, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { integer, sqliteTable, text as sqliteText } from "drizzle-orm/sqlite-core"
import { Predicate } from "@xonava/core/domain"
import { DrizzlePredicateCompiler, sortExpression } from "../predicateCompiler"
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
    expect(pgSql(Predicate.eq("updatedAt", "2026-01-01T05:30:00+05:30")).params).toEqual(["2026-01-01 00:00:00.000+00"])
    expect(my.sqlToQuery(compileMySql(Predicate.gte("updatedAt", "2026-01-01"), myMap)).params).toEqual(["2026-01-01 00:00:00.000"])
    expect(lite.sqlToQuery(compileSqlite(Predicate.lt("updatedAt", "2026-01-01T00:00:00.001Z"), liteMap)).params).toEqual([1767225600001])
  })

  it("accepts Date literals as scalars", () => {
    // Before: `Predicate operator eq requires a scalar value`.
    expect(pgSql(Predicate.eq("updatedAt", new Date("2026-01-01T00:00:00Z"))).params).toEqual(["2026-01-01 00:00:00.000+00"])
  })

  it("compiles an unparseable instant literal to UNKNOWN, which NOT keeps UNKNOWN", () => {
    for (const literal of ["2026-01-01T00:00:00", "2026-02-30T00:00:00Z", "yesterday"]) {
      expect(pgSql(Predicate.not(Predicate.eq("updatedAt", literal)))).toMatchObject({ sql: "COALESCE(not (1 = NULL), FALSE)", params: [] })
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

  it("PostgreSQL: uuid compares natively for canonical literals, as text otherwise", () => {
    expect(pgSql(Predicate.gt("key", "00000000-0000-4000-8000-000000000000")).sql).toBe('COALESCE("rows"."key" > $1, FALSE)')
    expect(pgSql(Predicate.eq("key", "ABC")).sql).toBe('COALESCE((CASE WHEN "rows"."key" IS NULL THEN NULL ELSE format(\'%s\', "rows"."key") END COLLATE "C") = $1, FALSE)')
    expect(pgSql(Predicate.gt("name", "a")).sql).toBe('COALESCE(("rows"."name" COLLATE "C") > $1, FALSE)')
  })

  it("MySQL: compares text through NO PAD utf8mb4_0900_bin (unless verified binary) and DECIMAL numerically", () => {
    expect(my.sqlToQuery(compileMySql(Predicate.eq("name", "a "), myMap, { mysqlBinaryCollation: true })).sql).toBe("COALESCE(`rows`.`name` = (CONVERT(? USING utf8mb4) COLLATE utf8mb4_0900_bin), FALSE)")
    // utf8mb4_bin is PAD SPACE: 'a' = 'a ' and 'a' > 'a\t' there, unlike code-point order.
    expect(my.sqlToQuery(compileMySql(Predicate.eq("name", "a "), myMap)).sql).toBe("COALESCE((CONVERT(`rows`.`name` USING utf8mb4) COLLATE utf8mb4_0900_bin) = ?, FALSE)")
    // Before: CONVERT(decimal) compared '10.000…' < '9' as strings.
    expect(my.sqlToQuery(compileMySql(Predicate.gt("price", 9), myMap)).sql).toBe("COALESCE(`rows`.`price` > ?, FALSE)")
  })

  it("isEmpty on a non-string column is exactly IS NULL", () => {
    expect(pgSql(Predicate.isEmpty("amount"))).toMatchObject({ sql: 'COALESCE("rows"."amount" is null, FALSE)', params: [] })
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

const status = pgEnum("row_status", ["locked", "draft", "Active"])
const pgTemporal = pgTable("temporal_rows", {
  day: date("day"),
  dayDate: date("day_date", { mode: "date" }),
  at: timestamp("at", { withTimezone: true, mode: "string" }),
  clock: time("clock"),
  status: status("status"),
  addr: inet("addr"),
})
const pgTemporalMap = { day: pgTemporal.day, dayDate: pgTemporal.dayDate, at: pgTemporal.at, clock: pgTemporal.clock, status: pgTemporal.status, addr: pgTemporal.addr }
const temporalSql = (node: Parameters<typeof compilePg>[0]) => pg.sqlToQuery(compilePg(node, pgTemporalMap))

describe("temporal SQL columns compare natively (index-usable) for RFC 3339 literals", () => {
  // Regression (review H1): string-mode temporal columns compared as text, so the HTTP layer's
  // date filter (a between of full ISO instants) matched no row and indexes were unusable.
  it("PostgreSQL date: full-date and instant literals compare as dates", () => {
    expect(temporalSql(Predicate.eq("day", "2024-01-01"))).toMatchObject({ sql: 'COALESCE("temporal_rows"."day" = $1, FALSE)', params: ["2024-01-01"] })
    expect(temporalSql(Predicate.between("day", { from: "2024-01-01T00:00:00.000Z", to: "2024-01-01T23:59:59.999Z" })))
      .toMatchObject({ sql: 'COALESCE(("temporal_rows"."day" >= $1 and "temporal_rows"."day" <= $2), FALSE)', params: ["2024-01-01", "2024-01-01 23:59:59.999+00"] })
    expect(temporalSql(Predicate.eq("dayDate", new Date("2024-01-01T00:00:00Z")))).toMatchObject({ params: ["2024-01-01"] })
    // Not RFC 3339: string-mode rows hydrate as strings, so core compares text.
    expect(temporalSql(Predicate.eq("day", "2024-1-1")).sql).toBe('COALESCE((CASE WHEN "temporal_rows"."day" IS NULL THEN NULL ELSE format(\'%s\', "temporal_rows"."day") END COLLATE "C") = $1, FALSE)')
    expect(temporalSql(Predicate.eq("dayDate", "2024-1-1")).sql).toBe("COALESCE((1 = NULL), FALSE)")
  })

  it("PostgreSQL timestamp (string mode) and time: RFC 3339 instants, engine text and clock literals stay native", () => {
    expect(temporalSql(Predicate.gte("at", "2026-01-01T05:30:00+05:30"))).toMatchObject({ sql: 'COALESCE("temporal_rows"."at" >= $1, FALSE)', params: ["2026-01-01 00:00:00.000+00"] })
    expect(temporalSql(Predicate.gt("at", "2026-01-01 00:00:00+00"))).toMatchObject({ sql: 'COALESCE("temporal_rows"."at" > $1, FALSE)', params: ["2026-01-01 00:00:00+00"] })
    expect(temporalSql(Predicate.eq("at", "soon")).sql).toBe('COALESCE((CASE WHEN "temporal_rows"."at" IS NULL THEN NULL ELSE format(\'%s\', "temporal_rows"."at") END COLLATE "C") = $1, FALSE)')
    expect(temporalSql(Predicate.lt("clock", "10:00:00")).sql).toBe('COALESCE("temporal_rows"."clock" < $1, FALSE)')
  })

  it("MySQL DATE (mode date): binds the calendar date, never a local-time Date", () => {
    // Regression (review M7): mysql2 serializes a Date in the connection time zone.
    const rows = mysqlTable("rows", { day: mysqlDate("day"), at: datetime("at", { mode: "string" }) })
    const map = { day: rows.day, at: rows.at }
    expect(my.sqlToQuery(compileMySql(Predicate.eq("day", "2024-01-01"), map)).params).toEqual(["2024-01-01"])
    expect(my.sqlToQuery(compileMySql(Predicate.eq("day", new Date("2024-01-01T00:00:00Z")), map)).params).toEqual(["2024-01-01"])
    expect(my.sqlToQuery(compileMySql(Predicate.lt("day", "2024-01-01T12:00:00Z"), map)).params).toEqual(["2024-01-01 12:00:00.000"])
    // Review LOW: temporal columns are never wrapped in CONVERT, with or without mysqlBinaryCollation.
    for (const options of [{}, { mysqlBinaryCollation: true }]) {
      expect(my.sqlToQuery(compileMySql(Predicate.gte("at", "2026-01-01T05:30:00+05:30"), map, options))).toMatchObject({ sql: "COALESCE(`rows`.`at` >= ?, FALSE)", params: ["2026-01-01 00:00:00.000"] })
    }
  })
})

describe("one comparison model for predicates and sort keys", () => {
  // Regression (review H2): enums sorted natively (declaration order) while keyset predicates
  // compared their text, so cursor pages skipped rows; `st::text = 'x'` also defeated the index.
  it("PostgreSQL enum: native equality (index-usable); ordering and sort keys by code point like core", () => {
    // Regression: ordering in declaration order disagreed with core, so an ABAC
    // deny `status lessThan "pending"` (enum pending, approved) let SQL return rows core denies.
    const textForm = '(CASE WHEN "temporal_rows"."status" IS NULL THEN NULL ELSE format(\'%s\', "temporal_rows"."status") END COLLATE "C")'
    expect(temporalSql(Predicate.eq("status", "draft"))).toMatchObject({ sql: 'COALESCE("temporal_rows"."status" = $1, FALSE)', params: ["draft"] })
    expect(temporalSql(Predicate.in("status", ["zzz", "Active"]))).toMatchObject({ sql: 'COALESCE("temporal_rows"."status" in ($1), FALSE)', params: ["Active"] })
    expect(temporalSql(Predicate.gt("status", "draft")).sql).toBe(`COALESCE(${textForm} > $1, FALSE)`)
    expect(temporalSql(Predicate.between("status", { from: "a", to: "m" })).sql).toBe(`COALESCE((${textForm} >= $1 and ${textForm} <= $2), FALSE)`)
    expect(pg.sqlToQuery(sql`${sortExpression(pgTemporal.status, { dialect: "postgres" })}`).sql).toBe(textForm)
    // A non-member equals no row (and is never sent to the enum type, which would reject it)...
    expect(temporalSql(Predicate.eq("status", "zzz"))).toMatchObject({ sql: 'COALESCE(("temporal_rows"."status" is null and null), FALSE)', params: [] })
    expect(temporalSql(Predicate.neq("status", "zzz"))).toMatchObject({ sql: 'COALESCE(("temporal_rows"."status" is not null or null), FALSE)', params: [] })
    // ...but orders definitely, by code point, like core.
    expect(temporalSql(Predicate.lt("status", "zzz"))).toMatchObject({ sql: `COALESCE(${textForm} < $1, FALSE)`, params: ["zzz"] })
    expect(temporalSql(Predicate.contains("status", "ft")).sql).toBe(`COALESCE(${textForm} LIKE $1 ESCAPE '\\', FALSE)`)
  })

  it("PostgreSQL inet and other text-form types: predicates and sort keys both use the text form", () => {
    expect(temporalSql(Predicate.gt("addr", "10.0.0.2")).sql).toBe('COALESCE((CASE WHEN "temporal_rows"."addr" IS NULL THEN NULL ELSE format(\'%s\', "temporal_rows"."addr") END COLLATE "C") > $1, FALSE)')
    expect(pg.sqlToQuery(sql`${sortExpression(pgTemporal.addr, { dialect: "postgres" })}`).sql).toBe('(CASE WHEN "temporal_rows"."addr" IS NULL THEN NULL ELSE format(\'%s\', "temporal_rows"."addr") END COLLATE "C")')
  })

  it("temporal and uuid sort keys are native", () => {
    expect(sortExpression(pgRows.key, { dialect: "postgres" })).toBe(pgRows.key)
    for (const column of [pgTemporal.day, pgTemporal.at, pgTemporal.clock]) expect(sortExpression(column, { dialect: "postgres" })).toBe(column)
  })
})

describe("WHERE clauses stay index-usable", () => {
  // Regression (review H1/H2 follow-up): COALESCE(<predicate>, FALSE) at the root hides every
  // comparison from the planner, so no predicate could use an index. In a WHERE clause UNKNOWN
  // already excludes the row, so the repository form leaves the root three-valued.
  it("compileWhere keeps the root three-valued; compile stays strictly two-valued for composition", () => {
    const compiler = new DrizzlePredicateCompiler(pgTemporalMap, { dialect: "postgres" })
    expect(pg.sqlToQuery(compiler.compileWhere(Predicate.eq("day", "2024-01-01"))).sql).toBe('("temporal_rows"."day" = $1)')
    expect(pg.sqlToQuery(compiler.compile(Predicate.eq("day", "2024-01-01"))).sql).toBe('COALESCE("temporal_rows"."day" = $1, FALSE)')
    expect(pg.sqlToQuery(compiler.compileWhere(Predicate.literal(false))).sql).toBe("1 = 0")
  })
})

describe("temporal literals outside the engine's input range never reach the server", () => {
  // Regression: valid RFC 3339 literals made PostgreSQL throw
  // ("0000-01-01" is out of range in ISO form; offsets beyond ±15:59; "+010000" years).
  it("PostgreSQL: binds instants in its own input form, with BC and five-digit years", () => {
    expect(temporalSql(Predicate.eq("day", "0000-01-01")).params).toEqual(["0001-01-01 BC"])
    expect(temporalSql(Predicate.gt("at", "9999-12-31T23:00:00-05:00")).params).toEqual(["10000-01-01 04:00:00.000+00"])
    expect(temporalSql(Predicate.lt("at", "0000-06-01T00:00:00Z")).params).toEqual(["0001-06-01 00:00:00.000+00 BC"])
    expect(temporalSql(Predicate.eq("dayDate", "0000-01-01")).params).toEqual(["0001-01-01 BC"])
  })

  // Regression (third review): Date literals before 4714-11-24 BC made PostgreSQL throw
  // ("timestamp out of range"); every stored value lies after that instant.
  it("PostgreSQL: Date literals before its lower limit compare as constants", () => {
    const tooEarly = new Date(0)
    tooEarly.setUTCFullYear(-4713, 10, 23)
    expect(temporalSql(Predicate.eq("at", tooEarly))).toMatchObject({ sql: 'COALESCE(("temporal_rows"."at" is null and null), FALSE)', params: [] })
    // PostgreSQL also stores -infinity, which is not above a literal below the range: compare against it, never a constant.
    expect(temporalSql(Predicate.gt("day", tooEarly))).toMatchObject({ sql: 'COALESCE("temporal_rows"."day" > $1, FALSE)', params: ["-infinity"] })
    expect(temporalSql(Predicate.gte("at", tooEarly))).toMatchObject({ sql: 'COALESCE("temporal_rows"."at" > $1, FALSE)', params: ["-infinity"] })
    expect(temporalSql(Predicate.lt("at", tooEarly))).toMatchObject({ sql: 'COALESCE("temporal_rows"."at" = $1, FALSE)', params: ["-infinity"] })
    expect(temporalSql(Predicate.lte("day", tooEarly))).toMatchObject({ sql: 'COALESCE("temporal_rows"."day" = $1, FALSE)', params: ["-infinity"] })
    expect(temporalSql(Predicate.neq("at", tooEarly))).toMatchObject({ sql: 'COALESCE(("temporal_rows"."at" is not null or null), FALSE)', params: [] })
    const earliest = new Date(0)
    earliest.setUTCFullYear(-4713, 10, 24)
    expect(temporalSql(Predicate.gte("at", earliest)).params).toEqual(["4714-11-24 00:00:00.000+00 BC"])
  })

  // Regression (fourth review): string-mode BC / five-digit-year rows produce cursor values the regex rejected,
  // so keyset predicates compared them as text and skipped rows.
  it("PostgreSQL: its own BC and five-digit-year output forms bind natively", () => {
    for (const literal of ["0044-03-15 12:00:00 BC", "12000-01-01 00:00:00", "0044-03-15 12:00:00.5+00:53:28 BC", "2024-01-01 10:00:00+00"]) {
      expect(temporalSql(Predicate.gt("at", literal))).toMatchObject({ sql: 'COALESCE("temporal_rows"."at" > $1, FALSE)', params: [literal] })
    }
    expect(temporalSql(Predicate.gt("day", "0044-03-15 BC"))).toMatchObject({ sql: 'COALESCE("temporal_rows"."day" > $1, FALSE)', params: ["0044-03-15 BC"] })
    // Before the lower limit (4714-11-24 BC) it is the same out-of-range comparison as a Date.
    expect(temporalSql(Predicate.gt("at", "9000-01-01 00:00:00 BC"))).toMatchObject({ sql: 'COALESCE("temporal_rows"."at" > $1, FALSE)', params: ["-infinity"] })
    expect(temporalSql(Predicate.lt("day", "9000-01-01 BC"))).toMatchObject({ sql: 'COALESCE("temporal_rows"."day" = $1, FALSE)', params: ["-infinity"] })
    expect(temporalSql(Predicate.eq("at", "9000-01-01 00:00:00 BC"))).toMatchObject({ params: [] })
    // The engine rejects these: they stay text comparisons.
    const textForm = '(CASE WHEN "temporal_rows"."at" IS NULL THEN NULL ELSE format(\'%s\', "temporal_rows"."at") END COLLATE "C")'
    for (const literal of ["0000-01-01 00:00:00 BC", "2024-02-30 00:00:00", "2024-01-01 25:00:00", "999999-01-01 00:00:00", "2024-01-01 10:00:00 BC AD"]) {
      expect(temporalSql(Predicate.gt("at", literal)).sql, literal).toBe(`COALESCE(${textForm} > $1, FALSE)`)
    }
  })

  it("PostgreSQL: engine-text literals outside its input range compare through the text form", () => {
    const textForm = '(CASE WHEN "temporal_rows"."at" IS NULL THEN NULL ELSE format(\'%s\', "temporal_rows"."at") END COLLATE "C")'
    for (const literal of ["2024-01-01 10:00:00+99", "2024-01-01 10:00:00+16:00", "0000-12-31 10:00:00+00"]) {
      expect(temporalSql(Predicate.gt("at", literal)).sql).toBe(`COALESCE(${textForm} > $1, FALSE)`)
    }
    expect(temporalSql(Predicate.gt("at", "2024-01-01 10:00:00+15:59")).sql).toBe('COALESCE("temporal_rows"."at" > $1, FALSE)')
  })

  it("MySQL: instants outside DATE/DATETIME's range compare as constants; offsets are never sent", () => {
    const rows = mysqlTable("rows", { day: mysqlDate("day"), at: datetime("at", { mode: "string" }) })
    const map = { day: rows.day, at: rows.at }
    const query = (node: Parameters<typeof compileMySql>[0]) => my.sqlToQuery(compileMySql(node, map))
    // MySQL stores years 0000-0999 too: they bind natively. Only instants outside 0000-9999 are constants.
    expect(query(Predicate.eq("day", "0500-01-01"))).toMatchObject({ sql: "COALESCE(`rows`.`day` = ?, FALSE)", params: ["0500-01-01"] })
    expect(query(Predicate.gt("day", "0000-01-01"))).toMatchObject({ sql: "COALESCE(`rows`.`day` > ?, FALSE)", params: ["0000-01-01"] })
    const bc = new Date(0)
    bc.setUTCFullYear(-1, 0, 1)
    expect(query(Predicate.eq("day", bc))).toMatchObject({ sql: "COALESCE((`rows`.`day` is null and null), FALSE)", params: [] })
    expect(query(Predicate.gt("day", bc))).toMatchObject({ sql: "COALESCE((`rows`.`day` is not null or null), FALSE)", params: [] })
    expect(query(Predicate.lt("at", "9999-12-31T23:00:00-05:00"))).toMatchObject({ sql: "COALESCE((`rows`.`at` is not null or null), FALSE)", params: [] })
    expect(query(Predicate.gte("at", "9999-12-31T23:00:00-05:00"))).toMatchObject({ sql: "COALESCE((`rows`.`at` is null and null), FALSE)", params: [] })
    // A driver-form literal with an offset is not passed to the server: it compares as text.
    expect(query(Predicate.eq("at", "2024-01-01 10:00:00+01:00")).sql).toBe("COALESCE((CONVERT(`rows`.`at` USING utf8mb4) COLLATE utf8mb4_0900_bin) = ?, FALSE)")
    expect(query(Predicate.eq("at", "2024-01-01 10:00:00.000")).sql).toBe("COALESCE(`rows`.`at` = ?, FALSE)")
    // Regression (fourth review): the driver's text form for years 0000-0999 binds natively too.
    expect(query(Predicate.eq("at", "0500-01-01 10:00:00"))).toMatchObject({ sql: "COALESCE(`rows`.`at` = ?, FALSE)", params: ["0500-01-01 10:00:00"] })
    expect(query(Predicate.eq("at", "0000-06-15 12:00:00.000"))).toMatchObject({ sql: "COALESCE(`rows`.`at` = ?, FALSE)", params: ["0000-06-15 12:00:00.000"] })
  })
})

describe("custom compilers", () => {
  // Regression: compileWhere bypassed a subclass's compile().
  it("compileWhere delegates to an overridden compile", () => {
    class Audited extends DrizzlePredicateCompiler {
      override compile(): ReturnType<DrizzlePredicateCompiler["compile"]> { return sql`audited` }
    }
    expect(pg.sqlToQuery(new Audited(pgTemporalMap, { dialect: "postgres" }).compileWhere(Predicate.eq("day", "2024-01-01"))).sql).toBe("audited")
  })
})
