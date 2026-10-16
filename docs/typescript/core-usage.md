# Core usage

Core capabilities do not require a global container. Supply the contract implementation required by the capability.

```ts
import { CacheService, type CacheAdapter } from "@xonava/core/cache";

declare const adapter: CacheAdapter;
const cache = new CacheService({ adapter, defaultTtlMs: 30_000 });
await cache.set("account:42", { enabled: true });
const account = await cache.get<{ enabled: boolean }>("account:42");
```

```ts
import { checkRateLimit, type AtomicRateLimitStore } from "@xonava/core/rate-limit";

declare const store: AtomicRateLimitStore;
const decision = await checkRateLimit({
  store, key: "tenant:t1:user:u1", limit: 100, windowMs: 60_000,
});
```

The examples are mirrored by compile-checked documentation tests.

## Read-model execution

`executeReadModel` applies one read-wide deadline. Callers may provide an absolute `deadline`, a bounded `timeoutMs`, or both (the earlier wins). If neither is provided, Core uses `DEFAULT_READ_MODEL_TIMEOUT_MS`; all executions are capped by `MAX_READ_MODEL_TIMEOUT_MS`. The effective deadline, clock, and one shared child `AbortSignal` are passed to every source executor.

Caller cancellation and deadline expiry always terminate the whole read, regardless of the partial-source failure policy. Ordinary provider rejection still follows that policy. Core removes its parent listener and timer when execution settles and observes providers that settle late, so they cannot cause unhandled rejections. JavaScript cannot forcibly stop an executor that ignores its signal; after termination Core stops waiting for it and does not process its eventual result.

Definitions are capped by the exported source, join, source-row, and output-row ceilings. Join execution builds a right-side index and also enforces `MAX_READ_MODEL_INDEXED_ROWS`. Join keys preserve strict-equality behavior: nullish and `NaN` keys do not match, while object keys match by identity.
