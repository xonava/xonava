import { describe, expect, it } from "vitest"
import {
  AUTHORITY_INVARIANTS,
  AUTHORITY_LATTICE_TRANSITIONS,
  EXECUTION_SCOPE_ID_PREFIX,
  EXECUTION_SCOPE_KINDS,
  PRINCIPAL_KINDS,
  isExplicitDelegation,
  transitionsFrom,
} from "../spec/authority"
import {
  DELEGATION_REVOCATION_MODELS,
  DEFAULT_MAX_DELEGATION_DEPTH,
  DELEGATION_INVARIANTS,
  GRANT_AUTHORIZATION_MODELS,
  IMPERSONATION_KINDS,
} from "../spec/delegation"
import {
  DURABLE_FORMAT_REGISTRY_V1,
  FORMAT_DEFAULT_MAX_CANONICAL_BYTES,
  CANONICAL_JSON_LIMITS_V1,
  SERIALIZATION_LIMIT_EXCEEDED_ERROR,
} from "../spec/formatVersions"
import {
  GUARANTEE_CERTIFICATION_SCHEMA,
  GUARANTEE_CERTIFICATION_SCHEMA_VERSION,
  GUARANTEE_IDS,
  GUARANTEE_STATUSES,
  V1_REQUIRED_GUARANTEES,
} from "../spec/guarantees"
import {
  ROUTE_EXPOSURES,
  ROUTE_INVARIANTS,
  SCOPE_RESOLUTION_KINDS,
  UNTRUSTED_SCOPE_INPUT_SOURCES,
} from "../spec/routes"
import { CANONICAL_TERMS, FORBIDDEN_SCOPE_OVERLOADS } from "../spec/terminology"
import {
  CANONICALIZATION_VERSION,
  DIGEST_ALGORITHM_VERSION,
  ENVELOPE_TIMESTAMP_PRECISION,
  FINGERPRINT_DOMAIN_SEPARATORS,
  VERSION_TAXONOMY_DOMAINS,
} from "../spec/versions"
import {
  AUTHORIZATION_SEQUENCE,
  AUTHORIZATION_SEQUENCE_INVARIANTS,
} from "../spec/authorizationSequencing"
import { FROZEN_CORE_EXPORT_DOMAINS, PACKAGE_EXPORT_POLICY } from "../spec/packageExports"

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

describe("foundation spec: execution scope", () => {
  it("defines exactly the four canonical execution scope kinds", () => {
    expect([...EXECUTION_SCOPE_KINDS]).toEqual(["application", "tenant", "platform", "system"])
  })

  it("never treats public as an execution scope kind", () => {
    expect(EXECUTION_SCOPE_KINDS).not.toContain("public")
    expect(AUTHORITY_INVARIANTS.publicIsNeverAnExecutionScopeKind).toBe(true)
  })

  it("declares platform and system as never implicit tenant wildcards", () => {
    expect(AUTHORITY_INVARIANTS.platformAndSystemAreNeverImplicitTenantWildcards).toBe(true)
    expect(AUTHORITY_INVARIANTS.tenantAuthorityCanNeverRebindToAnotherTenant).toBe(true)
  })

  it("uses the frozen execution scope identity prefix", () => {
    expect(EXECUTION_SCOPE_ID_PREFIX).toBe("fscope:v1:")
  })

  it("defines the canonical principal kinds including explicit anonymous", () => {
    expect([...PRINCIPAL_KINDS]).toEqual(["human", "service", "system", "anonymous"])
  })
})

describe("foundation spec: authority lattice", () => {
  it("derives tenant authority from platform or system only by explicit delegation", () => {
    const delegated = AUTHORITY_LATTICE_TRANSITIONS.filter(
      (transition) => transition.to === "delegated-tenant",
    )
    expect(delegated.length).toBe(2)
    for (const transition of delegated) {
      expect(isExplicitDelegation(transition)).toBe(true)
      expect(["platform", "system"]).toContain(transition.from)
    }
  })

  it("gives application and tenant authorities no outgoing runtime transitions", () => {
    expect(transitionsFrom("application")).toEqual([])
    expect(transitionsFrom("tenant")).toEqual([])
    expect(transitionsFrom("delegated-tenant")).toEqual([])
  })

  it("allows root to derive top-level authorities only during bootstrap resolution", () => {
    const rootTransitions = transitionsFrom("root")
    expect(rootTransitions.map((transition) => transition.to)).toEqual([
      "application",
      "tenant",
      "platform",
      "system",
    ])
    for (const transition of rootTransitions) {
      expect(transition.mechanism).toBe("bootstrap-resolution")
    }
  })

  it("contains no transition targeting a public authority", () => {
    for (const transition of AUTHORITY_LATTICE_TRANSITIONS) {
      expect(transition.to).not.toBe("public")
    }
  })

  it("rejects scope identity mismatch before data access", () => {
    expect(AUTHORITY_INVARIANTS.scopeIdMismatchRejectsBeforeDataAccess).toBe(true)
    expect(
      AUTHORITY_INVARIANTS.bootstrapOriginIsNeverPassedAsUnrestrictedPersistenceAuthority,
    ).toBe(true)
  })
})

