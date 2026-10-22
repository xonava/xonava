import { InMemoryCacheAdapter } from "@xonava/adapters/cache"
import { runCacheAdapterContractTests } from "../src/index"

runCacheAdapterContractTests("in-memory cache adapter", {
  createAdapter: () => new InMemoryCacheAdapter(),
})
