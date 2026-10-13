import { ConfigurationError } from "../domain/errors.js"
import { encodeExecutionScopeId, type ExecutionScope } from "../domain/executionScope.js"
import type { ScopeResolver } from "../security/scopeResolver.js"
import { COMPILED_DURABLE_FORMAT_REGISTRY_V1, validateRegistry, type CompiledDurableFormatRegistry } from "../serialization/formatRegistry.js"
import { canonicalSha256Hex } from "../serialization/canonicalJson.js"
import { GUARANTEE_CERTIFICATION_SCHEMA, GUARANTEE_CERTIFICATION_SCHEMA_VERSION, GUARANTEE_IDS, type GuaranteeId } from "../spec/guarantees.js"
import type { DatasourceDefinition, DelegationRuleDefinition, FrameworkDefinition, FrameworkDefinitionKind, FrameworkReference, RouteDefinition, ScopeResolverDefinition } from "./definition.js"
import type { CompiledConsumerPlan, CompiledDatasourceBinding, CompiledDefinitionPlan, CompiledDelegationRule, CompiledEntityPlan, CompiledEventPlan, CompiledFrameworkPlan, CompiledJobPlan, CompiledOperationPlan, CompiledPolicyPlan, CompiledPortBindingRequirement, CompiledReadinessRequirement, CompiledReadModelPlan, CompiledRoutePlan, CompiledSchedulePlan, CompiledScopeResolverBinding, CompiledWorkerBinding, CompiledWorkflowPlan, GuaranteeCertificationV1 } from "./compiledPlan.js"
import { definitionId, resolveDependencyOrder } from "./dependencyGraph.js"
import { type FrameworkDefinitionRegistry } from "./definitionRegistry.js"
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity.js"
import { readonlyMap } from "../kernel/readonlyCollections.js"
import { assertUniqueCacheKeyPrefixes } from "../entity/cachePrefixes.js"

