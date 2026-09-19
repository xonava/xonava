# adapters

Reference technology integrations for the public core contracts: PostgreSQL, MySQL, D1, HTTP/server composition, cache, and storage. Provider-specific semantics remain here, not in core.

See the [adapter model](../../docs/architecture/adapter-model.md) and [adapter authoring guide](../../docs/typescript/adapter-authoring.md). Passing typecheck alone does not certify an adapter.

HTTP framework bindings are available as `adapters/fastify` (Fastify 5), `adapters/hono` (Hono 4), and `adapters/express` (Express 5). Each supports individual Fetch handlers and mounting the result of `CRUD()`. See the [HTTP adapter guide](../../docs/typescript/http-adapters.md) for installation, raw-body setup, route mapping, transport metadata, and tests.
