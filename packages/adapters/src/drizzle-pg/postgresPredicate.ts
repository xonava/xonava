import type { SQL } from "drizzle-orm"
import type { PredicateNode } from "@xonava/core/domain"
import { compileDrizzlePredicate as compileShared, type DrizzleColumnMap, type PredicateCompilerOptions } from "../drizzle-shared/predicateCompiler"

/** PostgreSQL predicate compilation; defaults to code-point text ordering regardless of column collation. */
export function compileDrizzlePredicate(filter: PredicateNode, columnMap: DrizzleColumnMap, options: PredicateCompilerOptions = {}): SQL<unknown> {
  return compileShared(filter, columnMap, { dialect: "postgres", ...options })
}
