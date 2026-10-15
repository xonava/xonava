# Public API philosophy

The `@xonava/core` root intentionally exports only entity definition/compilation and operation creation/execution primitives. Capability APIs use explicit subpaths:

```ts
import { CacheService, type CacheAdapter } from "@xonava/core/cache";
import { checkRateLimit, type RateLimitStore } from "@xonava/core/rate-limit";
import type { PersistenceProvider } from "@xonava/core/persistence";
```

This makes ownership visible, improves tree shaking, reduces accidental coupling, and lets capability APIs evolve deliberately. Only paths in package `exports` are public. See the generated/maintained [export reference](../reference/package-exports.md).
