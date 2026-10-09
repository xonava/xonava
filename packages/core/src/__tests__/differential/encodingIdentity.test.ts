import { describe, expect, it } from "vitest"
import { forAll, forAllAsync, type Rng } from "./harness"
import {
  ALL_ATOMS, E_ACUTE_NFC, E_ACUTE_NFD, LONE_HIGH, SCOPE_KINDS, adversarialString, cacheReference, cacheValue, collidingStringPair, executionScope,
  jsonValue, mutateJson, nonBlankString, permuteCacheValue, permuteKeys, flipZeroSigns, scopeKey, shrinkScope, shrinkStrings, withScopeKey,
} from "./encodingArbitraries"
import {
  decodeExecutionScopeId, encodeExecutionScopeId, executionScopesEqual, type ExecutionScope,
} from "../../domain/executionScope"
import { CanonicalJsonError, canonicalJsonString, decodeBase64UrlUnpadded, encodeBase64UrlUnpadded } from "../../serialization/canonicalJson"
import { EXECUTION_SCOPE_ID_PREFIX, PRINCIPAL_KINDS } from "../../spec/authority"
import { assertTenantCacheTag, assertTenantIdempotencyScope, encodeTenantCacheTag, encodeTenantIdempotencyScope } from "../../persistence/scoped"
import { createIdempotencyNamespace } from "../../events/durability/idempotency"
import { encodeQuotaSubject, type QuotaSubject } from "../../quota/quota"
import { CacheService, buildKey, serializeCacheKeyPart, type CacheAdapter } from "../../cache/cache"
import { allocateSequence, sequencePeriod } from "../../sequence/sequence"
import type { SequenceDefinition } from "../../sequence/types"
import { buildJobFingerprintInput, fingerprintJob, type JobFingerprintInput } from "../../execution/jobFingerprint"
import type { JobExecutionScope, NewJob } from "../../execution/types"
import { defineEntity } from "../../entity/defineEntity"
import { parseTimeWindowMs } from "../../rate-limit/rateLimit"
import { ConfigurationError, TenantScopeViolationError, ValidationError } from "../../domain/errors"

/**
 * Property suite for identity, scope and key encodings. Every encoding here
 * names a namespace that isolates tenants, idempotency records or cache
 * entries, so the central property is injectivity: distinct inputs never
 * share an encoding, inside one builder and across builders that write the
 * same keyspace. Failures print a replayable seed (see ./harness.ts).
 */

const RETENTION = { completedTtlMs: 1000, abandonedTtlMs: 1000 }

/** Tracks every encoding seen in one property and fails on a collision between different identities. */
function collisionTracker<T>(identity: (value: T) => string) {
  const seen = new Map<string, string>()
  return (encoded: string, value: T): void => {
    const id = identity(value)
    const previous = seen.get(encoded)
    if (previous !== undefined && previous !== id) throw new Error(`collision: ${JSON.stringify(encoded)} encodes both ${previous} and ${id}`)
    seen.set(encoded, id)
  }
}

const scopeIdentity = (scope: ExecutionScope): string => JSON.stringify([scope.kind, scopeKey(scope)])

/** A pair of scopes chosen to stress injectivity: equal keys across kinds, normalization twins, prefix extensions. */
function scopePair(rng: Rng): [ExecutionScope, ExecutionScope] {
  const left = executionScope(rng)
  const key = scopeKey(left)
  const twin = key.includes(E_ACUTE_NFC) ? key.replace(E_ACUTE_NFC, E_ACUTE_NFD) : key.includes(E_ACUTE_NFD) ? key.replace(E_ACUTE_NFD, E_ACUTE_NFC) : `${key}${rng.pick(ALL_ATOMS)}`
  return rng.pick<() => [ExecutionScope, ExecutionScope]>([
    () => [left, withScopeKey(executionScope(rng, rng.pick(SCOPE_KINDS.filter((kind) => kind !== left.kind))), key)],
    () => [left, twin.trim() ? withScopeKey(left, twin) : left],
    () => [left, executionScope(rng)],
    () => [left, { ...left }],
  ])()
}

