import { afterEach, describe, expect, it, vi } from "vitest"
import type { EntityDescriptor, PersistenceProvider } from "@xonava/core/persistence"
import { createListHandler } from "../../../adapters/src/http/crudHandlers/list.js"
import type { CrudShared, ListPaginationConfig } from "../../../adapters/src/http/crudHandlers/types.js"
import { canonicalRequestNormalization, trustedSession } from "../../../adapters/src/http/__tests__/canonicalRequest.js"
import {
  CURSOR_SECRET, GOLDEN, RUN_AT, cursorPayload, fingerprintJobBase, idempotencyMaterial, legacyJobFingerprint, outboxRecord,
} from "./fixtures.js"
import { DIRECTIONS, RELEASES, hmacCursorIntegrity, releaseOps, type KvAdapter, type Release } from "./releases.js"

/**
 * N-1 upgrade compatibility, formats that need no database: job fingerprints, list cursors, HTTP idempotency
 * fingerprints and serialized responses, outbox fingerprints and KV tag-generation layouts. "0.1.0" is the previous
 * published release (npm alias), "current" is this checkout. Every ordered pair (old writer, new reader) and (new
 * writer, old reader) is exercised; where a format changed on purpose the test asserts the documented behaviour and names
 * the changeset or the docs/KNOWN-LIMITATIONS.md entry.
 */

const old = releaseOps["0.1.0"]
const current = releaseOps.current

describe("the previous release is the published code, isolated from this checkout", () => {
  it("loads its own classes, not the workspace ones", () => {
    expect(old.JobIdempotencyConflictError).not.toBe(current.JobIdempotencyConflictError)
    expect(old.ConflictError).not.toBe(current.ConflictError)
    expect(old.KvCacheAdapter).not.toBe(current.KvCacheAdapter)
  })

  it("pins the formats the suite compares: both releases write the same versions", () => {
    for (const release of RELEASES) {
      expect(releaseOps[release].JOB_FINGERPRINT_VERSION, release).toBe(5)
      expect(releaseOps[release].IDEMPOTENCY_FINGERPRINT_VERSION, release).toBe("v3")
    }
  })
})

describe("job fingerprints (packages/core/src/execution/jobFingerprint.ts)", () => {
  const input = (release: Release, maxAttempts?: number) => releaseOps[release].buildJobFingerprintInput({ ...fingerprintJobBase, ...(maxAttempts === undefined ? {} : { maxAttempts }) }, RUN_AT)

  it("writes the digests 0.1.0 wrote, byte for byte, for an explicit and for an omitted attempt budget", async () => {
    for (const release of RELEASES) {
      expect(await releaseOps[release].fingerprintJob(input(release, 5)), `${release} explicit`).toBe(GOLDEN.jobExplicitAttempts5)
      expect(await releaseOps[release].fingerprintJob(input(release)), `${release} omitted`).toBe(GOLDEN.jobOmittedAttempts)
    }
  })

  it.each(DIRECTIONS)("a fingerprint written by %s is recognised by %s", async (writer, reader) => {
    for (const maxAttempts of [undefined, 3, 5]) {
      const stored = await releaseOps[writer].fingerprintJob(input(writer, maxAttempts))
      expect(await releaseOps[reader].jobFingerprintMatches(stored, input(reader, maxAttempts)), `${writer} -> ${reader} maxAttempts=${maxAttempts}`).toBe(true)
      expect(await releaseOps[reader].jobFingerprintMatches(stored, releaseOps[reader].buildJobFingerprintInput({ ...fingerprintJobBase, payload: { other: true }, ...(maxAttempts === undefined ? {} : { maxAttempts }) }, RUN_AT)), "a different payload").toBe(false)
    }
  })

  it("distinguishes an omitted attempt budget from an explicit 3 in version 5", async () => {
    for (const release of RELEASES) {
      expect(await releaseOps[release].fingerprintJob(input(release)), release).not.toBe(await releaseOps[release].fingerprintJob(input(release, 3)))
    }
  })

  it("still recognises stored version-4 and version-3 fingerprints (docs/KNOWN-LIMITATIONS.md, Legacy fingerprints)", async () => {
    const job = { ...fingerprintJobBase }
    for (const version of [4, 3] as const) {
      // Legacy digests were written by releases older than 0.1.0; the legacy material is built with either release's serializers.
      for (const builder of RELEASES) {
        const legacy = await legacyJobFingerprint(releaseOps[builder], version, job)
        for (const reader of RELEASES) {
          // A legacy digest cannot tell an omitted budget from an explicit 3, so both match it.
          expect(await releaseOps[reader].jobFingerprintMatches(legacy, input(reader)), `v${version} built by ${builder}, omitted, read by ${reader}`).toBe(true)
          expect(await releaseOps[reader].jobFingerprintMatches(legacy, input(reader, 3)), `v${version} built by ${builder}, 3, read by ${reader}`).toBe(true)
          expect(await releaseOps[reader].jobFingerprintMatches(legacy, input(reader, 5)), `v${version} built by ${builder}, 5, read by ${reader}`).toBe(false)
        }
      }
    }
    // The two legacy constructions really differ on this payload (integer-like keys), so each is exercised on its own.
    expect(await legacyJobFingerprint(current, 4, fingerprintJobBase)).not.toBe(await legacyJobFingerprint(current, 3, fingerprintJobBase))
  })

  it("documents the intentional break: the version-5 digest of an omitted budget is not the version-4 digest (workers on version 4 conflict)", async () => {
    // docs/KNOWN-LIMITATIONS.md, "Job fingerprints": a worker that only knows version 4 cannot match a version-5 record.
    const v5 = await current.fingerprintJob(input("current"))
    expect(v5).not.toBe(await legacyJobFingerprint(current, 4, fingerprintJobBase))
    expect(v5).not.toBe(await legacyJobFingerprint(current, 3, fingerprintJobBase))
  })
})

