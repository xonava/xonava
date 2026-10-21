# Supporting reads for a parent action

A form often needs data from another module to be filled in. Assigning an order to a warehouse needs warehouse labels, but the dispatcher who assigns orders is not a warehouse administrator and should not be handed the warehouse module. This guide shows an application pattern for that case: a **supporting read**, a small read-only endpoint that belongs to the parent module and is admitted by the parent action.

This is a pattern in your application code, not a framework feature. It uses only public APIs: `createFrameworkWriteHandler` for the business action, `createAbacBundle` and `assertFrameworkAuthorization` for admission, and `createTenantScopedPersistenceProvider` for scope.

Every `ts` block below is compiled and executed by the documentation-example test (`packages/testing/tests/documentationExamples.test.ts`, source in `packages/testing/tests/supportingReadsExample.ts`), and that test fails if a block here drifts from the compiled source. Imports use only public paths from [`package-exports.md`](../reference/package-exports.md). The trusted session, tenant scope and policy provider follow [Ownership for non-staff users](ownership.md); read that guide first for what each layer does.

## The rules

1. **The parent action admits the read.** The endpoint is owned by the orders module and is allowed exactly when the caller may run `assignWarehouse` on orders. It does not need, and does not grant, any access to the warehouses module.
2. **The bundle is fresh on every request.** Nothing about the decision is copied into the session or cached, so revoking the parent action revokes the read on the next call.
3. **The response is a fixed allowlist.** The endpoint returns `{ id, label }` and nothing else, built field by field, so a new column on the warehouse row can never leak through it.
4. **The result is bounded, and a cut list says so.** The response carries `truncated: true` when more rows exist; it never silently drops rows.
5. **The response is never cached.** Every outcome carries `cache-control: no-store`.
6. **Choosing an option grants nothing.** The save treats the chosen id as untrusted input and re-checks the full order and the full warehouse record.

## 1. The records

Orders and warehouses live in two modules, `shop.orders` and `shop.warehouses`. Both entities are tenant scoped.

```ts
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
```

## 2. Policies for the parent action

The orders catalog lists the business action `assignWarehouse` next to `read`. A business action is granted on its own and never implied by `update`. Here dispatchers hold a **conditional** grant: they may assign a warehouse to orders whose status is `open`. The warehouses module is separate and, for this caller, grants read for the EU region only. Policies live in your policy store; the provider below reads it on every request.

```ts
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
```

## 3. Resolve a fresh bundle on every request

`resolveAbacBundle` builds the bundle from the current policies each time it is called, for whichever module is asked for. This is what makes revocation immediate. `resolveModuleAuthorizationFacts` lists the module entitlements of the tenant, and the module must have `assignWarehouse` enabled for either endpoint to run.

```ts
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
```

## 4. Session and routes

The trusted session and the tenant scope work as in the ownership guide. There are two route bindings: the business action `assignWarehouse` and the read `warehouseOptions`, both owned by the orders module.

```ts
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
```

## 5. Admit the read with the parent action

`admitParentAction` is the whole authorization step of the supporting read. It asks the question the save will ask, "may this caller run `assignWarehouse` on orders?", and nothing about warehouses.

- A missing bundle, a disabled module or a module without the action is refused (403).
- A missing allow, or an unconditional deny, is refused. Holding `read` on orders, or read on warehouses, does not count: the action must be `assignWarehouse`.
- A **conditional grant admits the read**. The read has no order in hand, so the question is whether the action can be granted at all. The condition (`status` equals `open`) is enforced when an order is actually saved.
- A **conditional deny does not refuse the read** either; it narrows which orders qualify and is enforced by the save.

```ts
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
```

## 6. The supporting read endpoint

The endpoint lists active warehouses of the caller's tenant. It is a plain handler over `Request` and `Response`, so mount it with any adapter. The details that matter:

