import { runRepositoryContractTests } from "../repository-contracts"
import { runTenantOccContractTests } from "./shared-conformance"
import type { PersistenceProvider } from "core/persistence"

export interface PersistenceProviderContractOptions {
  createProvider: () => PersistenceProvider
  createSecondProvider?: () => PersistenceProvider
  createTenantProvider?: (provider: PersistenceProvider, tenantId: string) => PersistenceProvider
  beforeEach?: () => void | Promise<void>
}

/** Runs the provider behavior every persistence adapter must support. */
export function runPersistenceProviderContractTests(
  label: string,
  options: PersistenceProviderContractOptions,
): void {
  runRepositoryContractTests(label, options)
  if (options.createTenantProvider) {
    runTenantOccContractTests<{
      id: string
      name: string
      value: number
      tenantId?: string
      version?: number
    }>(label, {
      entity: {
        name: "framework_contract_rows",
        primaryKey: "id",
        tenantField: "tenantId",
        versionField: "version",
        fields: {
          id: { type: "string" },
          name: { type: "string" },
          value: { type: "number" },
          tenantId: { type: "string", nullable: true },
          version: { type: "number", nullable: true },
        },
      },
      createProvider: options.createProvider,
      createSecondProvider: options.createSecondProvider ?? options.createProvider,
      createTenantProvider: options.createTenantProvider,
      createRow: (tenantId) => ({ id: `tenant-occ-${tenantId}`, name: "before", value: 1, tenantId, version: 1 }),
      getId: (row) => row.id,
      getVersion: (row) => row.version ?? 1,
    })
  }
}
