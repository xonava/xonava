# Stryker equivalent and unreachable mutants

Mutants listed here are not killable by any test: the branch is unreachable, the mutated code is dead, or the
mutated and the original code are observably identical. One line per location: file:line, mutators, reason.
Line numbers refer to the source before instrumentation.

## adapters http

### src/http/createFrameworkWriteHandler.ts

- src/http/createFrameworkWriteHandler.ts:82-88, all mutators: `getCookieValue` is a dead function (no caller in the package), so no test can reach it.
- src/http/createFrameworkWriteHandler.ts:146-147, all mutators: `resolveSessionRequired` is a dead function (no caller in the package).
- src/http/createFrameworkWriteHandler.ts:126, BlockStatement: the body-capturing wrapper's synchronous `parse` is never called, because `parseJsonBodySafely` only calls `parseAsync`.
- src/http/createFrameworkWriteHandler.ts:242, ConditionalExpression: the correlation id always has a value (it falls back to the request id), so the guard is always true.
- src/http/createFrameworkWriteHandler.ts:250, ObjectLiteral: `{ enabled: false, key: undefined }` and `{}` both leave `capabilityMode.enabled` falsy, so no capability key is passed either way.
- src/http/createFrameworkWriteHandler.ts:389, ConditionalExpression/StringLiteral: after a tag list exists the cache adapter provider is mandatory (checked at construction and again per request), so `!cacheAdapter` is unreachable in `invalidateAfterCommit`.
- src/http/createFrameworkWriteHandler.ts:422, OptionalChaining: the ABAC bundle is verified non-null a few lines earlier, so `abacBundle?.securityDigest` and `abacBundle.securityDigest` are identical.
- src/http/createFrameworkWriteHandler.ts:455, ConditionalExpression/StringLiteral: when the legacy-fingerprint retry also conflicts, adopting its result (`acquired = legacy`) still ends in the same `ConflictError`; the request fingerprint it rewrites is never used afterwards.
- src/http/createFrameworkWriteHandler.ts:610, OptionalChaining: `idempotency` is defined inside the heartbeat closure (the interval is only created when it is), so `idempotency?.port` equals `idempotency.port`.
- src/http/createFrameworkWriteHandler.ts:616, LogicalOperator: `leaseDurationMs` is always the constant 30 000 set a few lines earlier, so `a ?? 30_000` and `a && 30_000` both evaluate to 30 000.
- src/http/createFrameworkWriteHandler.ts:660, BlockStatement: the `else` branch (no idempotency reservation) can only run without invalidation tags, because tags require required idempotency at construction and a key at request time; `invalidateAfterCommit` is a no-op there.
