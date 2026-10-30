import {
  Param,
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm"
import { parseRfc3339Timestamp } from "@xonava/core/domain"
import type {
  PredicateCompiler,
  PredicateCondition,
  PredicateNode,
  PredicatePrimitive,
  PredicateRangeValue,
  PredicateValue,
} from "@xonava/core/domain"

export type DrizzleColumnMap = Record<string, AnyColumn>

/**
 * How each column is compared. The normative semantics are the core
 * evaluator's (docs/spec/persistence/predicates.md); SQL must agree with core
 * on the value kinds rows hydrate into. One classification drives both
 * predicates and repository sort keys ({@link sortExpression}), so keyset
 * cursor predicates always compare exactly as ORDER BY orders.
 *
 * - Character columns compare by Unicode code point. PostgreSQL orders them
 *   under COLLATE "C" (equality and LIKE are exact under deterministic
 *   collations, so equality indexes stay usable); MySQL compares through NO PAD
 *   `utf8mb4_0900_bin` unless `mysqlBinaryCollation` says the character
 *   columns already use it (`utf8mb4_bin` is PAD SPACE: 'a' = 'a '); SQLite's
 *   BINARY collation is already code-point order, and its LIKE is ASCII
 *   case-insensitive, so substring operators use instr()/substr().
 * - Temporal SQL columns (date, timestamp/datetime, time) compare natively as
 *   temporal values, index-usable, whenever the literal is a strict RFC 3339
 *   date or date-time (or a Date), and also for the engine's own text form of
 *   the type (string-mode columns hydrate it, so cursor values carry it). The
 *   instant is bound in a fixed, time-zone-free form (never through the
 *   driver's local-time Date serialization): PostgreSQL's own input form
 *   (BC and five-digit years included); on MySQL a UTC literal, or a constant
 *   comparison for instants outside DATE/DATETIME's stored 0000-9999 range (every
 *   stored value lies inside it). PostgreSQL compares an instant before its
 *   lower limit against -infinity (rows may hold ±infinity, which a constant
 *   would mis-order). A MySQL TIMESTAMP column compares in the session time
 *   zone, so it needs a UTC session ({@link assertMySqlUtcSession}).
 *   Engine-text literals are passed through only
 *   when the engine accepts them (PostgreSQL: its date/timestamp output form,
 *   BC and five-digit years included, offsets up to ±15:59; on MySQL years
 *   0000-9999 and no offset at all). Any other string compares with
 *   the column's text form when rows hydrate as strings, and is UNKNOWN when
 *   rows hydrate as Dates. A date column compares as a calendar date: compare
 *   it with full-date literals; a date-time literal is cast by the engine.
 * - PostgreSQL enums compare natively for equality and membership
 *   (index-usable; a literal that is not a member equals nothing). Ordering
 *   comparisons and sort keys use the text form, by code point, exactly like
 *   core (declaration order would disagree with core: an ABAC `lessThan` scope
 *   would select rows the record decision denies).
 * - PostgreSQL uuid compares natively for canonical lowercase literals and
 *   through its text form otherwise. Other string-hydrated types without a
 *   portable native order (inet, interval, ...) compare and sort through their
 *   text form.
 * - DECIMAL/NUMERIC (drivers return strings; entities hydrate numbers),
 *   numbers, and booleans compare natively.
 *
 * Literals are typed like the core evaluator types them: a literal of another
 * kind than the column's row values ("1" for a number column, a number for a
 * text column, a non-boolean for a boolean column) is not comparable and
 * yields UNKNOWN.
 */
export type PredicateDialect = "generic" | "sqlite" | "postgres" | "mysql"
export interface PredicateCompilerOptions {
  readonly dialect?: PredicateDialect
  /** MySQL only: every mapped character column already uses a NO PAD binary collation (utf8mb4_0900_bin). */
  readonly mysqlBinaryCollation?: boolean
}

type ColumnClass = "number" | "boolean" | "text" | "enum" | "temporal" | "uuid" | "textual" | "other"
type TemporalType = "date" | "timestamp" | "time" | "epoch"

interface ColumnInfo {
  readonly cls: ColumnClass
  readonly temporal?: TemporalType
  /** Rows hydrate as Date (drizzle dataType "date"). */
  readonly hydratesDate: boolean
  readonly enumValues?: readonly string[]
}

const CHARACTER_SQL_TYPE = /^(text|tinytext|mediumtext|longtext|varchar|character varying|char|character|nchar|nvarchar|bpchar|enum)\b/
const NUMERIC_SQL_TYPE = /^(numeric|decimal)\b/

function sqlTypeOf(column: AnyColumn): string | undefined {
  const getSQLType = (column as { getSQLType?: () => string }).getSQLType
  if (typeof getSQLType !== "function") return undefined
  return String(getSQLType.call(column)).trim().toLowerCase()
}

function temporalSqlType(sqlType: string | undefined): TemporalType | undefined {
  if (sqlType === undefined) return undefined
  if (/^date\b/.test(sqlType) && !/^datetime\b/.test(sqlType)) return "date"
  if (/^(timestamp|datetime)\b/.test(sqlType)) return "timestamp"
  if (/^time\b/.test(sqlType)) return "time"
  return undefined
}

function classify(column: AnyColumn, dialect: PredicateDialect): ColumnInfo {
  const dataType = (column as { dataType?: unknown }).dataType
  const columnType = String((column as { columnType?: unknown }).columnType ?? "")
  const sqlType = sqlTypeOf(column)
  const hydratesDate = dataType === "date"
  if (dataType === "number") return { cls: "number", hydratesDate }
  if (dataType === "boolean") return { cls: "boolean", hydratesDate }
  if (dialect === "postgres" && columnType.startsWith("PgEnum")) {
    const values = (column as { enumValues?: unknown }).enumValues
    return { cls: "enum", hydratesDate, enumValues: Array.isArray(values) ? values.map(String) : [] }
  }
  const temporal = temporalSqlType(sqlType)
  if (temporal && (dataType === "string" || hydratesDate)) return { cls: "temporal", temporal, hydratesDate }
  if (hydratesDate) return { cls: "temporal", temporal: "epoch", hydratesDate }
  if (dataType === "string") {
    if (NUMERIC_SQL_TYPE.test(sqlType ?? "")) return { cls: "number", hydratesDate }
    if (sqlType === undefined || CHARACTER_SQL_TYPE.test(sqlType)) return { cls: "text", hydratesDate }
    if (dialect === "postgres" && sqlType === "uuid") return { cls: "uuid", hydratesDate }
    return { cls: "textual", hydratesDate }
  }
  return { cls: "other", hydratesDate }
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** MySQL text output of a DATETIME/TIMESTAMP: `YYYY-MM-DD HH:MM:SS[.f]`. */
const MYSQL_TIMESTAMP_TEXT = /^(\d{4})(-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,6})?$/
/** PostgreSQL text output of a date or timestamp: `[Y]YYYY-MM-DD[ HH:MM:SS[.f][+HH[:MM[:SS]]]][ BC]` (years past 9999 keep all digits). */
const POSTGRES_TEMPORAL_TEXT = /^(\d{4,6})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?)?)?( BC)?$/
const TIME_TEXT = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?$/

