import type { DeleteOptions, EntityDescriptor, InsertRepository, PersistenceProvider, ReadOnlyPersistenceProvider, ReadOnlyRepository, ReadRepository, UnversionedEntityDescriptor, UpdateWhereOptions, VersionedEntityDescriptor } from "core/persistence"
import type { PredicateNode } from "core/domain"

/** Adapter-internal boundary for compiled descriptors whose version kind is known only at runtime. */
export interface InternalDynamicRepository<T, TId = string> extends ReadRepository<T, TId>, InsertRepository<T> {
  update(id: TId, data: Partial<T>, options?: UpdateWhereOptions): Promise<T>
  updateOneWhere?(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<{ updatedCount: number }>
  updateOneWhereReturning?(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<T | null>
  updateManyWhere?(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<number>
  delete(id: TId, options?: DeleteOptions): Promise<void>
  deleteWhere?(filter: PredicateNode, options?: DeleteOptions): Promise<{ deletedCount: number }>
}

export function internalRepositoryForDescriptor<T, TId = string>(
  provider: PersistenceProvider,
  entity: EntityDescriptor<T>,
): InternalDynamicRepository<T, TId>
export function internalRepositoryForDescriptor<T, TId = string>(
  provider: ReadOnlyPersistenceProvider,
  entity: EntityDescriptor<T>,
): ReadOnlyRepository<T, TId>
export function internalRepositoryForDescriptor<T, TId = string>(
  provider: PersistenceProvider | ReadOnlyPersistenceProvider,
  entity: EntityDescriptor<T>,
): InternalDynamicRepository<T, TId> | ReadOnlyRepository<T, TId> {
  return entity.versionField
    ? provider.repository<T, TId>(entity as VersionedEntityDescriptor<T>) as InternalDynamicRepository<T, TId> | ReadOnlyRepository<T, TId>
    : provider.repository<T, TId>(entity as UnversionedEntityDescriptor<T>) as InternalDynamicRepository<T, TId> | ReadOnlyRepository<T, TId>
}
