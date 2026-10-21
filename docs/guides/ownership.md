# Ownership for non-staff users

Customer accounts differ from staff accounts: they hold no capability strings, and each customer may touch only their own rows. This guide builds an owner-only `orders` entity so a signed-in customer can list, read, update and delete their own orders in their own tenant, and nothing else. The same shape fits any record that belongs to one user.

Every `ts` block below is compiled and executed by the documentation-example test (`packages/testing/tests/documentationExamples.test.ts`, source in `packages/testing/tests/ownershipGuideExample.ts`), and that test fails if a block here drifts from the compiled source. Imports use only public paths from [`package-exports.md`](../reference/package-exports.md).

## What protects an order

Four independent layers apply to every request. Do not rely on fewer.

1. **Trusted session.** Your code verifies the login and returns a `TrustedFrameworkSession` (identity plus execution scope). Nothing in the request body, query or headers chooses the user or the tenant.
2. **Tenant scope.** The entity declares `entityScope: { kind: "tenant" }`, so every read and write carries a structural `tenantId = <session tenant>` predicate. A tenant entity reached outside a tenant scope fails closed.
3. **Deny-by-default ABAC bundle.** A bundle always has `defaultEffect: "deny"`. An `allow` policy whose condition is `customerId equals user.id` grants access to a row only when the row's owner is the session user.
4. **Response projection.** The policy's `fieldAccess` decides which fields leave the server and which fields a caller may write.

## 1. Define the entity

