// Source of truth for the code blocks in docs/guides/supporting-reads.md.
// documentationExamples.test.ts compiles and runs this module and checks that
// every ```ts block in the guide appears here verbatim.
import { z } from "zod"
import {
  createFrameworkErrorHandler,
  createFrameworkWriteHandler,
  normalizeFrameworkRequest,
  parseUniqueQueryParameters,
  resolveRequestMetadata,
} from "@xonava/adapters/http"
import type { FrameworkAdapterDeps, FrameworkRequestNormalization } from "@xonava/adapters/server"
import type { CompiledRouteBinding, CompiledScopeResolverBinding } from "@xonava/core/bootstrap"
import {
  assertFrameworkAuthorization,
  createAbacAuthorizer,
  createAbacBundle,
  defineAbacModule,
  evaluatePredicate,
  ForbiddenError,
  NotFoundError,
  Predicate,
  PublicBusinessError,
  ValidationError,
  type AbacPolicy,
  type PredicateNode,
  type Principal,
  type RequestContext,
} from "@xonava/core/domain"
import { createOperation, type MutationOperationContext, type OperationAuthorizationPort } from "@xonava/core/operation"
import {
  createTenantScopedPersistenceProvider,
  type PersistenceProvider,
  type UnversionedEntityDescriptor,
} from "@xonava/core/persistence"
import { createVerifiedScopeResolution, type AbacPolicyProvider, type ScopeResolver } from "@xonava/core/security"

// --8<-- model
export const ORDERS = "shop.orders"
export const WAREHOUSES = "shop.warehouses"

export type Order = { id: string; tenantId: string; status: string; region: string; warehouseId: string | null }

export type Warehouse = {
  id: string
  tenantId: string
  label: string
  region: string
  active: boolean
  internalCostCentre: string
}

export const orderEntity: UnversionedEntityDescriptor<Order> = {
  name: "order",
  primaryKey: "id",
  tenantField: "tenantId",
  fields: {
    id: { type: "uuid" },
    tenantId: { type: "string" },
    status: { type: "string" },
    region: { type: "string" },
    warehouseId: { type: "uuid" },
  },
}

export const warehouseEntity: UnversionedEntityDescriptor<Warehouse> = {
  name: "warehouse",
  primaryKey: "id",
  tenantField: "tenantId",
  fields: {
    id: { type: "uuid" },
    tenantId: { type: "string" },
    label: { type: "string" },
    region: { type: "string" },
    active: { type: "boolean" },
    internalCostCentre: { type: "string" },
  },
}
// --8<-- end

// --8<-- policies
// The parent action is "assignWarehouse" on the orders module. The warehouses
// module is a different module with its own catalog and its own policies.
export const ordersCatalog = defineAbacModule({
  moduleKey: ORDERS,
  actions: ["read", "assignWarehouse"],
  capabilities: [],
  fields: {
    id: { key: "id", type: "identifier", operators: ["equals"] },
    status: { key: "status", type: "string", operators: ["equals"] },
    region: { key: "region", type: "string", operators: ["equals"] },
    warehouseId: { key: "warehouseId", type: "identifier", operators: ["equals"] },
  },
})

export const warehousesCatalog = defineAbacModule({
  moduleKey: WAREHOUSES,
  actions: ["read"],
  capabilities: [],
  fields: {
    id: { key: "id", type: "identifier", operators: ["equals"] },
    label: { key: "label", type: "string", operators: ["equals"] },
    region: { key: "region", type: "string", operators: ["equals"] },
    active: { key: "active", type: "boolean", operators: ["equals"] },
  },
})

type Condition = AbacPolicy["payload"]["conditions"]["systemScope"]["conditions"][number]

function policy(
  policyId: string,
  moduleKey: string,
  effect: "allow" | "deny",
  priority: number,
  actions: string[],
  conditions: Condition[],
): AbacPolicy {
  return {
    source: { policyId, scopeType: "tenant_default" },
    moduleKey,
    effect,
    priority,
    payload: {
      actions,
      capabilities: [],
      conditions: {
        version: 2,
        systemScope: { logic: "AND", conditions },
        userFilters: { logic: "AND", conditions: [] },
      },
    },
  }
}

