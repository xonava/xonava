import type { SQL } from "drizzle-orm"
import type { PredicateNode } from "core/domain"
import { compileDrizzlePredicate as compileShared, type DrizzleColumnMap, type PredicateCompilerOptions } from "../drizzle-shared/predicateCompiler"

/** D1/SQLite predicate compilation; defaults to SQLite text semantics. */
export function compileDrizzlePredicate(filter: PredicateNode, columnMap: DrizzleColumnMap, options: PredicateCompilerOptions = {}): SQL<unknown> {
  return compileShared(filter, columnMap, { dialect: "sqlite", ...options })
}
