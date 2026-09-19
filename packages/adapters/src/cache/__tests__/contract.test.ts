import { runCacheAdapterContractTests } from "testing"
import { InMemoryCacheAdapter } from "../inMemoryCacheAdapter"
import { SharedGenerationCacheAdapter } from "../sharedGenerationCacheAdapter"

runCacheAdapterContractTests("InMemoryCacheAdapter", {
  createAdapter: () => new InMemoryCacheAdapter(),
})

runCacheAdapterContractTests("SharedGenerationCacheAdapter over in-memory payload", {
  createAdapter: () => new SharedGenerationCacheAdapter({
    payload: new InMemoryCacheAdapter(),
    generations: {
      getTagGeneration: async () => "0",
      advanceTagGeneration: async (tag: string) => tag,
    },
  }),
})
