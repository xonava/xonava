# Standalone applications: platform scope

A standalone application has one deployment and no tenants: an internal tool, a single-company back office, a self-hosted service. Its data belongs to the application as a whole, so it uses the **platform** execution scope. This guide builds an `announcements` entity that staff manage over HTTP, then shows how jobs, schedules and workflows run under the same scope.

Every `ts` block below is compiled and executed by the documentation-example test (`packages/testing/tests/documentationExamples.test.ts`, source in `packages/testing/tests/standaloneGuideExample.ts`), and that test fails if a block here drifts from the compiled source. The same entity and handlers also run against PostgreSQL, MySQL and D1 in `packages/testing/integration/shared/platformScope.ts`. Imports use only public paths from [`package-exports.md`](../reference/package-exports.md).

## How platform scope isolates data

A tenant entity carries a tenant column, and the framework adds `tenantId = <session tenant>` to every read and write. A platform entity has no partition column. Nothing in the row says which deployment it belongs to, because there is only one. Isolation therefore comes from four other places:

1. **The route's fixed scope plan.** The route binding names the scope (`scopeResolution: { kind: "fixed", scope }`). Nothing in the request body, query or headers chooses it.
2. **The optional `scopeFilter`.** `entityScope: { kind: "platform", acknowledged: true, scopeFilter }` takes a predicate that is ANDed into every list, detail, update and delete. Use it when one platform table holds rows that a given route must not reach.
3. **The unwrapped provider.** Platform and system entities use the provider as the adapter built it. The tenant wrapper is not applied, and a tenant-scoped provider **refuses** such an entity (`TenantScopeViolationError`: the entity has no tenant field). Never hand a tenant-scoped provider to code that serves platform data.
4. **ABAC.** Policies decide which staff may read or write which rows and fields. For a platform route the ABAC bundle is the only authorization input: module entitlements (`enabledModuleKeys`, actions, capabilities) are consulted for tenant scope only.

`acknowledged: true` is required. It records that the author knows the entity is not partitioned by tenant or application.

### The current reach rule

The CRUD handlers guard only tenant and application entities: a tenant entity needs a tenant scope and an application entity needs an application scope (`assertEntityScopeContext`). A platform entity is **reachable from a system-scope or application-scope route as well as a platform one**, because the handlers do not check the route's scope kind against a platform entity. This is the current rule, not a recommendation: bind platform entities only to routes whose fixed scope is platform, and keep the `scopeFilter` and ABAC conditions as the second layer.

## 1. Define the entity

```ts
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
```

## 2. Describe the fields to ABAC and write the policy

A policy may only name actions, capabilities and fields that the module catalog lists. A platform bundle is created with `mode: "platform"` and policies with `scopeType: "platform_default"`.

```ts
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
```

## 3. Fix the scope in the route plan

The route binding carries the scope, and the trusted session carries the same scope. Your code verifies the login and returns the session; nothing in the request selects the user or the scope.

```ts
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
```

## 4. Create the handlers

```ts
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
```

`createPersistence` returns the plain provider for your database. See [persistence setup](persistence-setup.md) for PostgreSQL, MySQL and D1. Register the entity with the dialect's `DrizzleEntityRegistry` exactly as in the README quick start, with a table that has **no** tenant column.

Two behaviours to know:

- On databases with interactive transactions (PostgreSQL, MySQL) a successful create answers with an acknowledgement and no row, because the response is built by a read that runs outside the write transaction. Read the row back with the list or detail route.
- D1 applies conditional writes as one atomic batch and needs a `mutationAssertionTable` on the persistence provider.

## 5. Jobs, schedules and workflows

Jobs and schedules run under the `platform` or `system` scope kind, declared on the job definition and carried on the stored job. Jobs, schedules and workflows all keep the full `ExecutionScope`: a job enqueued under `{ kind: "platform", platformKey: "acme" }` reads back with that key (jobs and schedules store it in the `scope_key` column added by migration `0005_job_scope_key`; see [known limitations](../KNOWN-LIMITATIONS.md)), and workflow steps see it as `context.executionScope`.

```ts
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
```

Enqueue with a requester of the same kind (`scope: "platform"` with the `enqueue:platform` capability here; `scope: "system"` for system jobs). Schedules of either scope materialize jobs of the same scope, and the dispatcher refuses to run a job whose definition declares the other scope.

## What the tests prove

- `packages/testing/integration/shared/platformScope.ts` runs CRUD, list, filter, sort, offset pagination and optimistic concurrency for a platform entity on PostgreSQL, MySQL and D1, and checks the table has no partition column.
- The same file drives `createCrudHandlers` with the fixed platform scope plan on a real repository: create, list, detail, `If-Match` updates and deletes, anonymous refusal, caller-supplied scope hints ignored, a `scopeFilter` hiding and protecting other rows, and the reach rule above.
- Jobs, schedules and a signal-waiting workflow run under platform and system scope on all three databases.