/** Your policy store, one list per module. The provider reads it on every request. */
export type PolicyStore = Record<string, AbacPolicy[]>

export function defaultPolicies(): PolicyStore {
  return {
    // A conditional grant: dispatchers may assign a warehouse to open orders only.
    [ORDERS]: [policy("dispatch-open-orders", ORDERS, "allow", 10, ["read", "assignWarehouse"], [{ field: "status", operator: "equals", value: "open" }])],
    // The warehouses module grants read for the EU region only.
    [WAREHOUSES]: [policy("read-eu-warehouses", WAREHOUSES, "allow", 10, ["read"], [{ field: "region", operator: "equals", value: "eu" }])],
  }
}
// --8<-- end

// --8<-- adapter-deps
export type Entitlements = { enabledModuleKeys: string[]; enabledModuleActions: Record<string, string[]> }

export function defaultEntitlements(): Entitlements {
  return {
    enabledModuleKeys: [ORDERS, WAREHOUSES],
    enabledModuleActions: { [ORDERS]: ["read", "assignWarehouse"], [WAREHOUSES]: ["read"] },
  }
}

export function createAdapterDeps(store: PolicyStore, entitlements: Entitlements): FrameworkAdapterDeps {
  const provider: AbacPolicyProvider = {
    async resolve({ moduleKey }) {
      return store[moduleKey] ?? []
    },
  }
  return {
    assertValidCsrf: () => undefined,
    // Called on every request: the bundle is built fresh from the policy store,
    // so a revoked policy takes effect on the next call. Nothing is kept in the session.
    async resolveAbacBundle({ moduleKey, context }) {
      if (context.scope.kind !== "tenant") return null
      const catalog = moduleKey === ORDERS ? ordersCatalog : moduleKey === WAREHOUSES ? warehousesCatalog : undefined
      if (!catalog) return null
      return createAbacBundle({
        provider,
        mode: "tenant",
        moduleKey,
        catalog,
        context: { userId: context.identity.subject.id, tenantId: context.scope.tenantId },
      })
    },
    resolveModuleAuthorizationFacts: () => ({ ...entitlements }),
  }
}
// --8<-- end

// --8<-- session
export interface VerifiedLogin {
  userId: string
  tenantId: string
  sessionId: string
}

// The tenant comes from the verified session, never from the request.
const tenantFromSession: ScopeResolver = {
  key: "session-tenant",
  async resolve(input) {
    const tenantId = input.sessionFacts?.tenantId
    if (typeof tenantId !== "string" || tenantId === "") throw new ForbiddenError("No tenant in the verified session")
    return createVerifiedScopeResolution("session-tenant", { kind: "tenant", tenantId })
  },
}

const resolverBinding: CompiledScopeResolverBinding = {
  key: "session-tenant",
  definitionVersion: 1,
  resolver: tenantFromSession,
  allowedTargetKinds: ["tenant"],
}

function routeBinding(routeKey: "assignWarehouse" | "warehouseOptions"): CompiledRouteBinding {
  const write = routeKey === "assignWarehouse"
  return {
    routeKey,
    definitionVersion: 1,
    transport: "http",
    method: write ? "POST" : "GET",
    pathTemplate: write ? "/orders/:id/assign-warehouse" : "/orders/warehouse-options",
    exposure: "authenticated",
    operationKey: `${ORDERS}.${routeKey}`,
    scopeResolution: { kind: "resolver", resolverKey: "session-tenant", allowedTargetKinds: ["tenant"] },
    anonymousPrincipal: { allowed: false },
    inputPolicy: {},
    outputPolicy: {},
    mutation: write ? { allowed: true, idempotencyRequirement: "optional" } : { allowed: false },
    authorizationPlanKey: ORDERS,
  }
}

