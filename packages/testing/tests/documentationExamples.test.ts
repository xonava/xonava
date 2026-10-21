import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CacheService, type CacheAdapter } from "@xonava/core/cache"
import { checkRateLimit, type AtomicRateLimitStore } from "@xonava/core/rate-limit"
import { createNoopTelemetry, emitTelemetry, explicitlySafeTelemetryAttributes } from "@xonava/core/telemetry"
import { validateObjectKey } from "@xonava/core/object-store"
import { supportsInteractiveTransactions } from "@xonava/core/persistence"
import { validateQueryPlan } from "@xonava/core/query"
import { createOperation } from "@xonava/core/operation"
import { defineWorkflow } from "@xonava/core/workflow"
import { CRUD } from "@xonava/adapters/http"
import { adapterDeps, createOrderHandlers, inMemoryOrders, orders, ordersRequestNormalization, type Order, type VerifiedLogin } from "./ownershipGuideExample"

describe("canonical documentation examples", () => {
  it("compiles and executes capability-only cache usage", async () => {
    const values = new Map<string, unknown>()
    const adapter: CacheAdapter = {
      async get<T>(key: string) { return values.get(key) as T | undefined },
      async set<T>(key: string, value: T) { values.set(key, value) },
      async delete(key: string) { return values.delete(key) },
      async has(key: string) { return values.has(key) },
      async clear() { values.clear() },
      async addToTag() {},
      async getTagKeys() { return [] },
      async deleteTag() {},
    }
    const cache = new CacheService({ adapter, defaultTtlMs: 30_000 })
    await cache.set("account:42", { enabled: true })
    await expect(cache.get("account:42")).resolves.toEqual({ enabled: true })
  })

  it("compiles and executes atomic rate-limit usage", async () => {
    const store: AtomicRateLimitStore = {
      async increment() { return { count: 1, resetAt: 60_000 } },
      async incrementAtomically() { return { count: 1, resetAt: 60_000 } },
    }
    await expect(checkRateLimit({ store, key: "tenant:t1", limit: 10, windowMs: 60_000 }))
      .resolves.toEqual({ allowed: true, remaining: 9, resetAt: 60_000 })
  })

  it("compiles standalone telemetry and object-store usage", () => {
    const telemetry = createNoopTelemetry()
    emitTelemetry(telemetry, { name: "docs.example", severity: "info", timestamp: new Date(0), attributes: explicitlySafeTelemetryAttributes({ outcome: "ok" }) })
    expect(validateObjectKey("tenant/t1/object/42")).toBe("tenant/t1/object/42")
  })

  it("keeps persistence, query, operation, and workflow entry points public", () => {
    expect(typeof supportsInteractiveTransactions).toBe("function")
    expect(typeof validateQueryPlan).toBe("function")
    expect(typeof createOperation).toBe("function")
    expect(typeof defineWorkflow).toBe("function")
  })

  describe("ownership guide (docs/guides/ownership.md)", () => {
    const ALICE_ORDER = "00000000-0000-4000-8000-0000000000a1"
    const BOB_ORDER = "00000000-0000-4000-8000-0000000000b1"
    const OTHER_TENANT_ORDER = "00000000-0000-4000-8000-0000000000c1"
    const order = (id: string, customerId: string, tenantId = "t1"): Order => ({
      id, tenantId, customerId, status: "open", total: 10, shippingNote: "leave at door", internalNote: "fraud review", version: 1,
    })

    function setup(login: VerifiedLogin | null = { userId: "alice", tenantId: "t1", sessionId: "s1" }) {
      const store = inMemoryOrders([order(ALICE_ORDER, "alice"), order(BOB_ORDER, "bob"), order(OTHER_TENANT_ORDER, "alice", "t2")])
      const handlers = createOrderHandlers({ createPersistence: store.createPersistence, getCacheAdapter: async () => ({}) as never }, async () => login ?? undefined)
      return { store, handlers }
    }
    const patch = (id: string, body: unknown) => new Request(`https://shop.test/orders/${id}`, {
      method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json", "if-match": "1" },
    })
    const del = (id: string) => new Request(`https://shop.test/orders/${id}`, { method: "DELETE", headers: { "if-match": "1" } })
    const params = (id: string) => ({ params: Promise.resolve({ id }) })

    it("lists only the caller's orders in the caller's tenant and projects internal fields away", async () => {
      const { handlers } = setup()
      const response = await handlers.list(new Request("https://shop.test/orders"))
      expect(response.status).toBe(200)
      const body = await response.json() as { data?: Array<Record<string, unknown>>; rows?: Array<Record<string, unknown>> }
      const rows = body.data ?? body.rows ?? []
      expect(rows.map((row) => row.id)).toEqual([ALICE_ORDER])
      expect(rows[0]).not.toHaveProperty("internalNote")
      expect(rows[0]).toHaveProperty("shippingNote", "leave at door")
    })

    it("denies reading another customer's order and an order in another tenant", async () => {
      const { handlers } = setup()
      expect((await handlers.detail(new Request(`https://shop.test/orders/${ALICE_ORDER}`), { id: ALICE_ORDER })).status).toBe(200)
      expect((await handlers.detail(new Request(`https://shop.test/orders/${BOB_ORDER}`), { id: BOB_ORDER })).status).toBe(404)
      expect((await handlers.detail(new Request(`https://shop.test/orders/${OTHER_TENANT_ORDER}`), { id: OTHER_TENANT_ORDER })).status).toBe(404)
    })

    it("updates only the caller's own order and only the writable field", async () => {
      const { handlers, store } = setup()
      expect((await handlers.update(patch(ALICE_ORDER, { shippingNote: "ring twice" }), params(ALICE_ORDER))).status).toBe(200)
      expect(store.rows.get(ALICE_ORDER)?.shippingNote).toBe("ring twice")
      expect((await handlers.update(patch(BOB_ORDER, { shippingNote: "mine now" }), params(BOB_ORDER))).status).toBe(404)
      expect(store.rows.get(BOB_ORDER)?.shippingNote).toBe("leave at door")
      expect((await handlers.update(patch(ALICE_ORDER, { customerId: "bob" }), params(ALICE_ORDER))).status).toBe(400)
      expect(store.rows.get(ALICE_ORDER)?.customerId).toBe("alice")
    })

    it("deletes only the caller's own order", async () => {
      const { handlers, store } = setup()
      expect((await handlers.delete(del(BOB_ORDER), params(BOB_ORDER))).status).toBe(404)
      expect(store.rows.has(BOB_ORDER)).toBe(true)
      expect((await handlers.delete(del(ALICE_ORDER), params(ALICE_ORDER))).status).toBeLessThan(300)
      expect(store.rows.has(ALICE_ORDER)).toBe(false)
    })

    it("rejects a request without a verified login", async () => {
      const { handlers } = setup(null)
      const response = await handlers.list(new Request("https://shop.test/orders"))
      expect(response.status).toBe(401)
    })

    it("still runs module and ABAC action checks when the capability check is skipped", async () => {
      const store = inMemoryOrders([order(ALICE_ORDER, "alice")])
      const build = (deps: typeof adapterDeps) => CRUD(orders, {
        adapterDeps: deps,
        requestNormalization: ordersRequestNormalization(async () => ({ userId: "alice", tenantId: "t1", sessionId: "s1" })),
        scope: { scope: "tenant", idempotency: { required: false } },
        createPersistence: store.createPersistence,
        getCacheAdapter: async () => ({}) as never,
      })
      const request = () => new Request("https://shop.test/orders")
      expect((await build(adapterDeps).list(request())).status).toBe(200)
      // Module disabled for the tenant: denied although no capability key is configured.
      const moduleOff = { ...adapterDeps, resolveModuleAuthorizationFacts: () => ({ enabledModuleKeys: [], enabledModuleActions: {}, enabledModuleCapabilities: {} }) }
      expect((await build(moduleOff).list(request())).status).toBe(403)
      // No bundle: denied.
      const noBundle = { ...adapterDeps, resolveAbacBundle: async () => null }
      expect((await build(noBundle).list(request())).status).toBe(403)
      // Update action absent from the module entitlements: the write is denied.
      const readOnlyModule = { ...adapterDeps, resolveModuleAuthorizationFacts: () => ({ enabledModuleKeys: ["shop.orders"], enabledModuleActions: { "shop.orders": ["read"] }, enabledModuleCapabilities: {} }) }
      expect((await build(readOnlyModule).update(patch(ALICE_ORDER, { shippingNote: "x" }), params(ALICE_ORDER))).status).toBe(403)
      expect(store.rows.get(ALICE_ORDER)?.shippingNote).toBe("leave at door")
    })

    it("does not expose a create route", async () => {
      const { handlers } = setup()
      expect((await handlers.create(new Request("https://shop.test/orders", { method: "POST", body: "{}" }))).status).toBe(405)
    })

    it("keeps every ts block in the guide identical to the compiled example", () => {
      const guide = readFileSync(new URL("../../../docs/guides/ownership.md", import.meta.url), "utf8")
      const example = readFileSync(new URL("./ownershipGuideExample.ts", import.meta.url), "utf8")
      const blocks = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!.trimEnd())
      expect(blocks.length).toBeGreaterThan(0)
      for (const block of blocks) expect(example, `guide block not found in ownershipGuideExample.ts:\n${block}`).toContain(block)
    })
  })
})
