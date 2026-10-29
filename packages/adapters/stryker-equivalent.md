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

### src/http/scopeResolution.ts

- src/http/scopeResolution.ts:75, ConditionalExpression (`if (!input.session)` -> `false` in the fixed-scope branch): unreachable, because `resolveIdentity` runs first and already throws the same missing-session error for every non-public route; a public fixed route throws on line 74 before this check.
- src/http/scopeResolution.ts:117, OptionalChaining (`input.session?.source` -> `input.session.source`): the branch is reached only for a non-public route, and `resolveIdentity` has already rejected a missing session there, so `session` is always defined.
- src/http/scopeResolution.ts:141, 148, 149, 150, ConditionalExpression -> `false` (`...(x === undefined ? {} : { x })` always spreading `{ x: undefined }` for causationId, deadline, locale, timezone): `freezeVerifiedRequestContext` snapshots the context and drops every undefined optional key, so the resulting context is identical.

### src/http/trustedClientIp.ts

- src/http/trustedClientIp.ts:26, EqualityOperator (`hops < 0` -> `hops <= 0`): at zero hops the mutant returns the peer here, and the original returns the same peer at line 37 (after the trust checks, which also return the peer), so the result is identical.
- src/http/trustedClientIp.ts:26, ConditionalExpression (`trustedProxyIps.length === 0` -> `false`): with an empty allowlist no peer can be trusted, so line 31 returns the same peer.
- src/http/trustedClientIp.ts:31, ConditionalExpression (`peerAddress === null` -> `false`): `peerIsTrusted` already requires a non-null peer, so `!peerIsTrusted` is true whenever the peer is null and the same early return happens.
- src/http/trustedClientIp.ts:36, ArrayDeclaration (`?? []` -> `?? ["Stryker was here"]`): a missing header would give a one-entry chain, which only matches `hops + 1` for zero hops, and zero hops return at line 37 before the length check.
- src/http/trustedClientIp.ts:42, all three mutators (`peerAddress !== null && !isTrustedProxy(...)`): unreachable, because line 31 has already returned for a null or untrusted peer, so the condition is always false.
- src/http/trustedClientIp.ts:44, ConditionalExpression (`peerAddress !== null` -> `true`): the peer is always non-null after line 31, so the guard is always true.

