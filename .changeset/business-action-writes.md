---
"@xonava/core": minor
"@xonava/adapters": minor
---

Business-action writes: `createFrameworkWriteHandler` accepts a named business action (for example `approve`) with an optional `routeKey`, authorized by its own ABAC grant and never implied by `update`. `CRUD()` gains `update.protectedFields` to reserve fields for business actions, and `AbacAuthorizer.assertWrite` takes any action string.