describe("HTTP idempotency fingerprints and serialized responses (packages/adapters/src/http/idempotency.ts)", () => {
  it("fingerprints request material with the digests 0.1.0 wrote (version v3, and the v2 compatibility construction)", async () => {
    for (const release of RELEASES) {
      expect(await releaseOps[release].fingerprintJson(idempotencyMaterial), `${release} v3`).toBe(GOLDEN.fingerprintJson)
      expect(await releaseOps[release].legacyFingerprintJson(idempotencyMaterial), `${release} v2`).toBe(GOLDEN.legacyFingerprintJson)
    }
    // Integer-like keys make the two constructions differ, which is what the write handler's legacy retry relies on.
    expect(GOLDEN.fingerprintJson).not.toBe(GOLDEN.legacyFingerprintJson)
  })

  it.each(DIRECTIONS)("a response serialized by %s replays on %s", async (writer, reader) => {
    const response = new Response(JSON.stringify({ id: "a-1", ok: true }), { status: 201, headers: { "content-type": "application/json", etag: "\"1\"", "x-secret": "dropped", connection: "close" } })
    const serialized = await releaseOps[writer].serializeResponse(response)
    const replayed = releaseOps[reader].deserializeResponse(JSON.parse(JSON.stringify(serialized)) as never)
    expect(replayed.status).toBe(201)
    expect(await replayed.json()).toEqual({ id: "a-1", ok: true })
    expect(replayed.headers.get("content-type")).toBe("application/json")
    expect(replayed.headers.get("etag")).toBe("\"1\"")
    expect(replayed.headers.get("x-secret")).toBeNull()
    expect(serialized).toMatchObject({ version: "v1" })
  })
})

describe("outbox fingerprints (packages/adapters/src/drizzle-shared/outbox.ts)", () => {
  it("fingerprints events with the version-3 digest 0.1.0 wrote", async () => {
    for (const release of RELEASES) expect(await releaseOps[release].computeOutboxFingerprint(outboxRecord(releaseOps[release])), release).toBe(GOLDEN.outbox)
    // The scope identity the fingerprint covers is encoded identically.
    expect(outboxRecord(old).scopeId).toBe(outboxRecord(current).scopeId)
  })
})