export interface CompileFrameworkOptions {
  readonly frameworkVersion: string; readonly sourceRevision: string; readonly availableCapabilities?: readonly string[]
  readonly scopeResolvers?: readonly ScopeResolver[]; readonly certifications?: readonly GuaranteeCertificationV1[]
  readonly durableFormats?: CompiledDurableFormatRegistry; readonly evidenceArtifactDigests?: Readonly<Record<string, string>>
  readonly compiledAt?: string; readonly production?: boolean
}
const SCOPE_KINDS = new Set<ExecutionScope["kind"]>(["application", "tenant", "platform", "system"])
const HEX_256 = /^[a-f0-9]{64}$/
function fail(message: string): never { throw new ConfigurationError(message) }
function nonEmpty(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || value.trim() === "") fail(`${name} must be a non-empty string`) }
function unique(values: readonly string[], name: string): void { if (new Set(values).size !== values.length) fail(`duplicate ${name}`); for (const value of values) nonEmpty(value, name) }
function deepFreeze<T>(value: T): T { return cloneAndFreezeDefinition(value) }
function implicitReferences(definition: FrameworkDefinition): readonly FrameworkReference[] {
  const refs: FrameworkReference[] = [...(definition.references ?? [])]
  const add = (kind: FrameworkReference["kind"], key?: string) => { if (key && !refs.some(r => r.kind === kind && r.key === key)) refs.push({ kind, key }) }
  add("datasource", definition.datasourceKey); add("policy", definition.policyKey)
  for (const key of definition.eventKeys ?? []) add("event", key)
  for (const key of definition.operationKeys ?? []) add("operation", key)
  for (const key of definition.workflowKeys ?? []) add("workflow", key)
  if (definition.kind === "route") add("operation", (definition as RouteDefinition).operationKey)
  if (definition.kind === "route") { const route = definition as RouteDefinition; add("policy", route.authorizationPlanKey); if (route.scopeResolution?.kind === "resolver") add("scopeResolver", route.scopeResolution.resolverKey) }
  return refs
}
function normalize(definition: FrameworkDefinition): FrameworkDefinition {
  const clone = cloneAndFreezeDefinition(definition, true)
  return cloneAndFreezeDefinition({ ...clone, ...(clone.requiredCapabilities ? { requiredCapabilities: [...new Set(clone.requiredCapabilities)].sort() } : {}), references: implicitReferences(clone) }, true)
}
function assertCertification(cert: GuaranteeCertificationV1, options: CompileFrameworkOptions): string {
  if (cert.schema !== GUARANTEE_CERTIFICATION_SCHEMA || cert.schemaVersion !== GUARANTEE_CERTIFICATION_SCHEMA_VERSION) fail("invalid guarantee certification schema")
  if (!GUARANTEE_IDS.includes(cert.guarantee)) fail(`invalid guarantee ${String(cert.guarantee)}`)
  nonEmpty(cert.adapter?.packageName, "adapter.packageName"); nonEmpty(cert.adapter?.packageVersion, "adapter.packageVersion"); nonEmpty(cert.adapter?.adapterBuildId, "adapter.adapterBuildId")
  if (!(["proven", "unsupported", "experimental"] as const).includes(cert.status)) fail(`invalid guarantee status ${String(cert.status)}`)
  if (cert.status === "proven") {
    const evidence = cert.evidence
    if (!evidence) fail(`proven certification ${cert.guarantee} has no evidence`)
    if (!Number.isSafeInteger(evidence.suiteVersion) || evidence.suiteVersion < 1 || !HEX_256.test(evidence.artifactSha256)) fail(`invalid evidence for ${cert.guarantee}`)
    nonEmpty(evidence.suiteId, "evidence.suiteId"); nonEmpty(evidence.artifactPath, "evidence.artifactPath")
    if (evidence.sourceRevision !== options.sourceRevision || evidence.frameworkVersion !== options.frameworkVersion) fail(`stale evidence for ${cert.guarantee}`)
    if (!Number.isFinite(Date.parse(evidence.executedAt))) fail(`invalid evidence timestamp for ${cert.guarantee}`)
    const observed = options.evidenceArtifactDigests?.[evidence.artifactPath]
    if (observed === undefined || observed !== evidence.artifactSha256) fail(`evidence digest mismatch for ${cert.guarantee}`)
    if (cert.migration.state === "required-not-applied") fail(`required migration not applied for ${cert.guarantee}`)
  }
  return `${cert.adapter.packageName}:${cert.adapter.adapterBuildId}:${cert.guarantee}`
}
function validateFormats(registry: CompiledDurableFormatRegistry, definitions: readonly FrameworkDefinition[]): void {
  validateRegistry(registry.entries)
  if (registry.byFormatId.size !== registry.entries.length) fail("durable format registry index mismatch")
  for (const entry of registry.entries) {
    const indexed = registry.byFormatId.get(entry.formatId)
    if (!indexed || indexed.formatVersion !== entry.formatVersion || !entry.readableVersions.includes(entry.formatVersion)) fail(`durable format ${entry.formatId} is not current-version readable`)
  }
  for (const definition of definitions) for (const required of definition.requiredFormats ?? []) {
    const actual = registry.byFormatId.get(required.formatId)
    if (!actual) fail(`missing durable format ${required.formatId} required by ${definitionId(definition)}`)
    if (!required.readableVersions.every(v => actual.readableVersions.includes(v))) fail(`durable format ${required.formatId} reader incompatibility`)
    if (required.writableVersion !== undefined && actual.formatVersion !== required.writableVersion) fail(`durable format ${required.formatId} writer incompatibility`)
  }
}
function sealFormats(registry: CompiledDurableFormatRegistry): CompiledDurableFormatRegistry {
  const entries = Object.freeze(registry.entries.map(entry => cloneAndFreezeDefinition(entry, true)))
  return deepFreeze({ entries, byFormatId: readonlyMap(entries.map(entry => [entry.formatId, entry] as const)) })
}

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
const PATH_PARAMETER = /^:[A-Za-z_][A-Za-z0-9_]*$/
const PATH_LITERAL = /^[A-Za-z0-9._~!$&'()*+,;=@%-]+$/

/**
 * Validates an HTTP path template ("/", "/orders/:id") and returns its shape
 * with parameter names erased, so "/orders/:id" and "/orders/:orderId"
 * collide as the ambiguous routes they are.
 */
function routeShape(route: RouteDefinition): string {
  nonEmpty(route.path, `route ${route.key} path`)
  if (route.path === "/") return "/"
  if (!route.path.startsWith("/") || route.path.endsWith("/")) fail(`route ${route.key} path must start with "/" and must not end with "/"`)
  const names = new Set<string>()
  return route.path.split("/").slice(1).map((segment) => {
    if (PATH_PARAMETER.test(segment)) {
      if (names.has(segment)) fail(`route ${route.key} repeats path parameter ${segment}`)
      names.add(segment)
      return "/:"
    }
    if (segment === "." || segment === ".." || !PATH_LITERAL.test(segment)) fail(`route ${route.key} has an invalid path segment ${JSON.stringify(segment)}`)
    return `/${segment}`
  }).join("")
}

export function compileFramework(registry: FrameworkDefinitionRegistry, options: CompileFrameworkOptions): CompiledFrameworkPlan {
  nonEmpty(options.frameworkVersion, "frameworkVersion"); nonEmpty(options.sourceRevision, "sourceRevision")
  registry.transition("OPEN", "NORMALIZING")
  try {
    return compileOpenedRegistry(registry, options)
  } catch (error) {
    // A failed compile must not wedge the process: the registry returns to
    // OPEN so the application can correct its definitions and compile again.
    registry.reopenAfterFailedCompilation()
    throw error
  }
}

function compileOpenedRegistry(registry: FrameworkDefinitionRegistry, options: CompileFrameworkOptions): CompiledFrameworkPlan {
  const definitions = registry.snapshot().map(normalize)
  registry.transition("NORMALIZING", "RESOLVING")
  const startupOrder = resolveDependencyOrder(definitions)
  const byId = new Map(definitions.map(d => [definitionId(d), d]))
  const capabilities = new Set(options.availableCapabilities ?? [])
  unique([...capabilities], "available capability")
  for (const definition of definitions) {
    for (const capability of definition.requiredCapabilities ?? []) if (!capabilities.has(capability)) fail(`missing capability ${capability} required by ${definitionId(definition)}`)
    if (definition.datasourceKey) {
      const datasource = byId.get(`datasource:${definition.datasourceKey}`) as DatasourceDefinition | undefined
      if (!datasource) fail(`missing datasource ${definition.datasourceKey} required by ${definitionId(definition)}`)
      for (const capability of definition.requiredCapabilities ?? []) if (!datasource.capabilities.includes(capability)) fail(`datasource ${datasource.key} lacks capability ${capability} required by ${definitionId(definition)}`)
    }
  }
  // Entities declare their resolved cache key prefix in config.cache.keyPrefix; an
  // explicit prefix shared by two entities would mix their cached rows.
  assertUniqueCacheKeyPrefixes(definitions.flatMap(d => {
    const keyPrefix = d.kind === "entity" ? (d.config?.cache as { keyPrefix?: unknown } | undefined)?.keyPrefix : undefined
    return typeof keyPrefix === "string" ? [{ owner: definitionId(d), keyPrefix }] : []
  }))
  const formatSource = options.durableFormats ?? COMPILED_DURABLE_FORMAT_REGISTRY_V1
  validateFormats(formatSource, definitions)
  const durableFormats = sealFormats(formatSource)
  registry.transition("RESOLVING", "COMPILING")
  const compiled = definitions.map(definition => deepFreeze({ ...definition, definitionId: definitionId(definition), dependencies: implicitReferences(definition).map(r => `${r.kind}:${r.key}`) }) as CompiledDefinitionPlan)
  const groups = new Map<string, [string, CompiledDefinitionPlan][]>(); for (const plan of compiled) { const list = groups.get(plan.kind) ?? []; list.push([plan.key, plan]); groups.set(plan.kind, list) }
  const group = <K extends FrameworkDefinitionKind>(kind: K): ReadonlyMap<string, CompiledDefinitionPlan<K>> => readonlyMap((groups.get(kind) ?? []).map(([key, plan]) => [key, plan as CompiledDefinitionPlan<K>] as const))
  const resolverPorts = new Map<string, ScopeResolver>(); for (const resolver of options.scopeResolvers ?? []) { nonEmpty(resolver.key, "resolver key"); if (resolverPorts.has(resolver.key)) fail(`duplicate scope resolver ${resolver.key}`); resolverPorts.set(resolver.key, resolver) }
  const resolverDefinitions = definitions.filter(d => d.kind === "scopeResolver") as ScopeResolverDefinition[]
  const resolverBindings: [string, CompiledScopeResolverBinding][] = []
  for (const definition of resolverDefinitions) { const resolver = resolverPorts.get(definition.key); if (!resolver) fail(`missing scope resolver runtime ${definition.key}`); unique(definition.allowedTargetKinds, "resolver target kind"); if (definition.allowedTargetKinds.length === 0) fail(`scope resolver ${definition.key} has no allowed target kinds`); if (definition.allowedTargetKinds.some(k => !SCOPE_KINDS.has(k))) fail(`invalid resolver target kind for ${definition.key}`); resolverBindings.push([definition.key, deepFreeze({ key: definition.key, definitionVersion: definition.definitionVersion, resolver, allowedTargetKinds: [...definition.allowedTargetKinds] })]) }
  for (const key of resolverPorts.keys()) if (!resolverDefinitions.some(d => d.key === key)) fail(`scope resolver runtime ${key} has no definition`)
  const resolverMap = readonlyMap(resolverBindings)
  const routeEntries: [string, CompiledRoutePlan][] = []
  const routeShapes = new Map<string, string>()
  for (const raw of definitions.filter(d => d.kind === "route") as RouteDefinition[]) {
    nonEmpty(raw.method, `route ${raw.key} method`)
    const method = raw.method.toUpperCase()
    if (!HTTP_METHODS.has(method)) fail(`route ${raw.key} has unsupported HTTP method ${raw.method}`)
    const shape = `${method} ${routeShape(raw)}`
    const clash = routeShapes.get(shape)
    if (clash !== undefined) fail(`routes ${clash} and ${raw.key} both handle ${method} ${raw.path}`)
    routeShapes.set(shape, raw.key)
    const operation = byId.get(`operation:${raw.operationKey}`); if (!operation) fail(`route ${raw.key} references missing operation ${raw.operationKey}`)
    const policyKey = raw.authorizationPlanKey ?? raw.policyKey ?? operation.policyKey; if (!policyKey || !byId.has(`policy:${policyKey}`)) fail(`route ${raw.key} references missing authorization policy`)
    const scopeResolution = raw.scopeResolution
    if (!scopeResolution) fail(`route ${raw.key} has no scope resolution plan`)
    if (scopeResolution.kind === "resolver") { const binding = resolverMap.get(scopeResolution.resolverKey); if (!binding) fail(`route ${raw.key} references missing scope resolver ${scopeResolution.resolverKey}`); unique(scopeResolution.allowedTargetKinds, "route target kind"); if (scopeResolution.allowedTargetKinds.length === 0) fail(`route ${raw.key} has no allowed target kinds`); if (scopeResolution.allowedTargetKinds.some(k => !binding.allowedTargetKinds.includes(k))) fail(`route ${raw.key} widens resolver target kinds`) }
    else { encodeExecutionScopeId(scopeResolution.scope); if (raw.exposure === "public") fail(`public route ${raw.key} must use resolver scope resolution`) }
    const isPublic = raw.exposure === "public"
    routeEntries.push([raw.key, deepFreeze({ key: raw.key, routeKey: raw.key, definitionVersion: raw.definitionVersion, transport: "http", method, pathTemplate: raw.path, exposure: raw.exposure, operationKey: raw.operationKey, scopeResolution, anonymousPrincipal: isPublic ? { allowed: true, principal: { kind: "anonymous", id: "anonymous", authentication: { kind: "anonymous" } } } : { allowed: false }, inputPolicy: raw.inputPolicy ?? {}, outputPolicy: raw.outputPolicy ?? {}, mutation: raw.mutation ?? { allowed: false }, authorizationPlanKey: policyKey })])
  }
  for (const raw of definitions.filter(d => d.kind === "delegationRule") as DelegationRuleDefinition[]) { unique(raw.fromKinds, "delegation source kind"); unique(raw.toKinds, "delegation target kind"); unique(raw.capabilities, "delegation capability"); if ((raw.maximumDepth ?? 1) !== 1) fail(`delegation rule ${raw.key} must use maximum depth 1`); if (raw.allowImpersonation) fail(`delegation rule ${raw.key} cannot enable nested impersonation`) }
  const certificationEntries: [string, GuaranteeCertificationV1][] = []; for (const cert of options.certifications ?? []) { const key = assertCertification(cert, options); if (certificationEntries.some(([k]) => k === key)) fail(`duplicate guarantee certification ${key}`); certificationEntries.push([key, cloneAndFreezeDefinition(cert, true)]) }
  const certifications = readonlyMap(certificationEntries)
  const requirements: [string, readonly GuaranteeId[]][] = []
  for (const definition of definitions) if (definition.requiredGuarantees?.length) { const planKey = definitionId(definition); const required = Object.freeze([...new Set(definition.requiredGuarantees)]); requirements.push([planKey, required]); const datasource = definition.datasourceKey ? byId.get(`datasource:${definition.datasourceKey}`) as DatasourceDefinition | undefined : undefined; for (const guarantee of required) { const matches = [...certifications.values()].filter(c => c.guarantee === guarantee && c.status === "proven" && (!datasource || (c.adapter.packageName === datasource.adapter && (!datasource.adapterBuildId || c.adapter.adapterBuildId === datasource.adapterBuildId)))); if (!matches.length) fail(`missing proven certification ${guarantee} required by ${planKey}`) } }
  const policyEntries = groups.get("policy") ?? []; const policyDigests = readonlyMap(policyEntries.map(([key, plan]) => [key, canonicalSha256Hex(plan)] as const))
  const datasources = readonlyMap((groups.get("datasource") ?? []).map(([key, plan]) => { const d = plan as CompiledDefinitionPlan & DatasourceDefinition; unique(d.capabilities, "datasource capability"); return [key, d] as const }))
  const readinessByKey = new Map<string, CompiledReadinessRequirement>(); const portsByKey = new Map<string, CompiledPortBindingRequirement>(); const workers: CompiledWorkerBinding[] = []
  for (const definition of definitions) { for (const req of definition.readiness ?? []) { const prior = readinessByKey.get(req.key); if (prior && prior.description !== req.description) fail(`conflicting readiness requirement ${req.key}`); readinessByKey.set(req.key, deepFreeze({ ...req })) }; for (const req of definition.requiredPorts ?? []) { const next = deepFreeze({ key: req.key, capability: req.capability, optional: req.optional === true }); const prior = portsByKey.get(req.key); if (prior && (prior.capability !== next.capability || prior.optional !== next.optional)) fail(`conflicting runtime port ${req.key}`); portsByKey.set(req.key, next) }; if (["consumer", "job", "schedule", "workflow"].includes(definition.kind)) workers.push(deepFreeze({ key: definition.key, definitionKey: definitionId(definition), kind: definition.kind as CompiledWorkerBinding["kind"] })) }
  registry.transition("COMPILING", "SEALED")
  return deepFreeze({ framework: { frameworkVersion: options.frameworkVersion, sourceRevision: options.sourceRevision, compiledAt: options.compiledAt ?? new Date().toISOString() }, definitions: {
    entities: group("entity"),
    operations: group("operation"),
    readModels: group("readModel"),
    events: group("event"),
    consumers: group("consumer"),
    jobs: group("job"),
    schedules: group("schedule"),
    workflows: group("workflow"),
  }, routes: readonlyMap(routeEntries), datasources, authority: {
    delegationRules: group("delegationRule"), scopeResolvers: resolverMap,
  }, authorization: { policies: group("policy"), digests: policyDigests }, guarantees: { certifications, requirementsByPlan: readonlyMap(requirements) }, durableFormats, readiness: { requirements: Object.freeze([...readinessByKey.values()]) }, runtimeBindings: { requiredPorts: Object.freeze([...portsByKey.values()]), workerBindings: Object.freeze(workers), startupOrder } })
}
