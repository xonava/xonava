// Source of truth for the code blocks in docs/guides/standalone-application.md and the
// "Standalone application" example in README.md. documentationExamples.test.ts compiles and
// runs this module and checks that every ```ts block in the guide and the README example
// appears here verbatim. integration/shared/platformScope.ts runs the same entity and
// handlers against PostgreSQL, MySQL and D1.
import { z } from "zod"
import { CRUD, type CrudRuntime } from "@xonava/adapters/http"
import type { FrameworkAdapterDeps, FrameworkRequestNormalization } from "@xonava/adapters/server"
import type { CompiledRouteBinding } from "@xonava/core/bootstrap"
import {
  createAbacBundle,
  defineAbacModule,
  evaluatePredicate,
  type AbacPolicy,
  type ExecutionScope,
  type PredicateNode,
  type Principal,
  type RequestContext,
} from "@xonava/core/domain"
import { defineEntity } from "@xonava/core/entity"
import { createJobRegistry, type JobStore } from "@xonava/core/execution"
import type { PersistenceProvider } from "@xonava/core/persistence"
import type { AbacPolicyProvider } from "@xonava/core/security"

// --8<-- entity
export const MODULE_KEY = "app.announcements"

export type Announcement = {
  id: string
  title: string
  region: string
  priority: number
  version: number
}

const body = z.object({ title: z.string().min(1).max(200), region: z.string().min(1), priority: z.number().int() }).strict()
const patch = body.partial()

export const announcements = defineEntity<Announcement, z.infer<typeof body>, z.infer<typeof patch>, Announcement, Announcement>({
  moduleKey: MODULE_KEY,
  entity: {
    name: "announcement",
    primaryKey: "id",
    versionField: "version",
    fields: {
      id: { type: "uuid" },
      title: { type: "string" },
      region: { type: "string" },
      priority: { type: "number" },
      version: { type: "number" },
    },
  },
  // One deployment, no tenants: the row has no tenant or application column.
  entityScope: { kind: "platform", acknowledged: true },
  policy: { customCapabilityKey: "announcements" },
  cache: false,
  audit: false,
  validation: {
    idParams: z.object({ id: z.string().uuid() }).strict(),
    createBody: body,
    updateBody: patch,
  },
})
// --8<-- end

// --8<-- policy
export const announcementsCatalog = defineAbacModule({
  moduleKey: MODULE_KEY,
  actions: ["read", "create", "update", "delete"],
  capabilities: ["announcements"],
  fields: {
    id: { key: "id", type: "identifier", operators: ["equals"] },
    title: { key: "title", type: "string", operators: ["equals"] },
    region: { key: "region", type: "string", operators: ["equals"] },
    priority: { key: "priority", type: "number", operators: ["equals"] },
    version: { key: "version", type: "number", operators: ["equals"] },
  },
})

// Staff may manage every announcement. A deployment that wants less writes narrower conditions.
export const staffPolicy: AbacPolicy = {
  source: { policyId: "staff-announcements", scopeType: "platform_default" },
  moduleKey: MODULE_KEY,
  effect: "allow",
  priority: 10,
  payload: {
    actions: ["read", "create", "update", "delete"],
    capabilities: ["announcements"],
    conditions: {
      version: 2,
      systemScope: { logic: "AND", conditions: [] },
      userFilters: { logic: "AND", conditions: [] },
    },
  },
}

export const policyProvider: AbacPolicyProvider = {
  async resolve() {
    return [staffPolicy]
  },
}

export const adapterDeps: FrameworkAdapterDeps = {
  assertValidCsrf: () => undefined,
  async resolveAbacBundle({ moduleKey, context }) {
    if (context.scope.kind !== "platform") return null
    return createAbacBundle({
      provider: policyProvider,
      mode: "platform",
      moduleKey,
      catalog: announcementsCatalog,
      context: { userId: context.identity.subject.id },
    })
  },
  // Module entitlements are consulted for tenant scope only. A platform route is
  // authorized by the ABAC bundle above, so this deployment has nothing to add here.
  resolveModuleAuthorizationFacts: ({ moduleKey }) => ({
    enabledModuleKeys: [moduleKey],
    enabledModuleActions: {},
    enabledModuleCapabilities: {},
  }),
}
// --8<-- end

// --8<-- routes
// The scope is fixed in the route plan, never read from the request.
export const PLATFORM_SCOPE = { kind: "platform", platformKey: "acme" } as const satisfies ExecutionScope

export interface StaffLogin {
  userId: string
  sessionId: string
}