describe("list cursors (packages/core/src/query/cursorCodec.ts)", () => {
  const integrity = (release: Release) => hmacCursorIntegrity(releaseOps[release], CURSOR_SECRET)

  it("encodes the token 0.1.0 encoded, byte for byte", async () => {
    for (const release of RELEASES) expect(await releaseOps[release].encodeCursor({ ...cursorPayload }, integrity(release)), release).toBe(GOLDEN.cursor)
  })

  it.each(DIRECTIONS)("a cursor issued by %s is accepted by %s, with and without an expiry", async (writer, reader) => {
    for (const expiresAt of [undefined, Date.UTC(2031, 0, 1)]) {
      const payload = { ...cursorPayload, ...(expiresAt === undefined ? {} : { expiresAt }) }
      const token = await releaseOps[writer].encodeCursor(payload, integrity(writer))
      const decoded = await releaseOps[reader].decodeCursor(token, integrity(reader), 8192, { now: Date.UTC(2030, 0, 1) })
      expect(decoded).toMatchObject({ direction: "after", values: ["r-100", 42, true, null], routeHash: "route-h", queryHash: "query-h", scopeHash: "scope-h", sortHash: "sort-h" })
      expect(decoded.expiresAt).toBe(expiresAt)
    }
  })

  it.each(DIRECTIONS)("an expired cursor issued by %s is refused by %s with the same error", async (writer, reader) => {
    const token = await releaseOps[writer].encodeCursor({ ...cursorPayload, expiresAt: 1_000 }, integrity(writer))
    await expect(releaseOps[reader].decodeCursor(token, integrity(reader), 8192, { now: 1_000 })).rejects.toMatchObject({ message: "cursor expired" })
    await expect(releaseOps[reader].decodeCursor(token, integrity(reader), 8192, { now: 999 })).resolves.toMatchObject({ expiresAt: 1_000 })
  })

  it.each(DIRECTIONS)("a tampered cursor from %s fails integrity on %s, and a key rotation spans the releases", async (writer, reader) => {
    const token = await releaseOps[writer].encodeCursor({ ...cursorPayload }, integrity(writer))
    const [prefix, body, signature] = token.split(".")
    const forged = `${prefix}.${body!.replace(/.$/, (last) => (last === "A" ? "B" : "A"))}.${signature}`
    await expect(releaseOps[reader].decodeCursor(forged, integrity(reader))).rejects.toMatchObject({ message: expect.stringMatching(/integrity|non-canonical|malformed/) })
    const rotated = releaseOps[reader].createRotatingCursorIntegrity(hmacCursorIntegrity(releaseOps[reader], "next-key"), [integrity(reader)])
    await expect(releaseOps[reader].decodeCursor(token, rotated)).resolves.toMatchObject({ values: ["r-100", 42, true, null] })
    await expect(releaseOps[reader].decodeCursor(token, hmacCursorIntegrity(releaseOps[reader], "next-key"))).rejects.toMatchObject({ message: "cursor integrity verification failed" })
  })

  it("derives the same cursor binding hashes in both releases (the list handler binds a cursor to route, query, scope and sort)", async () => {
    const bindings = [
      { moduleKey: "orders", entity: { name: "order", namespace: null }, route: "list" },
      { filters: { status: "open", "10": 1 }, fields: ["id", "name"], consistency: null },
      { scopeId: "fscope:v1:abc", cacheScopeKey: null, securityDigest: null },
      [{ field: "id", direction: "asc" }],
    ]
    for (const material of bindings) expect(await old.fingerprintJson(material)).toBe(await current.fingerprintJson(material))
  })
})