describe("execution scope id (domain/executionScope.ts)", () => {
  it("round-trips every scope kind and key (decode(encode(s)) = s)", () => {
    forAll("scope id round trip", (rng) => executionScope(rng), (scope) => {
      const id = encodeExecutionScopeId(scope)
      expect(id.startsWith(EXECUTION_SCOPE_ID_PREFIX)).toBe(true)
      expect(id.slice(EXECUTION_SCOPE_ID_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(decodeExecutionScopeId(id)).toEqual(scope)
    }, { runs: 400, shrink: shrinkScope })
  })

  it("is injective: different (kind, key) never share an id, across kinds and Unicode normalization twins", () => {
    const track = collisionTracker(scopeIdentity)
    forAll("scope id injectivity", scopePair, ([left, right]) => {
      const a = encodeExecutionScopeId(left)
      const b = encodeExecutionScopeId(right)
      track(a, left)
      track(b, right)
      // Canonical JSON (RFC 8785) performs no Unicode normalization, so NFC and NFD
      // spellings are distinct scopes; equality is code-unit equality of the key.
      expect(a === b).toBe(scopeIdentity(left) === scopeIdentity(right))
      expect(executionScopesEqual(left, right)).toBe(a === b)
    }, { runs: 600 })
  })

  it("decodes only its own canonical spelling: every mutated id is rejected or re-encodes to itself", () => {
    forAll("scope id strict decode", (rng) => {
      const id: string = encodeExecutionScopeId(executionScope(rng))
      const position = rng.int(id.length + 1)
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=+/.: "
      const mutated = rng.pick([
        () => `${id.slice(0, position)}${rng.pick([...alphabet])}${id.slice(position + 1)}`,
        () => `${id.slice(0, position)}${rng.pick([...alphabet])}${id.slice(position)}`,
        () => `${id.slice(0, position)}${id.slice(position + 1)}`,
        () => id.toUpperCase(),
        () => id.replace(EXECUTION_SCOPE_ID_PREFIX, rng.pick(["fscope:v2:", "FSCOPE:v1:", "fscope:v1::", ""])),
      ])()
      return { id, mutated }
    }, ({ id, mutated }) => {
      let decoded: ExecutionScope | undefined
      try { decoded = decodeExecutionScopeId(mutated) } catch (error) { expect(error).toBeInstanceOf(CanonicalJsonError); return }
      expect(encodeExecutionScopeId(decoded)).toBe(mutated)
      if (mutated !== id) expect(decoded).not.toEqual(decodeExecutionScopeId(id))
    }, { runs: 800 })
  })

  it("rejects non-canonical JSON hidden inside valid base64url (whitespace, key order, escapes, extra keys)", () => {
    forAll("scope id non-canonical payload", (rng) => {
      const scope = executionScope(rng)
      const [, keyName] = Object.keys(scope)
      const key = scopeKey(scope)
      const variants = [
        `{ "${keyName}":${JSON.stringify(key)},"kind":"${scope.kind}"}`,
        `{"${keyName}":${JSON.stringify(key)}, "kind":"${scope.kind}"}`,
        `{"kind":"${scope.kind}","${keyName}":${JSON.stringify(key)}}`,
        `{"kind":"${scope.kind}","${keyName}":${JSON.stringify(key)}}\n`,
        `{"${keyName}":${JSON.stringify(key)},"kind":"\\u00${scope.kind.charCodeAt(0).toString(16)}${scope.kind.slice(1)}"}`,
        `{"${keyName}":${JSON.stringify(key)},"kind":"${scope.kind}","x":1}`,
        `{"${keyName}":${JSON.stringify(key).replace(/^"/, "\"\\/")},"kind":"${scope.kind}"}`,
      ]
      return { scope, json: rng.pick(variants) }
    }, ({ scope, json }) => {
      const id = `${EXECUTION_SCOPE_ID_PREFIX}${encodeBase64UrlUnpadded(new TextEncoder().encode(json))}`
      if (json === canonicalJsonString(scope)) {
        expect(decodeExecutionScopeId(id)).toEqual(scope)
        return
      }
      let decoded: ExecutionScope
      try { decoded = decodeExecutionScopeId(id) } catch (error) { expect(error).toBeInstanceOf(CanonicalJsonError); return }
      // A variant may still be the canonical spelling of a *different* scope (e.g. an
      // escape that changes the key); it must then be exactly that scope's encoding.
      expect(canonicalJsonString(decoded)).toBe(json)
      expect(decoded).not.toEqual(scope)
    }, { runs: 400 })
  })

  it("rejects keys canonical JSON cannot carry (lone surrogates, blank, oversized) with a CanonicalJsonError", () => {
    forAll("scope id invalid keys", (rng) => withScopeKey(executionScope(rng), rng.pick([
      () => `${nonBlankString(rng)}${LONE_HIGH}`,
      () => rng.pick(["", " ", "\t\n", "　".trim() === "" ? "　" : " "]),
      () => "x".repeat(4097),
    ])()), (scope) => {
      expect(() => encodeExecutionScopeId(scope)).toThrow(CanonicalJsonError)
    }, { runs: 150 })
  })
})

describe("tenant idempotency scope and cache tag (persistence/scoped.ts)", () => {
  it("encodeTenantIdempotencyScope is injective on adversarial tenant ids", () => {
    const track = collisionTracker((tenant: string) => tenant)
    forAll("tenant idempotency scope injective", (rng) => collidingStringPair(rng, 2, { nonBlank: true }), ([left, right]) => {
      for (const tenant of [left.join(":"), right.join(":"), left[0]!, right[0]!, `${left[0]}${left[1]}`]) track(encodeTenantIdempotencyScope(tenant), tenant)
    }, { runs: 500 })
  })

  it("a tenant scope (and any ':'-suffixed sub-scope) is accepted only for its own tenant", () => {
    forAll("tenant idempotency scope ownership", (rng) => {
      const [left, right] = collidingStringPair(rng, 2, { nonBlank: true })
      const owner = rng.bool() ? left.join(":") : left[0]!
      const other = rng.pick([right.join(":"), right[0]!, `${owner}:`, owner.slice(0, -1) || "x", `${owner}${rng.pick(ALL_ATOMS)}`, owner])
      return { owner, other, suffix: rng.bool() ? `:${adversarialString(rng)}` : "" }
    }, ({ owner, other, suffix }) => {
      const scope = `${encodeTenantIdempotencyScope(owner)}${suffix}`
      expect(() => assertTenantIdempotencyScope(scope, owner)).not.toThrow()
      if (other === owner) return
      expect(() => assertTenantIdempotencyScope(scope, other)).toThrow(TenantScopeViolationError)
    }, { runs: 600 })
  })

  it("encodeTenantCacheTag is injective on (tenant, tag) and owned only by its tenant", () => {
    const track = collisionTracker(([tenant, tag]: readonly string[]) => JSON.stringify([tenant, tag]))
    forAll("tenant cache tag injective", (rng) => collidingStringPair(rng, 2, { nonBlank: true }), ([left, right]) => {
      for (const pair of [left, right]) {
        const tag = encodeTenantCacheTag(pair[0]!, pair[1]!)
        track(tag, pair)
        expect(() => assertTenantCacheTag(tag, pair[0]!)).not.toThrow()
      }
      if (left[0] !== right[0]) expect(() => assertTenantCacheTag(encodeTenantCacheTag(left[0]!, left[1]!), right[0]!)).toThrow(TenantScopeViolationError)
    }, { runs: 500, shrink: ([left, right]) => (function* () { for (const smaller of shrinkStrings([...left, ...right])) yield [smaller.slice(0, 2), smaller.slice(2)] as [string[], string[]] })() })
  })

  // Regression: the length was parsed with Number(), so "tenant:01:x" was accepted for tenant "x".
  it("accepts a tenant namespace only in its canonical spelling (no leading-zero lengths)", () => {
    forAll("tenant scope canonical spelling", (rng) => {
      const tenant = nonBlankString(rng, { maxAtoms: 2 })
      const zeros = "0".repeat(1 + rng.int(3))
      return { tenant, scope: `tenant:${zeros}${tenant.length}:${tenant}` }
    }, ({ tenant, scope }) => {
      expect(() => assertTenantIdempotencyScope(scope, tenant)).toThrow(TenantScopeViolationError)
    }, { runs: 50 })
  })
})

describe("idempotency namespace (events/durability/idempotency.ts)", () => {
  it("is injective on (scope, operationKey) even when the operation key contains ':' or looks like a scope id", () => {
    const track = collisionTracker(([scope, operation]: readonly [ExecutionScope, string]) => JSON.stringify([scopeIdentity(scope), operation]))
    forAll("idempotency namespace injective", (rng) => {
      const [left, right] = scopePair(rng)
      const operation = nonBlankString(rng)
      const fake = `${operation}:${encodeExecutionScopeId(right).slice(EXECUTION_SCOPE_ID_PREFIX.length)}`
      return [[left, operation], [right, operation], [left, fake], [right, `${encodeExecutionScopeId(left).slice(EXECUTION_SCOPE_ID_PREFIX.length)}:${operation}`]] as Array<[ExecutionScope, string]>
    }, (cases) => {
      for (const [scope, operation] of cases) {
        const namespace = createIdempotencyNamespace(scope, operation, RETENTION)
        track(namespace.value, [scope, operation])
        expect(namespace.value).toBe(`${namespace.scopeId}:${operation}`)
        // The scope id carries no ':' after its prefix, so the first ':' after it splits uniquely.
        const rest = namespace.value.slice(EXECUTION_SCOPE_ID_PREFIX.length)
        expect(decodeExecutionScopeId(`${EXECUTION_SCOPE_ID_PREFIX}${rest.slice(0, rest.indexOf(":"))}`)).toEqual(scope)
      }
    }, { runs: 300 })
  })

  it("cross-builder: a framework idempotency namespace is never accepted as any tenant's length-prefixed scope", () => {
    forAll("idempotency namespace vs tenant scope", (rng) => ({ scope: executionScope(rng), operation: nonBlankString(rng), tenant: nonBlankString(rng) }), ({ scope, operation, tenant }) => {
      const namespace = createIdempotencyNamespace(scope, operation, RETENTION).value
      expect(() => assertTenantIdempotencyScope(namespace, tenant)).toThrow(TenantScopeViolationError)
      expect(namespace).not.toBe(encodeTenantIdempotencyScope(tenant))
    }, { runs: 300 })
  })
})

describe("quota subject (quota/quota.ts)", () => {
  const subjectReference = (subject: QuotaSubject): string => canonicalJsonString({
    scope: subject.scope,
    principal: subject.principal ? { kind: subject.principal.kind, id: subject.principal.id } : null,
    plan: subject.planKey ?? null,
  })
  const subject = (rng: Rng, base?: QuotaSubject): QuotaSubject => {
    const scope = base && rng.bool(0.6) ? base.scope : executionScope(rng)
    const principal = rng.bool(0.6) ? { kind: rng.pick(PRINCIPAL_KINDS), id: base?.principal && rng.bool(0.5) ? `${base.principal.id}${rng.pick([":", "%3A", ""])}` : nonBlankString(rng) } : undefined
    const planKey = rng.bool(0.5) ? (base?.planKey && rng.bool(0.5) ? `${base.planKey}:` : nonBlankString(rng, { maxAtoms: 2 })) : undefined
    return { scope, ...(principal ? { principal } : {}), ...(planKey ? { planKey } : {}) }
  }

  it("bucket subject keys are injective (equal iff scope, principal and plan are equal)", () => {
    const track = collisionTracker(subjectReference)
    forAll("quota subject injective", (rng) => {
      const left = subject(rng)
      return [left, rng.bool(0.3) ? { ...left } : subject(rng, left)] as const
    }, ([left, right]) => {
      const a = encodeQuotaSubject(left)
      const b = encodeQuotaSubject(right)
      track(a, left)
      track(b, right)
      expect(a === b).toBe(subjectReference(left) === subjectReference(right))
    }, { runs: 600 })
  })

  it("rejects malformed principals and plans with ValidationError (never a raw URIError)", () => {
    forAll("quota subject invalid text", (rng) => {
      const bad = `${nonBlankString(rng, { maxAtoms: 1 })}${rng.pick([LONE_HIGH, "\udc00", `${LONE_HIGH}x`])}`
      return rng.bool()
        ? { scope: executionScope(rng), principal: { kind: rng.pick(PRINCIPAL_KINDS), id: bad } }
        : { scope: executionScope(rng), planKey: bad }
    }, (value) => {
      expect(() => encodeQuotaSubject(value)).toThrow(ValidationError)
    }, { runs: 100 })
  })
})

describe("cache keys (cache/cache.ts)", () => {
  it("serializeCacheKeyPart equals the independent reference model's equality (differential, incl. tagged values)", () => {
    const track = collisionTracker(cacheReference)
    forAll("cache key part vs reference", (rng) => {
      const left = cacheValue(rng)
      const right = rng.pick([() => permuteCacheValue(rng, left), () => cacheValue(rng), () => permuteCacheValue(rng, cacheValue(rng, { maxDepth: 1 }))])()
      return [left, right] as const
    }, ([left, right]) => {
      const a = serializeCacheKeyPart(left)
      const b = serializeCacheKeyPart(right)
      track(a, left)
      track(b, right)
      expect(a === b).toBe(cacheReference(left) === cacheReference(right))
      expect(serializeCacheKeyPart(left)).toBe(a)
    }, { runs: 1500, describe: (value) => String([...value].map((item) => cacheReference(item))) })
  })

  it("buildKey is injective and reversible on adversarial (prefix, scope, suffix) triples", () => {
    const track = collisionTracker((parts: readonly string[]) => JSON.stringify(parts))
    forAll("buildKey injective", (rng) => collidingStringPair(rng, 3), ([left, right]) => {
      for (const parts of [left, right]) {
        let key: string
        try { key = buildKey(parts[0]!, parts[1]!, parts[2]!) } catch (error) { expect(error).toBeInstanceOf(CanonicalJsonError); continue }
        track(key, parts)
        const segments = key.split(":")
        expect(segments).toHaveLength(3)
        expect(segments.map(decodeURIComponent)).toEqual(parts)
        // Generation storage keys start with `__generation__:"`; a built key can never contain '"'.
        expect(key.includes("\"")).toBe(false)
      }
    }, { runs: 800, shrink: ([left, right]) => (function* () { for (const smaller of shrinkStrings([...left, ...right])) yield [smaller.slice(0, 3), smaller.slice(3)] as [string[], string[]] })() })
  })

  it("buildKey rejects lone surrogates with a canonicalization error, not a raw URIError", () => {
    forAll("buildKey lone surrogate", (rng) => {
      const parts = [adversarialString(rng), adversarialString(rng), adversarialString(rng)]
      parts[rng.int(3)] += rng.pick([LONE_HIGH, "\udc00"])
      return parts
    }, (parts) => {
      expect(() => buildKey(parts[0]!, parts[1]!, parts[2]!)).toThrow(CanonicalJsonError)
    }, { runs: 100 })
  })

  it("tagged storage keys are injective on (generation, key) and disjoint from every buildKey output", async () => {
    const storageOwner = new Map<string, string>()
    await forAllAsync("cache generation storage keys", (rng) => ({
      key: rng.bool() ? buildKey(adversarialString(rng, { longRate: 0 }), adversarialString(rng, { longRate: 0 }), adversarialString(rng, { longRate: 0 })) : adversarialString(rng, { maxAtoms: 3, longRate: 0 }),
      tags: Array.from({ length: 1 + rng.int(3) }, () => nonBlankString(rng, { maxAtoms: 2, longRate: 0 })).filter((tag, index, all) => all.indexOf(tag) === index),
      generation: rng.pick(["0", "1", "\"", ":", "0:1", "local:0", ""]),
    }), async ({ key, tags, generation }) => {
      const writes: string[] = []
      const adapter: CacheAdapter = {
        capabilities: { tagGenerationConsistency: "linearizable", coherenceScope: "shared" },
        get: async () => undefined, set: async (storageKey) => { writes.push(storageKey) }, delete: async () => true, has: async () => false, clear: async () => undefined,
        addToTag: async () => undefined, getTagKeys: async () => [], deleteTag: async () => undefined,
        getTagGeneration: async (tag) => `${generation}${tag.length}`, advanceTagGeneration: async () => "1",
      }
      await new CacheService({ adapter }).getOrSet(key, async () => 1, tags)
      expect(writes).toHaveLength(1)
      const storageKey = writes[0]!
      expect(storageKey.startsWith("__generation__:\"")).toBe(true)
      const identity = JSON.stringify([key, tags, generation])
      const previous = storageOwner.get(storageKey)
      // Different tag sets / generations / keys must not share a storage key.
      if (previous !== undefined && previous !== identity) {
        const [previousKey, previousTags, previousGeneration] = JSON.parse(previous) as [string, string[], string]
        const sameGenerations = JSON.stringify(previousTags.flatMap((tag) => [tag, `${previousGeneration}${tag.length}`])) === JSON.stringify(tags.flatMap((tag) => [tag, `${generation}${tag.length}`]))
        expect(sameGenerations && previousKey === key).toBe(true)
      }
      storageOwner.set(storageKey, identity)
    }, { runs: 400 })
  })
})

describe("entity default cache namespace (entity/defineEntity.ts)", () => {
  const schema = { parse: (value: unknown) => value } as never
  const defineInput = (moduleKey: string, name: string, namespace: string | undefined) => ({
    moduleKey,
    entity: { name, ...(namespace === undefined ? {} : { namespace }), fields: { id: { type: "string" as const }, tenantId: { type: "string" as const }, version: { type: "number" as const } }, tenantField: "tenantId" as const, versionField: "version" as const },
    entityScope: { kind: "tenant" as const },
    policy: { skipCapabilityCheck: true as const },
    validation: { createBody: schema, updateBody: schema },
    cache: {} as never,
  })
  const define = (moduleKey: string, name: string, namespace: string | undefined) => defineEntity(defineInput(moduleKey, name, namespace))
  const MODULE_KEYS = ["m", "tenant", "a.b", "a", "b", "fscope", "plan"] as const
  const NAMES = ["x", "a", "b", "orders", "a-b", "a_b"] as const
  const entityInput = (rng: Rng) => ({
    moduleKey: rng.pick(MODULE_KEYS),
    name: rng.pick(NAMES),
    namespace: rng.pick([undefined, "", "1", "01", "a", "a:b", "b:x", ":", "tenant:1", "x:1"]),
  })

  it("default cache prefixes are injective on (moduleKey, namespace, name)", () => {
    const track = collisionTracker((input: ReturnType<typeof entityInput>) => JSON.stringify([input.moduleKey, input.namespace ?? "", input.name]))
    forAll("entity cache prefix injective", entityInput, (input) => {
      const cache = define(input.moduleKey, input.name, input.namespace).cache
      if (cache === false) throw new Error("cache unexpectedly disabled")
      expect(cache.tag).toBe(cache.keyPrefix)
      // Absent namespace and "" are the same persistence namespace by construction.
      track(cache.keyPrefix, input)
    }, { runs: 400 })
  })

  /** Every substring between ':' boundaries: the only text a tenant-tag decoder could ever return as a tenant id. */
  const tenantCandidates = (tag: string): string[] => {
    const starts = [0, ...[...tag].flatMap((char, index) => (char === ":" ? [index + 1] : []))]
    const ends = [tag.length, ...[...tag].flatMap((char, index) => (char === ":" ? [index] : []))]
    return starts.flatMap((start) => ends.filter((end) => end > start).map((end) => tag.slice(start, end))).filter((tenant) => tenant.trim() !== "")
  }

  // Regression: the default global tag was `${moduleKey}:${namespace}:${name}`, so
  // moduleKey "tenant", namespace "1", name "x" produced "tenant:1:x", which
  // assertTenantCacheTag accepted for tenant "x". Defaults now live under the
  // reserved "entity:" prefix, which a tenant tag ("tenant:<len>:...") never has.
  it("cross-builder: no default entity cache prefix or tag is ever owned by any tenant", () => {
    forAll("entity tag vs tenant tag", entityInput, (input) => {
      const cache = define(input.moduleKey, input.name, input.namespace).cache
      if (cache === false) throw new Error("cache unexpectedly disabled")
      for (const value of [cache.tag, cache.keyPrefix]) {
        for (const tenant of tenantCandidates(value)) expect(() => assertTenantCacheTag(value, tenant)).toThrow(TenantScopeViolationError)
      }
    }, { runs: 400 })
  })

  it("rejects an explicit entity cache tag inside the tenant tag namespace", () => {
    expect(() => defineEntity({ ...defineInput("m", "x", undefined), cache: { tag: "tenant:1:x", keyPrefix: "p" } })).toThrow(ConfigurationError)
  })

  it("default idempotency namespaces are injective on (moduleKey, namespace, name)", () => {
    const track = collisionTracker((input: ReturnType<typeof entityInput>) => JSON.stringify([input.moduleKey, input.namespace ?? "", input.name]))
    forAll("entity idempotency namespace injective", entityInput, (input) => {
      track(define(input.moduleKey, input.name, input.namespace).compiledIdempotency.namespace, input)
    }, { runs: 400 })
  })
})

describe("sequence periods and formatted values (sequence/sequence.ts)", () => {
  const FIXED_ZONES = [["UTC", 0], ["Etc/GMT-14", 14 * 60], ["Etc/GMT+12", -12 * 60], ["Etc/GMT-5", 5 * 60], ["Etc/GMT+3", -3 * 60]] as const
  const MS_PER_DAY = 86_400_000
  const instant = (rng: Rng, minYear: number, maxYear: number): Date => {
    const start = Date.UTC(2000, 0, 1) + (minYear - 2000) * 365.2425 * MS_PER_DAY
    const end = Date.UTC(2000, 0, 1) + (maxYear - 2000) * 365.2425 * MS_PER_DAY
    const near = rng.bool(0.4)
    const base = new Date(start + (rng.next() / 0x1_0000_0000) * (end - start))
    // Bias towards local midnight / year boundaries where off-by-offset bugs live.
    if (near) base.setUTCHours(rng.pick([0, 23, 12, 10, 14]), rng.pick([0, 59]), rng.pick([0, 59]), rng.pick([0, 999]))
    if (near && rng.bool(0.4)) base.setUTCMonth(rng.pick([0, 11]), rng.pick([1, 31]))
    return base
  }
  const model = (at: Date, offsetMinutes: number, reset: "year" | "month" | "day"): string => {
    const local = new Date(at.getTime() + offsetMinutes * 60_000)
    const year = String(local.getUTCFullYear()).padStart(4, "0")
    const month = String(local.getUTCMonth() + 1).padStart(2, "0")
    const day = String(local.getUTCDate()).padStart(2, "0")
    return reset === "year" ? year : reset === "month" ? `${year}-${month}` : `${year}-${month}-${day}`
  }

  it("matches an offset-arithmetic model of the local calendar date in fixed-offset zones (years 1..9999)", () => {
    forAll("sequence period vs model", (rng) => ({ at: instant(rng, 1, 9999), zone: rng.pick(FIXED_ZONES), reset: rng.pick(["year", "month", "day"] as const) }), ({ at, zone, reset }) => {
      const local = new Date(at.getTime() + zone[1] * 60_000).getUTCFullYear()
      if (local < 1 || local > 9999) return
      expect(sequencePeriod(reset, at, zone[0])).toBe(model(at, zone[1], reset))
    }, { runs: 1000, describe: (value) => `${value.at.toISOString()} ${value.zone[0]} ${value.reset}` })
  })

  it("never maps two calendar periods to one key: instants before year 1 are rejected (no BC/AD aliasing)", () => {
    forAll("sequence period era", (rng) => ({ at: instant(rng, -3000, 1), zone: rng.pick(FIXED_ZONES), reset: rng.pick(["year", "month", "day"] as const) }), ({ at, zone, reset }) => {
      const local = new Date(at.getTime() + zone[1] * 60_000).getUTCFullYear()
      if (local >= 1) {
        expect(sequencePeriod(reset, at, zone[0])).toBe(model(at, zone[1], reset))
      } else {
        expect(() => sequencePeriod(reset, at, zone[0])).toThrow(ConfigurationError)
      }
    }, { runs: 400, describe: (value) => `${value.at.toISOString()} ${value.zone[0]} ${value.reset}` })
  })

  it("formatted values are unique per (period, value) within one definition", async () => {
    await forAllAsync("sequence formatted injective", (rng) => {
      const reset = rng.pick(["year", "month", "day"] as const)
      const definition: SequenceDefinition = {
        name: "inv", reset, periodFormat: rng.pick(["compact", "iso"] as const), padding: rng.pick([0, 1, 2, 4]),
        periodSeparator: rng.pick(["", "-", "0", "1", "/", ":", "--"]), ...(rng.bool() ? { prefix: rng.pick(["", "INV-", "1", "20", "a:b/"]) } : {}),
      }
      const allocations = Array.from({ length: 6 }, () => ({ at: instant(rng, 1000, 9999), value: rng.pick([1, 2, 9, 10, 11, 100, 101, 1000, 1 + rng.int(100_000)]) }))
      return { definition, allocations }
    }, async ({ definition, allocations }) => {
      const owner = new Map<string, string>()
      for (const { at, value } of allocations) {
        const allocation = await allocateSequence({ next: async () => value }, { scopeId: encodeExecutionScopeId({ kind: "tenant", tenantId: "t" }), definition, at })
        const identity = `${allocation.period}#${value}`
        const previous = owner.get(allocation.formatted)
        if (previous !== undefined) expect(previous).toBe(identity)
        owner.set(allocation.formatted, identity)
      }
    }, { runs: 300 })
  })
})

describe("job fingerprint (execution/jobFingerprint.ts)", () => {
  const jobScope = (rng: Rng): JobExecutionScope => executionScope(rng, rng.pick(["tenant", "platform", "system"] as const)) as JobExecutionScope
  const newJob = (rng: Rng): NewJob => ({
    executionScope: jobScope(rng), jobType: nonBlankString(rng, { maxAtoms: 2 }), jobVersion: 1 + rng.int(3), payload: jsonValue(rng, { maxDepth: 0 }) === null ? {} : { a: jsonValue(rng), [adversarialString(rng, { longRate: 0 }).replace("__proto__", "__proto")]: jsonValue(rng) },
    ...(rng.bool() ? { runAt: new Date(1_700_000_000_000 + rng.int(1e9)) } : {}),
    ...(rng.bool() ? { maxAttempts: rng.pick([1, 3, 5]) } : {}), ...(rng.bool() ? { priority: rng.pick([-0, 0, 1, -1]) } : {}),
    ...(rng.bool() ? { correlationId: rng.pick(["c1", "null", ""]) } : {}), ...(rng.bool() ? { partitionKey: rng.pick(["p", ":", "null"]) } : {}),
    ...(rng.bool() ? { metadata: { m: jsonValue(rng) } } : {}),
  }) as NewJob

  it("is stable for semantically equal jobs: key order, -0, equal Dates, documented defaults", async () => {
    await forAllAsync("job fingerprint stable", (rng) => {
      const job = newJob(rng)
      const runAt = new Date(1_800_000_000_000 + rng.int(1000))
      const twin = {
        ...(permuteKeys(rng, { ...job, runAt: undefined, executionScope: { ...job.executionScope } }) as NewJob),
        payload: flipZeroSigns(permuteKeys(rng, job.payload)) as Record<string, unknown>,
        executionScope: permuteKeys(rng, job.executionScope) as JobExecutionScope,
        ...(job.metadata ? { metadata: permuteKeys(rng, job.metadata) as Record<string, unknown> } : {}),
        ...(job.maxAttempts === 3 && rng.bool() ? { maxAttempts: undefined } : {}),
        ...(job.priority === 0 && rng.bool() ? { priority: undefined } : {}),
      }
      return { job, twin, runAt }
    }, async ({ job, twin, runAt }) => {
      const a = await fingerprintJob(buildJobFingerprintInput(job, runAt))
      const b = await fingerprintJob(buildJobFingerprintInput(twin as NewJob, new Date(runAt.getTime())))
      expect(a).toMatch(/^[0-9a-f]{64}$/)
      expect(b).toBe(a)
    }, { runs: 300 })
  })

  it("changes whenever any fingerprinted field changes meaning", async () => {
    const fields = ["executionScope", "jobType", "jobVersion", "payload", "runAt", "maxAttempts", "priority", "correlationId", "partitionKey", "metadata"] as const
    await forAllAsync("job fingerprint sensitive", (rng) => {
      const input = buildJobFingerprintInput(newJob(rng), new Date(1_800_000_000_000 + rng.int(1e6)))
      const field = rng.pick(fields)
      const changed: JobFingerprintInput = { ...input }
      switch (field) {
        case "executionScope": changed.executionScope = rng.bool() ? withScopeKey(input.executionScope, `${scopeKey(input.executionScope)}:`) as JobExecutionScope : { ...withScopeKey(input.executionScope, scopeKey(input.executionScope)), kind: input.executionScope.kind === "tenant" ? "platform" : "tenant", ...(input.executionScope.kind === "tenant" ? { platformKey: input.executionScope.tenantId } : { tenantId: scopeKey(input.executionScope) }) } as JobExecutionScope; break
        case "jobType": changed.jobType = `${input.jobType}${rng.pick([":", " ", E_ACUTE_NFD])}`; break
        case "jobVersion": changed.jobVersion = input.jobVersion + 1; break
        case "payload": changed.payload = mutateJson(rng, input.payload) as Record<string, unknown>; break
        case "runAt": changed.runAt = new Date(input.runAt.getTime() + rng.pick([1, -1, 3_600_000])); break
        case "maxAttempts": changed.maxAttempts = input.maxAttempts + 1; break
        case "priority": changed.priority = input.priority + 1; break
        case "correlationId": changed.correlationId = input.correlationId === null ? "null" : null; break
        case "partitionKey": changed.partitionKey = input.partitionKey === null ? "" : null; break
        case "metadata": changed.metadata = input.metadata === null ? {} : null; break
      }
      return { input, changed, field }
    }, async ({ input, changed }) => {
      const canonical = (value: JobFingerprintInput) => canonicalJsonString({ ...value, runAt: value.runAt.toISOString() })
      if (canonical(input) === canonical(changed)) return
      expect(await fingerprintJob(changed)).not.toBe(await fingerprintJob(input))
    }, { runs: 400 })
  })
})

describe("cross-builder keyspaces", () => {
  it("idempotency scopes: tenant length-prefixed scopes and framework namespaces never collide", () => {
    const track = collisionTracker((identity: string) => identity)
    forAll("idempotency keyspace", (rng) => {
      const [left, right] = collidingStringPair(rng, 2, { nonBlank: true, maxLength: 300 })
      return { tenants: [left.join(":"), right.join(":"), left[0]!, right[0]!], scope: executionScope(rng), operation: nonBlankString(rng) }
    }, ({ tenants, scope, operation }) => {
      for (const tenant of tenants) track(encodeTenantIdempotencyScope(tenant), `tenant-scope:${tenant}`)
      track(createIdempotencyNamespace(scope, operation, RETENTION).value, `namespace:${scopeIdentity(scope)}:${operation}`)
      track(encodeExecutionScopeId(scope), `scope-id:${scopeIdentity(scope)}`)
    }, { runs: 500 })
  })

  it("cache tags: tenant tags of different tenants never coincide, and base64url scope ids never contain ':'", () => {
    forAll("cache tag keyspace", (rng) => ({ tenants: collidingStringPair(rng, 2, { nonBlank: true, maxLength: 300 }), tag: nonBlankString(rng) }), ({ tenants: [left, right], tag }) => {
      const a = encodeTenantCacheTag(left.join(":"), tag)
      const b = encodeTenantCacheTag(right.join(":"), tag)
      if (left.join(":") !== right.join(":")) expect(a).not.toBe(b)
      const scopeId = encodeExecutionScopeId({ kind: "tenant", tenantId: left.join(":") })
      expect(scopeId.slice(EXECUTION_SCOPE_ID_PREFIX.length).includes(":")).toBe(false)
      expect(decodeBase64UrlUnpadded(scopeId.slice(EXECUTION_SCOPE_ID_PREFIX.length)).byteLength).toBeGreaterThan(0)
    }, { runs: 300 })
  })
})

describe("rate-limit windows (rate-limit/rateLimit.ts)", () => {
  const UNITS: ReadonlyArray<readonly [string, number]> = [
    ["ms", 1], ["millisecond", 1], ["milliseconds", 1], ["s", 1000], ["second", 1000], ["seconds", 1000], ["m", 60_000], ["minute", 60_000], ["minutes", 60_000],
    ["h", 3_600_000], ["hour", 3_600_000], ["hours", 3_600_000], ["d", 86_400_000], ["day", 86_400_000], ["days", 86_400_000],
  ]
  it("parses window spellings exactly like a unit-table model and rejects everything else as ConfigurationError", () => {
    forAll("rate-limit window parse", (rng) => {
      const [unit] = rng.pick(UNITS)
      const count = rng.pick([0, 1, 2, 59, 60, 1000, 999_999_999, 1_000_000_000, 104_249_991, 104_249_992, rng.int(1_000_000)])
      const digits = rng.bool(0.1) ? `0${count}` : String(count)
      const spelled = rng.bool(0.3) ? unit.toUpperCase() : unit
      const text = rng.pick([`${digits}${spelled}`, `${digits} ${spelled}`, ` ${digits}\t${spelled} `, `${digits}${spelled}s`, `${digits}.5${spelled}`, `-${digits}${spelled}`, `${digits}`, `${digits} ${spelled}x`, `${digits}:${spelled}`])
      return text
    }, (text) => {
      const match = /^(\d{1,9})\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?)$/.exec(text.trim().toLowerCase())
      const expected = match ? Number(match[1]) * (UNITS.find(([unit]) => unit === match[2])?.[1] ?? Number.NaN) : undefined
      let actual: number | undefined
      try { actual = parseTimeWindowMs(text) } catch (error) { expect(error).toBeInstanceOf(ConfigurationError) }
      if (expected === undefined || !Number.isSafeInteger(expected) || expected <= 0) expect(actual).toBeUndefined()
      else expect(actual).toBe(expected)
    }, { runs: 600 })
  })
})
