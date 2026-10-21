# HTTP framework adapters

The `@xonava/adapters/fastify`, `@xonava/adapters/hono`, and `@xonava/adapters/express` entry points bind the existing Fetch-based `CRUD()` and `createFrameworkWriteHandler()` handlers to Fastify 5, Hono 4, and Express 5. Authorization, scope resolution, validation, optimistic concurrency, rate limiting, and idempotency stay in the existing HTTP handlers.

Install only the framework you use. Framework dependencies are optional peers and are not imported by `@xonava/adapters` or `@xonava/adapters/http`. Express TypeScript users also need `@types/express` 5. Node adapters require Node 22 or later; Hono's entry point uses Web APIs and has no Node transport imports.

## Fastify

```ts
import Fastify from 'fastify'
import { CRUD, resolveAdapterHttpMetadata } from '@xonava/adapters/http'
import { fastifyCrudPlugin } from '@xonava/adapters/fastify'

// definition is a compiled defineEntity() result; runtime is your existing CrudRuntime.
const handlers = CRUD(definition, {
  ...runtime,
  adapterDeps: { ...runtime.adapterDeps, resolveHttpMetadata: resolveAdapterHttpMetadata },
})
const app = Fastify()
await app.register(fastifyCrudPlugin, {
  prefix: '/people',
  handlers,
  origin: 'https://api.example.com',
  maxBodyBytes: 1024 * 1024,
})
await app.listen({ port: 3000 })
```

The plugin installs an encapsulated raw Buffer parser so malformed JSON, UTF-8, media types, and schema validation still reach the shared handlers. Other Fastify routes keep their existing parsers. Fastify's parser rejects oversized bodies before calling the adapter, using its native 413 response.

For individual handlers, use `createFastifyHandler(handler, options)`. Register raw parsing in the same encapsulated plugin as those routes:

```ts
import { createFastifyHandler } from '@xonava/adapters/fastify'

await app.register(async scoped => {
  scoped.removeAllContentTypeParsers()
  scoped.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1048576 },
    (_request, body, done) => done(null, body))
  scoped.post('/action', createFastifyHandler(writeHandler, {
    origin: 'https://api.example.com',
  }))
})
```

Do not attach a Fastify body schema or a hook that replaces raw bodies with parsed objects on these routes. The adapter rejects parsed bodies rather than reserializing them.

## Hono

```ts
import { Hono } from 'hono'
import { createHonoCrudApp, createHonoHandler } from '@xonava/adapters/hono'

const app = new Hono()
app.route('/people', createHonoCrudApp(handlers))
app.post('/action', createHonoHandler(writeHandler))
export default app
```

Hono passes `context.req.raw` directly to the Fetch handler, preserving its body stream and abort signal. Mount handlers before middleware that consumes the raw body. Apply Hono's body-limit middleware if you need a transport-level limit; existing CRUD JSON parsing independently defaults to 1 MiB. Hono's parent router controls strict trailing-slash matching: the collection path in this example is `/people`.

For runtime connection metadata, pass `resolveHttpMetadata(context)` in the options. Use the deployment runtime's authenticated connection information. The callback can also access typed Hono bindings through `HonoAdapterOptions<YourEnv>`. No client IP is inferred from forwarded headers.

## Express

```ts
import express from 'express'
import { createExpressCrudRouter, createExpressHandler } from '@xonava/adapters/express'

const app = express()
app.use('/people', createExpressCrudRouter(handlers, {
  origin: 'https://api.example.com',
  maxBodyBytes: 1024 * 1024,
}))
app.post('/action', createExpressHandler(writeHandler, {
  origin: 'https://api.example.com',
}))
// Install JSON middleware afterward for unrelated routes.
app.use(express.json())
app.listen(3000)
```

Express adapters read and bound the raw request themselves. They can also accept a Buffer from `express.raw({ type: '*/*', inflate: false })`; configure that middleware's own size limit appropriately. Mounting after `express.json()` or `express.text()` fails closed with a configuration error. Compressed request bodies are not decompressed by the adapters. Requests retain `originalUrl`, including mount prefixes and repeated query parameters. Parent router parameters are merged into CRUD route parameters.

## Shared contract

CRUD helpers register these routes beneath the supplied mount point:

