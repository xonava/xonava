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

## core entity

Module-load initialisers (static mutants): the vitest runner does not re-evaluate module initialisers per mutant, so these report Survived although tests assert the values exactly (`validateEntityMutationKills`, `defineEntityMutationKills`, `entityHelpersMutationKills`, `compileEntityMutationKills`).

- src/entity/validateEntity.ts:10-14, ArrayDeclaration/StringLiteral: `ENTITY_QUERY_LIMIT_KEYS` (every default and the three extra limit keys are accepted by tests).
- src/entity/validateEntity.ts:278-284, ArrayDeclaration/StringLiteral/ObjectLiteral: `ALLOWED_CRUD_ROUTES` and `CRUD_HOOK_ALLOWLIST` (every hook on every route is accepted, every foreign hook rejected with the exact message).
- src/entity/compileEntity.ts:93, ArrowFunction: the `routesFor` initialiser; compileEntity.ts:133, ObjectLiteral: `AUDIT_CLASSIFICATION_RANK`.
- src/entity/defineEntity.ts:292,328,330, ArrayDeclaration/StringLiteral: `DEFAULT_AUDIT_EMIT_ON`, `ENTITY_CACHE_NAMESPACE_PREFIX` and `TENANT_CACHE_TAG_PREFIX` (default tags, emit list and the reserved-prefix error are asserted).
- src/entity/capabilityCheck.ts:27, Regex: `CAPABILITY_KEY_PATTERN` (valid and invalid keys, including anchors and the character classes, are asserted).

Redundant or unreachable code:

- src/entity/validateEntity.ts:50, ConditionalExpression/ArrayDeclaration: a non-object `fields` is rejected by the "must declare fields" check before `fieldNames` is read.
- src/entity/validateEntity.ts:93,100, ConditionalExpression: `Set.has` of a non-string is false, so the `typeof` pre-check rejects the same values.
- src/entity/validateEntity.ts:123,142,190, OptionalChaining: `requireField` already proved the field exists, so its descriptor is defined.
- src/entity/validateEntity.ts:158, CallExpression: `resolveCapabilityKey` repeats `assertCapabilityConfigValid` immediately after.
- src/entity/validateEntity.ts:160, ConditionalExpression/LogicalOperator: a skipped capability resolves to `{ enabled: false }`, an enabled one always has a key, and `isRuntimeCapability(undefined)` is false.
- src/entity/validateEntity.ts:231-233, ConditionalExpression/LogicalOperator/BooleanLiteral/StringLiteral/BlockStatement: unreachable, `requireField(input.entity.primaryKey, ...)` already rejected a missing primary key.
- src/entity/validateEntity.ts:243, ConditionalExpression/BooleanLiteral: for `audit === false` the expression `false?.fieldClassification ?? {}` is `{}` as well.
- src/entity/validateEntity.ts:316, ArrayDeclaration: the route is always a key of `CRUD_HOOK_ALLOWLIST` here.
- src/entity/compileEntity.ts:41, ConditionalExpression/LogicalOperator: `WeakSet.has` of a non-object is false, so the guards are redundant.
- src/entity/compileEntity.ts:94, ConditionalExpression/OptionalChaining: `route` is never undefined and `defineEntity` always normalises `routes`.
- src/entity/compileEntity.ts:103-105,109, ConditionalExpression/LogicalOperator/BooleanLiteral: `defineEntity` normalises `cache` and `audit` to `false` or an object, so the `undefined` branches are unreachable and `false.auditGuarantee` is undefined.
- src/entity/compileEntity.ts:140, EqualityOperator: equal ranks mean the same classification, so reassigning it changes nothing.
- src/entity/compileEntity.ts:173,214,216, ConditionalExpression/BooleanLiteral: reading a property of `false` is undefined, which takes the same default as the disabled branch.
- src/entity/compileEntity.ts:177, ObjectLiteral: `compileEntityScope` falls back to the tenant field passed as its second argument.
- src/entity/compileEntity.ts:198, BooleanLiteral: `Object.defineProperty` at line 222 redefines the brand with `value: true`.
- src/entity/defineEntity.ts:351, ConditionalExpression/StringLiteral: `validateEntity` rejects `idempotency.required` with the same message; the idempotency object is kept as is.
- src/entity/defineEntity.ts:362,367, ConditionalExpression/ObjectLiteral: `...input.entity` already carries `primaryKey` and `immutableFields`, and `compileEntity` rebuilds the immutable list.
- src/entity/defineEntity.ts:376-388, OptionalChaining: `input.audit` and `input.cache` are objects inside these branches.
- src/entity/defineEntity.ts:390, ConditionalExpression/BooleanLiteral: `cloneAndFreezeDefinition(false ?? {})` is `false`.
- src/entity/defineEntity.ts:408, ObjectLiteral/BooleanLiteral: the brand on `normalized` is replaced by the one `compileEntity` puts on the compiled copy.
- src/entity/queryableFields.ts:8, ConditionalExpression: `Object.entries` of a non-object value is empty.
- src/entity/brands.ts:5, ConditionalExpression: `WeakSet.has(null)` is false.
- src/entity/cachePrefixes.ts:30, ArrayDeclaration: a stray string element destructures to `undefined`/`undefined`, which never collides.