describe("foundation spec: delegation lifecycle", () => {
  it("freezes default maximum delegation depth at one", () => {
    expect(DEFAULT_MAX_DELEGATION_DEPTH).toBe(1)
  })

  it("supports exactly the two specified revocation models", () => {
    expect([...DELEGATION_REVOCATION_MODELS]).toEqual([
      "not-revocable-before-expiry",
      "authoritative-store",
    ])
  })

  it("supports exactly snapshot and continuous authorization models", () => {
    expect([...GRANT_AUTHORIZATION_MODELS]).toEqual(["snapshot", "continuous"])
  })

  it("forbids nested impersonation", () => {
    expect(DELEGATION_INVARIANTS.nestedImpersonationForbidden).toBe(true)
    expect([...IMPERSONATION_KINDS]).toEqual(["none", "explicit"])
  })
})

describe("foundation spec: guarantee registry", () => {
  it("uses exactly the three certification statuses", () => {
    expect([...GUARANTEE_STATUSES]).toEqual(["proven", "unsupported", "experimental"])
  })

  it("keeps guarantee IDs unique, stable and namespaced", () => {
    expect(hasDuplicates(GUARANTEE_IDS)).toBe(false)
    for (const id of GUARANTEE_IDS) {
      expect(id).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9.]+)?$/)
    }
  })

  it("matches the frozen V1 guarantee subsets per adapter", () => {
    expect([...V1_REQUIRED_GUARANTEES.postgresql]).toEqual([
      "transaction.interactive",
      "persistence.conditionalVersionedMutation",
      "persistence.conditionalAuthorizedMutation",
      "idempotency.atomicCommitReceipt",
      "audit.atomic",
      "outbox.atomic",
      "cacheGeneration.atomic",
    ])
    expect([...V1_REQUIRED_GUARANTEES.d1]).toEqual([
      "transaction.atomicBatch",
      "persistence.conditionalVersionedMutation",
      "persistence.conditionalAuthorizedMutation",
      "idempotency.atomicCommitReceipt",
      "audit.atomic",
      "outbox.atomic",
      "cacheGeneration.atomic",
    ])
  })

  it("requires transaction.interactive only of PostgreSQL and atomicBatch only of D1 in V1", () => {
    expect(V1_REQUIRED_GUARANTEES.postgresql).toContain("transaction.interactive")
    expect(V1_REQUIRED_GUARANTEES.postgresql).not.toContain("transaction.atomicBatch")
    expect(V1_REQUIRED_GUARANTEES.d1).toContain("transaction.atomicBatch")
    expect(V1_REQUIRED_GUARANTEES.d1).not.toContain("transaction.interactive")
  })

  it("keeps every V1 requirement inside the canonical guarantee vocabulary", () => {
    for (const required of [...V1_REQUIRED_GUARANTEES.postgresql, ...V1_REQUIRED_GUARANTEES.d1]) {
      expect(GUARANTEE_IDS).toContain(required)
    }
  })

  it("pins the certification schema identity", () => {
    expect(GUARANTEE_CERTIFICATION_SCHEMA).toBe("framework.guarantee-certification")
    expect(GUARANTEE_CERTIFICATION_SCHEMA_VERSION).toBe(1)
  })
})

describe("foundation spec: durable formats", () => {
  it("matches the frozen canonical serialization ceilings exactly", () => {
    expect(CANONICAL_JSON_LIMITS_V1).toEqual({
      maxUtf8Bytes: 16 * 1024 * 1024,
      maxDepth: 64,
      maxTotalNodes: 250_000,
      maxObjectMembers: 100_000,
      maxArrayItems: 100_000,
      maxStringUtf8Bytes: 8 * 1024 * 1024,
      maxPropertyNameUtf8Bytes: 1_024,
    })
  })

  it("keeps durable format IDs unique with positive integer versions", () => {
    const ids = DURABLE_FORMAT_REGISTRY_V1.map((format) => format.formatId)
    expect(hasDuplicates(ids)).toBe(false)
    for (const format of DURABLE_FORMAT_REGISTRY_V1) {
      expect(Number.isInteger(format.formatVersion)).toBe(true)
      expect(format.formatVersion).toBeGreaterThanOrEqual(1)
    }
  })

  it("registers the canonical framework envelopes", () => {
    const ids = DURABLE_FORMAT_REGISTRY_V1.map((format) => format.formatId)
    expect(ids).toContain("framework.event-envelope")
    expect(ids).toContain("framework.authority-provenance")
  })

  it("freezes the canonicalization and digest algorithm versions", () => {
    expect(CANONICALIZATION_VERSION).toBe("jcs-rfc8785-v1")
    expect(DIGEST_ALGORITHM_VERSION).toBe("sha256-v1")
    expect(ENVELOPE_TIMESTAMP_PRECISION).toBe("rfc3339-utc-milliseconds")
  })

  it("freezes fingerprint domain separators", () => {
    expect(FINGERPRINT_DOMAIN_SEPARATORS.idempotency).toBe("framework:idempotency:v1:")
    expect(FINGERPRINT_DOMAIN_SEPARATORS.outbox).toBe("framework:outbox:v1:")
    expect(FINGERPRINT_DOMAIN_SEPARATORS.cursorQuery).toBe("framework:cursor-query:v1:")
  })

  it("exposes the stable serialization limit violation error code", () => {
    expect(SERIALIZATION_LIMIT_EXCEEDED_ERROR).toBe("SERIALIZATION_LIMIT_EXCEEDED")
  })

  it("records per-format default maxima within the absolute ceiling", () => {
    for (const limit of Object.values(FORMAT_DEFAULT_MAX_CANONICAL_BYTES)) {
      expect(limit).toBeLessThanOrEqual(CANONICAL_JSON_LIMITS_V1.maxUtf8Bytes)
      expect(limit).toBeGreaterThan(0)
    }
  })
})

