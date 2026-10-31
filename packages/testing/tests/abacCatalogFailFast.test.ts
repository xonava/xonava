import { describe, expect, it } from "vitest"
import { CRUD } from "@xonava/adapters/http"
import { assertAbacPoliciesMatchCatalog, createAbacBundle, defineAbacModule, InvalidPolicyConfigurationError } from "@xonava/core/domain"
import { adapterDeps, inMemoryOrders, orders, ordersCatalog, ordersRequestNormalization, ownOrdersPolicy, policyProvider } from "./ownershipGuideExample"

// The policy writes shippingNote; this catalog forgot to list it.
const brokenCatalog = defineAbacModule({
  ...ordersCatalog,
  fields: Object.fromEntries(Object.entries(ordersCatalog.fields).filter(([key]) => key !== "shippingNote")),
})

describe("policy/catalog mismatch is never first discovered by a request", () => {
  it("is reported by the pre-flight with module, policy and field names, before any handler exists", () => {
    expect(() => assertAbacPoliciesMatchCatalog({ moduleKey: "shop.orders", catalog: brokenCatalog, policies: [ownOrdersPolicy] }))
      .toThrow(expect.objectContaining({ moduleKey: "shop.orders", policyId: "customer-own-orders", missingFields: ["shippingNote"] }))
    expect(() => assertAbacPoliciesMatchCatalog({ moduleKey: "shop.orders", catalog: ordersCatalog, policies: [ownOrdersPolicy] })).not.toThrow()
  })

  it("an app that pre-flights never builds handlers for a broken catalog", async () => {
    let handlersBuilt = false
    const start = async () => {
      assertAbacPoliciesMatchCatalog({ moduleKey: "shop.orders", catalog: brokenCatalog, policies: await policyProvider.resolve({ mode: "tenant", moduleKey: "shop.orders", context: {} }) })
      handlersBuilt = true
    }
    await expect(start()).rejects.toBeInstanceOf(InvalidPolicyConfigurationError)
    expect(handlersBuilt).toBe(false)
  })

  it("without the pre-flight the mismatch surfaces on a request as a fail-closed 500 (defence in depth)", async () => {
    const store = inMemoryOrders([])
    const handlers = CRUD(orders, {
      adapterDeps: {
        ...adapterDeps,
        resolveAbacBundle: async ({ moduleKey, context }) => context.scope.kind !== "tenant" ? null : createAbacBundle({
          provider: policyProvider, mode: "tenant", moduleKey, catalog: brokenCatalog,
          context: { userId: context.identity.subject.id, tenantId: context.scope.tenantId },
        }),
      },
      requestNormalization: ordersRequestNormalization(async () => ({ userId: "alice", tenantId: "t1", sessionId: "s1" })),
      scope: { scope: "tenant", idempotency: { required: false } },
      createPersistence: store.createPersistence,
      getCacheAdapter: async () => ({}) as never,
    })
    expect((await handlers.list(new Request("https://shop.test/orders"))).status).toBe(500)
  })
})