| Method | Path | Handler |
| --- | --- | --- |
| GET | `/` | `list(request)` |
| GET | `/:id` | `detail(request, params)` |
| POST | `/` | `create(request, context)` |
| PATCH | `/:id` | `update(request, context)` |
| DELETE | `/:id` | `delete(request, context)` |

The helpers accept the result of `CRUD(definition, runtime)`. Disabled entity routes retain their existing 405 response; unknown paths and methods use the host router's behavior. Individual adapters accept an `HttpHandler`: `(request, context?) => Response | Promise<Response>`, where `context.params` resolves to decoded route parameters. For a standalone detail route, wrap its distinct signature:

```ts
const detailHandler = async (request, context) =>
  handlers.detail(request, await context.params)
```

Node adapters require an explicit HTTP(S) `origin` without credentials, a path, a query, or a fragment. They never construct URLs from Host or forwarded headers. The default raw body limit is 1 MiB; `maxBodyBytes` counts bytes, not characters. A limit of zero allows only empty bodies. Request bodies are buffered up to the limit; responses stream with backpressure. Host parser limits may reject a request earlier than the adapter's limit.

Statuses, binary bodies, repeated Set-Cookie headers, idempotency headers, If-Match, request/correlation IDs, and Retry-After are preserved. Node response bridges strip hop-by-hop headers and suppress HEAD bodies. Socket disconnects abort the Fetch request signal and cancel streamed responses. A failure after response streaming begins terminates the stream; it cannot become a new JSON response.

Uncaught handler/conversion errors use `createFrameworkErrorHandler()`. The optional `reportError` callback receives errors reported by that boundary; errors already handled inside CRUD retain CRUD's own reporting behavior. Fastify parser errors and router-level errors stay under the framework's error handling.

`requestNormalization.resolveTrustedSession` returns `undefined` when the request has no login. On a route whose binding is authenticated and has no anonymous principal, every CRUD and write handler then answers 401 `UNAUTHORIZED` before scope resolution, admission, the repository, audit or the business action run; there is no need to throw from the resolver. Routes that allow an anonymous principal keep their existing behaviour, and an inconsistent binding stays a configuration error (500).

To integrate Node peer addresses, set `runtime.adapterDeps.resolveHttpMetadata` to `resolveAdapterHttpMetadata`. It supplies the socket peer address, never an automatic proxy-trust assertion. Continue configuring `resolveClientIp` using the existing trusted-proxy policy. If your application already supplies a metadata resolver, compose it explicitly instead of replacing its policy accidentally.

## Business actions

A write that is not a plain create, update or delete is a business action. Register a route binding for it, grant the action in the module catalog and the ABAC policies, and pass the name as `action`:

```ts
const approve = createFrameworkWriteHandler({
  adapterDeps,
  requestNormalization, // routeBindings includes an `approve` binding
  scope: { scope: "tenant", idempotency: { required: true } },
  moduleKey: "billing.invoices",
  action: "approve", // routeKey defaults to the action
  customCapabilityKey: "billing.invoices.approve",
  createPersistence,
  definition: approveInvoiceOperation, // key matches the binding's operationKey
  resolveInput,
  resolveResourceIdentity,
  recoverCommittedResponse,
})

// Keep generic updates away from the fields only approve may change.
const handlers = CRUD(invoiceDefinition, { ...runtime, update: { protectedFields: ["status", "approvedAt"] } })
```

