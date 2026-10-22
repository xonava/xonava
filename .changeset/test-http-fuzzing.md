---
"@xonava/adapters": patch
---

Fix three defects found by HTTP fuzzing: Fastify idempotent update and delete requests with path parameters were refused with 400, the Fastify CRUD plugin answered oversized bodies and unparseable Content-Type values with Fastify's own error codes instead of `REQUEST_BODY_TOO_LARGE` and `UNSUPPORTED_MEDIA_TYPE`, and a request body too large to fingerprint for `Idempotency-Key` caused a 500 instead of a 400.
