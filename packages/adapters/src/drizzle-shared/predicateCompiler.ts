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

function compileCondition(columnMap: DrizzleColumnMap, condition: PredicateCondition): SQL<unknown> {
  const column = requireColumn(columnMap, condition.field)

  switch (condition.op) {
    case "eq":
      return condition.value === null ? isNull(column) : eq(column, requireScalarValue(condition) as never)
    case "neq":
      return condition.value === null ? isNotNull(column) : ne(column, requireScalarValue(condition) as never)
    case "contains": {
      const value = requireScalarValue(condition)
      if (typeof value !== "string") throw new Error(`Predicate operator contains requires a string value`)
      return sql`${column} LIKE ${`%${escapeLike(value)}%`} ESCAPE '\\'`
    }
    case "startsWith": {
      const value = requireScalarValue(condition)
      if (typeof value !== "string") throw new Error(`Predicate operator startsWith requires a string value`)
      return sql`${column} LIKE ${`${escapeLike(value)}%`} ESCAPE '\\'`
    }
    case "endsWith": {
      const value = requireScalarValue(condition)
      if (typeof value !== "string") throw new Error(`Predicate operator endsWith requires a string value`)
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

export class DrizzlePredicateCompiler implements PredicateCompiler<SQL<unknown>> {
  constructor(private readonly columnMap: DrizzleColumnMap) {}

  compile(filter: PredicateNode): SQL<unknown> {
    switch (filter.kind) {
      case "literal":
        return filter.value ? sql`1 = 1` : sql`1 = 0`
      case "condition":
        return strictBoolean(compileCondition(this.columnMap, filter))
      case "and": {
        if (filter.filters.length === 0) return sql`1 = 1`
        const compiled = filter.filters.map((child) => this.compile(child))
          return strictBoolean(compiled.length === 1 ? compiled[0]! : and(...compiled) ?? sql`1 = 1`)
      }
      case "or": {
        if (filter.filters.length === 0) return sql`1 = 0`
        const compiled = filter.filters.map((child) => this.compile(child))
          return strictBoolean(compiled.length === 1 ? compiled[0]! : or(...compiled) ?? sql`1 = 0`)
      }
      case "not":
        return strictBoolean(not(this.compile(filter.filter)))
      default:
        throw new Error(`Unsupported predicate node kind: ${(filter as PredicateNode).kind}`)
    }
  }
}

export function compileDrizzlePredicate(filter: PredicateNode, columnMap: DrizzleColumnMap): SQL<unknown> {
  return new DrizzlePredicateCompiler(columnMap).compile(filter)
}
