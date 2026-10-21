import { InMemoryObjectStore } from "@xonava/adapters/storage"
import { runObjectStoreContractTests } from "../src/index"

runObjectStoreContractTests("in-memory object store", { createStore: () => new InMemoryObjectStore() })
