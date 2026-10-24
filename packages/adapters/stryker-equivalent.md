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