## adapters drizzle-shared
- src/drizzle-shared/transactionOutcome.ts:63, EqualityOperator (`timeoutMs < 1` -> `<= 1`): at exactly 1 the mutant returns 1 and the original falls through to `Math.min(Math.floor(1), MAX)` = 1, so the result is identical.
- src/drizzle-shared/idempotency.ts:33, ConditionalExpression->true and three LogicalOperator mutants (8 mutants in total on the `typeof parsed === "object" && parsed !== null && "type" in parsed && "value" in parsed` guard): the guard is only a pre-filter. Whenever a mutant lets a non-object, null or object without type/value through, `"type" in parsed` throws a TypeError (caught by the surrounding try) or `record.type === "number" && isEntityVersion(record.value)` is false, and both paths end in the same corruption error.
- src/drizzle-shared/workflowFailureCodec.ts:11, ConditionalExpression (`value == null` -> `false`): null/undefined then flow to `parsed = value` and are rejected by the `!parsed` guard on line 16, so the result is still null.
- src/drizzle-shared/workflowFailureCodec.ts:14, BlockStatement (`catch { return null }` -> `catch {}`): on invalid JSON `parsed` stays the raw string, which fails the object check on line 16 and returns null, the same result.
- src/drizzle-shared/workflowFailureCodec.ts:16, ConditionalExpression (`typeof parsed !== "object"` -> `false`): non-object truthy primitives reach the field checks, where `record.code` is not a string, so null is returned anyway.
- src/drizzle-shared/workflowFailureCodec.ts:20, ConditionalExpression (`typeof record.attempt !== "number"` -> `false`): redundant with `!Number.isSafeInteger(record.attempt)`, which is true for every non-number.
- src/drizzle-shared/predicateCompiler.ts:109, ConditionalExpression (`sqlType === undefined` -> `false`): the regexes then run on the string "undefined", which matches no temporal type, so the result is still undefined.
- src/drizzle-shared/predicateCompiler.ts:131, StringLiteral (`sqlType ?? ""` in the NUMERIC test): neither "" nor any other non-numeric text matches NUMERIC_SQL_TYPE, so the branch is the same.
- src/drizzle-shared/predicateCompiler.ts:169, ConditionalExpression (the `hour > 23` clause of the time-field check -> `false`): hour 24 rolls the local date to the next day, which the `getUTCDate() !== day` check on line 174 rejects anyway.
- src/drizzle-shared/predicateCompiler.ts:179, StringLiteral (`"native"` -> `""`): callers only compare the result with `undefined` and `BELOW_RANGE`, so any other string behaves the same.
- src/drizzle-shared/predicateCompiler.ts:326, OptionalChaining (`enumValues?.includes`): classify() always sets `enumValues` to an array for the enum class, so the optional chain never short-circuits.
- src/drizzle-shared/predicateCompiler.ts:337, ConditionalExpression (`typeof value === "string"` -> `true`): the only other value kinds reaching it (numbers, booleans) make parseRfc3339Timestamp return null, and line 343 then returns INCOMPARABLE exactly as the `else` branch does.
- src/drizzle-shared/predicateCompiler.ts:345, ConditionalExpression (`(postgres || mysql) && !hydratesDate` -> `true`): on sqlite/generic the only reachable inner branch is the time-text one, which yields `Param(value)`, rendering identically to the raw `value` of the fall-through; Date-hydrated columns are covered by the tests and stay INCOMPARABLE.
- src/drizzle-shared/predicateCompiler.ts:438, StringLiteral (`options.dialect ?? "generic"` -> `""`): `dialect` is only ever compared with "sqlite", "mysql" and "postgres", so "" and "generic" behave the same.
- src/drizzle-shared/predicateCompiler.ts:450, ConditionalExpression (`operator === ne` -> `true` in the NOT_A_MEMBER branch): only eq/ne reach NOT_A_MEMBER (ordered comparisons use the text form), so `operator === ne` is already true whenever it is not eq.
- src/drizzle-shared/predicateCompiler.ts:462-463, ConditionalExpression / StringLiteral (`below` and the "infinity" branch): ABOVE_RANGE is only produced by mysqlInstant, so on PostgreSQL `below` is always true and the "infinity" branch is unreachable.
- src/drizzle-shared/predicateCompiler.ts:494 and :498, StringLiteral (`?? sql\`1 = 0\`` fallbacks of `or(...)`/`and(...)`): drizzle's or()/and() return undefined only for an empty list, and both calls pass two conditions.
- src/drizzle-shared/predicateCompiler.ts:531, ConditionalExpression (`disjuncts.length === 1 ? disjuncts[0] : or(...)` -> `false`): drizzle's `or(x)` of a single condition renders exactly `x`.
- src/drizzle-shared/predicateCompiler.ts:533-534, ConditionalExpression (`case "includesAny"` / `case "includesAll"` labels): without the label the operator reaches `default`, which throws the same "Unsupported predicate operator" error.
- src/drizzle-shared/predicateCompiler.ts:542-543, ConditionalExpression / StringLiteral (empty-`clauses` guard and `and(...) ?? sql\`1 = 0\``): `and()` of no clauses is undefined and falls back to the same `1 = 0`; and() of two clauses is never undefined.
- src/drizzle-shared/predicateCompiler.ts:586, 588, 591, 593, ConditionalExpression / StringLiteral (empty and single-child guards of and/or): `and()`/`or()` of nothing falls back to the same `1 = 1` / `1 = 0`, a single child renders identically with or without the explicit parentheses, and the `??` fallbacks are unreachable for two or more children.

## adapters drizzle-pg

### src/drizzle-pg/drizzleIdempotencyStore.ts

- src/drizzle-pg/drizzleIdempotencyStore.ts:15, ConditionalExpression (`property in current` -> `true`): reading a property the object lacks yields `undefined`, which fails the `typeof value === "string"` test exactly as the skipped read does.
- src/drizzle-pg/drizzleIdempotencyStore.ts:19, ConditionalExpression (`"cause" in current` -> `true`): `current.cause` is `undefined` when absent, which ends the walk exactly as the `undefined` branch does.