## core events

- src/events/durability/deliveryRunner.ts:54, OptionalChaining: the abort listener only fires when `parent` is defined, so `parent.reason` equals `parent?.reason`.
- src/events/durability/deliveryRunner.ts:57, LogicalOperator: a pre-aborted parent never reaches the work and the abort reason is only mapped to `cancelled`, so `&& new CancelledError()` is not observable.
- src/events/durability/deliveryRunner.ts:60, CallExpression: dropping `reject(error)` changes nothing because the abort listener on the next line rejects with the same `TimeoutError`.
- src/events/durability/deliveryRunner.ts:69, ConditionalExpression: `timer` is always assigned synchronously by the Promise executor, so the guard is always true.
- src/events/durability/deliveryRunner.ts:156, BlockStatement: `delay` is declared as `undefined`, so an empty catch block leaves the same value.
- src/events/eventEnvelope.ts:51, OptionalChaining: `assertDurableAuthorityProvenance` rejects a provenance without target before this line.
- src/events/eventEnvelope.ts:52, ConditionalExpression/LogicalOperator: `assertDurableAuthorityProvenance` already guarantees the target scope matches its scopeId, so the three terms cannot disagree independently.
- src/events/durability/delivery.ts:120,123,125, ConditionalExpression/StringLiteral: `stableJsonForm` only builds a comparison key for two payloads through the same function, so a changed bracket, brace or separator string, or treating an array like an object, maps both sides identically.
- src/events/durability/delivery.ts:126,133, ConditionalExpression/StringLiteral: `String(number)` equals `JSON.stringify(number)` for JSON-normalised numbers, and the `?? "null"` fallbacks are unreachable after the JSON round trip.
- src/events/durability/auditRedaction.ts, all mutants: excluded from mutation runs because its linear-time tests time out under Stryker.

## core security