describe("list cursors through the list handler (opt-in cursorTtlMs, .changeset/list-cursor-ttl.md)", () => {
  type Row = { id: string; name: string; title: string }
  type Shared = CrudShared<Row, Row, Partial<Row>, Row, Row>
  const rows: Row[] = [{ id: "r1", name: "a", title: "t1" }, { id: "r2", name: "b", title: "t2" }]
  const integrity = hmacCursorIntegrity(old, "list-cursor-upgrade-key")
  const descriptor: EntityDescriptor<Row> = { name: "orders", primaryKey: "id", fields: { id: { type: "string" }, name: { type: "string" }, title: { type: "string" } } }
  const handler = (pagination: Record<string, unknown>) => {
    const persistence = {
      dialect: "test",
      capabilities: {} as PersistenceProvider["capabilities"],
      repository: () => ({ findMany: async () => ({ rows, rowCount: rows.length, page: 1, pageSize: 10, pageInfo: { kind: "cursor", hasNextPage: true, hasPreviousPage: false } }) }),
    } as unknown as PersistenceProvider
    const options = {
      adapterDeps: {}, requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), "test.cursor"), scope: { scope: "tenant" as const },
      moduleKey: "test.cursor", entity: descriptor, policy: { skipCapabilityCheck: true }, filterableColumns: ["id", "name", "title"], searchableColumns: ["name", "title"], sortableColumns: ["id"],
      pagination: { strategy: "cursor", integrity, uniqueFields: ["id"], ...pagination } as ListPaginationConfig, cache: { enabled: false, tag: "test", keyPrefix: "test" }, getCacheAdapter: async () => null as never, createPersistence: () => persistence,
    } as unknown as Shared["options"]
    const shared = {
      options, entity: descriptor, deps: options.adapterDeps, routes: { list: true, detail: false, create: false, update: false, delete: false },
      enforceReadAccess: async () => undefined, buildReadScope: () => ({ filter: undefined }), enforceReadRateLimit: async () => undefined, buildReadTags: () => [], resolveDefaultSort: () => [{ field: "id", direction: "asc" }],
    } as unknown as Shared
    return (query = "") => createListHandler(shared)(new Request(`https://example.test/items${query}`))
  }
  const findEndCursor = (value: unknown): string | undefined => {
    if (value === null || typeof value !== "object") return undefined
    const record = value as Record<string, unknown>
    if (typeof record.endCursor === "string") return record.endCursor
    for (const item of Object.values(record)) { const found = findEndCursor(item); if (found) return found }
    return undefined
  }
  const issue = async (list: ReturnType<typeof handler>): Promise<string> => {
    const response = await list()
    const body = await response.text()
    expect(response.status, body).toBe(200)
    return findEndCursor(JSON.parse(body))!
  }
  afterEach(() => { vi.useRealTimers() })

  it("issues the cursor 0.1.0 issued when no TTL is configured, and replays it", async () => {
    const list = handler({})
    const cursor = await issue(list)
    const decoded = await old.decodeCursor(cursor, integrity)
    expect(decoded.expiresAt).toBeUndefined()
    // 0.1.0's codec re-encodes the payload to the identical token: nothing in the format moved.
    expect(await old.encodeCursor({ ...decoded } as never, integrity)).toBe(cursor)
    const replay = await list(`?cursor=${encodeURIComponent(cursor)}`)
    expect(replay.status, await replay.clone().text()).toBe(200)
  })

  it("refuses a cursor 0.1.0 issued (no expiry) once cursorTtlMs is enabled, with the stale-cursor 400", async () => {
    // Documented: a cursor issued before the TTL was enabled carries no expiry and would never lapse (.changeset/list-cursor-ttl.md).
    const legacyCursor = await issue(handler({}))
    const response = await handler({ cursorTtlMs: 60_000 })(`?cursor=${encodeURIComponent(legacyCursor)}`)
    expect(response.status).toBe(400)
    expect(await response.text()).toMatch(/restart from the first page/)
  })

  it("issues expiring cursors that 0.1.0's codec reads and enforces, and that the current handler refuses once expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const start = new Date("2026-10-20T00:00:00Z")
    vi.setSystemTime(start)
    const list = handler({ cursorTtlMs: 60_000 })
    const cursor = await issue(list)
    const decoded = await old.decodeCursor(cursor, integrity, 8192, { now: start.getTime() })
    expect(decoded.expiresAt).toBe(start.getTime() + 60_000)
    await expect(old.decodeCursor(cursor, integrity, 8192, { now: start.getTime() + 60_000 })).rejects.toMatchObject({ message: "cursor expired" })
    vi.setSystemTime(start.getTime() + 59_999)
    expect((await list(`?cursor=${encodeURIComponent(cursor)}`)).status).toBe(200)
    vi.setSystemTime(start.getTime() + 60_000)
    const expired = await list(`?cursor=${encodeURIComponent(cursor)}`)
    expect(expired.status).toBe(400)
    expect(await expired.text()).toMatch(/restart from the first page/)
  })
})

/** A fake KV namespace; the counters and values it holds are visible to the test. */
class FakeKv {
  readonly store = new Map<string, string>()
  async get(key: string, options?: { type: "json" }): Promise<unknown> {
    const value = this.store.get(key)
    if (value === undefined) return null
    return options?.type === "json" ? JSON.parse(value) as unknown : value
  }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value) }
  async delete(key: string): Promise<void> { this.store.delete(key) }
  async list(options?: { prefix?: string }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
    return { keys: [...this.store.keys()].filter((name) => !options?.prefix || name.startsWith(options.prefix)).map((name) => ({ name })), list_complete: true }
  }
  raw(key: string): string | undefined {
    const value = this.store.get(key)
    return value === undefined ? undefined : JSON.parse(value) as string
  }
}