`skipCapabilityCheck: true` is used here because customers hold no capability strings. Read [what it skips](#what-skipcapabilitycheck-skips) before copying it. `routes: { create: false }` leaves order creation to a checkout operation that you control. The update body schema is `.strict()` and lists only the field a customer may change.

```ts
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
```

## 2. Describe the fields to ABAC

A policy may only name fields that the module catalog lists, and the catalog's `actions` must include every action a policy grants. Policy normalization fails with `CATALOG_VALIDATION_FAILED` otherwise. `createAbacBundle` reports it as an `InvalidPolicyConfigurationError` (`moduleKey`, `policyId`, `missingFields`), which answers 500 if it first happens while serving a request. Call `assertAbacPoliciesMatchCatalog({ moduleKey, catalog, policies })` at startup or when policies are loaded to find the mismatch before any request does.

```ts
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
```

## 3. Write the ownership policy

The condition `{ field: "customerId", operator: "equals", userAttr: "user.id" }` compares the row's `customerId` with the user id of the bundle context. The allowed `userAttr` values are `user.id`, `user.roleId`, `user.branchId`, `user.departmentId` and `user.tenantId`. A `userAttr` that resolves to nothing never matches: an `allow` clause with an unresolved attribute grants nothing.

In an `allow` policy the `fieldAccess.read` map is an allowlist: any declared field it does not name (here `internalNote` and `tenantId`) is omitted from responses. `fieldAccess.write` lists the fields a caller may change. Use `"mask"` instead of `"allow"` to return a redacted value.

```ts
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
```

In production the provider reads policies from your policy store. It receives the mode, module key and context, and returns raw `AbacPolicy` objects; `createAbacBundle` validates them against the catalog, compiles the conditions into predicates, sorts them by priority, and binds a security digest.

## 4. Resolve the bundle and entitlements

`resolveAbacBundle` runs on every request with the `RequestContext` that the adapter built from your trusted session. The ABAC context carries the user id from `context.identity.subject` (the effective user; `actor` is whoever is operating the session) and the tenant from the verified scope. Return `null` for anything you cannot vouch for; the handler then answers 403. `createAbacBundle` returns the verified bundle type the adapter requires, so no assertion is needed.

`resolveModuleAuthorizationFacts` supplies module entitlements only (which module, actions and capabilities this tenant has enabled). It does not make decisions.

```ts
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
```

## 5. Build the trusted session and tenant scope

`resolveTrustedSession` is the only place that decides who the caller is. Verify the login in your own authentication layer and return the identity and the tenant. If the login is missing or invalid, throw `UnauthorizedError` so the handler answers 401. Returning `undefined` for an authenticated route is treated as a server misconfiguration and answers 500.

The tenant must not come from the request. The route binding below uses a scope resolver that reads the tenant from `resolverFacts`, which only `resolveTrustedSession` can set. Route bindings are normally taken from the compiled route plans of `@xonava/core/bootstrap`; they are written out here to keep the example self-contained.

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
      if (!login) throw new UnauthorizedError("Sign in to continue")
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
```

## 6. Create the handlers

`CRUD()` returns `list`, `detail`, `create`, `update` and `delete` handlers over standard `Request` and `Response` objects. Mount them with an adapter from `@xonava/adapters/express`, `/fastify` or `/hono`, or call them directly. `createPersistence` returns your database provider, for example one of the Drizzle adapters.

The sample sets `idempotency: { required: false }` to stay short. For real write routes supply `createIdempotencyPort` in the adapter dependencies and keep idempotency required.

```ts
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
```

## What each operation does

| Operation | Ownership enforcement |
|---|---|
| List | The read scope (`tenantId = session tenant` AND `customerId = user.id`) is compiled into the query predicate, so filtering, sorting, search and counts only see the caller's rows. Caller filters are combined with it and cannot widen it. |
| Detail | Same predicate on a lookup by id. Another customer's order, or an order in another tenant, answers 404, which does not reveal that it exists. |
| Update | The row is loaded and then written with a filter that contains the primary key, the tenant predicate, the ownership predicate and the expected version, so ownership is part of the write itself and not only of an earlier check. The patch is checked against `fieldAccess.write`, and both the stored row and the patched row must satisfy the policy. A foreign order answers 404; an unknown field is rejected by the strict body schema (400). Optimistic concurrency is on for this entity: send the current version as `If-Match`; a missing or stale version answers 409. |
| Delete | A conditional delete with the same ownership predicate. A foreign order answers 404 and nothing is removed. |
| Response | Every returned record goes through `projectResponseRecord` with the policy's field overrides, so `internalNote` is never sent. This applies to list, detail and the record returned by a mutation. |

## What `skipCapabilityCheck` skips

`skipCapabilityCheck: true` skips only the **capability-key** check: the entitlement lookup in `enabledModuleCapabilities` and the bundle's global capability assertion (`packages/core/src/entity/capabilityCheck.ts` resolves the setting to "no key"). It is a typed alternative to `customCapabilityKey`; an entity must declare exactly one.

It does not skip:

- the module entitlement check (`enabledModuleKeys` and `enabledModuleActions`) for tenant scope;
- the requirement for a verified ABAC bundle (none means 403);
- the ABAC collection action check (a policy must grant `update` for an update to proceed);
- the ownership predicate, write-field rules and response projection.

The documentation-example test demonstrates this: with the capability check skipped, disabling the module for the tenant, returning no bundle, or removing `update` from the module's actions each cause a 403.

### Removing a capability does not prove the bundle denies access

Taking a capability string away from a customer proves nothing about the data. With `skipCapabilityCheck: true` there is no capability string to take away, and even with a `customCapabilityKey` the capability gate is separate from the row gate. Whether a customer can see a row depends only on the policies in the bundle. To show that access is denied, test the bundle:

- with a different user id (their rows must not appear);
- with no policies (deny-by-default: nothing matches);
- with the policy removed, the module disabled, or the bundle returning `null`.

Do not conclude that access is closed because a capability is missing from a role.

## Limits and notes

- **Authentication is yours.** The handlers consume a trusted session; they do not verify passwords or tokens.
- **Caching.** The sample sets `cache: false`. Read responses are shared between requests only inside one security partition (the bundle's security digest plus its `cacheScopeKey`), and are not cached at all when the bundle has no scope key. Leave caching off for per-customer data unless you have reviewed that.
- **Persistence.** The documentation test runs the handlers against an in-memory stand-in, not a database. Run your own database through the persistence conformance suites in `@xonava/testing` before relying on these conditions in SQL.
- **Creating rows.** This guide disables the create route. If customers may create records, add `create` to the policy and catalog actions, keep `customerId` out of the create body schema, and set it from the trusted context in an operation, so a customer cannot create a row for someone else.
- **Staff access.** Give staff their own policies, scoped by role, in the same provider; they are resolved into the same bundle and ordered by priority. Keep customer and staff routes separate where their response shapes differ.
