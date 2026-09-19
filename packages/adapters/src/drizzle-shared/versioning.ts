import type { AnyColumn } from "drizzle-orm"
import { assertEntityVersion, assertEntityVersionCanIncrement } from "core/serialization"
import type { EntityDescriptor } from "core/persistence"
import { ConfigurationError } from "core/domain"
type DrizzleColumnMap = Record<string, AnyColumn>

export function requireMappedVersionColumn<T>(
  entity: EntityDescriptor<T>,
  versionField: (keyof T & string) | undefined,
  columnMap: DrizzleColumnMap,
): AnyColumn | undefined {
  if (!versionField) return undefined
  const column = columnMap[versionField]
  if (!column) throw new ConfigurationError(`Versioned entity "${entity.name}" requires a mapped version field`)
  return column
}

export function assertVersionFieldIsFrameworkManaged<T>(
  entity: EntityDescriptor<T>,
  data: Partial<T>,
): void {
  if (entity.versionField && entity.versionField in (data as Record<string, unknown>)) {
    throw new ConfigurationError(
      `Cannot set version field "${String(entity.versionField)}" directly; the framework auto-increments it`,
    )
  }
}

export function assertVersionedInsertValue<T>(entity: EntityDescriptor<T>, data: Partial<T>): void {
  if (!entity.versionField) return
  const value = (data as Record<string, unknown>)[entity.versionField]
  if (value !== undefined) assertEntityVersion(value)
}

export function assertVersionCanIncrement(value: unknown): void {
  assertEntityVersionCanIncrement(value)
}

export function requireOptimisticConcurrencyVersion<T>(
  entity: EntityDescriptor<T>,
  hasOptimisticConcurrency: boolean,
): void {
  if (hasOptimisticConcurrency && !entity.versionField) {
    throw new ConfigurationError(
      `Entity "${entity.name}" has no versionField configured. Optimistic concurrency requires a version column.`,
    )
  }
}
