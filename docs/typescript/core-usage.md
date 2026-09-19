# Core usage

Core capabilities do not require a global container. Supply the contract implementation required by the capability.

```ts
import { CacheService, type CacheAdapter } from "core/cache";

declare const adapter: CacheAdapter;
const cache = new CacheService({ adapter, defaultTtlMs: 30_000 });
await cache.set("account:42", { enabled: true });
const account = await cache.get<{ enabled: boolean }>("account:42");
```

```ts
import { checkRateLimit, type AtomicRateLimitStore } from "core/rate-limit";

declare const store: AtomicRateLimitStore;
const decision = await checkRateLimit({
  store, key: "tenant:t1:user:u1", limit: 100, windowMs: 60_000,
});
```

The examples are mirrored by compile-checked documentation tests.
