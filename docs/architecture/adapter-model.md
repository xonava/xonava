# Adapter model and framework neutrality

Core does not depend on Express, Fastify, Hono, NestJS, Next.js, database drivers, or cloud SDKs. An integration translates a runtime request into neutral operation input and maps canonical results/errors back to its transport.

```text
HTTP request → HTTP adapter → core operation → canonical result/error → HTTP adapter → response
```

HTTP status, headers, request objects, and middleware are adapter concerns. A reference adapter is an example/proof implementation. A certified adapter has passed the applicable conformance and provider-specific suites. A defect in an uncertified custom adapter is not automatically a core defect.
