# @xonava/testing

Conformance contracts and test kit for verifying Xonava adapters against persistence, cache, concurrency, and access-policy guarantees.

[![npm version](https://img.shields.io/npm/v/@xonava/testing)](https://www.npmjs.com/package/@xonava/testing)
[![license: MIT](https://img.shields.io/npm/l/@xonava/testing)](https://github.com/xonava/xonava/blob/main/LICENSE)
[![node >=22](https://img.shields.io/node/v/@xonava/testing)](https://nodejs.org)

> **Experimental.** Xonava is in its `0.x` series: a minor release may contain breaking changes until `1.0.0`. Pin an exact version. See [Known limitations](https://github.com/xonava/xonava/blob/main/docs/KNOWN-LIMITATIONS.md) before you adopt it.

Each export is a function that registers a named Vitest suite checking an implementation against a contract, such as a repository, a persistence provider, or a cache adapter.

## Install

```sh
npm install -D @xonava/testing vitest
```

Requires Node.js 22 or later. The package is ESM only. `vitest` ^4.1.7 is a required peer dependency and runs the suites. [`@xonava/core`](https://www.npmjs.com/package/@xonava/core) is installed automatically as a dependency. Install [`@xonava/adapters`](https://www.npmjs.com/package/@xonava/adapters) too if you test its implementations.

## Usage

### Run a contract suite against your own implementation

Call the suite runner at the top level of a Vitest test file. This example checks the in-memory cache adapter, and you can swap in your own `CacheAdapter`.

```ts
import { InMemoryCacheAdapter } from "@xonava/adapters/cache";
import { runCacheAdapterContractTests } from "@xonava/testing/contracts/cache-adapter";

runCacheAdapterContractTests("in-memory cache", {
  createAdapter: () => new InMemoryCacheAdapter(),
});
```

### Test a persistence provider

Point the suite at a provider connected to a dedicated test database.

```ts
import type { PersistenceProvider } from "@xonava/core/persistence";
import { runPersistenceProviderContractTests } from "@xonava/testing/contracts/persistence-provider";

declare function createProvider(): PersistenceProvider; // your adapter, wired to a dedicated test database

runPersistenceProviderContractTests("my provider", {
  createProvider,
});
```

## Entry points

| Import | Suite |
| --- | --- |
| `@xonava/testing` | All suite runners |
| `@xonava/testing/repositories` | Repository contract suite |
| `@xonava/testing/predicates` | Predicate contract suite |
| `@xonava/testing/abac` | ABAC invariant suite |
| `@xonava/testing/contracts/persistence-provider` | Persistence provider contract suite |
| `@xonava/testing/contracts/atomic-batch` | Atomic batch contract suite |
| `@xonava/testing/contracts/cache-adapter` | Cache adapter contract suite |
| `@xonava/testing/contracts/shared-conformance` | Shared conformance suites for idempotency, outbox replay, audit, cache generation, atomic rollback, and tenant OCC |

Only the paths in the package `exports` map are public. Do not deep-import `src` or `dist`.

## What a passing suite proves

The published package contains the compiled `dist` output and this README. The database integration, race, and crash suites and the database fixtures are not included. They run from a repository checkout against real databases. See [CONTRIBUTING.md](https://github.com/xonava/xonava/blob/main/CONTRIBUTING.md).

Passing a contract suite does not prove that a provider meets every guarantee. Real-provider guarantees require configured real runtimes. A skipped mandatory provider suite is not certification.

## Documentation

- [Writing and testing adapters](https://github.com/xonava/xonava/blob/main/docs/guides/writing-and-testing-adapters.md)
- [Testing profile](https://github.com/xonava/xonava/blob/main/docs/typescript/testing.md)
- [Certification guide](https://github.com/xonava/xonava/blob/main/docs/guides/certification.md)
- [Known limitations](https://github.com/xonava/xonava/blob/main/docs/KNOWN-LIMITATIONS.md)

## License

[MIT](https://github.com/xonava/xonava/blob/main/LICENSE)