/**
 * Whether MySQL accepts this text form of a DATETIME as input (so it is never a server error). It stores
 * years 0000-9999, which is all the four-digit form can say.
 */
function isMySqlTimestampText(value: string): boolean {
  const match = MYSQL_TIMESTAMP_TEXT.exec(value)
  return match !== null && parseRfc3339Timestamp(`${match[1]}${match[2]}T${match[3]}Z`) !== null
}

/**
 * PostgreSQL's own text form of a date (`date`) or timestamp (`timestamp`), as string-mode columns hydrate it
 * and cursor values carry it: "native" when the server accepts it as input, BELOW_RANGE when it is a valid
 * instant before the type's lower limit (4714-11-24 BC), undefined for anything the server would reject
 * (year 0, impossible dates, displacements beyond ±15:59:59, years JavaScript cannot represent).
 */
function postgresTemporalText(value: string, temporal: "date" | "timestamp"): "native" | typeof BELOW_RANGE | undefined {
  const match = POSTGRES_TEMPORAL_TEXT.exec(value)
  if (match === null || (match[4] !== undefined) !== (temporal === "timestamp")) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12) return undefined
  const [hour, minute, second] = [Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0)]
  if (hour > 23 || minute > 59 || second > 59) return undefined
  const local = new Date(0)
  local.setUTCFullYear(match[11] === undefined ? year : 1 - year, month - 1, day)
  local.setUTCHours(hour, minute, second, 0)
  if (Number.isNaN(local.getTime()) || local.getUTCDate() !== day) return undefined
  let instant = local.getTime()
  if (match[7] !== undefined) {
    if (Number(match[8]) > 15 || Number(match[9] ?? 0) > 59 || Number(match[10] ?? 0) > 59) return undefined
    instant -= (match[7] === "-" ? -1 : 1) * (Number(match[8]) * 3600 + Number(match[9] ?? 0) * 60 + Number(match[10] ?? 0)) * 1000
  }
  return Math.min(instant, local.getTime()) < POSTGRES_MIN_TIME ? BELOW_RANGE : "native"
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0")
}

