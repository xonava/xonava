// Source of truth for the code blocks in docs/guides/ownership.md.
// documentationExamples.test.ts compiles and runs this module and checks that
// every ```ts block in the guide appears here verbatim.
import { z } from "zod"
import { CRUD, type CrudRuntime } from "@xonava/adapters/http"
import type { FrameworkAdapterDeps, FrameworkRequestNormalization } from "@xonava/adapters/server"
import type { CompiledRouteBinding, CompiledScopeResolverBinding } from "@xonava/core/bootstrap"
import {
  createAbacBundle,
  defineAbacModule,
  ForbiddenError,
  evaluatePredicate,
  type AbacPolicy,
  type PredicateNode,
  type Principal,
  type RequestContext,
} from "@xonava/core/domain"
import { defineEntity } from "@xonava/core/entity"
import type { PersistenceProvider } from "@xonava/core/persistence"
import { createVerifiedScopeResolution, type AbacPolicyProvider, type ScopeResolver } from "@xonava/core/security"

// --8<-- entity
export const MODULE_KEY = "shop.orders"

export type Order = {
  id: string
  tenantId: string
  customerId: string
  status: string
  total: number
  shippingNote: string
  internalNote: string
  version: number
}

export const orders = defineEntity<Order, Record<string, never>, { shippingNote: string }, Order, Order>({
  moduleKey: MODULE_KEY,
  entity: {
    name: "order",
    primaryKey: "id",
    tenantField: "tenantId",
    versionField: "version",
    fields: {
      id: { type: "uuid" },
      tenantId: { type: "string" },
      customerId: { type: "string" },
      status: { type: "string" },
      total: { type: "number" },
      shippingNote: { type: "string" },
      internalNote: { type: "string" },
      version: { type: "number" },
    },
  },
  entityScope: { kind: "tenant" },
  // Customers hold no capability strings. This skips only the capability-key
  // check; module and ABAC action checks still run.
  policy: { skipCapabilityCheck: true },
  cache: false,
  audit: false,
  validation: {
    idParams: z.object({ id: z.string().uuid() }).strict(),
    createBody: z.object({}).strict(),
    updateBody: z.object({ shippingNote: z.string().max(500) }).strict(),
  },
  // Customers never create orders through this surface.
  routes: { create: false },
})
// --8<-- end

// --8<-- catalog
export const ordersCatalog = defineAbacModule({
  moduleKey: MODULE_KEY,
  actions: ["read", "update", "delete"],
  capabilities: [],
  // Every field named in a policy condition or fieldAccess must be listed.
  fields: {
    id: { key: "id", type: "identifier", operators: ["equals"] },
    customerId: { key: "customerId", type: "identifier", operators: ["equals"] },
    status: { key: "status", type: "string", operators: ["equals"] },
    total: { key: "total", type: "number", operators: ["equals"] },
    shippingNote: { key: "shippingNote", type: "string", operators: ["equals"] },
    internalNote: { key: "internalNote", type: "string", operators: ["equals"] },
    version: { key: "version", type: "number", operators: ["equals"] },
  },
})
// --8<-- end

// --8<-- policy
export const ownOrdersPolicy: AbacPolicy = {
  source: { policyId: "customer-own-orders", scopeType: "tenant_default" },
  moduleKey: MODULE_KEY,
  effect: "allow",
  priority: 10,
  payload: {
    actions: ["read", "update", "delete"],
    capabilities: [],
    conditions: {
      version: 2,
      systemScope: {
        logic: "AND",
        conditions: [{ field: "customerId", operator: "equals", userAttr: "user.id" }],
      },
      userFilters: { logic: "AND", conditions: [] },
    },
    fieldAccess: {
      // An allow policy's read map is an allowlist: internalNote is omitted.
      read: {
        id: "allow",
        customerId: "allow",
        status: "allow",
        total: "allow",
        shippingNote: "allow",
        version: "allow",
      },
      write: ["shippingNote"],
    },
  },
}

export const policyProvider: AbacPolicyProvider = {
  async resolve() {
    return [ownOrdersPolicy]
  },
}
// --8<-- end

