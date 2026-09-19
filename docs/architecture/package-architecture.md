# Package architecture

## `core`

Contracts, framework semantics, orchestration, domain primitives, capability logic, and intentional public APIs. Its root export is deliberately small; specialized capabilities use subpaths such as `core/cache` and `core/persistence`.

## `adapters`

Reference and technology-specific implementations: PostgreSQL, MySQL, D1, HTTP/server composition, cache, and object storage. An adapter translates provider behavior into core semantics and normalizes provider failures.

## `testing`

Fixtures, integration suites, conformance suites, race tests, process-crash/replay tests, and certification support. It may depend on core and adapters where proof requires real implementations.

See [public exports](../reference/package-exports.md) for the exact supported entry points.
