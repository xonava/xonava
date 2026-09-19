# HTTP framework adapters

The `adapters/fastify`, `adapters/hono`, and `adapters/express` entry points bind the existing Fetch-based `CRUD()` and `createFrameworkWriteHandler()` handlers to Fastify 5, Hono 4, and Express 5. Authorization, scope resolution, validation, optimistic concurrency, rate limiting, and idempotency stay in the existing HTTP handlers.

Install only the framework you use. Framework dependencies are optional peers and are not imported by `adapters` or `adapters/http`. Express TypeScript users also need `@types/express` 5. Node adapters require Node 22 or later; Hono's entry point uses Web APIs and has no Node transport imports.

## Fastify

```ts
import Fastify from 'fastify'
import { CRUD, resolveAdapterHttpMetadata } from 'adapters/http'
import { fastifyCrudPlugin } from 'adapters/fastify'

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
import { createFastifyHandler } from 'adapters/fastify'

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
import { createHonoCrudApp, createHonoHandler } from 'adapters/hono'

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
import { createExpressCrudRouter, createExpressHandler } from 'adapters/express'

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

To integrate Node peer addresses, set `runtime.adapterDeps.resolveHttpMetadata` to `resolveAdapterHttpMetadata`. It supplies the socket peer address, never an automatic proxy-trust assertion. Continue configuring `resolveClientIp` using the existing trusted-proxy policy. If your application already supplies a metadata resolver, compose it explicitly instead of replacing its policy accidentally.

## Verification

Run the transport and real-framework tests with:

```sh
npm run test -w adapters -- src/http/__tests__/frameworkAdapters.test.ts src/http/__tests__/nodeTransport.test.ts
npm run typecheck
npm run lint
npm run build
npm test
```

Tests cover real framework routing, compiled CRUD lifecycles, tenant isolation, authorization, OCC, idempotent replay, body validation/limits, cookies, binary streaming, host spoofing, cancellation, stream failures, and middleware/parser integration. CRUD lifecycle tests use an in-memory repository fixture; database adapter certification remains a separate suite.

Framework references: [Fastify content-type parsers](https://fastify.dev/docs/latest/Reference/ContentTypeParser/), [Fastify replies](https://fastify.dev/docs/latest/Reference/Reply/), [Hono requests](https://hono.dev/docs/api/request), and [Express API](https://expressjs.com/en/5x/api.html).