// --8<-- adapter-deps
export const adapterDeps: FrameworkAdapterDeps = {
  assertValidCsrf: () => undefined,
  async resolveAbacBundle({ moduleKey, context }) {
    if (context.scope.kind !== "tenant") return null
    const bundle = await createAbacBundle({
      provider: policyProvider,
      mode: "tenant",
      moduleKey,
      catalog: ordersCatalog,
      context: { userId: context.identity.subject.id, tenantId: context.scope.tenantId },
    })
    return bundle
  },
  resolveModuleAuthorizationFacts: ({ moduleKey }) => ({
    enabledModuleKeys: [moduleKey],
    enabledModuleActions: { [moduleKey]: ["read", "update", "delete"] },
    enabledModuleCapabilities: {},
  }),
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

function routeBinding(action: "list" | "detail" | "update" | "delete"): CompiledRouteBinding {
  return {
    routeKey: `orders.${action}`,
    definitionVersion: 1,
    transport: "http",
    method: action === "update" ? "PATCH" : action === "delete" ? "DELETE" : "GET",
    pathTemplate: action === "list" ? "/orders" : "/orders/:id",
    exposure: "authenticated",
    operationKey: `shop.orders.${action}`,
    scopeResolution: { kind: "resolver", resolverKey: "session-tenant", allowedTargetKinds: ["tenant"] },
    anonymousPrincipal: { allowed: false },
    inputPolicy: {},
    outputPolicy: {},
    mutation: action === "update" || action === "delete"
      ? { allowed: true, idempotencyRequirement: "optional" }
      : { allowed: false },
    authorizationPlanKey: "shop.orders",
  }
}

export function ordersRequestNormalization(
  verifyLogin: (request: Request) => Promise<VerifiedLogin | undefined>,
): FrameworkRequestNormalization {
  return {
    routeBindings: {
      list: routeBinding("list"),
      detail: routeBinding("detail"),
      update: routeBinding("update"),
      delete: routeBinding("delete"),
      create: routeBinding("detail"), // unused: the create route is disabled
    },
    resolverBindings: new Map([[resolverBinding.key, resolverBinding]]),
    async resolveTrustedSession({ request }) {
      const login = await verifyLogin(request)
      if (!login) return undefined
      const customer: Principal = {
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
        identity: { actor: customer, subject: customer },
        scope: { kind: "tenant", tenantId: login.tenantId },
        resolverFacts: { tenantId: login.tenantId },
      }
    },
    async resolveAdmissionEvidence() {
      const now = new Date().toISOString()
      return {
        grantId: "customer-session",
        purpose: "customer-self-service",
        reason: "authenticated customer",
        issuedAt: now,
        policy: {
          policyKey: "shop.orders",
          policyVersion: 1,
          policyDigest: "customer-self-service",
          evaluatedAt: now,
          authorizationModel: "continuous",
        },
      }
    },
  }
}
// --8<-- end

// --8<-- handlers
export function createOrderHandlers(
  runtime: Pick<CrudRuntime, "createPersistence" | "getCacheAdapter">,
  verifyLogin: (request: Request) => Promise<VerifiedLogin | undefined>,
) {
  return CRUD(orders, {
    adapterDeps,
    requestNormalization: ordersRequestNormalization(verifyLogin),
    scope: { scope: "tenant", idempotency: { required: false } },
    createPersistence: runtime.createPersistence,
    getCacheAdapter: runtime.getCacheAdapter,
  })
}
// --8<-- end

// ---------------------------------------------------------------------------
// Test support, not shown in the guide: an in-memory persistence provider.
// ---------------------------------------------------------------------------
export function inMemoryOrders(seed: Order[]) {
  const rows = new Map(seed.map((row) => [row.id, { ...row }]))
  const select = (filter?: PredicateNode) => [...rows.values()].filter((row) => !filter || evaluatePredicate(row, filter))
  const repository = {
    findById: async (id: string) => rows.get(id) ?? null,
    findOneWhere: async (filter: PredicateNode) => select(filter)[0] ?? null,
    findMany: async ({ filter }: { filter?: PredicateNode }) => ({ rows: select(filter), rowCount: select(filter).length, page: 1, pageSize: 20 }),
    insert: async (row: Order) => { rows.set(row.id, { ...row }); return { ...row } },
    update: async (id: string, patch: Partial<Order>) => {
      const updated = { ...rows.get(id)!, ...patch }
      rows.set(id, updated)
      return { ...updated }
    },
    delete: async (id: string) => { rows.delete(id) },
    updateOneWhereReturning: async (filter: PredicateNode, patch: Partial<Order>) => {
      const current = select(filter)[0]
      if (!current) return null
      const updated = { ...current, ...patch, version: current.version + 1 }
      rows.set(updated.id, updated)
      return { ...updated }
    },
    deleteWhere: async (filter: PredicateNode) => {
      const matches = select(filter)
      for (const row of matches) rows.delete(row.id)
      return { deletedCount: matches.length }
    },
  }
  const persistence = {
    dialect: "test",
    capabilities: { interactiveTransactions: true, atomicBatch: false, returningInsert: true, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100 },
    repository: () => repository,
    runInTransaction: async <T>(work: (provider: PersistenceProvider) => Promise<T>) => work(persistence),
  } as PersistenceProvider
  return { rows, createPersistence: (_context: RequestContext) => persistence }
}