describe("foundation spec: routes and terminology", () => {
  it("defines exactly authenticated and public route exposures", () => {
    expect([...ROUTE_EXPOSURES]).toEqual(["authenticated", "public"])
  })

  it("separates route exposure from data authority", () => {
    expect(ROUTE_INVARIANTS.routeExposureIsTransportPolicyOnly).toBe(true)
    expect(ROUTE_INVARIANTS.routeExposureNeverSelectsDataAuthority).toBe(true)
    expect(ROUTE_INVARIANTS.publicRouteNeverGrantsTenantPlatformOrSystemAuthority).toBe(true)
  })

  it("defines fixed and resolver scope-resolution plans", () => {
    expect([...SCOPE_RESOLUTION_KINDS]).toEqual(["fixed", "resolver"])
  })

  it("classifies query, body and cursor as untrusted scope inputs", () => {
    expect([...UNTRUSTED_SCOPE_INPUT_SOURCES]).toEqual(["query", "body", "cursor"])
  })

  it("registers the canonical terminology without duplicates", () => {
    const terms = CANONICAL_TERMS.map((entry) => entry.term)
    expect(hasDuplicates(terms)).toBe(false)
    for (const term of [
      "Principal",
      "Actor",
      "Subject",
      "ExecutionScope",
      "RouteExposure",
      "AuthorityGrant",
      "PersistenceAuthority",
      "CompiledFrameworkPlan",
      "AuthorizedExecutionPlan",
    ]) {
      expect(terms).toContain(term)
    }
  })

  it("marks RouteExposure as non-authoritative and non-durable", () => {
    const routeExposure = CANONICAL_TERMS.find((entry) => entry.term === "RouteExposure")
    expect(routeExposure?.securityAuthority).toBe(false)
    expect(routeExposure?.durable).toBe(false)
  })

  it("enumerates forbidden scope overloads", () => {
    expect(FORBIDDEN_SCOPE_OVERLOADS.length).toBeGreaterThan(0)
  })

  it("distinguishes every version taxonomy domain", () => {
    expect(hasDuplicates(VERSION_TAXONOMY_DOMAINS)).toBe(false)
    expect(VERSION_TAXONOMY_DOMAINS.length).toBeGreaterThanOrEqual(11)
  })
})

describe("foundation spec: sequencing and export policy", () => {
  it("freezes authorization before attenuated preparation and execution", () => {
    expect([...AUTHORIZATION_SEQUENCE]).toEqual([
      "normalize-principal",
      "match-compiled-route",
      "resolve-execution-scope",
      "validate-authority-grant",
      "authorize-operation",
      "attenuate-persistence",
      "prepare-operation",
      "perform-operation",
    ])
    expect(AUTHORIZATION_SEQUENCE_INVARIANTS.noDataAccessBeforeScopeAndGrantValidation).toBe(true)
    expect(AUTHORIZATION_SEQUENCE_INVARIANTS.noMutationBeforeAuthorization).toBe(true)
  })

  it("defines public API exclusively through exports with no 1.x aliases", () => {
    expect(PACKAGE_EXPORT_POLICY.publicApiSource).toBe("package.json#exports")
    expect(PACKAGE_EXPORT_POLICY.filesystemReachabilityIsPublicApi).toBe(false)
    expect(PACKAGE_EXPORT_POLICY.compatibilityAliases1xPermitted).toBe(false)
    expect([...FROZEN_CORE_EXPORT_DOMAINS]).toEqual([
      "domain", "entity", "operation", "query", "security", "execution", "events", "workflow",
      "kernel", "cache", "rate-limit", "telemetry", "quota", "resilience", "object-store",
      "health", "secrets", "feature-flags", "business-calendar", "persistence", "read-model",
      "bootstrap", "serialization", "storage",
    ])
  })
})
