# Using capabilities independently

Cache-only applications import `@xonava/core/cache`; rate-limit-only applications import `@xonava/core/rate-limit`; telemetry-only applications import `@xonava/core/telemetry`; object storage imports `@xonava/core/object-store`; persistence imports `@xonava/core/persistence`; query composition imports `@xonava/core/query` plus persistence where execution requires it.

The root package is not an umbrella for every capability. Independent consumption is verified by isolated bundle fixtures. Importing a subpath does not initialize bootstrap, workflow, HTTP, or a database provider.

```ts
import { enforceRateLimit, type RateLimitStore } from "@xonava/core/rate-limit";
declare const store: RateLimitStore;
await enforceRateLimit({ store, key: "ip:trusted-key", config: { max: 20, timeWindow: "1 minute", consistency: "best-effort" } });
```