export function ordersRequestNormalization(
  verifyLogin: (request: Request) => Promise<VerifiedLogin | undefined>,
): FrameworkRequestNormalization {
  return {
    routeBindings: {
      assignWarehouse: routeBinding("assignWarehouse"),
      warehouseOptions: routeBinding("warehouseOptions"),
      // The type requires the five CRUD keys even though no CRUD handler is built here.
      list: routeBinding("warehouseOptions"),
      detail: routeBinding("warehouseOptions"),
      create: routeBinding("assignWarehouse"),
      update: routeBinding("assignWarehouse"),
      delete: routeBinding("assignWarehouse"),
    },
    resolverBindings: new Map([[resolverBinding.key, resolverBinding]]),
    async resolveTrustedSession({ request }) {
      const login = await verifyLogin(request)
      if (!login) return undefined
      const user: Principal = {
        id: login.userId,
        kind: "human",
        authentication: {
          kind: "authenticated",
          method: "password",
          authenticatedAt: new Date().toISOString(),
          sessionId: login.sessionId,
        },
      }
      return {
        identity: { actor: user, subject: user },
        scope: { kind: "tenant", tenantId: login.tenantId },
        resolverFacts: { tenantId: login.tenantId },
      }
    },
    async resolveAdmissionEvidence() {
      const now = new Date().toISOString()
      return {
        grantId: "dispatcher-session",
        purpose: "order-dispatch",
        reason: "authenticated dispatcher",
        issuedAt: now,
        policy: {
          policyKey: ORDERS,
          policyVersion: 1,
          policyDigest: "order-dispatch",
          evaluatedAt: now,
          authorizationModel: "continuous",
        },
      }
    },
  }
}
// --8<-- end

// --8<-- admission
/** Builds the trusted request context for a hand-written endpoint, as the built-in handlers do. */
async function requestContextFor(
  normalization: FrameworkRequestNormalization,
  request: Request,
  routeKey: string,
  metadata: { requestId: string; correlationId: string },
): Promise<RequestContext> {
  const route = normalization.routeBindings[routeKey]!
  const session = await normalization.resolveTrustedSession({ request, route })
  return normalizeFrameworkRequest({
    ...metadata,
    route,
    resolverBindings: normalization.resolverBindings,
    ...(session === undefined ? {} : { session }),
    admit: ({ identity, scope, scopeId }) => normalization.resolveAdmissionEvidence({ request, route, identity, scope, scopeId }),
    signal: request.signal,
    host: new URL(request.url).hostname,
  })
}

/**
 * Admits a supporting read with the PARENT action. It resolves a fresh bundle for the
 * parent module and asks the same question the save will ask: may this caller run
 * "assignWarehouse"? A deny, a missing grant, a disabled module or a missing bundle
 * all refuse. A conditional grant admits the read, because some order may qualify;
 * the save re-checks the actual order.
 */
export async function admitParentAction(deps: FrameworkAdapterDeps, context: RequestContext, action: string): Promise<void> {
  const bundle = await deps.resolveAbacBundle({ moduleKey: ORDERS, context })
  if (!bundle) throw new ForbiddenError("ABAC authorization bundle unavailable")
  assertFrameworkAuthorization({
    facts: {
      ...deps.resolveModuleAuthorizationFacts?.({ moduleKey: ORDERS, context }),
      scope: "tenant",
      ownerAuthority: false,
      impersonated: false,
    },
    moduleKey: ORDERS,
    action,
    bundle,
  })
}
// --8<-- end

// --8<-- read
/** At most this many options are returned. */
export const WAREHOUSE_OPTION_LIMIT = 25

export type WarehouseOption = { id: string; label: string }
export type WarehouseOptions = { items: WarehouseOption[]; truncated: boolean }

const errorHandler = createFrameworkErrorHandler()

