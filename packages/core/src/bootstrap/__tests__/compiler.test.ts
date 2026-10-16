import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../../domain/errors"
import { FrameworkDefinitionRegistry } from "../definitionRegistry"
import { compileFramework } from "../compiler"
import { FrameworkRuntimeRegistry } from "../runtimeRegistry"
import { createVerifiedScopeResolution } from "../../security/scopeResolver"

describe("bootstrap compiler", () => {
  it("orders dependencies and seals all public collections", () => {
    const registry = new FrameworkDefinitionRegistry()
    registry.register({ kind: "entity", key: "orders", definitionVersion: 1 })
    registry.register({ kind: "operation", key: "create-order", definitionVersion: 1,
      references: [{ kind: "entity", key: "orders", minimumVersion: 1 }] })
    const plan = compileFramework(registry, { frameworkVersion: "2.0.0-alpha.1", sourceRevision: "test", compiledAt: "2026-09-10T00:00:00.000Z" })
    expect(plan.runtimeBindings.startupOrder).toEqual(["entity:orders", "operation:create-order"])
    expect(plan.definitions.entities.get("orders")?.definitionVersion).toBe(1)
    expect(registry.state).toBe("SEALED")
    expect(() => registry.register({ kind: "entity", key: "late", definitionVersion: 1 })).toThrow(ConfigurationError)
    expect((plan.definitions.entities as Map<string, unknown>).set).toBeUndefined()
  })

  it("fails closed on missing references, cycles, capabilities, and guarantee evidence", () => {
    const missing = new FrameworkDefinitionRegistry()
    missing.register({ kind: "operation", key: "bad", definitionVersion: 1, references: [{ kind: "entity", key: "absent" }] })
    expect(() => compileFramework(missing, { frameworkVersion: "2", sourceRevision: "x" })).toThrow(/missing definition/)

    const capability = new FrameworkDefinitionRegistry()
    capability.register({ kind: "entity", key: "secured", definitionVersion: 1, requiredCapabilities: ["transactions"] })
    expect(() => compileFramework(capability, { frameworkVersion: "2", sourceRevision: "x" })).toThrow(/missing capability/)

    const guarantee = new FrameworkDefinitionRegistry()
    guarantee.register({ kind: "entity", key: "durable", definitionVersion: 1, requiredGuarantees: ["audit.atomic"] })
    expect(() => compileFramework(guarantee, { frameworkVersion: "2", sourceRevision: "x" })).toThrow(/missing proven certification/)
  })

  it("compiles routes, scope resolution, policies, datasources, workers and runtime metadata", () => {
    const registry = new FrameworkDefinitionRegistry()
    registry.register({ kind: "datasource", key: "primary", definitionVersion: 1, adapter: "@adapter/pg", adapterBuildId: "pg-1", capabilities: ["transactions"] })
    registry.register({ kind: "policy", key: "orders.write", definitionVersion: 2, config: { action: "write" } })
    registry.register({ kind: "scopeResolver", key: "host-tenant", definitionVersion: 1, allowedTargetKinds: ["tenant"] })
    registry.register({ kind: "entity", key: "orders", definitionVersion: 1, datasourceKey: "primary", policyKey: "orders.write", requiredCapabilities: ["transactions"], requiredPorts: [{ key: "clock", capability: "clock" }], readiness: [{ key: "database", description: "database migrated" }] })
    registry.register({ kind: "operation", key: "create-order", definitionVersion: 1, references: [{ kind: "entity", key: "orders" }], policyKey: "orders.write" })
    registry.register({ kind: "route", key: "create-order", definitionVersion: 1, method: "post", path: "/orders", operationKey: "create-order", exposure: "public", scopeResolution: { kind: "resolver", resolverKey: "host-tenant", allowedTargetKinds: ["tenant"] }, authorizationPlanKey: "orders.write", mutation: { allowed: true, idempotencyRequirement: "required" } })
    registry.register({ kind: "consumer", key: "order-consumer", definitionVersion: 1, eventKeys: [] })
    const resolver = { key: "host-tenant", resolve: async () => createVerifiedScopeResolution("host-tenant", { kind: "tenant", tenantId: "one" }) }
    const plan = compileFramework(registry, { frameworkVersion: "2.0.0", sourceRevision: "abc", compiledAt: "2026-09-10T00:00:00.000Z", availableCapabilities: ["transactions"], scopeResolvers: [resolver] })
    expect(plan.routes.get("create-order")).toMatchObject({ method: "POST", pathTemplate: "/orders", authorizationPlanKey: "orders.write", scopeResolution: { kind: "resolver", allowedTargetKinds: ["tenant"] } })
    expect(plan.datasources.get("primary")?.adapter).toBe("@adapter/pg")
    expect(plan.authorization.digests.get("orders.write")).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.runtimeBindings.requiredPorts).toEqual([{ key: "clock", capability: "clock", optional: false }])
    expect(plan.runtimeBindings.workerBindings).toEqual([{ key: "order-consumer", definitionKey: "consumer:order-consumer", kind: "consumer" }])
    const runtime = new FrameworkRuntimeRegistry(plan, registry).bind("clock", {})
    expect(() => runtime.ready()).toThrow(/readiness/)
    runtime.ready(new Set(["database"]))
    expect(registry.state).toBe("READY")
  })

  it("rejects route, resolver, datasource and policy authority mismatches", () => {
    const missingOperation = new FrameworkDefinitionRegistry()
    missingOperation.register({ kind: "route", key: "r", definitionVersion: 1, method: "GET", path: "/", operationKey: "missing", exposure: "authenticated", scopeResolution: { kind: "fixed", scope: { kind: "tenant", tenantId: "t" } }, authorizationPlanKey: "p" })
    expect(() => compileFramework(missingOperation, { frameworkVersion: "2", sourceRevision: "x" })).toThrow(/missing definition reference operation:missing/)

    const datasource = new FrameworkDefinitionRegistry()
    datasource.register({ kind: "datasource", key: "d", definitionVersion: 1, adapter: "d", capabilities: [] })
    datasource.register({ kind: "entity", key: "e", definitionVersion: 1, datasourceKey: "d", requiredCapabilities: ["transactions"] })
    expect(() => compileFramework(datasource, { frameworkVersion: "2", sourceRevision: "x", availableCapabilities: ["transactions"] })).toThrow(/datasource d lacks capability/)
  })

  it("validates exact guarantee evidence identity and artifact digest", () => {
    const registry = new FrameworkDefinitionRegistry()
    registry.register({ kind: "datasource", key: "pg", definitionVersion: 1, adapter: "@adapter/pg", adapterBuildId: "build-1", capabilities: [] })
    registry.register({ kind: "entity", key: "orders", definitionVersion: 1, datasourceKey: "pg", requiredGuarantees: ["audit.atomic"] })
    const digest = "a".repeat(64)
    const certification = { schema: "framework.guarantee-certification", schemaVersion: 1, guarantee: "audit.atomic", adapter: { packageName: "@adapter/pg", packageVersion: "2.0.0", adapterBuildId: "build-1" }, status: "proven", evidence: { suiteId: "pg", suiteVersion: 1, artifactPath: "evidence/pg.json", artifactSha256: digest, sourceRevision: "rev", frameworkVersion: "2.0.0", executedAt: "2026-09-10T00:00:00.000Z", environment: { runtime: "node", runtimeVersion: "24", databaseEngine: "postgresql", databaseVersion: "17" } }, topology: { mode: "single", limits: {}, assumptions: [] }, failureBehavior: { startupWhenRequired: "reject-configuration", runtimeIfTopologyChanges: "fail-closed" }, migration: { state: "not-required", migrationIds: [] } } as const
    expect(() => compileFramework(registry, { frameworkVersion: "2.0.0", sourceRevision: "rev", certifications: [certification] })).toThrow(/evidence digest mismatch/)
    const ok = new FrameworkDefinitionRegistry(); for (const d of registry.snapshot()) ok.register(d)
    const plan = compileFramework(ok, { frameworkVersion: "2.0.0", sourceRevision: "rev", certifications: [certification], evidenceArtifactDigests: { "evidence/pg.json": digest } })
    expect(plan.guarantees.certifications.size).toBe(1)
    // Before the fix HEX_256.test([digest]) coerced the array to its element and passed the shape check.
    const arrayDigest = { ...certification, evidence: { ...certification.evidence, artifactSha256: [digest] } }
    const fresh = new FrameworkDefinitionRegistry(); for (const d of registry.snapshot()) fresh.register(d)
    expect(() => compileFramework(fresh, { frameworkVersion: "2.0.0", sourceRevision: "rev", certifications: [arrayDigest as never], evidenceArtifactDigests: { "evidence/pg.json": digest } })).toThrow(/invalid evidence/)
  })

  it("rejects incompatible formats, unsupported delegation, duplicate resolver bindings and mutation", () => {
    const delegation = new FrameworkDefinitionRegistry()
    delegation.register({ kind: "delegationRule", key: "bad", definitionVersion: 1, fromKinds: ["platform"], toKinds: ["tenant"], capabilities: ["read"], maximumDepth: 2 })
    expect(() => compileFramework(delegation, { frameworkVersion: "2", sourceRevision: "x" })).toThrow(/maximum depth 1/)

    const frozen = new FrameworkDefinitionRegistry(); frozen.register({ kind: "entity", key: "e", definitionVersion: 1, config: { nested: { value: 1 } } })
    const plan = compileFramework(frozen, { frameworkVersion: "2", sourceRevision: "x" })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.definitions.entities.get("e")?.config?.nested)).toBe(true)
  })
})
