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
})
