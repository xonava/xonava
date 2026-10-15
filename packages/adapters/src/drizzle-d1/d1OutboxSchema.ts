import { getTableConfig, type AnySQLiteTable } from "drizzle-orm/sqlite-core"
import type { AnyColumn } from "drizzle-orm"
import { ConfigurationError } from "@xonava/core/domain"

export type D1OutboxColumns = AnySQLiteTable & {
  id?: AnyColumn
  tenantId?: AnyColumn
  idempotencyScope?: AnyColumn
  idempotencyKey?: AnyColumn
  eventFingerprint?: AnyColumn
}

function sameColumn(left: unknown, right: AnyColumn): boolean {
  return left === right || (typeof left === "object" && left !== null && "name" in left && (left as { name?: unknown }).name === right.name)
}

export function validateD1AtomicOutboxColumns(table: AnySQLiteTable): D1OutboxColumns {
  const columns = table as D1OutboxColumns
  if (!columns.id) throw new ConfigurationError("D1 outbox requires an id column")
  if (!columns.idempotencyScope || !columns.idempotencyKey) {
    throw new ConfigurationError("D1 outbox requires idempotencyScope and idempotencyKey columns")
  }
  if (!columns.eventFingerprint) throw new ConfigurationError("D1 outbox requires an eventFingerprint column")
  const scopeColumn = columns.idempotencyScope
  const keyColumn = columns.idempotencyKey

  const config = getTableConfig(table)
  const hasUniqueScopeKey = config.indexes.some((index) => {
    const indexedColumns = index.config.columns
    return index.config.unique && indexedColumns.length === 2 &&
      sameColumn(indexedColumns[0], scopeColumn) &&
      sameColumn(indexedColumns[1], keyColumn)
  }) || config.uniqueConstraints.some((constraint) => {
    return constraint.columns.length === 2 &&
      sameColumn(constraint.columns[0], scopeColumn) &&
      sameColumn(constraint.columns[1], keyColumn)
  })
  if (!hasUniqueScopeKey) {
    throw new ConfigurationError("D1 outbox requires a unique (idempotencyScope,idempotencyKey) constraint")
  }
  return columns
}