describe("KV cache tag-generation layouts (packages/adapters/src/cache/kvCacheAdapter.ts)", () => {
  const CURRENT_LAYOUT = "__cachegen__:"
  const PREVIOUS_LAYOUT = "__cache__:__generation__:"
  const TAGGED_KEY = "__generation__:\"1:probe\":value"
  const open = (release: Release, kv: FakeKv): KvAdapter => new releaseOps[release].KvCacheAdapter(kv as never)

  it.each(DIRECTIONS)("values cached by %s are served by %s and a delete by the reader is seen by the writer", async (writer, reader) => {
    const kv = new FakeKv()
    await open(writer, kv).set("plain", { n: 1, nested: ["a"] })
    await open(writer, kv).set("ttl", "x", 120_000)
    expect(await open(reader, kv).get("plain")).toEqual({ n: 1, nested: ["a"] })
    expect(await open(reader, kv).get("ttl")).toBe("x")
    expect(await open(reader, kv).delete("plain")).toBe(true)
    expect(await open(writer, kv).has("plain")).toBe(false)
  })

  it.each(DIRECTIONS)("a tag advanced by %s is observed by %s, and the reader's advance by the writer", async (writer, reader) => {
    const kv = new FakeKv()
    expect(await open(reader, kv).getTagGeneration("t")).toBe("0")
    const first = await open(writer, kv).advanceTagGeneration("t")
    expect(await open(reader, kv).getTagGeneration("t")).toBe(first)
    expect(await open(writer, kv).getTagGeneration("t")).toBe(first)
    const second = await open(reader, kv).advanceTagGeneration("t")
    expect(second).not.toBe(first)
    expect(await open(writer, kv).getTagGeneration("t")).toBe(second)
    // Both layouts hold the same counter, which is what lets an instance on either release read it.
    expect(kv.raw(`${CURRENT_LAYOUT}t`)).toBe(second)
    expect(kv.raw(`${PREVIOUS_LAYOUT}t`)).toBe(second)
  })

  it.each(RELEASES)("an advance by an instance on the layout before 0.1.0 (previous counter only) is observed by %s and converges on the next advance", async (release) => {
    const kv = new FakeKv()
    const adapter = open(release, kv)
    const initial = await adapter.advanceTagGeneration("t")
    await kv.put(`${PREVIOUS_LAYOUT}t`, JSON.stringify("999:00000000-0000-4000-8000-000000000000"))
    const observed = await adapter.getTagGeneration("t")
    expect(observed, "a change to either counter must change what is observed").not.toBe(initial)
    expect(observed).not.toBe("0")
    // Every release observes the same token for the same pair of counters.
    for (const other of RELEASES) expect(await open(other, kv).getTagGeneration("t")).toBe(observed)
    const converged = await adapter.advanceTagGeneration("t")
    for (const other of RELEASES) expect(await open(other, kv).getTagGeneration("t")).toBe(converged)
  })

  it.each(DIRECTIONS)("clear() by %s keeps the counters of both layouts and drops tagged values written by %s", async (clearer, other) => {
    const kv = new FakeKv()
    const generation = await open(other, kv).advanceTagGeneration("t")
    await open(other, kv).set(TAGGED_KEY, "tagged")
    await open(other, kv).set("plain", "p")
    await open(clearer, kv).clear()
    expect(await open(other, kv).has(TAGGED_KEY)).toBe(false)
    expect(await open(other, kv).has("plain")).toBe(false)
    expect(kv.raw(`${CURRENT_LAYOUT}t`)).toBe(generation)
    expect(kv.raw(`${PREVIOUS_LAYOUT}t`)).toBe(generation)
    expect(await open(clearer, kv).getTagGeneration("t")).toBe(generation)
  })

  it("is not affected by which release computed the digest: the pair token of differing counters is the same in both releases", async () => {
    const kv = new FakeKv()
    await kv.put(`${CURRENT_LAYOUT}p`, JSON.stringify("1:a"))
    await kv.put(`${PREVIOUS_LAYOUT}p`, JSON.stringify("2:b"))
    const tokens = await Promise.all(RELEASES.map(async (release) => open(release, new FakeKvSeeded(kv)).getTagGeneration("p")))
    expect(tokens[0]).toMatch(/^h:[A-Za-z0-9_-]{43}$/)
    expect(tokens[1]).toBe(tokens[0])
  })
})

/** A read-only snapshot of another FakeKv, so reading one release cannot adopt counters for the next. */
class FakeKvSeeded extends FakeKv {
  constructor(source: FakeKv) { super(); for (const [key, value] of source.store) this.store.set(key, value) }
}
