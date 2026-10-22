import { UnavailableError } from "@xonava/core/domain"
import type { ObjectStore } from "@xonava/core/object-store"
import { InMemoryObjectStore } from "@xonava/adapters/storage"
import { runObjectStoreContractTests } from "../src/index"

const providerFailureText = "provider-secret-7f3a"

// Models a store whose provider failures were already mapped to UnavailableError without provider text.
function createFailingObjectStore(): ObjectStore {
  const unavailable = async (): Promise<never> => {
    throw new UnavailableError("object store is unavailable")
  }
  return { put: unavailable, get: unavailable, head: unavailable, delete: unavailable }
}

runObjectStoreContractTests("in-memory object store", {
  createStore: () => new InMemoryObjectStore(),
  createFailingStore: createFailingObjectStore,
  providerFailureText,
})