### src/drizzle-pg/drizzleJobStore.ts

- src/drizzle-pg/drizzleJobStore.ts:41, ConditionalExpression (`!raw` -> `false` in `parseMetadata`): the only caller is `row.metadata ? parseMetadata(row.metadata) : null`, so the guard never sees a falsy value.
- src/drizzle-pg/drizzleJobStore.ts:60, StringLiteral (`includes("\u0000")` -> `includes("")`): `replaceAll("\u0000", ...)` is a no-op for a string without NUL, so the result is identical.
- src/drizzle-pg/drizzleJobStore.ts:140, StringLiteral (`?? "best_effort"` -> `""`): the history mode is only ever compared with `"required"`, so `""` behaves as `"best_effort"`.
- src/drizzle-pg/drizzleJobStore.ts:149-152, all mutators: `partitionKeyColumnName`, `leaseExpiresAtColumnName`, `physicalIdColumn` and `physicalStatusColumn` are assigned in the constructor and never read.
- src/drizzle-pg/drizzleJobStore.ts:231, ConditionalExpression (`tenantFilter`): only called with a non-null tenant id (`requesterFilters` checks `!== null` first), so the `isNull` branch is unreachable and `eq` is used either way.
- src/drizzle-pg/drizzleJobStore.ts:253, CallExpression (`assertJobScopeCanEnqueue`): `encodeJobScope` always returns a consistent scope and tenant id, so the assertion can never fail here.
- src/drizzle-pg/drizzleJobStore.ts:340, ConditionalExpression/EqualityOperator (`requesterScope.length > 0`): `requesterFilters` always returns at least the scope filter, so the guard is always true.
- src/drizzle-pg/drizzleJobStore.ts:347, 362, 370, ArrayDeclaration (the `[]` arm of `scope ? [scope] : []`): `scope` is always defined (see 340), so the empty arm is unreachable.
- src/drizzle-pg/drizzleJobStore.ts:371, ConditionalExpression/EqualityOperator (inner `left.id > right.id ? 1 : 0`): the sort only distinguishes negative from non-negative results, so returning 0 or 1 for equal or greater ids orders identically (verified with shuffled batches of 40 to 300 ids against each mutant).
- src/drizzle-pg/drizzleJobStore.ts:479-480, all mutators (`recordExecution`'s `executionHistory === "required"` branch): required history goes through `atomicTransition`, so `recordExecution` only runs in best-effort mode and the returned `error` is never read.

### src/drizzle-pg/drizzleRepository.ts

- src/drizzle-pg/drizzleRepository.ts:120, ConditionalExpression (`clauses.length === 1` -> `false`): `sql.join` of a single clause renders the same SQL as the clause itself.
- src/drizzle-pg/drizzleRepository.ts:159, 161, 174, 176, ConditionalExpression/EqualityOperator (empty `and`/`or` guards in `isAlwaysTruePredicate`/`isAlwaysFalsePredicate`): `[].every(...)` is `true` and `[].some(...)` is `false`, so the explicit `length` guards and their mutants give the same answer.
- src/drizzle-pg/drizzleRepository.ts:164, 179, ConditionalExpression (removed `default:` clause): the switch then falls off the end and returns `undefined`, which is falsy exactly like the `false` it replaces.
- src/drizzle-pg/drizzleRepository.ts:266, StringLiteral (`kind: "offset"` -> `""`): `resolvePagination` reads only `page` and `pageSize`, never `kind`.
- src/drizzle-pg/drizzleRepository.ts:268, OptionalChaining (`options?.filter` -> `options.filter`): a cursor exists only when `options` does.
- src/drizzle-pg/drizzleRepository.ts:327, LogicalOperator (`options?.optimisticConcurrency && versionField` -> `||`): a versioned entity requires the option and an unversioned one rejects it earlier, so both operands are always equally truthy.
- src/drizzle-pg/drizzleRepository.ts:397, 408, 472, OptionalChaining/ConditionalExpression (`options?.optimisticConcurrency` in the versioned branches): `assertVersionedWriteHasExpectedVersion` has already required the option for a versioned entity, so it is always defined there.
- src/drizzle-pg/drizzleRepository.ts:416, 487, 516, 552, ConditionalExpression/LogicalOperator (explicit rethrow of `OptimisticConcurrencyError`, `NotFoundError`, `ConfigurationError`): the fall-through `rethrowConstraintError` returns a `FrameworkCoreError` unchanged and throws it, so the same error object escapes either way.

### src/drizzle-pg/drizzleWorkflowStore.ts

- src/drizzle-pg/drizzleWorkflowStore.ts:14, ConditionalExpression (`row.outcome == null ? null : row.outcome` -> `false`): for a `null` outcome the unguarded read is also `null`.

### src/drizzle-pg/pgUtils.ts

- src/drizzle-pg/pgUtils.ts:19, ConditionalExpression (`typeof obj.meta === "object"` -> `true`): a truthy non-object `meta` has no `rowCount` or `changes`, so the lookups fall through to the same error.

## adapters drizzle-mysql

- src/drizzle-mysql/drizzlePersistenceProvider.ts:36 and :39, ConditionalExpression (`typeof client !== "object"` / `typeof promiseClient !== "object"` -> `false`): the other operand of each `||` (and the `getConnection` function check on line 39) rejects the same non-object values, so the result is unchanged.
- src/drizzle-mysql/drizzlePersistenceProvider.ts:42, ArrayDeclaration (`[]` -> `["Stryker was here"]`): the single row is then a string with no `connectionId`, which fails with the same `connection_id` error as an empty result.
- src/drizzle-mysql/drizzlePersistenceProvider.ts:43, ConditionalExpression (`typeof parsed !== "number"` -> `false`): `Number.isSafeInteger` is already false for every non-number.
- src/drizzle-mysql/drizzlePersistenceProvider.ts:87, ConditionalExpression (`if (this.finished) return` in `arm` -> `false`): `arm` runs once, before anything can disarm, so `finished` is never true there.
- src/drizzle-mysql/drizzlePersistenceProvider.ts:92, ConditionalExpression (`if (this.finished) return` in `fire` -> `false`): `disarm` clears the timer, so `fire` never runs after `finished`.
- src/drizzle-mysql/drizzlePersistenceProvider.ts:102, ConditionalExpression (`targetId === undefined` -> `false`): the timer is only armed after `connectionId` is set.
- src/drizzle-mysql/drizzlePersistenceProvider.ts:107, ArrowFunction (`() => false` -> `() => undefined`): the value is only tested for truthiness.
- src/drizzle-mysql/drizzlePersistenceProvider.ts:114, ConditionalExpression (`this.timer !== undefined` -> `true`): `clearTimeout(undefined)` is a no-op.
- src/drizzle-mysql/drizzlePersistenceProvider.ts:121, ConditionalExpression (`if (this.killInFlight)` -> `true`): awaiting `undefined` is a no-op.
- src/drizzle-mysql/drizzlePersistenceProvider.ts:168, CallExpression (`guard.disarm()` removed): no await sits between it and `release`, which disarms first thing.
- src/drizzle-mysql/drizzlePersistenceProvider.ts:170, StringLiteral / BooleanLiteral (`transactionTimeoutError("mysql", undefined, true)` arguments): this error is only thrown when `guard.fired` is true, and the outer catch then replaces it with a fresh `transactionTimeoutError`.
- src/drizzle-mysql/drizzleIdempotencyStore.ts:12 and :13, ConditionalExpression (`typeof current === "object" && "cause" in current` -> `true`): reading `.cause` of a non-object or a cause-less object gives `undefined`, which ends the walk the same way.
- src/drizzle-mysql/drizzleIdempotencyStore.ts:17, ConditionalExpression (`row.status === "completed"` -> `true`; `pendingInvalidations !== undefined` -> `true`): `result` is only read for completed rows, and a stringified `undefined` parses to the same empty list.
- src/drizzle-mysql/drizzleIdempotencyStore.ts:23, ConditionalExpression (`row.status === "business-committed"` -> `true`): `resolveExistingIdempotency` only throws for business-committed rows.
- src/drizzle-mysql/mysqlAtomicBackends.ts:8, ConditionalExpression (`value === null` -> `false` in `parsed`): null then falls through and is returned as null anyway.
- src/drizzle-mysql/mysqlAtomicBackends.ts:27 and :28, ConditionalExpression (`database === undefined ? {} : { database }` -> `false`): `{ database: undefined }` qualifies the table exactly like `{}`.
- src/drizzle-mysql/mysqlPredicate.ts:48, OptionalChaining (`row?.summer` -> `row.summer`): only evaluated when `row?.winter` already matched, so `row` is defined.
- src/drizzle-mysql/mysqlUtils.ts:2, ConditionalExpression (`typeof value !== "object"` -> `false`): a non-object has no `affectedRows` or `rowsAffected`, so the result is 0 either way.
- src/drizzle-mysql/mysqlUtils.ts:9, ConditionalExpression (`typeof timeoutMs !== "number"` -> `false`): `Number.isSafeInteger` already rejects every non-number.
- src/drizzle-mysql/mysqlIdentifiers.ts:38, ConditionalExpression (`overrides === null` -> `false`): `options?.tables ?? {}` can never yield null.
- src/drizzle-mysql/drizzleJobStore.ts:48, CallExpression (`assertJobScopeCanEnqueue(scope,tenantId)` removed in `enqueue`): `encodeJobScope` always returns a consistent scope and tenant id, so the assertion can never fail here (same as drizzle-pg `drizzleJobStore.ts:253`).
- src/drizzle-mysql/drizzleRepository.ts:50, StringLiteral / ConditionalExpression (`updateManyWhere` versioned-entity guard): unreachable, because the method is deleted from versioned repositories.

## adapters drizzle-d1

### src/drizzle-d1/drizzleJobStore.ts

- src/drizzle-d1/drizzleJobStore.ts:41, ConditionalExpression: `parseMetadata` is only called for a truthy `row.metadata`, so the `!raw` guard is never taken.
- src/drizzle-d1/drizzleJobStore.ts:121, StringLiteral: only `executionHistory === "required"` is ever compared, so the `"best_effort"` default and `""` behave the same.
- src/drizzle-d1/drizzleJobStore.ts:176, ConditionalExpression: `tenantFilter(null)` is unreachable, because `requesterFilters` only calls it for tenant requesters (tenant id not null).
- src/drizzle-d1/drizzleJobStore.ts:198, CallExpression: `assertJobScopeCanEnqueue` is redundant after `encodeJobScope`, which always yields a consistent scope and tenant id.
- src/drizzle-d1/drizzleJobStore.ts:306, ConditionalExpression/EqualityOperator: `requesterFilters` always returns the scope filter, so its length is never 0.
- src/drizzle-d1/drizzleJobStore.ts:314, 327, 336, ArrayDeclaration: the `[]` branch of `scope ? [scope] : []` is unreachable (see line 306).
- src/drizzle-d1/drizzleJobStore.ts:320, LogicalOperator: `nextAttemptAt` and `runAt` are both timestamp columns with the same driver encoding, so `a ?? b` and `a && b` encode `now` identically.
- src/drizzle-d1/drizzleJobStore.ts:469, all mutators: `recordExecution` is only called from the best-effort branches, so the `required` branch of its catch is unreachable.

### src/drizzle-d1/drizzleRepository.ts

- src/drizzle-d1/drizzleRepository.ts:107, ConditionalExpression: `sql.join([single], ", ")` renders exactly like the single order-by clause.
- src/drizzle-d1/drizzleRepository.ts:127, 129, 142, 144, ConditionalExpression/EqualityOperator: the empty-array shortcuts equal `[].every(...)` (true) and `[].some(...)` (false), so they never change the result.
- src/drizzle-d1/drizzleRepository.ts:132, 147, ConditionalExpression (`default:` removed): the missing default returns `undefined` instead of `false`; every caller only tests truthiness.
- src/drizzle-d1/drizzleRepository.ts:205, LogicalOperator: `constraintMap` is only handed to `rethrowConstraintError`, which discards it (`void constraintMap`).
- src/drizzle-d1/drizzleRepository.ts:421, ConditionalExpression: `delete repository.updateManyWhere` removes a property that the repository literal never defines.
- src/drizzle-d1/drizzleRepository.ts:455, ConditionalExpression/OptionalChaining: for a versioned entity `requireOptimisticConcurrencyVersion` has already required `optimisticConcurrency`, so the guard is always true and `options` is defined.
- src/drizzle-d1/drizzleRepository.ts:471, ConditionalExpression: `rethrowNormalizedDrizzleError` passes a `FrameworkCoreError` through unchanged, so the explicit `OptimisticConcurrencyError` rethrow is redundant.

### src/drizzle-d1/drizzlePersistenceProvider.ts

- src/drizzle-d1/drizzlePersistenceProvider.ts:57, MethodExpression (`.trim()` removed): the trigger text is only searched with `includes`, so surrounding whitespace is irrelevant.
- src/drizzle-d1/drizzlePersistenceProvider.ts:214, ConditionalExpression (`command.expectedVersion !== undefined` -> `true`): a versioned command without `expectedVersion` is rejected before encoding, so the operand is always true here.
- src/drizzle-d1/drizzlePersistenceProvider.ts:218, ConditionalExpression (`typeof command === "object"` -> `true`): a non-object has no `kind === "statement"`, so the result is the same.
- src/drizzle-d1/drizzlePersistenceProvider.ts:239, 240, ArrayDeclaration: the `[]` branches gain a placeholder field name that no command value ever carries.
- src/drizzle-d1/drizzlePersistenceProvider.ts:243, ConditionalExpression: adding `undefined` to the protected-field set is harmless, because provided field names are always strings.
- src/drizzle-d1/drizzlePersistenceProvider.ts:450, ConditionalExpression: `capabilities.maxPageSize` is always defined (it defaults to 100).
- src/drizzle-d1/drizzlePersistenceProvider.ts:451, all mutators: the repository's `constraintMap` is discarded by `rethrowConstraintError` (see drizzleRepository.ts:205).
- src/drizzle-d1/drizzlePersistenceProvider.ts:470-474, all mutators: `verifyIdempotencyFence` only runs for an idempotency item, and the check at line 624 has already required both tables.
- src/drizzle-d1/drizzlePersistenceProvider.ts:481, ConditionalExpression: the identity check in the failure handler is always true; a newer verification cannot start before the failed one is cleared.
- src/drizzle-d1/drizzlePersistenceProvider.ts:497, CallExpression: the `validateD1AtomicOutboxColumns` call is repeated on the next statement, which throws the same errors.
- src/drizzle-d1/drizzlePersistenceProvider.ts:508, CallExpression: `assertOutboxScope` is repeated inside `fingerprintOutboxRecord`, which runs on the next statement.
- src/drizzle-d1/drizzlePersistenceProvider.ts:671-672, 676, all mutators: the second outbox table/mapper check and the missing-fingerprint check are unreachable, because the first check at line 495 and the fingerprint pass already guarantee both.
- src/drizzle-d1/drizzlePersistenceProvider.ts:709, 713, ConditionalExpression/EqualityOperator: either empty-plan guard alone returns `[]`, and `[first, ...rest]` equals `[first]` when `rest` is empty.
- src/drizzle-d1/drizzlePersistenceProvider.ts:727, 759, ArrayDeclaration: the placeholder message or column name never appears in a provider message, and classification only uses `some`.
- src/drizzle-d1/drizzlePersistenceProvider.ts:740, ConditionalExpression: `receiptResult === undefined` is redundant, because `getAffectedRows(undefined)` is 0 and fails the next comparison.
- src/drizzle-d1/drizzlePersistenceProvider.ts:761, ConditionalExpression (`typeof current === "object"` -> `true`): a primitive cause has neither `message` nor `cause`, so the walk ends the same way.
- src/drizzle-d1/drizzlePersistenceProvider.ts:771, MethodExpression/OptionalChaining: `createMutationAssertion` already rejects a table without both columns, so the name filter and `?.` are never exercised.
- src/drizzle-d1/drizzlePersistenceProvider.ts:785, ConditionalExpression: `normalizeDrizzleError` returns a `FrameworkCoreError` unchanged, so the early return is redundant.
- src/drizzle-d1/drizzlePersistenceProvider.ts:787, ConditionalExpression/EqualityOperator: `some` over an empty column list is false, so the length guard is redundant.

### Other files

- src/drizzle-d1/d1OutboxSchema.ts:14, ConditionalExpression/LogicalOperator (7 mutants): for column objects the `typeof`, `!== null` and `"name" in` operands are always true and identical objects share a name, so every variant of `sameColumn` gives the same answer; a differing column name is covered by tests.
- src/drizzle-d1/d1BatchLimits.ts:17, CallExpression: `Object.setPrototypeOf` is redundant for a native `class extends Error` (ES2022 target).
- src/drizzle-d1/d1BatchLimits.ts:44, BlockStatement: with the catch body emptied, `query` stays undefined and the next check throws the identical "could not inspect" error.
- src/drizzle-d1/d1Session.ts:59, ConditionalExpression/EqualityOperator: `db.select(undefined)` selects all columns exactly like `db.select()`.
- src/drizzle-d1/d1Utils.ts:23, ConditionalExpression: a truthy primitive passes the guard and falls through every `typeof` check to 0.
- src/drizzle-d1/d1Utils.ts:32, ConditionalExpression: a non-object `meta` has no numeric `changes`, so the result is 0 either way.
- src/drizzle-d1/d1Utils.ts:54, BlockStatement: an emptied catch returns `undefined` instead of `false`; the caller negates it, so both mean "not self-mapping".
- src/drizzle-d1/d1AtomicLeaseBackend.ts:51, OptionalChaining: a missing row throws a TypeError on `row!.now_ms` in the next expression either way.
- src/drizzle-d1/drizzleOutboxSink.ts:35, CallExpression: `assertOutboxScope` is repeated inside `fingerprintOutboxRecord` two statements later.
- src/drizzle-d1/drizzleWorkflowStore.ts:13, ConditionalExpression/BlockStatement: a null row throws inside the `try` and is caught, and an emptied catch leaves `payload` undefined, which the next guard turns into `null` as well.

## adapters cache

### src/cache/kvCacheAdapter.ts

- src/cache/kvCacheAdapter.ts:53, ConditionalExpression (`current !== undefined` -> `true`): `current === undefined` with a defined `legacy` can never satisfy `current === legacy`, and both undefined returns earlier.
- src/cache/kvCacheAdapter.ts:57, Regex (`/=+$/` -> `/=+/` or `/=$/`): a base64 SHA-256 digest has exactly one `=`, always at the end.
- src/cache/kvCacheAdapter.ts:77, ConditionalExpression/LogicalOperator in `isEnvelope`: the final `=== 1` marker check already rejects strings, numbers, booleans, arrays and `null` (which never reaches it), so each earlier clause is redundant.
- src/cache/kvCacheAdapter.ts:141, ConditionalExpression (`stored.e !== undefined` -> `true`): `undefined <= Date.now()` is `false`, so the result is identical.
- src/cache/kvCacheAdapter.ts:282, ConditionalExpression: adopting a legacy counter when `current` is already set or `legacy` is undefined re-reads the current key and returns the same value.
- src/cache/kvCacheAdapter.ts:307, BlockStatement (`catch { return undefined }` -> `catch {}`): a function that falls off the end of the catch also returns `undefined`.

### src/cache/cacheValueCodec.ts

- src/cache/cacheValueCodec.ts:28, ConditionalExpression (`case "undefined"` removed): the `undefined` value is then returned as is, and every caller already maps it with `?? null` or drops it.
- src/cache/cacheValueCodec.ts:53, 56, 59, BooleanLiteral (`inArray` `true` -> `false`): array, Map and Set callers coalesce an `undefined` result with `?? null`, so the flag changes nothing.
- src/cache/cacheValueCodec.ts:82, ConditionalExpression (`Object.hasOwn(record, TAG)` -> `true`): an untagged record has no matching switch case and falls through to `decodePlain` anyway.
- src/cache/cacheValueCodec.ts:115, ConditionalExpression (`typeof ttlMs !== "number"` -> `false`): `Number.isSafeInteger` already rejects every non-number.

### src/cache/inMemoryCacheAdapter.ts

- src/cache/inMemoryCacheAdapter.ts:55, ConditionalExpression/OptionalChaining in `isExpired`: a record without `expiresAt` compares `undefined <= now`, which is `false`, and `isExpired` is never called with `undefined`.
- src/cache/inMemoryCacheAdapter.ts:66, ConditionalExpression (`if (!members) continue`): every tag membership is pruned from `keyTags` and `tags` together, so the tag set always exists.
- src/cache/inMemoryCacheAdapter.ts:77, ConditionalExpression/BlockStatement (empty-store early return in `sweep`): on an empty map the loop hits `done` twice and resets the cursor itself.
- src/cache/inMemoryCacheAdapter.ts:88, 89, ConditionalExpression/BooleanLiteral (`wrapped` early exit in `sweep`): the early exit only saves re-inspecting entries, which removes the same expired set.
- src/cache/inMemoryCacheAdapter.ts:98, ConditionalExpression (`if (!record) return undefined`): the following `isExpired(undefined)` is `false`, so `undefined` is returned either way.
- src/cache/inMemoryCacheAdapter.ts:125, UpdateOperator (`++this.nextRevision` -> `--`): revisions are only compared for equality, and decrementing still yields unique values.
- src/cache/inMemoryCacheAdapter.ts:126, ConditionalExpression (`ttlMs !== undefined` -> `true`): without a ttl `expiresAt` becomes `NaN`, and `NaN <= now` is `false`, so the entry never expires.
- src/cache/inMemoryCacheAdapter.ts:131, ConditionalExpression (`if (oldest.done) break`): the loop only runs while `size >= maxEntries > 0`, so the map is never empty there.
- src/cache/inMemoryCacheAdapter.ts:137, 158, CallExpression (`revisions.set` / `revisions.clear`): the `revisions` map is write-only; no code reads it.
- src/cache/inMemoryCacheAdapter.ts:183, ArrayDeclaration (`?? []` -> `["Stryker was here"]`): the placeholder key is not live, so the trailing `filter` removes it.
- src/cache/inMemoryCacheAdapter.ts:193, 194, OptionalChaining in `deleteTag`: every tagged key is present in `keyTags` and `values`, because `removeKey` prunes tag membership together with the value.
- src/cache/inMemoryCacheAdapter.ts:207, StringLiteral (`?? "0"` -> `?? ""`): `Number("")` is `0`, the same as `Number("0")`.

### src/cache/inMemoryRateLimitStore.ts

- src/cache/inMemoryRateLimitStore.ts:41, ConditionalExpression/EqualityOperator (`this.buckets.size > 0` -> `true` / `>= 0`): on an empty map the loop only hits `done` twice and returns.
- src/cache/inMemoryRateLimitStore.ts:46, 47, ConditionalExpression/BooleanLiteral (`wrapped` early exit in `sweep`): the early exit only saves re-inspecting entries, which removes the same expired set.

## adapters server

- src/server/authorizedRepository.ts:52, ConditionalExpression (`field !== FIELD_READ_DEFAULT_KEY` -> `true`): for the `*` key both branches evaluate `plan["*"] === "allow"`.
- src/server/authorizedRepository.ts:282, ConditionalExpression (`if (versionField)` -> `true`): `versionField` was already proven truthy at line 236, so the guard is always taken.
- src/server/authorizedRepository.ts:288, StringLiteral (`"read"` in the no-versionField fallback filter): unreachable, `versionField` is always set here.
- src/server/idempotencyFinalizer.ts:4, ConditionalExpression (`if (value)` -> `true`): `emitTelemetry` itself returns immediately for an undefined port.
- src/server/idempotencyFinalizer.ts:12, ConditionalExpression (`if (timer) clearInterval(timer)` in `stop` -> `true`): `clearInterval(undefined)` is a no-op.
- src/server/persistenceRouter.ts:12, ConditionalExpression (`if (!scope) return undefined` -> `false`): `encodeExecutionScopeId(undefined)` throws and the catch returns `undefined`, the same result.
- src/server/persistenceRouter.ts:15, BlockStatement (empty `catch` body): falling out of the catch also returns `undefined`.
