import {
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
import { parseRfc3339Timestamp } from "core/domain"
import type {
  PredicateCompiler,
  PredicateCondition,
  PredicateNode,
  PredicatePrimitive,
  PredicateRangeValue,
  PredicateValue,
} from "core/domain"

export type DrizzleColumnMap = Record<string, AnyColumn>

/**
 * Text semantics differ by engine. The normative semantics are case-sensitive,
 * Unicode code-point ordered string comparison (docs/spec/persistence/predicates.md).
 * - "sqlite": LIKE is ASCII case-insensitive, so substring operators compile to
 *   instr()/substr(); the default BINARY collation is code-point ordered.
 * - "postgres": ordering comparisons on character columns use COLLATE "C" (UTF-8
 *   byte order, i.e. code-point order) so locale/ICU column collations cannot
 *   reorder results. Equality and LIKE are already exact under deterministic
 *   collations, so equality indexes remain usable. Non-character columns whose
 *   rows hydrate as strings (string-mode `date`, `uuid`, ...) compare natively
 *   when the literal is in the type's canonical text form (native order equals
 *   code-point order of the canonical form) and through `::text` otherwise.
 * - "mysql": default `_ci` collations ignore case even for `=`, so every text
 *   comparison is made through utf8mb4_0900_bin (NO PAD: `utf8mb4_bin` is
 *   PAD SPACE and treats 'a' and 'a ' as equal). When the schema declares NO PAD
 *   binary collations on every predicate column (verify with
 *   assertMySqlBinaryCollation), set `mysqlBinaryCollation: true` to compare
 *   character columns directly and keep index use.
 * - "generic": plain operators; the engine collation must already be binary.
 *
 * Literals are typed like the core evaluator types them: a literal of another
 * kind than the column's row values (the string "1" for a number column, a
 * number for a text column, a non-boolean for a boolean column) is not
 * comparable and yields UNKNOWN; a strict RFC 3339 string compared with an
 * instant column is that instant, and any other string is UNKNOWN.
 */
export type PredicateDialect = "generic" | "sqlite" | "postgres" | "mysql"
export interface PredicateCompilerOptions {
  readonly dialect?: PredicateDialect
  /** MySQL only: every mapped character column already uses a NO PAD binary collation (utf8mb4_0900_bin). */
  readonly mysqlBinaryCollation?: boolean
}

/** The value kind rows of a column hydrate into, which decides comparability. */
type ValueKind = "string" | "number" | "boolean" | "instant" | "other"

const CHARACTER_SQL_TYPE = /^(text|tinytext|mediumtext|longtext|varchar|character varying|char|character|nchar|nvarchar|bpchar|enum)\b/
const NUMERIC_SQL_TYPE = /^(numeric|decimal)\b/

function sqlTypeOf(column: AnyColumn): string | undefined {
  const getSQLType = (column as { getSQLType?: () => string }).getSQLType
  if (typeof getSQLType !== "function") return undefined
  return String(getSQLType.call(column)).trim().toLowerCase()
}

function valueKind(column: AnyColumn): ValueKind {
  switch ((column as { dataType?: unknown }).dataType) {
    case "number": return "number"
    case "boolean": return "boolean"
    case "date": return "instant"
    // DECIMAL/NUMERIC drivers return strings; entities hydrate them as numbers.
    case "string": return NUMERIC_SQL_TYPE.test(sqlTypeOf(column) ?? "") ? "number" : "string"
    default: return "other"
  }
}

/** A string-valued column stored in a character type (or of unknown SQL type). */
function isCharacterColumn(column: AnyColumn): boolean {
  if (valueKind(column) !== "string") return false
  const type = sqlTypeOf(column)
  return type === undefined || CHARACTER_SQL_TYPE.test(type)
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Whether the literal is the exact text PostgreSQL prints for a value of this non-character type. */
function isPostgresCanonicalText(sqlType: string | undefined, value: string): boolean {
  if (sqlType === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= "0001" && parseRfc3339Timestamp(value) !== null
  if (sqlType === "uuid") return UUID_TEXT.test(value)
  return false
}

interface TextSemantics {
  /**
   * Expression used for equality, membership, and substring matching. `literal`
   * is the compared value; it is omitted for LIKE and emptiness tests.
   */
  readonly exact: (column: AnyColumn, literal?: PredicatePrimitive) => AnyColumn | SQL<unknown>
  /** Expression used for ordering comparisons with `literal`. */
  readonly ordered: (column: AnyColumn, literal?: PredicatePrimitive) => AnyColumn | SQL<unknown>
  /** Whether comparing with `literal` goes through the column's text form. */
  readonly viaText: (column: AnyColumn, literal?: PredicatePrimitive) => boolean
}

function textSemantics(options: PredicateCompilerOptions): TextSemantics {
  if (options.dialect === "postgres") {
    const viaText = (column: AnyColumn, literal?: PredicatePrimitive): boolean =>
      valueKind(column) === "string" && !isCharacterColumn(column) &&
      (literal === undefined || (typeof literal === "string" && !isPostgresCanonicalText(sqlTypeOf(column), literal)))
    const asText = (column: AnyColumn) => sql`(${column}::text COLLATE "C")`
    return {
      viaText,
      exact: (column, literal) => (viaText(column, literal) ? asText(column) : column),
      ordered: (column, literal) => (viaText(column, literal) ? asText(column) : isCharacterColumn(column) ? sql`(${column} COLLATE "C")` : column),
    }
  }
  if (options.dialect === "mysql") {
    const viaText = (column: AnyColumn): boolean => valueKind(column) === "string" && (options.mysqlBinaryCollation !== true || !isCharacterColumn(column))
    const binary = (column: AnyColumn) => (viaText(column) ? sql`(CONVERT(${column} USING utf8mb4) COLLATE utf8mb4_0900_bin)` : column)
    return { viaText, exact: binary, ordered: binary }
  }
  const identity = (column: AnyColumn) => column
  return { viaText: () => false, exact: identity, ordered: identity }
}

/**
 * The expression a repository sorts by so ORDER BY agrees with predicate
 * comparison (keyset cursors are predicates): code-point order for strings,
 * native order otherwise. PostgreSQL sorts character columns under
 * COLLATE "C"; MySQL sorts string columns through utf8mb4_0900_bin unless
 * `mysqlBinaryCollation` is set (character columns are then NO PAD binary
 * already); SQLite's default BINARY collation is code-point order. A sort
 * through COLLATE "C" or CONVERT cannot use an index built under another
 * collation (see docs/spec/query.md).
 */
export function sortExpression(column: AnyColumn, options: PredicateCompilerOptions = {}): AnyColumn | SQL<unknown> {
  if (options.dialect === "postgres") return isCharacterColumn(column) ? sql`(${column} COLLATE "C")` : column
  if (options.dialect === "mysql") return textSemantics(options).ordered(column)
  return column
}

/** A literal that cannot be compared with the column's values: the comparison is UNKNOWN. */
const INCOMPARABLE = Symbol("incomparable")

/** Types a literal as the core evaluator would against this column's row values. */
function bindLiteral(column: AnyColumn, value: PredicatePrimitive | undefined): PredicatePrimitive | typeof INCOMPARABLE {
  if (value === null || value === undefined) return INCOMPARABLE
  switch (valueKind(column)) {
    case "number": return typeof value === "number" && !Number.isNaN(value) ? value : INCOMPARABLE
    case "boolean": return typeof value === "boolean" ? value : INCOMPARABLE
    case "instant": {
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? INCOMPARABLE : value
      if (typeof value !== "string") return INCOMPARABLE
      const time = parseRfc3339Timestamp(value)
      return time === null ? INCOMPARABLE : new Date(time)
    }
    case "string": return typeof value === "number" || typeof value === "boolean" ? INCOMPARABLE : value
    default: return value
  }
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

function compileCondition(columnMap: DrizzleColumnMap, condition: PredicateCondition, dialect: PredicateDialect, text: TextSemantics): SQL<unknown> {
  const column = requireColumn(columnMap, condition.field)
  const kind = valueKind(column)
  // Text expressions are SQL wrappers; drizzle binds the compared value as a plain
  // parameter for them. Non-text columns stay columns so their encoders apply.
  const exactFor = (value: PredicatePrimitive) => text.exact(column, value) as AnyColumn
  const orderedFor = (value: PredicatePrimitive) => text.ordered(column, value) as AnyColumn
  const compare = (operator: typeof eq, value: PredicatePrimitive | undefined, purpose: "exact" | "ordered"): SQL<unknown> => {
    const bound = bindLiteral(column, value)
    if (bound === INCOMPARABLE) return unknown()
    return operator(purpose === "exact" ? exactFor(bound) : orderedFor(bound), bound as never)
  }
  const textMatch = (op: "contains" | "startsWith" | "endsWith"): SQL<unknown> => {
    const value = requireScalarValue(condition)
    if (typeof value !== "string") throw new Error(`Predicate operator ${op} requires a string value`)
    // Core matches substrings only against string values.
    if (kind === "number" || kind === "boolean" || kind === "instant") return unknown()
    if (dialect === "sqlite") return sqliteTextMatch(column, op, value)
    const exact = text.exact(column) as AnyColumn
    const pattern = (escape: (value: string) => string) => op === "contains" ? `%${escape(value)}%` : op === "startsWith" ? `${escape(value)}%` : `%${escape(value)}`
    return dialect === "mysql"
      ? sql`${exact} LIKE ${pattern(escapeLikeForMySql)} ESCAPE '!'`
      : sql`${exact} LIKE ${pattern(escapeLike)} ESCAPE '\\'`
  }
  // Only strings can be empty; for any other kind isEmpty is exactly IS NULL.
  const emptyString = kind === "string" || kind === "other"

  switch (condition.op) {
    case "eq":
      return condition.value === null ? isNull(column) : compare(eq, requireScalarValue(condition), "exact")
    case "neq":
      return condition.value === null ? isNotNull(column) : compare(ne, requireScalarValue(condition), "exact")
    case "contains":
    case "startsWith":
    case "endsWith":
      return textMatch(condition.op)
    case "isEmpty":
      return emptyString ? or(isNull(column), eq(text.exact(column) as AnyColumn, "")) ?? sql`1 = 0` : isNull(column)
    case "isNotEmpty":
      return emptyString ? and(isNotNull(column), ne(text.exact(column) as AnyColumn, "")) ?? sql`1 = 0` : isNotNull(column)
    case "gt":
      return compare(gt, requireScalarValue(condition), "ordered")
    case "lt":
      return compare(lt, requireScalarValue(condition), "ordered")
    case "gte":
      return compare(gte, requireScalarValue(condition), "ordered")
    case "lte":
      return compare(lte, requireScalarValue(condition), "ordered")
    case "isTrue":
      return kind === "boolean" || kind === "other" ? eq(column, true) : unknown()
    case "isFalse":
      return kind === "boolean" || kind === "other" ? eq(column, false) : unknown()
    case "isNull":
      return isNull(column)
    case "isNotNull":
      return isNotNull(column)
    case "in": {
      if (!Array.isArray(condition.value)) throw new Error("Predicate operator in requires a value list")
      const members = asArray(condition.value).filter((value) => value !== null)
      // `x IN ()` is FALSE; an incomparable member is an UNKNOWN disjunct.
      if (members.length === 0) return sql`1 = 0`
      const bound = members.map((value) => bindLiteral(column, value))
      const values = bound.filter((value): value is PredicatePrimitive => value !== INCOMPARABLE)
      const someIncomparable = values.length < bound.length
      if (values.length === 0) return unknown()
      // One expression for the whole list: native only when every literal allows it.
      const representative = values.find((value) => text.viaText(column, value)) ?? values[0]!
      const membership = inArray(exactFor(representative), values as never[])
      return someIncomparable ? or(membership, unknown()) ?? membership : membership
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
  private readonly dialect: PredicateDialect
  private readonly text: TextSemantics

  constructor(private readonly columnMap: DrizzleColumnMap, options: PredicateCompilerOptions = {}) {
    this.dialect = options.dialect ?? "generic"
    this.text = textSemantics(options)
  }

  compile(filter: PredicateNode): SQL<unknown> {
    // Literals are already two-valued and stay unwrapped for readable plans.
    if (filter.kind === "literal") return this.compileNode(filter)
    return strictBoolean(this.compileNode(filter))
  }

  private compileNode(filter: PredicateNode): SQL<unknown> {
    switch (filter.kind) {
      case "literal":
        return filter.value ? sql`1 = 1` : sql`1 = 0`
      case "condition":
        return compileCondition(this.columnMap, filter, this.dialect, this.text)
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

export function compileDrizzlePredicate(filter: PredicateNode, columnMap: DrizzleColumnMap, options: PredicateCompilerOptions = {}): SQL<unknown> {
  return new DrizzlePredicateCompiler(columnMap, options).compile(filter)
}
