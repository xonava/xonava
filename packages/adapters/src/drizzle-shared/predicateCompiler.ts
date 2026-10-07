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
 * code-point ordered string comparison.
 * - "sqlite": LIKE is ASCII case-insensitive, so substring operators compile to
 *   instr()/substr() with the default BINARY collation (code-point order).
 * - "generic": LIKE-based operators; the engine collation must be binary.
 */
export type PredicateDialect = "generic" | "sqlite"
export interface PredicateCompilerOptions { readonly dialect?: PredicateDialect }

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&")
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

function compileCondition(columnMap: DrizzleColumnMap, condition: PredicateCondition, dialect: PredicateDialect): SQL<unknown> {
  const column = requireColumn(columnMap, condition.field)

  switch (condition.op) {
    case "eq":
      return condition.value === null ? isNull(column) : eq(column, requireScalarValue(condition) as never)
    case "neq":
      return condition.value === null ? isNotNull(column) : ne(column, requireScalarValue(condition) as never)
    case "contains": {
      const value = requireScalarValue(condition)
      if (typeof value !== "string") throw new Error(`Predicate operator contains requires a string value`)
      if (dialect === "sqlite") return sqliteTextMatch(column, "contains", value)
      return sql`${column} LIKE ${`%${escapeLike(value)}%`} ESCAPE '\\'`
    }
    case "startsWith": {
      const value = requireScalarValue(condition)
      if (typeof value !== "string") throw new Error(`Predicate operator startsWith requires a string value`)
      if (dialect === "sqlite") return sqliteTextMatch(column, "startsWith", value)
      return sql`${column} LIKE ${`${escapeLike(value)}%`} ESCAPE '\\'`
    }
    case "endsWith": {
      const value = requireScalarValue(condition)
      if (typeof value !== "string") throw new Error(`Predicate operator endsWith requires a string value`)
      if (dialect === "sqlite") return sqliteTextMatch(column, "endsWith", value)
      return sql`${column} LIKE ${`%${escapeLike(value)}`} ESCAPE '\\'`
    }
    case "isEmpty":
      return or(isNull(column), eq(column, "")) ?? sql`1 = 0`
    case "isNotEmpty":
      return and(isNotNull(column), ne(column, "")) ?? sql`1 = 0`
    case "gt":
      return gt(column, requireScalarValue(condition) as never)
    case "lt":
      return lt(column, requireScalarValue(condition) as never)
    case "gte":
      return gte(column, requireScalarValue(condition) as never)
    case "lte":
      return lte(column, requireScalarValue(condition) as never)
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
      return values.length > 0 ? inArray(column, values as never[]) : sql`1 = 0`
    }
    case "includesAny":
    case "includesAll":
      throw new Error(`Unsupported predicate operator: ${condition.op}`)
    case "between": {
      const range = asRange(condition.value)
      if (!range) throw new Error("Predicate operator between requires a range value")
      const clauses: SQL<unknown>[] = []
      if (range.from !== undefined) clauses.push(gte(column, range.from as never))
      if (range.to !== undefined) clauses.push(lte(column, range.to as never))
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

  constructor(private readonly columnMap: DrizzleColumnMap, options: PredicateCompilerOptions = {}) {
    this.dialect = options.dialect ?? "generic"
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
        return compileCondition(this.columnMap, filter, this.dialect)
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