- **Allowlist.** The row is mapped to `{ id, label }` explicitly. `internalCostCentre`, `region`, `active` and `tenantId` are never serialized.
- **Bound and overflow.** The query asks for one row more than the limit to learn whether the list was cut, returns at most `WAREHOUSE_OPTION_LIMIT` items, and sets `truncated`. The client should then ask the user to type a few letters and call again with `q`. Only `q` is accepted, at most 50 characters; unknown or repeated parameters are a 400.
- **Tenant scope is structural.** The persistence is wrapped with `createTenantScopedPersistenceProvider`, so the query cannot reach another tenant's warehouses even by mistake.
- **No cache.** Every response, errors included, is `cache-control: no-store`: the answer depends on a policy decision that may change a second later.

```ts
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
```

## 7. The save re-checks everything

The business action is the only thing that changes data. The id the user picked is untrusted input, exactly like any other body field; it proves nothing about access to the warehouse. The operation therefore:

1. loads the order through tenant-scoped persistence (another tenant's order is a 404);
2. loads the **full warehouse record** and asks the warehouses module's own fresh bundle whether this caller may read it. If not, the answer is the same 404 as for an id that does not exist, so the response confirms nothing about warehouses the caller cannot see;
3. applies a business rule with `PublicBusinessError`, whose code and message are yours and safe to show (an inactive warehouse is a 4xx with `WAREHOUSE_NOT_ACCEPTING`, not a 403);
4. calls `enforceAbac` with the order and the new `warehouseId`, so the conditional grant is evaluated against the real record. An order that is not `open` is refused with 403 even though the supporting read was admitted.

`createFrameworkWriteHandler` runs the module and ABAC admission for `assignWarehouse` before `execute` starts. Revoking the action therefore stops the save in the same way as it stops the read.

```ts
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
```

For real write routes keep idempotency required: supply `createIdempotencyPort` in the adapter dependencies, a `resolveResourceIdentity` and a `recoverCommittedResponse` (see [`readCommittedRecord`](../typescript/http-adapters.md)). The sample sets `idempotency: { required: false }` to stay short.

## What each point guarantees

| Point | Behaviour | Where it is tested |
|---|---|---|
| Admission by the parent action | Allow, conditional grant and conditional deny admit; an unconditional deny, no grant, a `read`-only grant, a disabled module or no bundle refuse (403); no login is 401 | "is admitted by the parent action through a fresh bundle" |
| Fixed response allowlist | Items contain exactly `id` and `label` | "returns only id and label" |
| Bound and overflow | At most 25 items, `truncated: true` when more exist, `false` at exactly the limit; the store is asked for 26 rows | "bounds the result", "exactly the limit" |
| No cache | `cache-control: no-store` on 200, 400, 401 and 403 | "sets cache-control: no-store" |
| Revocation | Removing the grant refuses the next read and the next save | "revoking the parent action" |
| Choosing grants nothing | A listed warehouse the caller cannot read, another tenant's warehouse and a missing id all answer 404; a non-open order is 403; an inactive warehouse is a public business error | "grants nothing by listing an option" and the two tests after it |

## Limits and notes

- **The labels are a deliberate disclosure.** Everyone who may run `assignWarehouse` can see the id and label of every active warehouse in the tenant, including warehouses they cannot read in the warehouses module. If a label is sensitive, filter the query or do not use this pattern for it.
- **A list is not a permission.** Never skip the re-check on save because "the client could only have picked a listed id". Ids can be forged, replayed, or stale.
- **Keep the allowlist small.** Add fields to the mapping deliberately. Do not return the row and strip fields.
- **Persistence.** The documentation test runs against an in-memory stand-in. Run your own database through the persistence conformance suites in `@xonava/testing` before relying on these queries in SQL.
- **Route bindings.** `FrameworkRequestNormalization.routeBindings` must contain the five CRUD keys (`list`, `detail`, `create`, `update`, `delete`) even when the module builds no CRUD handler; the sample points them at its two bindings and never uses them.
- **Hand-written endpoint plumbing.** `requestContextFor` and `admitParentAction` repeat what the built-in handlers do internally, because that step is not exported. Keep them in one shared module in your application.