export function createWarehouseOptionsHandler(args: {
  adapterDeps: FrameworkAdapterDeps
  requestNormalization: FrameworkRequestNormalization
  createPersistence: (context: RequestContext) => PersistenceProvider
}) {
  return async (request: Request): Promise<Response> => {
    const metadata = resolveRequestMetadata(request)
    // Every outcome, including errors, must stay out of shared caches.
    const respond = (response: Response): Response => {
      response.headers.set("cache-control", "no-store")
      response.headers.set("x-request-id", metadata.requestId)
      return response
    }
    try {
      const context = await requestContextFor(args.requestNormalization, request, "warehouseOptions", metadata)
      if (context.scope.kind !== "tenant") throw new ForbiddenError("A tenant-scoped session is required")
      await admitParentAction(args.adapterDeps, context, "assignWarehouse")

      const query = parseUniqueQueryParameters(request)
      for (const key of Object.keys(query)) if (key !== "q") throw new ValidationError(`Unknown query parameter: ${key}`)
      const q = query.q?.trim() ?? ""
      if (q.length > 50) throw new ValidationError("q must be at most 50 characters")

      // Tenant scope is structural: this provider cannot reach another tenant's rows.
      const persistence = createTenantScopedPersistenceProvider(args.createPersistence(context), context.scope.tenantId)
      const result = await persistence.repository<Warehouse>(warehouseEntity).findMany({
        filter: q === ""
          ? Predicate.eq("active", true)
          : Predicate.and(Predicate.eq("active", true), Predicate.contains("label", q)),
        sort: [{ field: "label", direction: "asc" }, { field: "id", direction: "asc" }],
        // One more than the limit, to learn whether the list was cut.
        pagination: { kind: "offset", page: 1, pageSize: WAREHOUSE_OPTION_LIMIT + 1 },
      })
      const body: WarehouseOptions = {
        // A fixed allowlist: nothing else on the warehouse row can leave through this endpoint.
        items: result.rows.slice(0, WAREHOUSE_OPTION_LIMIT).map(({ id, label }) => ({ id, label })),
        truncated: result.rows.length > WAREHOUSE_OPTION_LIMIT,
      }
      return respond(Response.json(body))
    } catch (error) {
      return respond(errorHandler(error, metadata))
    }
  }
}
// --8<-- end

// --8<-- save
const tenantSession: OperationAuthorizationPort<unknown> = {
  async authorize({ operation }) {
    return operation.request?.scope.kind === "tenant"
      ? { allowed: true }
      : { allowed: false, reason: "A tenant-scoped session is required" }
  },
}

export function createAssignWarehouse(deps: FrameworkAdapterDeps) {
  return createOperation<{ orderId: string; warehouseId: string }, { id: string; warehouseId: string }>({
    key: `${ORDERS}.assignWarehouse`,
    kind: "mutation",
    atomicity: { kind: "standard", mode: "required" },
    authorization: tenantSession,
    async execute({ operation, input }: { operation: MutationOperationContext; input: { orderId: string; warehouseId: string } }) {
      const request = operation.request!
      // The persistence is tenant-scoped: another tenant's id is simply not found.
      const order = await operation.persistence.repository<Order>(orderEntity).findById(input.orderId)
      if (!order) throw new NotFoundError("Order not found")

      // The chosen id is untrusted input. Load the full warehouse record and ask the
      // warehouses module whether this caller may read it. Having been listed as an
      // option proved nothing; an unreadable warehouse looks like a missing one.
      const warehouse = await operation.persistence.repository<Warehouse>(warehouseEntity).findById(input.warehouseId)
      const warehouseBundle = await deps.resolveAbacBundle({ moduleKey: WAREHOUSES, context: request })
      if (!warehouse || !warehouseBundle || !createAbacAuthorizer(warehouseBundle).canRecordAction("read", warehouse)) {
        throw new NotFoundError("Warehouse not found")
      }
      if (!warehouse.active) {
        throw new PublicBusinessError({
          publicCode: "WAREHOUSE_NOT_ACCEPTING",
          publicMessage: "This warehouse is not accepting orders",
          fields: ["warehouseId"],
        })
      }

      // Re-check the parent action against the full order, including the new value.
      operation.enforceAbac?.enforce("assignWarehouse", { ...order, warehouseId: warehouse.id }, ["warehouseId"])
      await operation.persistence.repository<Order>(orderEntity).update(order.id, { warehouseId: warehouse.id })
      return { id: order.id, warehouseId: warehouse.id }
    },
  })
}