function routeBinding(action: "list" | "detail" | "create" | "update" | "delete"): CompiledRouteBinding {
  const mutates = action === "create" || action === "update" || action === "delete"
  return {
    routeKey: `announcements.${action}`,
    definitionVersion: 1,
    transport: "http",
    method: action === "create" ? "POST" : action === "update" ? "PATCH" : action === "delete" ? "DELETE" : "GET",
    pathTemplate: action === "list" || action === "create" ? "/announcements" : "/announcements/:id",
    exposure: "authenticated",
    operationKey: `app.announcements.${action}`,
    scopeResolution: { kind: "fixed", scope: PLATFORM_SCOPE },
    anonymousPrincipal: { allowed: false },
    inputPolicy: {},
    outputPolicy: {},
    mutation: mutates ? { allowed: true, idempotencyRequirement: "optional" } : { allowed: false },
    authorizationPlanKey: "app.announcements",
  }
}

export function staffRequestNormalization(
  verifyLogin: (request: Request) => Promise<StaffLogin | undefined>,
): FrameworkRequestNormalization {
  return {
    routeBindings: {
      list: routeBinding("list"),
      detail: routeBinding("detail"),
      create: routeBinding("create"),
      update: routeBinding("update"),
      delete: routeBinding("delete"),
    },
    resolverBindings: new Map(),
    async resolveTrustedSession({ request }) {
      const login = await verifyLogin(request)
      if (!login) return undefined
      const staff: Principal = {
        id: login.userId,
        kind: "human",
        authentication: {
          kind: "authenticated",
          method: "password",
          authenticatedAt: new Date().toISOString(),
          sessionId: login.sessionId,
        },
      }
      return { identity: { actor: staff, subject: staff }, scope: PLATFORM_SCOPE }
    },
    async resolveAdmissionEvidence() {
      const now = new Date().toISOString()
      return {
        grantId: "staff-session",
        purpose: "staff-administration",
        reason: "authenticated staff member",
        issuedAt: now,
        policy: {
          policyKey: "app.announcements",
          policyVersion: 1,
          policyDigest: "staff-administration",
          evaluatedAt: now,
          authorizationModel: "continuous",
        },
      }
    },
  }
}
// --8<-- end

// --8<-- handlers
export function createAnnouncementHandlers(
  runtime: Pick<CrudRuntime, "createPersistence" | "getCacheAdapter">,
  verifyLogin: (request: Request) => Promise<StaffLogin | undefined>,
) {
  return CRUD(announcements, {
    adapterDeps,
    requestNormalization: staffRequestNormalization(verifyLogin),
    scope: { scope: "platform", idempotency: { required: false } },
    createPersistence: runtime.createPersistence,
    getCacheAdapter: runtime.getCacheAdapter,
  })
}
// --8<-- end

// --8<-- jobs
// Jobs and schedules run under the same scope kinds. The stores keep the platformKey or systemKey
// in the scope_key column (migration 0005_job_scope_key), so the key reads back exactly as enqueued.
export const jobs = createJobRegistry()
jobs.register({
  type: "announcements.expire",
  version: 1,
  scope: "platform",
  maxAttempts: 3,
  retryDelayMs: 1_000,
  retryBackoffMultiplier: 2,
  decodePayload: (input) => input as Record<string, unknown>,
  execute: async () => ({ success: true }),
})

export async function enqueueExpiry(store: JobStore) {
  return store.enqueue({
    requester: { scope: "platform", actorId: "staff-1", capabilities: ["enqueue:platform"] },
    job: { executionScope: PLATFORM_SCOPE, jobType: "announcements.expire", jobVersion: 1, payload: {} },
  })
}
// --8<-- end

// ---------------------------------------------------------------------------
// Test support, not shown in the guide: an in-memory persistence provider.
// ---------------------------------------------------------------------------
export function inMemoryAnnouncements(seed: Announcement[]) {
  const rows = new Map(seed.map((row) => [row.id, { ...row }]))
  const select = (filter?: PredicateNode) => [...rows.values()].filter((row) => !filter || evaluatePredicate(row, filter))
  const repository = {
    findById: async (id: string) => rows.get(id) ?? null,
    findOneWhere: async (filter: PredicateNode) => select(filter)[0] ?? null,
    findMany: async ({ filter }: { filter?: PredicateNode }) => ({ rows: select(filter), rowCount: select(filter).length, page: 1, pageSize: 20 }),
    insert: async (row: Announcement) => { rows.set(row.id, { ...row }); return { ...row } },
    update: async (id: string, patch: Partial<Announcement>) => {
      const updated = { ...rows.get(id)!, ...patch }
      rows.set(id, updated)
      return { ...updated }
    },
    delete: async (id: string) => { rows.delete(id) },
    updateOneWhereReturning: async (filter: PredicateNode, patch: Partial<Announcement>) => {
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
