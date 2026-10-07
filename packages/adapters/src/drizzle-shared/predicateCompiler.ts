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
 * - "postgres": ordering comparisons on text use COLLATE "C" (UTF-8 byte order,
 *   i.e. code-point order) so locale/ICU column collations cannot reorder
 *   results. Equality and LIKE are already exact under deterministic collations,
 *   so equality indexes remain usable.
 * - "mysql": default `_ci` collations ignore case even for `=`, so every text
 *   comparison is made through utf8mb4_bin. When the schema declares binary
 *   collations on every predicate column (verify with assertMySqlBinaryCollation),
 *   set `mysqlBinaryCollation: true` to compare columns directly and keep index use.
 * - "generic": plain operators; the engine collation must already be binary.
 */
export type PredicateDialect = "generic" | "sqlite" | "postgres" | "mysql"
export interface PredicateCompilerOptions {
  readonly dialect?: PredicateDialect
  /** MySQL only: every mapped text column already uses a binary collation. */
  readonly mysqlBinaryCollation?: boolean
}

interface TextSemantics {
  /** Expression used for equality, membership, and substring matching. */
  readonly exact: (column: AnyColumn) => AnyColumn | SQL<unknown>
  /** Expression used for ordering comparisons. */
  readonly ordered: (column: AnyColumn) => AnyColumn | SQL<unknown>
}

function isTextColumn(column: AnyColumn): boolean {
  return (column as { dataType?: unknown }).dataType === "string"
}

function textSemantics(options: PredicateCompilerOptions): TextSemantics {
  const identity = (column: AnyColumn) => column
  if (options.dialect === "postgres") return { exact: identity, ordered: (column) => isTextColumn(column) ? sql`(${column} COLLATE "C")` : column }
  if (options.dialect === "mysql" && options.mysqlBinaryCollation !== true) {
    const binary = (column: AnyColumn) => isTextColumn(column) ? sql`(CONVERT(${column} USING utf8mb4) COLLATE utf8mb4_bin)` : column
    return { exact: binary, ordered: binary }
  }
  return { exact: identity, ordered: identity }
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
  if (!value || Array.isArray(value)) return undefined
  if (typeof value === "object") return value as PredicateRangeValue
  return undefined
}

function requireScalarValue(condition: PredicateCondition): PredicatePrimitive {
  if (Array.isArray(condition.value) || (condition.value && typeof condition.value === "object")) {
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
  // Text expressions are SQL wrappers; drizzle binds the compared value as a plain
  // parameter for them. Non-text columns stay columns so their encoders apply.
  const exact = text.exact(column) as AnyColumn
  const ordered = text.ordered(column) as AnyColumn
  const like = (pattern: (escape: (value: string) => string) => string): SQL<unknown> =>
    dialect === "mysql"
      ? sql`${exact} LIKE ${pattern(escapeLikeForMySql)} ESCAPE '!'`
      : sql`${exact} LIKE ${pattern(escapeLike)} ESCAPE '\\'`

  switch (condition.op) {
    case "eq":
      return condition.value === null ? isNull(column) : eq(exact, requireScalarValue(condition) as never)
    case "neq":
      return condition.value === null ? isNotNull(column) : ne(exact, requireScalarValue(condition) as never)
    case "contains": {
      const value = requireScalarValue(condition)
      if (typeof value !== "string") throw new Error(`Predicate operator contains requires a string value`)
      if (dialect === "sqlite") return sqliteTextMatch(column, "contains", value)
      return like((escape) => `%${escape(value)}%`)
    }
    case "startsWith": {
      const value = requireScalarValue(condition)
      if (typeof value !== "string") throw new Error(`Predicate operator startsWith requires a string value`)
      if (dialect === "sqlite") return sqliteTextMatch(column, "startsWith", value)
      return like((escape) => `${escape(value)}%`)
    }
    case "endsWith": {
      const value = requireScalarValue(condition)
      if (typeof value !== "string") throw new Error(`Predicate operator endsWith requires a string value`)
      if (dialect === "sqlite") return sqliteTextMatch(column, "endsWith", value)
      return like((escape) => `%${escape(value)}`)
    }
    case "isEmpty":
      return or(isNull(column), eq(exact, "")) ?? sql`1 = 0`
    case "isNotEmpty":
      return and(isNotNull(column), ne(exact, "")) ?? sql`1 = 0`
    case "gt":
      return gt(ordered, requireScalarValue(condition) as never)
    case "lt":
      return lt(ordered, requireScalarValue(condition) as never)
    case "gte":
      return gte(ordered, requireScalarValue(condition) as never)
    case "lte":
      return lte(ordered, requireScalarValue(condition) as never)
    case "isTrue":
      return eq(column, true)
    case "isFalse":
      return eq(column, false)
    case "isNull":
      return isNull(column)
    case "isNotNull":
      return isNotNull(column)
    case "in": {
      if (!Array.isArray(condition.value)) throw new Error("Predicate operator in requires a value list")
      const values = asArray(condition.value).filter((value) => value !== null)
      return values.length > 0 ? inArray(exact, values as never[]) : sql`1 = 0`
    }
    case "includesAny":
    case "includesAll":
      throw new Error(`Unsupported predicate operator: ${condition.op}`)
    case "between": {
      const range = asRange(condition.value)
      if (!range) throw new Error("Predicate operator between requires a range value")
      const clauses: SQL<unknown>[] = []
      if (range.from !== undefined) clauses.push(gte(ordered, range.from as never))
      if (range.to !== undefined) clauses.push(lte(ordered, range.to as never))
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