- src/security/authorizedExecutionPlan.ts:30, ConditionalExpression/LogicalOperator: `WeakSet.has` returns false for `null` and primitives, so the `typeof`/`null` guards in `isAuthorizedExecutionPlan` cannot change the result.
- src/security/authorizedExecutionPlan.ts:50, ConditionalExpression/LogicalOperator: `Object.isFrozen` is true for primitives and `null`, and re-freezing or re-walking an already frozen object has no effect, so every reordered guard in `deepFreeze` is equivalent.
- src/security/authorizedExecutionPlan.ts:73, ConditionalExpression: `cloneAndFreezeDefinition` rejects any object deeper than 64 levels before the snapshot runs, so the snapshot `depth` operand is never the only reason to throw (the node-count and the `>=` boundary operands are killed).
- src/security/authorizedExecutionPlan.ts:85,87, BooleanLiteral: `Object.freeze(copy)` makes every own property non-configurable and non-writable anyway, so the `configurable`/`writable` flags of the Date mutator guards are redundant (`enumerable` is asserted).
- src/security/authorizedExecutionPlan.ts:105,113, ArithmeticOperator: the snapshot depth limit is unreachable (see line 73), so `depth + 1` and `depth - 1` behave identically.
- src/security/authorizedExecutionPlan.ts:129, OptionalChaining: `plan.identity?.actor` has already thrown for a missing identity, so `identity?.subject` is never evaluated on an undefined identity.
- src/security/authorizedExecutionPlan.ts:144, ConditionalExpression/StringLiteral/BlockStatement/ArrowFunction: the "no revalidation strategy" check is a second copy of the check in `assertDynamicFactEvidence` (line 191), which always throws first with the same message; the two copies cover each other.
- src/security/authorizedExecutionPlan.ts:186,191, ConditionalExpression/StringLiteral: `typeof fact !== "object"` and the line 191 mutation check are covered by the next conjunct and by the copy on line 144 (same message), so neither changes an outcome.
- src/security/scopeResolver.ts:43, ConditionalExpression/LogicalOperator: `WeakSet.has` returns false for `null` and primitives, so the guards in `isVerifiedScopeResolution` cannot change the result.

## core serialization

Module-load constants (static mutants): the vitest runner does not re-evaluate module initialisers per mutant, so these report Survived although tests kill them when the mutation is applied by hand (each replacement was applied to the source and the named tests failed).

- src/serialization/fingerprint.ts:20, Regex (10 mutants): `DOMAIN_SEPARATOR` is a module-load initialiser (static); every variant is killed by `fingerprintMutationKills.test.ts` ("rejects malformed separators", "accepts well-formed separators") when applied by hand.
- src/serialization/formatEnvelope.ts:25, Regex (2 mutants): `FORMAT_ID_PATTERN` is a module-load initialiser (static); killed by `formatEnvelopeMutationKills.test.ts` ("isValidFormatId") when applied by hand.
- src/serialization/sha256.ts:7,12, ArrayDeclaration: `INITIAL_HASH` and `ROUND_CONSTANTS` are module-load initialisers (static); emptying either breaks every digest in `sha256.test.ts` and `smallFilesMutationKills.test.ts` when applied by hand.

Unreachable or redundant (the observable result is identical):

