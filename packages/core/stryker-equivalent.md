# Stryker equivalent and unreachable mutants

Mutants listed here are not killable by any test because the branch is unreachable after
`validateOperationDefinition`. One line per location: file:line, mutators, reason.

- src/operation/atomicBatchOperationPipeline.ts:54-56, ConditionalExpression/LogicalOperator/StringLiteral: `atomicBatchScope === "tenant-scoped"` with no tenant-scoped contract is rejected earlier by `supportsAtomicBatch`, so the throw is dead.
- src/operation/standardOperationPipeline.ts:222, ConditionalExpression/LogicalOperator/StringLiteral: `required: true` with best-effort delivery is rejected by `validateOperationDefinition` before preflight.
- src/operation/standardOperationPipeline.ts:224, ConditionalExpression/LogicalOperator/StringLiteral: a transactional (atomic) audit with non-required atomicity is rejected by `validateOperationDefinition`.
- src/operation/standardOperationPipeline.ts:95-97, ConditionalExpression/LogicalOperator/StringLiteral: mutations require required atomicity, so a run outside a transaction cannot register durable outbox records.

## core `domain`

Module-load constants (static mutants): the vitest runner does not re-evaluate module initialisers per mutant, so these report Survived although the values are asserted exactly by tests (e.g. `errorsOutcomes.test.ts`, `principalMutationKills.test.ts`).

- src/domain/errors.ts:34-55, ObjectLiteral/StringLiteral/BooleanLiteral: `internalConfiguration`, `internalState` and `ERROR_DEFAULTS` are module-load initialisers (static mutants).
- src/domain/errors.ts:215-219, Regex/ArrayDeclaration/StringLiteral: `PUBLIC_CODE_PATTERN`, `TRANSPORT_RESERVED_PUBLIC_CODES` and `CONTROL_CHARACTERS` are module-load initialisers (static mutants).
- src/domain/principal.ts:24, Regex: `RFC3339_UTC` is a module-load initialiser (static mutant).
- src/domain/requestContext.ts (static initialisers), src/domain/errors.ts:91, BooleanLiteral: same reason, static mutants.

Redundant layers (either check alone yields the same observable result):

- src/domain/principal.ts:36-37 and 43-52, ConditionalExpression/LogicalOperator/StringLiteral: the field range pre-check and the UTC round-trip comparison reject the same inputs (an out-of-range month, day, hour, minute or second always changes a round-tripped field); the milliseconds string is never compared.
- src/domain/evaluatePredicate.ts:55,60-62, ConditionalExpression/StringLiteral: `"0"` defaults for absent clock fields equal `""` after `Number()`, the calendar round-trip makes the individual year/month/day checks redundant, and `Date.parse` of a bare full-date equals UTC midnight.
- src/domain/evaluatePredicate.ts:34,36,94-95, StringLiteral/ConditionalExpression/EqualityOperator: booleans compare identically as booleans or as `Number()` (`false < true`), so the boolean-to-number conversion and the primitive `kind` labels cannot change a result.
- src/domain/evaluatePredicate.ts:77,78,80, EqualityOperator/ConditionalExpression: unequal code points (`a !== b`) and unequal lengths are already excluded by the guards, and skipping the low surrogate of an astral character cannot change the first differing position.
- src/domain/evaluatePredicate.ts:109, ConditionalExpression/LogicalOperator: a non-object, array or `Date` range operand has neither `from` nor `to`, so the guard and the `from`/`to` emptiness check both return false.
- src/domain/evaluatePredicate.ts:119,143,191,202,237,183, ConditionalExpression: the early returns after a TRUE (`or`/membership/`includesAny`), FALSE (`and`/`includesAll`) outcome are short-circuit optimisations; continuing yields the same Kleene result (`or(true, x)` is true, `and(false, x)` is false) and a skipped sibling is depth-checked either way.
- src/domain/evaluatePredicate.ts:273, ConditionalExpression: a node with a non-array `filters` is never reachable after validation of the tree shape.
- src/domain/authority.ts:100, LogicalOperator/ConditionalExpression: `scopeId` equality and `executionScopesEqual` agree for every target that passed `assertTarget` (the id is the canonical encoding of the scope).
- src/domain/authority.ts:104-107, ConditionalExpression/LogicalOperator: `originsEqual` branches are only reached with matching kinds after the kind guard, so the per-kind conjuncts are redundant.
- src/domain/authority.ts:157, 196, 242, 300, ConditionalExpression/LogicalOperator/MethodExpression: `Date.parse(undefined)` is NaN, which compares false in every ordering test; a blank resource id is never in a validated permitted list, so the blank check never changes the forbidden outcome.
- src/domain/authority.ts:238,291, StringLiteral: the field label of `assertAuthorityOrigin` for a delegation source is shadowed by the identical grant-source check that runs first for the single permitted hop (first hop source must equal the grant source).
- src/domain/authority.ts:244,248-249,303-304, all mutators: `preceding` is always undefined inside the loop because the maximum delegation depth of one is enforced before it, so the discontinuity branch is unreachable.
- src/domain/executionScope.ts:69-70, all mutators: `CANONICAL_JSON_LIMITS_V1.maxUtf8Bytes` (16 MiB) is larger than the identity-source limit (4 KiB) checked just above, so the absolute-ceiling branch is unreachable.
- src/domain/abacPolicySchema.ts:170-171,319-320, all mutators: `clonePolicyInput` enforces the same depth, node and array limits as `policyInputWithinBudget`, so the second check never fails for cloned data.
- src/domain/coercePolicyValue.ts:67-68, StringLiteral: the `case "identifier"`/`case "string"` labels fall through to `default`, which has the same body.

## core execution

- src/execution/dispatcher.ts:38, ConditionalExpression/EqualityOperator: a UTF-8 encoded message always has a lead byte at index 0, so `cut > 0` never decides the loop.
- src/execution/dispatcher.ts:103-115 (abortableSleep), all mutators: the signal handed to the system clock is never aborted before the sleep starts (`stopped` is set first), and a late abort only clears or resolves an already-settled wait; `signal?.` is always defined, `once` is irrelevant after the timer fired.
- src/execution/dispatcher.ts:151,567,572,570,367, EqualityOperator/ConditionalExpression/BooleanLiteral: a `retryable` kind falls through to the same default; versions of one type are unique so `>=` equals `>`; an exact definition decodes identically through the registry.
- src/execution/dispatcher.ts:171,188,501,546,553,499, ConditionalExpression: timer handles and the settled execution promise are always defined at these points; awaiting an undefined renewal only adds a microtask.
- src/execution/dispatcher.ts:397,400,414-416,474,541,691, ConditionalExpression/OptionalChaining/BooleanLiteral: idempotent repeat of an abort/reject, callbacks assigned synchronously, and `stopped` is set again by the finally block.
- src/execution/dispatcher.ts:518,585,587,667,701,273, StringLiteral/ArrowFunction/ConditionalExpression: a permanent failure dead-letters for any non-retryable kind and ignores `now`; a null marker and a regex on "null" agree; `since === now` yields the same instant; an undefined timeoutMs fails the timer check identically; the retry time is never null after `shouldRetry`; the invalid-clock message is swallowed.
- src/execution/dispatcher.ts, OptionalChaining on `log.warn?.`/`log.debug?.`: the telemetry logger always defines every level.