`approve` is admitted only by its own grant (an `update` grant does not imply it), a missing binding or a reserved name (`read`, `manage`, `create`, `update`, `delete`) fails at construction, and a generic update that touches a `protectedFields` entry is refused with 403. See [Business actions](../spec/operations.md#business-actions-normative).

## Committed responses in custom write handlers

A write handler that returns the row it changed must build that response from a fresh read, not from the value `execute` returned: the response has to honour the caller's read scope and field-read overrides, and an idempotent recovery after a crash has to produce the same bytes as the first response. `readCommittedRecord` is the function built-in create and update use for both. Call it from the operation's `after` hook and from `recoverCommittedResponse`:

```ts
import { readCommittedRecord } from "@xonava/adapters/http"

const read = (context: RequestContext, id: string, committedVersion?: number) =>
  readCommittedRecord({
    entity: invoiceDescriptor,        // versionField drives the revision check
    moduleKey: "billing.invoices",     // key the ABAC bundle is resolved for
    context,                           // operation.request in `after`, `context` in recovery
    persistence: createPersistence(context),
    adapterDeps,                       // only resolveAbacBundle is used
    entityScope: { kind: "tenant" },   // the structural scope the entity is registered with
    id,
    ...(committedVersion !== undefined ? { committedVersion } : {}),
  })

const approve = createFrameworkWriteHandler({
  // ...
  definition: {
    // ...
    after: async ({ operation, result }) => {
      const committed = await read(operation.request!, result.id, result.version)
      return committed.kind === "record" ? { record: committed.record } : { success: true }
    },
  },
  resolveResourceIdentity: ({ input }) => ({ entity: "invoice", id: input.id, version: input.expectedVersion + 1 }),
  recoverCommittedResponse: async ({ resource, context }) => {
    const committed = await read(context, resource.id, resource.version)
    return committed.kind === "record" ? { record: committed.record } : null
  },
})
```

Arguments: `entity` is the descriptor (its `versionField` and declared fields); `moduleKey` selects the ABAC bundle; `context` is the trusted request context; `persistence` is the provider to read through (tenant scoping is added for tenant entities); `adapterDeps` supplies `resolveAbacBundle`; `entityScope` is the entity's structural scope declaration; `id` is the primary key; `committedVersion` is the version the write committed. The result is one of:

| `kind` | Meaning |
| --- | --- |
| `record` | The committed row, read under the read scope and projected with the caller's overrides. |
| `outside-read-scope` | The row exists in the structural scope but the caller may not read it. |
| `revision-unavailable` | The row is readable but its stored version is not `committedVersion`. The newer revision is never substituted. |
| `deleted` | No row with this id exists in the structural scope. |

These are internal outcomes, not HTTP responses. Do not let an unauthorized client tell `outside-read-scope` from `deleted`: answer both with the same response (built-in create and update return `{ "success": true, "reason": "CREATED_OUTSIDE_READ_SCOPE" }` or `UPDATED_OUTSIDE_READ_SCOPE` and no entity content). In `recoverCommittedResponse`, return `null` for every kind other than `record`; the framework then stores a stable 409 for the receipt. Separating `deleted` from `outside-read-scope` costs one extra read, issued only when the scoped read finds nothing and only with the structural scope (tenant, application and active-row filters), never an unscoped read.

## Hand-written endpoints

A read endpoint that is neither CRUD nor a write handler (a lookup list, a report) can reuse the request and admission steps of the built-in handlers instead of re-implementing them. Both helpers are exported from `@xonava/adapters/http`.

```ts
import { admitModuleAction, resolveEndpointRequestContext, resolveRequestMetadata } from "@xonava/adapters/http"

const requestMetadata = resolveRequestMetadata(request)
const context = await resolveEndpointRequestContext({
  request,
  routeKey: "warehouseOptions", // a key of requestNormalization.routeBindings
  normalization: requestNormalization,
  requestMetadata, // optional: omit to have the ids generated
})
const bundle = await adapterDeps.resolveAbacBundle({ moduleKey: "shop.orders", context })
admitModuleAction({ adapterDeps, moduleKey: "shop.orders", action: "assignWarehouse", context, bundle })
```

- `resolveEndpointRequestContext({ request, routeKey, normalization, adapterDeps?, requestMetadata?, pathParameters? })` returns the trusted `RequestContext` (trusted session, scope resolution, admission evidence) exactly as CRUD and write handlers build it. A missing route binding is a `ConfigurationError`; a request without a login on a route that does not allow anonymous callers is refused with 401.
- `admitModuleAction({ adapterDeps, moduleKey, action, context, bundle, capabilityKey? })` applies the module and ABAC collection admission CRUD uses. A missing, unverified or other-module bundle, a deny, and a disabled module, action or capability are refused with 403. A conditional grant admits, because the per-record condition belongs to the action itself.
- `routeBindings` needs only the keys you use. The five CRUD keys (`list`, `detail`, `create`, `update`, `delete`) are required only by a CRUD handler whose route is enabled; `CRUD(...)` throws a `ConfigurationError` naming the missing key at construction. See [supporting reads](../guides/supporting-reads.md) for a complete example.

## Method and body matrix

Every write handler (CRUD `create`, `update` and `delete`, and `createFrameworkWriteHandler`) reads its body with `parseJsonBodySafely` (`packages/adapters/src/http/requestBody.ts`) before session, CSRF or authorization checks. Refusals are mapped by `createFrameworkErrorHandler` (`packages/adapters/src/http/handleFrameworkCoreError.ts`). List and detail handlers never read a body: they parse only the query and path parameters.

| Operation | Reads a body? | Empty body | Non-empty body, no body contract | Non-empty body, contract, not JSON | Malformed JSON | Over the byte limit |
| --- | --- | --- | --- | --- | --- | --- |
| list (`GET /`) | No | Answered normally | Ignored; answered normally | Ignored; answered normally | Ignored; answered normally | 413 `REQUEST_BODY_TOO_LARGE` at the Fastify and Express transports, before the handler runs. Hono: a Fetch GET cannot carry a body |
| detail (`GET /:id`) | No | Answered normally | Ignored; answered normally | Ignored; answered normally | Ignored; answered normally | Same as list |
| create (`POST /`) | Yes when `createBody` is declared; otherwise only checked | Declared: 400 `INVALID_JSON`. Not declared: passes the body check | 415 `BODY_NOT_ACCEPTED` | 415 `UNSUPPORTED_MEDIA_TYPE` when declared; `BODY_NOT_ACCEPTED` when not | Declared: 400 `INVALID_JSON`. Not declared: 415 `BODY_NOT_ACCEPTED` | 413 `REQUEST_BODY_TOO_LARGE` |
| update (`PATCH /:id`) | Yes when `updateBody` is declared; otherwise only checked | Declared: 400 `INVALID_JSON`. Not declared: passes the body check | 415 `BODY_NOT_ACCEPTED` | 415 `UNSUPPORTED_MEDIA_TYPE` when declared; `BODY_NOT_ACCEPTED` when not | Declared: 400 `INVALID_JSON`. Not declared: 415 `BODY_NOT_ACCEPTED` | 413 `REQUEST_BODY_TOO_LARGE` |
| delete (`DELETE /:id`) | No contract; only checked | Passes the body check | 415 `BODY_NOT_ACCEPTED` | 415 `BODY_NOT_ACCEPTED` | 415 `BODY_NOT_ACCEPTED` | 413 `REQUEST_BODY_TOO_LARGE` |
| custom write (`createFrameworkWriteHandler`) | Yes when `validation.body` is set; otherwise only checked | Declared: 400 `INVALID_JSON`. Not declared: passes the body check | 415 `BODY_NOT_ACCEPTED` | 415 `UNSUPPORTED_MEDIA_TYPE` when declared; `BODY_NOT_ACCEPTED` when not | Declared: 400 `INVALID_JSON`. Not declared: 415 `BODY_NOT_ACCEPTED` | 413 `REQUEST_BODY_TOO_LARGE` |

Checks run in this order for every write handler, and the first failure wins:

1. Size: a declared `Content-Length` above the limit, or more streamed bytes than the limit, gives 413 before the body is read.
2. Encoding: bytes that are not valid UTF-8 give 400 `INVALID_JSON`, even when no body contract is declared.
3. Contract: a non-empty body with no body contract gives 415 `BODY_NOT_ACCEPTED`, whatever its content type, and before the JSON is parsed.
4. Content type: with a contract, a non-empty body must be `application/json` or `application/*+json` with `charset=utf-8` if a charset is given. An empty body skips this check.
5. JSON: an empty or malformed body gives 400 `INVALID_JSON`.
6. Schema: a body that fails the declared contract gives 400 `VALIDATION_ERROR`.

An empty body is zero bytes. Whitespace alone is non-empty. Path and query parameters are validated before the body, so a parameter failure is answered first. A refused body never reaches the CSRF, session or authorization stages.

## Verification

Run the transport and real-framework tests with:

```sh
npm run test -w @xonava/adapters -- src/http/__tests__/frameworkAdapters.test.ts src/http/__tests__/nodeTransport.test.ts
npm run typecheck
npm run lint
npm run build
npm test
```

Tests cover real framework routing, compiled CRUD lifecycles, tenant isolation, authorization, OCC, idempotent replay, body validation/limits, cookies, binary streaming, host spoofing, cancellation, stream failures, and middleware/parser integration. CRUD lifecycle tests use an in-memory repository fixture; database adapter certification remains a separate suite.

Framework references: [Fastify content-type parsers](https://fastify.dev/docs/latest/Reference/ContentTypeParser/), [Fastify replies](https://fastify.dev/docs/latest/Reference/Reply/), [Hono requests](https://hono.dev/docs/api/request), and [Express API](https://expressjs.com/en/5x/api.html).
