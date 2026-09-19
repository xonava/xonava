import type { PredicateNode } from "../../domain"
import type { DeleteOptions, EntityDescriptor, InsertRepository, PersistenceProvider, ReadRepository, UnversionedEntityDescriptor, UpdateWhereOptions, VersionedEntityDescriptor } from "../provider"

export interface TestRepository<T, TId = string> extends ReadRepository<T, TId>, InsertRepository<T> {
  update(id: TId, data: Partial<T>, options?: UpdateWhereOptions): Promise<T>
  updateOneWhere?(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<{ updatedCount: number }>
  updateOneWhereReturning?(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<T | null>
  updateManyWhere?(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<number>
  delete(id: TId, options?: DeleteOptions): Promise<void>
  deleteWhere?(filter: PredicateNode, options?: DeleteOptions): Promise<{ deletedCount: number }>
}

export interface TestProviderFactory extends PersistenceProvider {
  forTenant(tenantId: string): PersistenceProvider
}

export function testRepositoryForDescriptor<T, TId = string>(provider: PersistenceProvider, entity: EntityDescriptor<T>): TestRepository<T, TId> {
  return (entity.versionField
    ? provider.repository<T, TId>(entity as VersionedEntityDescriptor<T>)
    : provider.repository<T, TId>(entity as UnversionedEntityDescriptor<T>)) as TestRepository<T, TId>
}