- src/serialization/fingerprint.ts:39-40, BlockStatement/ConditionalExpression/EqualityOperator/StringLiteral/ObjectLiteral: the per-format limit (at most 1 MiB) is always below `maxUtf8Bytes` (16 MiB) and is checked first, so the second ceiling check can never fire.
- src/serialization/hmac.ts:11, EqualityOperator: `index <= BLOCK_SIZE` only writes `inner[64]`/`outer[64]`, which the following `set` calls overwrite (or a zero-length message leaves out of bounds, where typed arrays ignore the write).
- src/serialization/sha256.ts:35, ArithmeticOperator/BooleanLiteral: the high word of the bit length is 0 for every input below 512 MiB (`x * 2**32` wraps to 0 in `setUint32`, and the byte order of a zero word is irrelevant); testing it needs a 512 MiB input.
- src/serialization/sha256.ts:45, EqualityOperator: `index <= 64` writes `words[64]`, an out-of-bounds typed-array write that is ignored, and nothing reads it.
- src/serialization/version.ts:6, ConditionalExpression: `Number.isSafeInteger` is already false for every non-number, so the `typeof value === "number"` guard is redundant.
- src/serialization/formatEnvelope.ts:35, ConditionalExpression: `format.length === 0` is redundant, the pattern requires one character.
- src/serialization/formatEnvelope.ts:117,122, ConditionalExpression: the `typeof` guards are redundant, `isValidFormatId` and `isValidVersion` already return false for non-strings and non-numbers.
- src/serialization/formatRegistry.ts:137, StringLiteral: every compiled format has the single readable version `[1]`, so the `", "` join separator cannot be observed.
- src/serialization/versionedCodec.ts:138,152,162,173, ConditionalExpression: `limit !== undefined` forced to true leaves `bytes > undefined`, which is false, so formats without a default limit behave the same.
- src/serialization/canonicalJson.ts:26, EqualityOperator: `i <= s.length` reads `charCodeAt(length)`, which is NaN and matches no surrogate range.
- src/serialization/canonicalJson.ts:41, EqualityOperator/ConditionalExpression: `compareByte` is only called for distinct keys and `Array.prototype.sort` only needs the sign test `< 0`, so `<=`/`>=` and a comparator that returns 0 instead of 1 sort identically.
- src/serialization/canonicalJson.ts:57, ConditionalExpression: an empty input falls through to the loop and returns `""` anyway.
- src/serialization/canonicalJson.ts:86,102, ConditionalExpression: the empty string and an already padded input decode to the same bytes without the early return or the `=` padding.
- src/serialization/canonicalJson.ts:105,106,123,124, UnaryOperator/EqualityOperator/ConditionalExpression/LogicalOperator/BlockStatement/StringLiteral: the character-set check on line 87 admits only alphabet characters, so the `-1` lookup entries (and the error for them) are never used.
- src/serialization/canonicalJson.ts:127-129, ConditionalExpression/EqualityOperator: `out <= bytesLen` or an always-true guard only adds out-of-bounds typed-array writes, which are ignored.
- src/serialization/canonicalJson.ts:135, ConditionalExpression: `typeof s !== "string"` is redundant, a non-string either fails the regular expression or fails the final `toISOString() === s` comparison.
- src/serialization/canonicalJson.ts:136, ConditionalExpression/Regex: without the `^`/`$` anchors any input that is not exactly the canonical spelling is still rejected by `new Date(s)` or the final `toISOString() === s` comparison (extended years are covered by the 4 digit pattern and killed).
- src/serialization/canonicalJson.ts:221, ArrayDeclaration: `new Array()` and `new Array(length)` give the same array because every index is assigned.
- src/serialization/canonicalJson.ts:232, ConditionalExpression: after the checks above only objects reach this branch, so the `typeof val === "object"` test is always true and the trailing throw (line 282) is unreachable.
- src/serialization/canonicalJson.ts:282, StringLiteral: unreachable, see line 232.
- src/serialization/canonicalJson.ts:330, ConditionalExpression/StringLiteral: `JSON.stringify` of a canonicalised value is never undefined.
- src/serialization/canonicalJson.ts:384,460,468,473,479,481,485,559,591, EqualityOperator/ConditionalExpression: `pos <= len` (or an always-true bound) reads `str[len]`, which is `undefined` and matches none of the compared characters, so scanning stops exactly as before.
- src/serialization/canonicalJson.ts:392,555,585, ConditionalExpression/LogicalOperator/EqualityOperator/StringLiteral: `parseStringRaw`, `parseArray` and `parseObject` are only entered after the caller has checked the opening character, so their own guards are dead.
- src/serialization/canonicalJson.ts:428, Regex: the slice is exactly four characters long (the `incomplete unicode escape` check guarantees it), so the `^`/`$` anchors are redundant.
- src/serialization/canonicalJson.ts:449,470,482,597,620, ConditionalExpression/EqualityOperator: when the guard is removed, `str[pos]` is `undefined` and the next check throws the identical error message.
- src/serialization/canonicalJson.ts:454,579,634, ConditionalExpression/EqualityOperator: `pos < len && ...` forced true or `<=` evaluates `str[len]`, `undefined`, which equals none of the characters tested.
- src/serialization/canonicalJson.ts:596, CallExpression: `skipWs()` at the top of the object member loop is redundant, whitespace is skipped after `{` and after `,`.