function isUtcMidnight(date: Date): boolean {
  return date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0
}

function clockText(date: Date): string {
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`
}

/** The earliest instant PostgreSQL date/timestamp types accept: 4714-11-24 BC (astronomical year -4713), 00:00 UTC. */
const POSTGRES_MIN_TIME = (() => {
  const date = new Date(0)
  date.setUTCFullYear(-4713, 10, 24)
  return date.getTime()
})()

/** An instant in PostgreSQL's input form: astronomical year 0 is 1 BC; years past 9999 keep all digits. */
function postgresInstant(time: number, calendarDate: boolean): string | typeof BELOW_RANGE {
  // Every JavaScript instant is below PostgreSQL's upper limits (294276 AD); only the lower limit can be crossed.
  if (time < POSTGRES_MIN_TIME) return BELOW_RANGE
  const date = new Date(time)
  const year = date.getUTCFullYear()
  const era = year >= 1 ? "" : " BC"
  const day = `${pad(year >= 1 ? year : 1 - year, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  if (calendarDate && isUtcMidnight(date)) return `${day}${era}`
  return `${day} ${clockText(date)}+00${era}`
}

/**
 * MySQL DATE/DATETIME document years 1000-9999 but store and compare years 0000-0999 too, so only
 * instants outside 0000-9999 lie beyond every stored value.
 */
function mysqlInstant(time: number, calendarDate: boolean): string | typeof BELOW_RANGE | typeof ABOVE_RANGE {
  const date = new Date(time)
  const year = date.getUTCFullYear()
  if (year < 0) return BELOW_RANGE
  if (year > 9999) return ABOVE_RANGE
  const day = `${pad(year, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  return calendarDate && isUtcMidnight(date) ? day : `${day} ${clockText(date)}`
}

/** The left/right of one comparison, or why there is none. */
type Operand =
  | { readonly left: AnyColumn | SQL<unknown>; readonly right: unknown }
  | typeof INCOMPARABLE
  | typeof NOT_A_MEMBER
  | typeof BELOW_RANGE
  | typeof ABOVE_RANGE

/** An instant before / after every value the column can store (a constant comparison). */
const BELOW_RANGE = Symbol("belowRange")
const ABOVE_RANGE = Symbol("aboveRange")

/** A literal that cannot be compared with the column's values: the comparison is UNKNOWN. */
const INCOMPARABLE = Symbol("incomparable")
/** A string that is not a member of the column's enum: equal to no row. */
const NOT_A_MEMBER = Symbol("notAMember")

class Comparison {
  readonly info: ColumnInfo

  constructor(readonly column: AnyColumn, private readonly options: PredicateCompilerOptions) {
    this.info = classify(column, options.dialect ?? "generic")
  }

  private get dialect(): PredicateDialect {
    return this.options.dialect ?? "generic"
  }

  private memo: { textForm?: AnyColumn | SQL<unknown>; textOrdered?: AnyColumn | SQL<unknown> } = {}

  /**
   * The column's text form under code-point comparison (one instance, so
   * membership lists group by it). PostgreSQL uses the type's output function
   * (`format('%s', ...)`), which is exactly what the driver hydrates; a
   * `::text` cast differs for some types (inet gains its netmask). NULL stays
   * NULL (format would print it as '').
   */
  textForm(): AnyColumn | SQL<unknown> {
    this.memo.textForm ??= this.dialect === "postgres"
      ? sql`(CASE WHEN ${this.column} IS NULL THEN NULL ELSE format('%s', ${this.column}) END COLLATE "C")`
      : this.dialect === "mysql" ? sql`(CONVERT(${this.column} USING utf8mb4) COLLATE utf8mb4_0900_bin)` : this.column
    return this.memo.textForm
  }

  /** Expression for equality and membership on character columns. */
  private textExact(): AnyColumn | SQL<unknown> {
    if (this.dialect === "mysql" && this.options.mysqlBinaryCollation !== true) return this.textForm()
    return this.column
  }

  /**
   * A text literal compared with {@link textExact}. When the bare column is compared (`mysqlBinaryCollation`),
   * the literal carries the column's collation explicitly: MySQL's equality propagation substitutes the
   * constant of `col = 'U1'` into the other conditions of the same AND (`col <> 'u1'`, `NOT NOT col = 'U1'`
   * included) and then compares the two constants under the connection's collation, case-insensitively, so
   * the rows differ from the bare column's NO PAD binary comparison. An explicitly collated constant keeps the
   * column index usable (equality, IN, ranges).
   */
  textLiteral(value: string): string | SQL<unknown> {
    return this.dialect === "mysql" && this.options.mysqlBinaryCollation === true ? sql`(CONVERT(${value} USING utf8mb4) COLLATE utf8mb4_0900_bin)` : value
  }

  /** Expression for ordering comparisons and sort keys on character columns. */
  private textOrdered(): AnyColumn | SQL<unknown> {
    if (this.dialect !== "postgres") return this.textExact()
    this.memo.textOrdered ??= sql`(${this.column} COLLATE "C")`
    return this.memo.textOrdered
  }

  /** The sort key consistent with every ordered comparison of this column. */
  sortKey(): AnyColumn | SQL<unknown> {
    if (this.info.cls === "text") return this.textOrdered()
    if (this.info.cls === "textual" || this.info.cls === "enum") return this.textForm()
    return this.column
  }

  /** Expression whose string value substring/emptiness tests examine, or undefined when rows are not strings. */
  stringForm(): AnyColumn | SQL<unknown> | undefined {
    switch (this.info.cls) {
      case "number":
      case "boolean":
        return undefined
      case "text":
        return this.textExact()
      case "temporal":
        return this.info.hydratesDate ? undefined : this.textForm()
      case "enum":
      case "uuid":
      case "textual":
        return this.textForm()
      default:
        return this.column
    }
  }

  operand(value: PredicatePrimitive | undefined, purpose: "exact" | "ordered"): Operand {
    if (value === null || value === undefined) return INCOMPARABLE
    const column = this.column
    switch (this.info.cls) {
      case "number": return typeof value === "number" && !Number.isNaN(value) ? { left: column, right: value } : INCOMPARABLE
      case "boolean": return typeof value === "boolean" ? { left: column, right: value } : INCOMPARABLE
      case "text":
        if (typeof value === "number" || typeof value === "boolean") return INCOMPARABLE
        return purpose === "exact" ? { left: this.textExact(), right: typeof value === "string" ? this.textLiteral(value) : value } : { left: this.textOrdered(), right: value }
      case "textual": return typeof value === "string" ? { left: this.textForm(), right: value } : INCOMPARABLE
      case "uuid":
        if (typeof value !== "string") return INCOMPARABLE
        return UUID_TEXT.test(value) ? { left: column, right: value } : { left: this.textForm(), right: value }
      case "enum":
        if (typeof value !== "string") return INCOMPARABLE
        // Ordering is by code point, like core; only equality may use the enum's native type.
        if (purpose === "ordered") return { left: this.textForm(), right: value }
        return this.info.enumValues?.includes(value) ? { left: column, right: value } : NOT_A_MEMBER
      case "temporal": return this.temporalOperand(value)
      default: return { left: column, right: value }
    }
  }

  private temporalOperand(value: PredicatePrimitive): Operand {
    const { temporal, hydratesDate } = this.info
    const column = this.column
    let time: number | null = null
    if (value instanceof Date) time = Number.isNaN(value.getTime()) ? null : value.getTime()
    else if (typeof value === "string") time = parseRfc3339Timestamp(value)
    else return INCOMPARABLE
    if (time !== null) {
      if (temporal === "time") return INCOMPARABLE
      return this.bindInstant(time)
    }
    if (typeof value !== "string") return INCOMPARABLE
    // The engine's own text form (what string-mode rows and their cursor values carry).
    if ((this.dialect === "postgres" || this.dialect === "mysql") && !hydratesDate) {
      if (this.dialect === "postgres" && (temporal === "timestamp" || temporal === "date")) {
        const text = postgresTemporalText(value, temporal)
        if (text === BELOW_RANGE) return BELOW_RANGE
        if (text !== undefined) return { left: column, right: new Param(value) }
      }
      if (this.dialect === "mysql" && temporal === "timestamp" && isMySqlTimestampText(value)) return { left: column, right: new Param(value) }
      if (temporal === "time" && TIME_TEXT.test(value)) return { left: column, right: new Param(value) }
    }
    return hydratesDate ? INCOMPARABLE : { left: this.textForm(), right: value }
  }

  /** A time-zone-free literal for the instant, bound without the driver's Date serialization. */
  private bindInstant(time: number): Operand {
    const { temporal } = this.info
    const column = this.column
    if ((this.dialect === "postgres" || this.dialect === "mysql") && temporal !== "epoch") {
      const literal = this.dialect === "postgres" ? postgresInstant(time, temporal === "date") : mysqlInstant(time, temporal === "date")
      return typeof literal === "string" ? { left: column, right: new Param(literal) } : literal
    }
    // SQLite/generic: Date-hydrated columns encode Dates themselves.
    return { left: column, right: this.info.hydratesDate ? new Date(time) : new Param(new Date(time).toISOString()) }
  }
}

/**
 * The expression a repository sorts by so ORDER BY agrees with predicate
 * comparison (keyset cursors are predicates): code-point order for character
 * data, native order for numbers, temporal values, PostgreSQL enums and uuids.
 * Sorting through COLLATE "C" or CONVERT cannot use an index built under
 * another collation, so repositories use it for cursor pagination only.
 */
export function sortExpression(column: AnyColumn, options: PredicateCompilerOptions = {}): AnyColumn | SQL<unknown> {
  return new Comparison(column, options).sortKey()
}

/** SQL UNKNOWN: stays UNKNOWN under NOT, like the core evaluator. */
function unknown(): SQL<unknown> {
  return sql`(1 = NULL)`
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&")
}

/**
 * MySQL treats backslash as an escape inside string literals, so `ESCAPE '\'`
 * is an unterminated literal there. MySQL uses `!` as the LIKE escape instead.
 */
function escapeLikeForMySql(value: string): string {
  return value.replace(/[!%_]/g, "!$&")
}

function asArray(value: PredicateValue | undefined): PredicatePrimitive[] {
  return Array.isArray(value) ? value : []
}

function asRange(value: PredicateValue | undefined): PredicateRangeValue | undefined {
  if (!value || Array.isArray(value) || value instanceof Date) return undefined
  if (typeof value === "object") return value as PredicateRangeValue
  return undefined
}

function requireScalarValue(condition: PredicateCondition): PredicatePrimitive {
  // A Date is a scalar instant literal, not a structured value.
  if (Array.isArray(condition.value) || (condition.value && typeof condition.value === "object" && !(condition.value instanceof Date))) {
    throw new Error(`Predicate operator ${condition.op} requires a scalar value`)
  }

  return condition.value as PredicatePrimitive
}

function requireColumn(columnMap: DrizzleColumnMap, field: string): AnyColumn {
  if (!Object.hasOwn(columnMap, field)) throw new Error(`Predicate references unmapped field \"${field}\"`)
  const column = columnMap[field]
  if (!column) throw new Error(`Predicate references unmapped field \"${field}\"`)
  return column
}

function strictBoolean(expression: SQL<unknown>): SQL<unknown> {
  return sql`COALESCE(${expression}, FALSE)`
}

function sqliteTextMatch(column: AnyColumn, op: "contains" | "startsWith" | "endsWith", needle: string): SQL<unknown> {
  // An empty needle matches every non-null string; `col = col` stays UNKNOWN for NULL.
  if (needle.length === 0) return sql`${column} = ${column}`
  if (op === "contains") return sql`instr(${column}, ${needle}) > 0`
  if (op === "startsWith") return sql`substr(${column}, 1, length(${needle})) = ${needle}`
  return sql`substr(${column}, -length(${needle})) = ${needle}`
}

function compileCondition(columnMap: DrizzleColumnMap, condition: PredicateCondition, options: PredicateCompilerOptions): SQL<unknown> {
  const column = requireColumn(columnMap, condition.field)
  const dialect = options.dialect ?? "generic"
  const comparison = new Comparison(column, options)
  const { cls } = comparison.info
  // Equality to no row: FALSE, or UNKNOWN for a NULL value.
  const equalsNothing = () => sql`(${column} is null and null)`
  // TRUE for every non-NULL value (UNKNOWN for NULL).
  const holdsForAll = () => sql`(${column} is not null or null)`
  const compare = (operator: typeof eq, value: PredicatePrimitive | undefined, purpose: "exact" | "ordered"): SQL<unknown> => {
    const operand = comparison.operand(value, purpose)
    if (operand === INCOMPARABLE) return unknown()
    if (operand === NOT_A_MEMBER) {
      if (operator === eq) return equalsNothing()
      if (operator === ne) return holdsForAll()
      return unknown()
    }
    if (operand === BELOW_RANGE || operand === ABOVE_RANGE) {
      // A finite stored value is greater than a literal below the range, and smaller than one above it.
      const below = operand === BELOW_RANGE
      if (operator === eq) return equalsNothing()
      if (operator === ne) return holdsForAll()
      const greater = operator === gt || operator === gte
      if (dialect === "postgres") {
        // PostgreSQL also stores -infinity and infinity, which lie beyond the literal on the other side:
        // let the engine order the rows against the infinity on the literal's side (NULL stays UNKNOWN).
        if (below) return greater ? gt(column, new Param("-infinity")) : eq(column, new Param("-infinity"))
        return greater ? eq(column, new Param("infinity")) : lt(column, new Param("infinity"))
      }
      return greater === below ? holdsForAll() : equalsNothing()
    }
    return operator(operand.left as AnyColumn, operand.right as never)
  }
  const textMatch = (op: "contains" | "startsWith" | "endsWith"): SQL<unknown> => {
    const value = requireScalarValue(condition)
    if (typeof value !== "string") throw new Error(`Predicate operator ${op} requires a string value`)
    // Core matches substrings only against string values.
    const subject = comparison.stringForm()
    if (subject === undefined) return unknown()
    if (dialect === "sqlite") return sqliteTextMatch(column, op, value)
    const pattern = (escape: (value: string) => string) => op === "contains" ? `%${escape(value)}%` : op === "startsWith" ? `${escape(value)}%` : `%${escape(value)}`
    return dialect === "mysql"
      ? sql`${subject} LIKE ${pattern(escapeLikeForMySql)} ESCAPE '!'`
      : sql`${subject} LIKE ${pattern(escapeLike)} ESCAPE '\\'`
  }

  switch (condition.op) {
    case "eq":
      return condition.value === null ? isNull(column) : compare(eq, requireScalarValue(condition), "exact")
    case "neq":
      return condition.value === null ? isNotNull(column) : compare(ne, requireScalarValue(condition), "exact")
    case "contains":
    case "startsWith":
    case "endsWith":
      return textMatch(condition.op)
    case "isEmpty": {
      // Only strings can be empty; for any other kind isEmpty is exactly IS NULL.
      const subject = comparison.stringForm()
      return subject === undefined ? isNull(column) : or(isNull(column), eq(subject as AnyColumn, cls === "text" ? comparison.textLiteral("") : "")) ?? sql`1 = 0`
    }
    case "isNotEmpty": {
      const subject = comparison.stringForm()
      return subject === undefined ? isNotNull(column) : and(isNotNull(column), ne(subject as AnyColumn, cls === "text" ? comparison.textLiteral("") : "")) ?? sql`1 = 0`
    }
    case "gt":
      return compare(gt, requireScalarValue(condition), "ordered")
    case "lt":
      return compare(lt, requireScalarValue(condition), "ordered")
    case "gte":
      return compare(gte, requireScalarValue(condition), "ordered")
    case "lte":
      return compare(lte, requireScalarValue(condition), "ordered")
    case "isTrue":
      return cls === "boolean" || cls === "other" ? eq(column, true) : unknown()
    case "isFalse":
      return cls === "boolean" || cls === "other" ? eq(column, false) : unknown()
    case "isNull":
      return isNull(column)
    case "isNotNull":
      return isNotNull(column)
    case "in": {
      if (!Array.isArray(condition.value)) throw new Error("Predicate operator in requires a value list")
      const members = asArray(condition.value).filter((value) => value !== null)
      // `x IN ()` is FALSE; an incomparable member is an UNKNOWN disjunct; a non-member equals nothing.
      if (members.length === 0) return sql`1 = 0`
      const operands = members.map((value) => comparison.operand(value, "exact"))
      const comparable = operands.filter((operand): operand is Exclude<Operand, symbol> => typeof operand !== "symbol")
      const someIncomparable = operands.includes(INCOMPARABLE)
      // Group by left expression: canonical and non-canonical literals may compare differently.
      const groups = new Map<AnyColumn | SQL<unknown>, unknown[]>()
      for (const operand of comparable) groups.set(operand.left, [...(groups.get(operand.left) ?? []), operand.right])
      const disjuncts: SQL<unknown>[] = []
      for (const [left, values] of groups) disjuncts.push(inArray(left as AnyColumn, values as never[]))
      if (someIncomparable) disjuncts.push(unknown())
      if (disjuncts.length === 0) return equalsNothing()
      return disjuncts.length === 1 ? disjuncts[0]! : or(...disjuncts) ?? disjuncts[0]!
    }
    case "includesAny":
    case "includesAll":
      throw new Error(`Unsupported predicate operator: ${condition.op}`)
    case "between": {
      const range = asRange(condition.value)
      if (!range) throw new Error("Predicate operator between requires a range value")
      const clauses: SQL<unknown>[] = []
      if (range.from !== undefined) clauses.push(compare(gte, range.from, "ordered"))
      if (range.to !== undefined) clauses.push(compare(lte, range.to, "ordered"))
      if (clauses.length === 0) return sql`1 = 0`
      return clauses.length === 1 ? clauses[0]! : and(...clauses) ?? sql`1 = 0`
    }
    default:
      throw new Error(`Unsupported predicate operator: ${String(condition.op)}`)
  }
}

/**
 * Compiles the neutral predicate AST with SQL-native Kleene three-valued
 * logic, which is the normative predicate semantics shared with the core
 * in-memory evaluator. Leaves and composites are left three-valued so NOT
 * UNKNOWN stays UNKNOWN; only the root collapses UNKNOWN to FALSE.
 */
export class DrizzlePredicateCompiler implements PredicateCompiler<SQL<unknown>> {
  constructor(private readonly columnMap: DrizzleColumnMap, private readonly options: PredicateCompilerOptions = {}) {}

  /** A strictly two-valued expression (UNKNOWN is FALSE), safe to negate or project. */
  compile(filter: PredicateNode): SQL<unknown> {
    // Literals are already two-valued and stay unwrapped for readable plans.
    if (filter.kind === "literal") return this.compileNode(filter)
    return strictBoolean(this.compileNode(filter))
  }

  /**
   * The same predicate for a WHERE clause (alone or AND-ed with other
   * conditions), where UNKNOWN already excludes the row. The root stays
   * three-valued, so the planner sees the comparisons and can use indexes
   * (a root COALESCE(..., FALSE) hides them). Never negate or project it.
   */
  compileWhere(filter: PredicateNode): SQL<unknown> {
    // A subclass that overrides compile() keeps control of its WHERE clauses.
    if (this.compile !== DrizzlePredicateCompiler.prototype.compile) return this.compile(filter)
    if (filter.kind === "literal") return this.compileNode(filter)
    return sql`(${this.compileNode(filter)})`
  }

  private compileNode(filter: PredicateNode): SQL<unknown> {
    switch (filter.kind) {
      case "literal":
        return filter.value ? sql`1 = 1` : sql`1 = 0`
      case "condition":
        return compileCondition(this.columnMap, filter, this.options)
      case "and": {
        if (filter.filters.length === 0) return sql`1 = 1`
        const compiled = filter.filters.map((child) => this.compileNode(child))
        return compiled.length === 1 ? sql`(${compiled[0]!})` : and(...compiled) ?? sql`1 = 1`
      }
      case "or": {
        if (filter.filters.length === 0) return sql`1 = 0`
        const compiled = filter.filters.map((child) => this.compileNode(child))
        return compiled.length === 1 ? sql`(${compiled[0]!})` : or(...compiled) ?? sql`1 = 0`
      }
      case "not":
        return not(this.compileNode(filter.filter))
      default:
        throw new Error(`Unsupported predicate node kind: ${(filter as PredicateNode).kind}`)
    }
  }
}

/**
 * A predicate compiler a repository accepts: anything with `compile`; when it
 * also offers `compileWhere` (as {@link DrizzlePredicateCompiler} does), WHERE
 * clauses use that index-usable form.
 */
export type DrizzleWhereCompiler = PredicateCompiler<SQL<unknown>> & { compileWhere?: (filter: PredicateNode) => SQL<unknown> }

export function compileWhereClause(compiler: DrizzleWhereCompiler, filter: PredicateNode): SQL<unknown> {
  return typeof compiler.compileWhere === "function" ? compiler.compileWhere(filter) : compiler.compile(filter)
}

export function compileDrizzlePredicate(filter: PredicateNode, columnMap: DrizzleColumnMap, options: PredicateCompilerOptions = {}): SQL<unknown> {
  return new DrizzlePredicateCompiler(columnMap, options).compile(filter)
}
