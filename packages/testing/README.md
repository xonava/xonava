# @xonava/testing

Reusable fixtures and contract suites for `@xonava/core` and `@xonava/adapters`. Each export runs a named suite that checks an implementation against a contract, such as a repository, a persistence provider, or a cache adapter.

## Install

```sh
npm install -D @xonava/testing vitest
```

`vitest` ^4.1.7 is a peer dependency and runs the suites. Requires Node.js 22 or later.

## Exports

| Import | Suite |
| --- | --- |
| `@xonava/testing` | All suite runners listed below |
| `@xonava/testing/repositories` | Repository contract suite |
| `@xonava/testing/predicates` | Predicate contract suite |
| `@xonava/testing/abac` | ABAC invariant suite |
| `@xonava/testing/contracts/persistence-provider` | Persistence provider contract suite |
| `@xonava/testing/contracts/atomic-batch` | Atomic batch contract suite |
| `@xonava/testing/contracts/cache-adapter` | Cache adapter contract suite |
| `@xonava/testing/contracts/shared-conformance` | Shared conformance suites for idempotency, outbox replay, audit, cache generation, atomic rollback, and tenant OCC |

Only the paths in the package `exports` map are public. Do not deep-import `src` or `dist`.

## Example

Run the cache adapter suite against your own implementation in a Vitest test file:

```ts
import { runCacheAdapterContractTests } from "@xonava/testing/contracts/cache-adapter";
import { createMyCacheAdapter } from "./my-cache-adapter"; // your CacheAdapter implementation

runCacheAdapterContractTests("my cache", {
  createAdapter: () => createMyCacheAdapter(),
});
```

## Scope of the published package

The published package contains the compiled `dist` output and this README. The database integration, race, and crash suites and the database fixtures are not included. They run from a repository checkout against real databases. See [CONTRIBUTING.md](https://github.com/Suriyaprakash-Somu/engine/blob/main/CONTRIBUTING.md).

Passing a contract suite does not prove that a provider meets every guarantee. Real-provider guarantees require configured real runtimes.

## Documentation

- [Testing architecture](https://github.com/Suriyaprakash-Somu/engine/blob/main/docs/typescript/testing.md)
- [Certification guide](https://github.com/Suriyaprakash-Somu/engine/blob/main/docs/guides/certification.md)
- [Writing and testing adapters](https://github.com/Suriyaprakash-Somu/engine/blob/main/docs/guides/writing-and-testing-adapters.md)

## License

MIT