export function createAssignWarehouseHandler(args: {
  adapterDeps: FrameworkAdapterDeps
  requestNormalization: FrameworkRequestNormalization
  createPersistence: (context: RequestContext) => PersistenceProvider
}) {
  return createFrameworkWriteHandler({
    adapterDeps: args.adapterDeps,
    requestNormalization: args.requestNormalization,
    scope: { scope: "tenant", idempotency: { required: false } },
    moduleKey: ORDERS,
    action: "assignWarehouse",
    skipCapabilityCheck: true,
    runtimeCapabilities: { deferredExecution: false, cache: false },
    createPersistence: args.createPersistence,
    validation: {
      params: z.object({ id: z.string().uuid() }).strict(),
      body: z.object({ warehouseId: z.string().uuid() }).strict(),
    },
    definition: createAssignWarehouse(args.adapterDeps).definition,
    resolveInput: async ({ validated }) => ({
      orderId: (validated.validatedParams as { id: string }).id,
      warehouseId: (validated.validatedBody as { warehouseId: string }).warehouseId,
    }),
  })
}
// --8<-- end

// ---------------------------------------------------------------------------
// Test support, not shown in the guide: an in-memory persistence provider.
// ---------------------------------------------------------------------------
export function inMemoryShop(seed: { orders: Order[]; warehouses: Warehouse[] }) {
  const tables: Record<string, Map<string, Record<string, unknown>>> = {
    order: new Map(seed.orders.map((row) => [row.id, { ...row }])),
    warehouse: new Map(seed.warehouses.map((row) => [row.id, { ...row }])),
  }
  const queries: Array<{ entity: string; pageSize: number | undefined }> = []
  const persistence = {
    dialect: "test",
    capabilities: { interactiveTransactions: true, atomicBatch: false, returningInsert: true, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100 },
    repository: (entity: { name: string }) => {
      const rows = tables[entity.name]!
      const select = (filter?: PredicateNode) => [...rows.values()].filter((row) => !filter || evaluatePredicate(row, filter))
      return {
        findById: async (id: string) => (rows.has(id) ? { ...rows.get(id) } : null),
        findOneWhere: async (filter: PredicateNode) => { const row = select(filter)[0]; return row ? { ...row } : null },
        findMany: async (options: { filter?: PredicateNode; sort?: Array<{ field: string; direction: "asc" | "desc" }>; pagination?: { pageSize: number } } = {}) => {
          queries.push({ entity: entity.name, pageSize: options.pagination?.pageSize })
          const matches = select(options.filter).map((row) => ({ ...row }))
          for (const { field, direction } of [...(options.sort ?? [])].reverse()) {
            matches.sort((a, b) => String(a[field]).localeCompare(String(b[field])) * (direction === "asc" ? 1 : -1))
          }
          const pageSize = options.pagination?.pageSize ?? 20
          return { rows: matches.slice(0, pageSize), rowCount: matches.length, page: 1, pageSize }
        },
        update: async (id: string, patch: Record<string, unknown>) => {
          const updated = { ...rows.get(id), ...patch }
          rows.set(id, updated)
          return { ...updated }
        },
        updateOneWhereReturning: async (filter: PredicateNode, patch: Record<string, unknown>) => {
          const current = select(filter)[0]
          if (!current) return null
          const updated = { ...current, ...patch }
          rows.set(updated.id as string, updated)
          return { ...updated }
        },
      }
    },
    runInTransaction: async <T>(work: (provider: PersistenceProvider) => Promise<T>) => work(provider),
  }
  const provider: PersistenceProvider = persistence as never
  return {
    orders: tables.order as unknown as Map<string, Order>,
    warehouses: tables.warehouse as unknown as Map<string, Warehouse>,
    queries,
    createPersistence: (_context: RequestContext) => provider,
  }
}
