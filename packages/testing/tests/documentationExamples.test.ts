import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CacheService, type CacheAdapter } from "@xonava/core/cache"
import { checkRateLimit, type AtomicRateLimitStore } from "@xonava/core/rate-limit"
import { createNoopTelemetry, emitTelemetry, explicitlySafeTelemetryAttributes } from "@xonava/core/telemetry"
import { validateObjectKey } from "@xonava/core/object-store"
import { supportsInteractiveTransactions } from "@xonava/core/persistence"
import { validateQueryPlan } from "@xonava/core/query"
import { createOperation, createOperationContext } from "@xonava/core/operation"
import { defineWorkflow } from "@xonava/core/workflow"
import { CRUD } from "@xonava/adapters/http"
import { createAbacBundle } from "@xonava/core/domain"
import { InMemoryObjectStore } from "@xonava/adapters/storage"
import {
  cleanupExpiredUploads,
  createFinalizeUpload,
  inMemoryDatabase,
  putReservedObject,
  reserveUpload,
  sessionRequest,
  UPLOAD_LIMITS,
  type Reservation,
  type ReserveUploadInput,
} from "./durableUploadsExample"
import { adapterDeps as standaloneDeps, announcements, announcementsCatalog, staffPolicy, createAnnouncementHandlers, staffRequestNormalization, enqueueExpiry, inMemoryAnnouncements, jobs as standaloneJobs, PLATFORM_SCOPE, type Announcement, type StaffLogin } from "./standaloneGuideExample"
import {
  createAdapterDeps,
  createAssignWarehouseHandler,
  createWarehouseOptionsHandler,
  defaultEntitlements,
  defaultPolicies,
  inMemoryShop,
  ordersRequestNormalization as shopRequestNormalization,
  ORDERS,
  WAREHOUSE_OPTION_LIMIT,
  type Order as ShopOrder,
  type Warehouse,
  type WarehouseOptions,
} from "./supportingReadsExample"
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

  describe("standalone application guide (docs/guides/standalone-application.md)", () => {
    const FIRST = "00000000-0000-4000-8000-0000000000a1"
    const SECOND = "00000000-0000-4000-8000-0000000000a2"
    const row = (id: string, priority: number): Announcement => ({ id, title: `announcement ${priority}`, region: "eu", priority, version: 1 })
    const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`https://app.test${path}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: { "content-type": "application/json", ...headers },
    })

    function setup(login: StaffLogin | null = { userId: "staff-1", sessionId: "s1" }) {
      const store = inMemoryAnnouncements([row(FIRST, 1), row(SECOND, 2)])
      const handlers = createAnnouncementHandlers({ createPersistence: store.createPersistence, getCacheAdapter: async () => ({}) as never }, async () => login ?? undefined)
      return { store, handlers }
    }

    it("serves list, detail, create, update and delete under the fixed platform scope", async () => {
      const { handlers, store } = setup()
      const list = await handlers.list(json("GET", "/announcements"))
      expect(list.status, await list.clone().text()).toBe(200)
      expect((await handlers.detail(json("GET", `/announcements/${FIRST}`), { id: FIRST })).status).toBe(200)
      const created = await handlers.create(json("POST", "/announcements", { title: "new", region: "us", priority: 3 }))
      expect(created.status, await created.clone().text()).toBe(201)
      const patched = await handlers.update(json("PATCH", `/announcements/${FIRST}`, { title: "edited" }, { "if-match": "1" }), { params: Promise.resolve({ id: FIRST }) })
      expect(patched.status, await patched.clone().text()).toBe(200)
      expect(store.rows.get(FIRST)?.title).toBe("edited")
      const removed = await handlers.delete(json("DELETE", `/announcements/${SECOND}`, undefined, { "if-match": "1" }), { params: Promise.resolve({ id: SECOND }) })
      expect(removed.status, await removed.clone().text()).toBeLessThan(300)
      expect(store.rows.has(SECOND)).toBe(false)
    })

    it("rejects a request without a verified login", async () => {
      const { handlers } = setup(null)
      expect((await handlers.list(json("GET", "/announcements"))).status).toBe(401)
    })

    it("denies the request when the ABAC bundle is missing, read-only or lacks the capability", async () => {
      const store = inMemoryAnnouncements([row(FIRST, 1)])
      const build = (deps: typeof standaloneDeps) => CRUD(announcements, {
        adapterDeps: deps,
        requestNormalization: staffRequestNormalization(async () => ({ userId: "staff-1", sessionId: "s1" })),
        scope: { scope: "platform", idempotency: { required: false } },
        createPersistence: store.createPersistence,
        getCacheAdapter: async () => ({}) as never,
      })
      expect((await build(standaloneDeps).list(json("GET", "/announcements"))).status).toBe(200)
      // Without the bundle or without the grant there is no access, whatever the module facts say.
      const readOnly = { ...standaloneDeps, resolveAbacBundle: async ({ moduleKey }: { moduleKey: string }) => createAbacBundle({
        provider: { async resolve() { return [{ ...staffPolicy, payload: { ...staffPolicy.payload, actions: ["read"], capabilities: ["announcements"] } }] } },
        mode: "platform", moduleKey, catalog: announcementsCatalog, context: { userId: "staff-1" },
      }) }
      expect((await build(readOnly).list(json("GET", "/announcements"))).status).toBe(200)
      expect((await build(readOnly).create(json("POST", "/announcements", { title: "x", region: "eu", priority: 1 }))).status).toBe(403)
      const noCapability = { ...standaloneDeps, resolveAbacBundle: async ({ moduleKey }: { moduleKey: string }) => createAbacBundle({
        provider: { async resolve() { return [{ ...staffPolicy, payload: { ...staffPolicy.payload, capabilities: [] } }] } },
        mode: "platform", moduleKey, catalog: announcementsCatalog, context: { userId: "staff-1" },
      }) }
      expect((await build(noCapability).list(json("GET", "/announcements"))).status).toBe(403)
      const noBundle = { ...standaloneDeps, resolveAbacBundle: async () => null }
      expect((await build(noBundle).list(json("GET", "/announcements"))).status).toBe(403)
    })

    it("declares a platform job definition and enqueues under the platform scope", async () => {
      expect(standaloneJobs.get("announcements.expire", 1)?.scope).toBe("platform")
      const enqueued: unknown[] = []
      await enqueueExpiry({ enqueue: async (args: unknown) => { enqueued.push(args); return {} } } as never)
      expect(enqueued).toMatchObject([{ requester: { scope: "platform" }, job: { executionScope: PLATFORM_SCOPE, jobType: "announcements.expire" } }])
    })

    it("keeps every ts block in the guide and the README example identical to the compiled example", () => {
      const example = readFileSync(new URL("./standaloneGuideExample.ts", import.meta.url), "utf8")
      const guide = readFileSync(new URL("../../../docs/guides/standalone-application.md", import.meta.url), "utf8")
      const guideBlocks = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!.trimEnd())
      expect(guideBlocks.length).toBeGreaterThan(0)
      for (const block of guideBlocks) expect(example, `guide block not found in standaloneGuideExample.ts:\n${block}`).toContain(block)
      const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8")
      const section = readme.match(/## Standalone application\n([\s\S]*?)\n## /)?.[1] ?? ""
      const readmeBlocks = [...section.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!.trimEnd())
      expect(readmeBlocks.length).toBeGreaterThan(0)
      for (const block of readmeBlocks) expect(example, `README block not found in standaloneGuideExample.ts:\n${block}`).toContain(block)
    })
  })

  describe("durable uploads guide (docs/guides/durable-uploads.md)", () => {
    const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
    const BYTES = new TextEncoder().encode("hello durable uploads")
    const START = new Date("2026-10-01T00:00:00.000Z")
    const request = (overrides: Partial<ReserveUploadInput> = {}): ReserveUploadInput => ({
      reservationId: "res-00000001", fileName: "hello.pdf", contentType: "application/pdf", contentLength: BYTES.byteLength, sha256: sha256(BYTES), ...overrides,
    })

    function setup() {
      const db = inMemoryDatabase()
      const store = new InMemoryObjectStore()
      const clock = { current: START }
      const as = (operationKey: string, userId = "alice", tenantId = "t1") => createOperationContext({
        persistence: db.persistence,
        runtimeCapabilities: { deferredExecution: false, cache: false },
        request: sessionRequest(tenantId, userId, operationKey),
        clock: { now: () => clock.current },
      })
      const finalize = createFinalizeUpload(store)
      const reserve = (input = request(), userId = "alice", tenantId = "t1") => reserveUpload.run({ operation: as("uploads.reserve", userId, tenantId), input })
      const fin = (reservationId = "res-00000001", userId = "alice", tenantId = "t1") => finalize.run({ operation: as("uploads.finalize", userId, tenantId), input: { reservationId } })
      const cleanup = () => cleanupExpiredUploads({ persistence: db.persistence, store, now: clock.current })
      const advance = (ms: number) => { clock.current = new Date(clock.current.getTime() + ms) }
      return { db, store, reserve, fin, cleanup, advance }
    }

    it("reserves, uploads, and finalizes into an attachment pinned to the stored object version", async () => {
      const { store, reserve, fin } = setup()
      const reservation = await reserve()
      expect(reservation).toMatchObject({ status: "reserved", objectKey: "tenants/t1/uploads/res-00000001", ownerId: "alice" })
      await putReservedObject({ store, reservation, body: BYTES, now: START })
      const attachment = await fin()
      expect(attachment).toMatchObject({ id: "res-00000001", contentLength: BYTES.byteLength, executionScope: { kind: "tenant", tenantId: "t1" } })
      const head = await store.head({ key: reservation.objectKey })
      expect(attachment.object).toEqual({ key: reservation.objectKey, version: head?.version })
    })

    it("applies authorization and size and type limits when reserving", async () => {
      const { db, reserve } = setup()
      await expect(reserveUpload.run({ operation: createOperationContext({ persistence: db.persistence, runtimeCapabilities: { deferredExecution: false, cache: false } }), input: request() })).rejects.toThrow()
      await expect(reserve(request({ contentLength: UPLOAD_LIMITS.maxBytes + 1 }))).rejects.toThrow(/contentLength/)
      await expect(reserve(request({ contentType: "text/html" }))).rejects.toThrow(/content type/)
      await expect(reserve(request({ reservationId: "../escape" }))).rejects.toThrow(/reservationId/)
      expect(db.table("upload_reservation").size).toBe(0)
    })

    it("refuses to finalize another user's or another tenant's reservation", async () => {
      const { store, reserve, fin } = setup()
      const reservation = await reserve()
      await putReservedObject({ store, reservation, body: BYTES, now: START })
      await expect(fin("res-00000001", "mallory")).rejects.toThrow(/not found/i)
      await expect(fin("res-00000001", "alice", "t2")).rejects.toThrow(/not found/i)
    })

    it("refuses to finalize when the object is missing or the provider metadata disagrees", async () => {
      const { store, reserve, fin, db } = setup()
      const reservation = await reserve()
      const base = { key: reservation.objectKey, contentType: "application/pdf", metadata: { reservationId: reservation.id } }
      const put = (body: Uint8Array, overrides: Record<string, unknown> = {}) => store.put({
        ...base, body, contentLength: body.byteLength, checksum: { algorithm: "sha256", value: sha256(body) }, ...overrides,
      })
      await expect(fin()).rejects.toThrow(/not been uploaded/)

      await put(BYTES.slice(0, 5))
      await expect(fin()).rejects.toThrow(/size/)

      // Right size, different bytes: the checksum no longer matches the reservation.
      await put(new Uint8Array(BYTES.byteLength).fill(7))
      await expect(fin()).rejects.toThrow(/checksum/)

      // No checksum recorded: nothing to reconcile against.
      await put(BYTES, { checksum: undefined })
      await expect(fin()).rejects.toThrow(/checksum/)

      await put(BYTES, { contentType: "image/png" })
      await expect(fin()).rejects.toThrow(/type/)
      await put(BYTES, { metadata: { reservationId: "someone-else" } })
      await expect(fin()).rejects.toThrow(/belong/)

      expect(db.table("attachment").size).toBe(0)
      expect((db.table("upload_reservation").get(reservation.id) as unknown as Reservation).status).toBe("reserved")

      await put(BYTES)
      await expect(fin()).resolves.toMatchObject({ id: reservation.id })
    })

    it("lets the object store reject a body that does not match the declared length or checksum", async () => {
      const { store, reserve } = setup()
      const reservation = await reserve()
      await expect(putReservedObject({ store, reservation, body: BYTES.slice(0, 3), now: START })).rejects.toThrow()
      const sameLengthOtherBytes = new Uint8Array(BYTES.byteLength).fill(1)
      await expect(putReservedObject({ store, reservation, body: sameLengthOtherBytes, now: START })).rejects.toThrow(/checksum/)
      expect(await store.head({ key: reservation.objectKey })).toBeNull()
    })

    it("removes an object left by a crash between put and finalize, but only after the reservation expires", async () => {
      const { store, reserve, cleanup, advance, db } = setup()
      const reservation = await reserve()
      await putReservedObject({ store, reservation, body: BYTES, now: START })
      // The process crashed here: no finalize ever runs.
      advance(UPLOAD_LIMITS.reservationTtlMs - 1)
      await expect(cleanup()).resolves.toEqual({ deleted: 0, kept: 0 })
      expect(await store.head({ key: reservation.objectKey })).not.toBeNull()
      advance(1)
      await expect(cleanup()).resolves.toEqual({ deleted: 1, kept: 0 })
      expect(await store.head({ key: reservation.objectKey })).toBeNull()
      expect((db.table("upload_reservation").get(reservation.id) as unknown as Reservation).status).toBe("deleted")
    })

    it("never deletes an object referenced by a finalized attachment", async () => {
      const { store, reserve, fin, cleanup, advance, db } = setup()
      const reservation = await reserve()
      await putReservedObject({ store, reservation, body: BYTES, now: START })
      await fin()
      advance(UPLOAD_LIMITS.reservationTtlMs * 10)
      await expect(cleanup()).resolves.toEqual({ deleted: 0, kept: 0 })
      expect(await store.head({ key: reservation.objectKey })).not.toBeNull()

      // Even a damaged reservation row cannot make cleanup delete a referenced object.
      db.table("upload_reservation").set(reservation.id, { ...db.table("upload_reservation").get(reservation.id)!, status: "expired" })
      await expect(cleanup()).resolves.toEqual({ deleted: 0, kept: 1 })
      expect(await store.head({ key: reservation.objectKey })).not.toBeNull()
    })

    it("refuses to finalize an expired reservation, before or after cleanup", async () => {
      const { store, reserve, fin, cleanup, advance } = setup()
      const reservation = await reserve()
      await putReservedObject({ store, reservation, body: BYTES, now: START })
      advance(UPLOAD_LIMITS.reservationTtlMs)
      await expect(fin()).rejects.toThrow(/expired/)
      await cleanup()
      expect(await store.head({ key: reservation.objectKey })).toBeNull()
      await expect(fin()).rejects.toThrow(/expired/)
    })

    it("is idempotent on retry at every step", async () => {
      const { store, reserve, fin, cleanup, advance, db } = setup()
      const first = await reserve()
      expect(await reserve()).toEqual(first)
      await expect(reserve(request({ fileName: "other.pdf" }))).rejects.toThrow(/different upload/)
      expect(db.table("upload_reservation").size).toBe(1)

      await putReservedObject({ store, reservation: first, body: BYTES, now: START })
      await putReservedObject({ store, reservation: first, body: BYTES, now: START })

      const attachment = await fin()
      expect(await fin()).toEqual(attachment)
      expect(db.table("attachment").size).toBe(1)

      const second = await reserve(request({ reservationId: "res-00000002" }))
      await putReservedObject({ store, reservation: second, body: BYTES, now: START })
      advance(UPLOAD_LIMITS.reservationTtlMs * 2)
      await expect(cleanup()).resolves.toEqual({ deleted: 1, kept: 0 })
      await expect(cleanup()).resolves.toEqual({ deleted: 0, kept: 0 })
      expect(await store.head({ key: first.objectKey })).not.toBeNull()
      expect(await store.head({ key: second.objectKey })).toBeNull()
    })

    it("finishes a cleanup run that stopped after claiming but before deleting", async () => {
      const { store, reserve, cleanup, advance, db } = setup()
      const reservation = await reserve()
      await putReservedObject({ store, reservation, body: BYTES, now: START })
      advance(UPLOAD_LIMITS.reservationTtlMs)
      db.table("upload_reservation").set(reservation.id, { ...db.table("upload_reservation").get(reservation.id)!, status: "expired" })
      await expect(cleanup()).resolves.toEqual({ deleted: 1, kept: 0 })
      expect(await store.head({ key: reservation.objectKey })).toBeNull()
    })

    it("keeps every ts block in the guide identical to the compiled example", () => {
      const guide = readFileSync(new URL("../../../docs/guides/durable-uploads.md", import.meta.url), "utf8")
      const example = readFileSync(new URL("./durableUploadsExample.ts", import.meta.url), "utf8")
      const blocks = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!.trimEnd())
      expect(blocks.length).toBeGreaterThan(0)
      for (const block of blocks) expect(example, `guide block not found in durableUploadsExample.ts:\n${block}`).toContain(block)
    })
  })

  describe("supporting reads guide (docs/guides/supporting-reads.md)", () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
    const ORDER = uuid(1)
    const CLOSED_ORDER = uuid(2)
    const EU = uuid(101)
    const US = uuid(102)
    const INACTIVE_EU = uuid(103)
    const OTHER_TENANT = uuid(104)
    const warehouse = (id: string, label: string, over: Partial<Warehouse> = {}): Warehouse => ({
      id, tenantId: "t1", label, region: "eu", active: true, internalCostCentre: "cc-secret", ...over,
    })
    const order = (id: string, status: string): ShopOrder => ({ id, tenantId: "t1", status, region: "eu", warehouseId: null })

    function setup(extra: Warehouse[] = [], login: VerifiedLogin | null = { userId: "dora", tenantId: "t1", sessionId: "s1" }) {
      const policies = defaultPolicies()
      const entitlements = defaultEntitlements()
      const deps = createAdapterDeps(policies, entitlements)
      const shop = inMemoryShop({
        orders: [order(ORDER, "open"), order(CLOSED_ORDER, "shipped")],
        warehouses: [
          warehouse(EU, "Berlin"),
          warehouse(US, "Austin", { region: "us" }),
          warehouse(INACTIVE_EU, "Closed depot", { active: false }),
          warehouse(OTHER_TENANT, "Foreign depot", { tenantId: "t2" }),
          ...extra,
        ],
      })
      const normalization = shopRequestNormalization(async () => login ?? undefined)
      const args = { adapterDeps: deps, requestNormalization: normalization, createPersistence: shop.createPersistence }
      return { policies, entitlements, shop, options: createWarehouseOptionsHandler(args), assign: createAssignWarehouseHandler(args) }
    }
    const optionsRequest = (query = "") => new Request(`https://shop.test/orders/warehouse-options${query}`)
    const assignRequest = (orderId: string, warehouseId: string) => new Request(`https://shop.test/orders/${orderId}/assign-warehouse`, {
      method: "POST", body: JSON.stringify({ warehouseId }), headers: { "content-type": "application/json" },
    })
    const params = (id: string) => ({ params: Promise.resolve({ id }) })

    it("returns only id and label, sorted, for active warehouses of the caller's tenant", async () => {
      const { options } = setup()
      const response = await options(optionsRequest())
      expect(response.status).toBe(200)
      const body = await response.json() as WarehouseOptions
      // The supporting read is admitted by the parent action, not by the warehouses module,
      // so the US warehouse is listed although this caller cannot read it there.
      expect(body).toEqual({ items: [{ id: US, label: "Austin" }, { id: EU, label: "Berlin" }], truncated: false })
      for (const item of body.items) expect(Object.keys(item).sort()).toEqual(["id", "label"])
      expect(JSON.stringify(body)).not.toMatch(/cc-secret|Foreign|Closed depot|tenantId|region/)
    })

    it("sets cache-control: no-store on success and on every refusal", async () => {
      const ok = setup()
      expect((await ok.options(optionsRequest())).headers.get("cache-control")).toBe("no-store")
      const anonymous = setup([], null)
      const unauthenticated = await anonymous.options(optionsRequest())
      expect(unauthenticated.status).toBe(401)
      expect(unauthenticated.headers.get("cache-control")).toBe("no-store")
      const denied = setup()
      denied.policies[ORDERS] = []
      const forbidden = await denied.options(optionsRequest())
      expect(forbidden.status).toBe(403)
      expect(forbidden.headers.get("cache-control")).toBe("no-store")
      const invalid = await ok.options(optionsRequest("?q=a&q=b"))
      expect(invalid.status).toBe(400)
      expect(invalid.headers.get("cache-control")).toBe("no-store")
    })

    it("bounds the result and reports overflow explicitly", async () => {
      const many = Array.from({ length: WAREHOUSE_OPTION_LIMIT + 4 }, (_, index) => warehouse(uuid(200 + index), `Depot ${String(index).padStart(2, "0")}`))
      const { options, shop } = setup(many)
      const body = await (await options(optionsRequest())).json() as WarehouseOptions
      expect(body.items).toHaveLength(WAREHOUSE_OPTION_LIMIT)
      expect(body.truncated).toBe(true)
      // The store was asked for one more row than it may return, never for everything.
      expect(shop.queries.at(-1)).toEqual({ entity: "warehouse", pageSize: WAREHOUSE_OPTION_LIMIT + 1 })
      // Narrowing the search brings the list back under the bound.
      const narrowed = await (await options(optionsRequest("?q=Depot%200"))).json() as WarehouseOptions
      expect(narrowed.truncated).toBe(false)
      expect(narrowed.items.every((item) => item.label.includes("Depot 0"))).toBe(true)
    })

    it("is not truncated when the list has exactly the limit", async () => {
      const exact = Array.from({ length: WAREHOUSE_OPTION_LIMIT - 2 }, (_, index) => warehouse(uuid(200 + index), `Depot ${String(index).padStart(2, "0")}`))
      const { options } = setup(exact)
      const body = await (await options(optionsRequest())).json() as WarehouseOptions
      expect(body.items).toHaveLength(WAREHOUSE_OPTION_LIMIT)
      expect(body.truncated).toBe(false)
    })

    it("rejects unknown, repeated and oversize query parameters", async () => {
      const { options } = setup()
      expect((await options(optionsRequest("?limit=1000"))).status).toBe(400)
      expect((await options(optionsRequest("?tenantId=t2"))).status).toBe(400)
      expect((await options(optionsRequest(`?q=${"x".repeat(51)}`))).status).toBe(400)
    })

    it("is admitted by the parent action through a fresh bundle, conditional grants and denies included", async () => {
      // The default conditional grant (open orders only) admits the read.
      const conditional = setup()
      expect((await conditional.options(optionsRequest())).status).toBe(200)

      // A conditional deny narrows which orders qualify but still admits the read.
      const conditionalDeny = setup()
      conditionalDeny.policies[ORDERS]!.push({
        ...conditionalDeny.policies[ORDERS]![0]!,
        source: { policyId: "no-eu-orders", scopeType: "tenant_default" },
        effect: "deny",
        priority: 20,
        payload: {
          ...conditionalDeny.policies[ORDERS]![0]!.payload,
          conditions: { version: 2, systemScope: { logic: "AND", conditions: [{ field: "region", operator: "equals", value: "us" }] }, userFilters: { logic: "AND", conditions: [] } },
        },
      })
      expect((await conditionalDeny.options(optionsRequest())).status).toBe(200)

      // An unconditional deny on the parent action refuses the read.
      const hardDeny = setup()
      hardDeny.policies[ORDERS]!.push({
        ...hardDeny.policies[ORDERS]![0]!,
        source: { policyId: "freeze-dispatch", scopeType: "tenant_default" },
        effect: "deny",
        priority: 20,
        payload: {
          ...hardDeny.policies[ORDERS]![0]!.payload,
          actions: ["assignWarehouse"],
          conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
        },
      })
      expect((await hardDeny.options(optionsRequest())).status).toBe(403)

      // Reading orders is not the parent action.
      const readOnly = setup()
      readOnly.policies[ORDERS] = [{
        ...readOnly.policies[ORDERS]![0]!,
        payload: { ...readOnly.policies[ORDERS]![0]!.payload, actions: ["read"] },
      }]
      expect((await readOnly.options(optionsRequest())).status).toBe(403)

      // Holding the warehouses module's read grant is not the parent action either.
      const onlyWarehouses = setup()
      onlyWarehouses.policies[ORDERS] = []
      expect((await onlyWarehouses.options(optionsRequest())).status).toBe(403)

      // The module must also be enabled for the tenant with that action.
      const moduleOff = setup()
      moduleOff.entitlements.enabledModuleActions[ORDERS] = ["read"]
      expect((await moduleOff.options(optionsRequest())).status).toBe(403)
    })

    it("revoking the parent action revokes the read on the next request", async () => {
      const { options, assign, policies } = setup()
      expect((await options(optionsRequest())).status).toBe(200)
      policies[ORDERS] = []
      expect((await options(optionsRequest())).status).toBe(403)
      expect((await assign(assignRequest(ORDER, EU), params(ORDER))).status).toBe(403)
    })

    it("assigns a warehouse the caller may read to an order the caller may dispatch", async () => {
      const { assign, shop } = setup()
      const response = await assign(assignRequest(ORDER, EU), params(ORDER))
      expect(response.status, await response.clone().text()).toBe(200)
      expect(await response.json()).toEqual({ id: ORDER, warehouseId: EU })
      expect(shop.orders.get(ORDER)?.warehouseId).toBe(EU)
    })

    it("grants nothing by listing an option: the save re-checks the full warehouse record", async () => {
      const { options, assign, shop } = setup()
      const listed = await (await options(optionsRequest())).json() as WarehouseOptions
      expect(listed.items.map((item) => item.id)).toContain(US)

      // Offered by the supporting read, but the warehouses module does not let this caller read it.
      const unreadable = await assign(assignRequest(ORDER, US), params(ORDER))
      expect(unreadable.status).toBe(404)
      // It answers exactly like an id that does not exist, so the response confirms nothing.
      const missing = await assign(assignRequest(ORDER, uuid(999)), params(ORDER))
      expect(missing.status).toBe(404)
      expect((await unreadable.json() as { message?: string }).message).toBe((await missing.json() as { message?: string }).message)
      // Another tenant's warehouse is not reachable either.
      expect((await assign(assignRequest(ORDER, OTHER_TENANT), params(ORDER))).status).toBe(404)
      expect(shop.orders.get(ORDER)?.warehouseId).toBeNull()
    })

    it("re-checks the full order against the parent action at save time", async () => {
      const { assign, shop } = setup()
      // The read was admitted by a conditional grant; this order does not satisfy the condition.
      const response = await assign(assignRequest(CLOSED_ORDER, EU), params(CLOSED_ORDER))
      expect(response.status).toBe(403)
      expect(shop.orders.get(CLOSED_ORDER)?.warehouseId).toBeNull()
    })

    it("reports a business rule with a public code, not an authorization failure", async () => {
      const inactive = setup()
      const response = await inactive.assign(assignRequest(ORDER, INACTIVE_EU), params(ORDER))
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.status).not.toBe(403)
      expect(response.status).not.toBe(404)
      expect(JSON.stringify(await response.json())).toContain("WAREHOUSE_NOT_ACCEPTING")
      expect(inactive.shop.orders.get(ORDER)?.warehouseId).toBeNull()
    })

    it("keeps every ts block in the guide identical to the compiled example", () => {
      const guide = readFileSync(new URL("../../../docs/guides/supporting-reads.md", import.meta.url), "utf8")
      const example = readFileSync(new URL("./supportingReadsExample.ts", import.meta.url), "utf8")
      const blocks = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!.trimEnd())
      expect(blocks.length).toBeGreaterThan(0)
      for (const block of blocks) expect(example, `guide block not found in supportingReadsExample.ts:\n${block}`).toContain(block)
    })
  })
})
