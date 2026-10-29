import { describe, expect, it, vi } from "vitest"
import { ConfigurationError } from "../../domain"
import { reconstructAsOf, validateTemporalRevision, validateTemporalSnapshot } from "../temporal"
import type { TemporalHistoryStore, TemporalResource, TemporalRevision, TemporalRevisionPage, TemporalSnapshot } from "../types"

type S = { v: number }
const target: TemporalResource = { scopeId: "scope-1" as never, entityType: "order", entityId: "o1" }
const asOf = new Date(10_000)
const rev = (revision: number, kind: TemporalRevision<S>["kind"], state: S | null, o: Record<string, unknown> = {}): TemporalRevision<S> => ({ ...target, revision, kind, state, occurredAt: new Date(1000 * revision), ...o }) as TemporalRevision<S>
const snap = (revision: number, state: S | null, o: Record<string, unknown> = {}): TemporalSnapshot<S> => ({ ...target, revision, state, occurredAt: new Date(500), ...o }) as TemporalSnapshot<S>
const fails = (fn: () => unknown, message: string) => expect(fn).toThrow(new ConfigurationError(message))
const store = (o: { snapshot?: TemporalSnapshot<S> | null; pages?: unknown[] } = {}): TemporalHistoryStore<S> & { revisions: ReturnType<typeof vi.fn>; latestSnapshot: ReturnType<typeof vi.fn> } => {
  const pages = [...(o.pages ?? [{ items: [], hasMore: false }])]
  return {
    append: vi.fn(), saveSnapshot: vi.fn(),
    latestSnapshot: vi.fn(async () => o.snapshot ?? null),
    revisions: vi.fn(async () => pages.shift() as TemporalRevisionPage<S>),
  }
}
const replay = (s: TemporalHistoryStore<S>, options?: { maxRevisions?: number; pageSize?: number }) => reconstructAsOf(s, target, asOf, options)

describe("validateTemporalRevision", () => {
  const id = "Temporal resource identity is invalid"
  it("validates resource identity", () => {
    fails(() => validateTemporalRevision(null as never), id)
    for (const scopeId of ["", 5, "a\0b", "a\rb", "a\nb", "a".repeat(1025)]) fails(() => validateTemporalRevision(rev(1, "created", { v: 1 }, { scopeId })), id)
    for (const entityType of ["", "-x", 5, ["a"], "a".repeat(257)]) fails(() => validateTemporalRevision(rev(1, "created", { v: 1 }, { entityType })), id)
    for (const entityId of ["", "a b", 5, "a".repeat(257)]) fails(() => validateTemporalRevision(rev(1, "created", { v: 1 }, { entityId })), id)
    expect(validateTemporalRevision(rev(1, "created", { v: 1 }, { scopeId: "a".repeat(1024), entityType: "a".repeat(256), entityId: "b".repeat(256) })).revision).toBe(1)
  })
  it("validates revision number, timestamp, kind and state", () => {
    for (const revision of [0, -1, 1.5, Number.NaN]) fails(() => validateTemporalRevision(rev(revision, "created", { v: 1 })), "Temporal revision must be a positive safe integer")
    for (const occurredAt of ["2026", new Date(Number.NaN), undefined]) fails(() => validateTemporalRevision(rev(1, "created", { v: 1 }, { occurredAt })), "Temporal revision timestamp is invalid")
    fails(() => validateTemporalRevision(rev(1, "gone" as never, { v: 1 })), "Temporal revision kind is invalid")
    for (const state of [undefined, "x", 5, [1]]) fails(() => validateTemporalRevision(rev(1, "created", state as never)), "Temporal state must be a record or null")
    fails(() => validateTemporalRevision(rev(1, "deleted", { v: 1 })), "Deleted temporal revision must have null state")
    for (const kind of ["created", "updated", "restored"] as const) fails(() => validateTemporalRevision(rev(1, kind, null)), "Non-deleted temporal revision must have state")
    expect(validateTemporalRevision(rev(1, "deleted", null)).state).toBeNull()
  })
  it("validates optional entity version and linked identities", () => {
    fails(() => validateTemporalRevision(rev(1, "created", { v: 1 }, { entityVersion: -1 })), "Entity version must be a non-negative safe integer.")
    expect(validateTemporalRevision(rev(1, "created", { v: 1 }, { entityVersion: 0 })).entityVersion).toBe(0)
    fails(() => validateTemporalRevision(rev(1, "created", { v: 1 }, { eventId: "bad id" })), "Temporal event identity is invalid")
    fails(() => validateTemporalRevision(rev(1, "created", { v: 1 }, { auditId: "" })), "Temporal audit identity is invalid")
    fails(() => validateTemporalRevision(rev(1, "created", { v: 1 }, { eventId: 5 })), "Temporal event identity is invalid")
    const ok = validateTemporalRevision(rev(1, "created", { v: 1 }, { eventId: "e1", auditId: "a1" }))
    expect([ok.eventId, ok.auditId]).toEqual(["e1", "a1"])
  })
  it("returns a frozen snapshot labelled as a temporal revision", () => {
    const input = rev(1, "created", { v: 1 })
    const out = validateTemporalRevision(input)
    expect(out).not.toBe(input)
    expect(Object.isFrozen(out)).toBe(true)
    expect(out.occurredAt.getTime()).toBe(1000)
    expect(() => validateTemporalRevision(rev(1, "created", { v: 1 }, { extra: () => 1 }))).toThrow("Temporal revision must contain data only")
  })
})

describe("validateTemporalSnapshot", () => {
  it("validates identity, revision, timestamp and state", () => {
    fails(() => validateTemporalSnapshot(null as never), "Temporal resource identity is invalid")
    for (const revision of [-1, 1.5, Number.NaN]) fails(() => validateTemporalSnapshot(snap(revision, null)), "Temporal revision must be a positive safe integer")
    fails(() => validateTemporalSnapshot(snap(1, null, { occurredAt: "x" })), "Temporal snapshot timestamp is invalid")
    fails(() => validateTemporalSnapshot(snap(1, 5 as never)), "Temporal state must be a record or null")
    fails(() => validateTemporalSnapshot(snap(0, { v: 1 })), "A revision-0 temporal snapshot cannot carry state")
    expect(validateTemporalSnapshot(snap(0, null)).revision).toBe(0)
    expect(validateTemporalSnapshot(snap(1, null)).state).toBeNull()
    expect(validateTemporalSnapshot(snap(1, { v: 1 })).state).toEqual({ v: 1 })
    expect(() => validateTemporalSnapshot(snap(1, { v: 1 }, { extra: () => 1 }))).toThrow("Temporal snapshot must contain data only")
    expect(Object.isFrozen(validateTemporalSnapshot(snap(1, { v: 1 })))).toBe(true)
  })
})

describe("reconstructAsOf inputs", () => {
  it("validates the target, as-of instant and limits", async () => {
    await expect(reconstructAsOf(store(), { ...target, entityId: "" }, asOf)).rejects.toThrow(new ConfigurationError("Temporal resource identity is invalid"))
    for (const at of [new Date(Number.NaN), "2026", undefined]) await expect(reconstructAsOf(store(), target, at as never)).rejects.toThrow(new ConfigurationError("Temporal as-of timestamp is invalid"))
    const m = new ConfigurationError("Temporal replay limits are invalid")
    for (const options of [{ maxRevisions: 0 }, { maxRevisions: 1.5 }, { maxRevisions: 5, pageSize: 0 }, { maxRevisions: 5, pageSize: 6 }, { maxRevisions: 5, pageSize: 1.5 }, { pageSize: Number.NaN }]) await expect(replay(store(), options)).rejects.toThrow(m)
    await expect(replay(store(), { maxRevisions: 5, pageSize: 5 })).resolves.toBeDefined()
  })
  it("defaults the page size to min(250, max) and passes cursor, instant and limit", async () => {
    const a = store()
    await replay(a)
    expect(a.revisions).toHaveBeenCalledWith(target, { afterRevision: 0, asOf, limit: 250 })
    expect(a.latestSnapshot).toHaveBeenCalledWith(target, asOf)
    const b = store()
    await replay(b, { maxRevisions: 3 })
    expect(b.revisions).toHaveBeenCalledWith(target, { afterRevision: 0, asOf, limit: 3 })
    const c = store({ pages: [{ items: [rev(1, "created", { v: 1 }), rev(2, "updated", { v: 2 })], hasMore: true }, { items: [rev(3, "updated", { v: 3 })], hasMore: false }] })
    await replay(c, { maxRevisions: 5, pageSize: 2 })
    expect(c.revisions.mock.calls.map(call => call[1])).toEqual([{ afterRevision: 0, asOf, limit: 2 }, { afterRevision: 2, asOf, limit: 2 }])
    const d = store({ pages: [{ items: [rev(1, "created", { v: 1 }), rev(2, "updated", { v: 2 })], hasMore: true }, { items: [rev(3, "updated", { v: 3 })], hasMore: false }] })
    await replay(d, { maxRevisions: 3, pageSize: 2 })
    expect(d.revisions.mock.calls[1]![1]).toEqual({ afterRevision: 2, asOf, limit: 1 })
  })
})

describe("reconstructAsOf snapshots", () => {
  it("starts from a valid base snapshot", async () => {
    const s = store({ snapshot: snap(2, { v: 2 }), pages: [{ items: [rev(3, "updated", { v: 3 })], hasMore: false }] })
    const out = await replay(s)
    expect(s.revisions).toHaveBeenCalledWith(target, { afterRevision: 2, asOf, limit: 250 })
    expect(out.revision).toBe(3)
    expect(out.state).toEqual({ v: 3 })
    expect(out.replayedRevisions).toBe(1)
    const only = await replay(store({ snapshot: snap(2, { v: 2 }) }))
    expect(only).toMatchObject({ revision: 2, state: { v: 2 }, deleted: false, replayedRevisions: 0 })
  })
  it("rejects snapshots for another resource or from the future", async () => {
    const outside = new ConfigurationError("Temporal store returned a snapshot outside the request")
    for (const o of [{ scopeId: "other" }, { entityType: "other" }, { entityId: "other" }]) await expect(replay(store({ snapshot: snap(1, { v: 1 }, o) }))).rejects.toThrow(outside)
    await expect(replay(store({ snapshot: snap(1, { v: 1 }, { occurredAt: new Date(10_001) }) }))).rejects.toThrow(new ConfigurationError("Temporal store returned a future snapshot"))
    await expect(replay(store({ snapshot: snap(1, { v: 1 }, { occurredAt: new Date(10_000) }) }))).resolves.toMatchObject({ revision: 1 })
    await expect(replay(store({ snapshot: snap(1, 5 as never) }))).rejects.toThrow(new ConfigurationError("Temporal state must be a record or null"))
  })
  it("reports a deleted snapshot as deleted", async () => {
    expect(await replay(store({ snapshot: snap(3, null) }))).toMatchObject({ revision: 3, state: null, deleted: true })
  })
})

describe("reconstructAsOf pages and streams", () => {
  const page = (items: unknown[], hasMore = false) => ({ items, hasMore })
  const invalidPage = new ConfigurationError("Temporal store returned an invalid revision page")
  it("rejects malformed pages", async () => {
    for (const p of [undefined, null, { items: "x", hasMore: false }, { items: [], hasMore: "no" }, { items: [], hasMore: undefined }, { items: [], hasMore: 0 }, { items: [rev(1, "created", { v: 1 })], hasMore: undefined }, { items: [rev(1, "created", { v: 1 })], hasMore: null }, { items: [], hasMore: true }, { hasMore: false }]) await expect(replay(store({ pages: [p] }))).rejects.toThrow(invalidPage)
    await expect(replay(store({ pages: [page([rev(1, "created", { v: 1 }), rev(2, "updated", { v: 2 })])] }), { maxRevisions: 5, pageSize: 1 })).rejects.toThrow(invalidPage)
    await expect(replay(store({ pages: [page([rev(1, "created", { v: 1 })])] }), { maxRevisions: 5, pageSize: 1 })).resolves.toMatchObject({ revision: 1 })
  })
  it("rejects revisions outside the request", async () => {
    const m = new ConfigurationError("Temporal store returned a revision outside the request")
    for (const o of [{ scopeId: "other" }, { entityType: "other" }, { entityId: "other" }, { occurredAt: new Date(10_001) }]) await expect(replay(store({ pages: [page([rev(1, "created", { v: 1 }, o)])] }))).rejects.toThrow(m)
    await expect(replay(store({ pages: [page([rev(1, "created", { v: 1 }, { occurredAt: new Date(10_000) })])] }))).resolves.toMatchObject({ revision: 1 })
    await expect(replay(store({ pages: [page([rev(1, "created", 5 as never)])] }))).rejects.toThrow(new ConfigurationError("Temporal state must be a record or null"))
  })
  it("enforces a contiguous, well-ordered lifecycle", async () => {
    const run = (...items: TemporalRevision<S>[]) => replay(store({ pages: [page(items)] }))
    await expect(run(rev(2, "created", { v: 1 }))).rejects.toThrow(new ConfigurationError("Temporal revision stream is not contiguous"))
    await expect(run(rev(1, "created", { v: 1 }), rev(3, "updated", { v: 2 }))).rejects.toThrow(new ConfigurationError("Temporal revision stream is not contiguous"))
    await expect(run(rev(1, "updated", { v: 1 }))).rejects.toThrow(new ConfigurationError("Temporal revision stream must begin with creation"))
    await expect(run(rev(1, "created", { v: 1 }), rev(2, "deleted", null), rev(3, "updated", { v: 2 }))).rejects.toThrow(new ConfigurationError("Deleted temporal state must be restored before further updates"))
    await expect(run(rev(1, "created", { v: 1 }), rev(2, "deleted", null), rev(3, "created", { v: 2 }))).rejects.toThrow(new ConfigurationError("Deleted temporal state must be restored before further updates"))
    await expect(run(rev(1, "created", { v: 1 }), rev(2, "created", { v: 2 }))).rejects.toThrow(new ConfigurationError("Active temporal state only accepts update or deletion"))
    await expect(run(rev(1, "created", { v: 1 }), rev(2, "restored", { v: 2 }))).rejects.toThrow(new ConfigurationError("Active temporal state only accepts update or deletion"))
    const restored = await run(rev(1, "created", { v: 1 }), rev(2, "deleted", null), rev(3, "restored", { v: 3 }), rev(4, "updated", { v: 4 }))
    expect(restored).toMatchObject({ revision: 4, state: { v: 4 }, deleted: false, replayedRevisions: 4 })
  })
  it("enforces the revision limit", async () => {
    const m = new ConfigurationError("Temporal replay exceeds the configured revision limit")
    const three = [rev(1, "created", { v: 1 }), rev(2, "updated", { v: 2 }), rev(3, "updated", { v: 3 })]
    await expect(replay(store({ pages: [page(three)] }), { maxRevisions: 3 })).resolves.toMatchObject({ replayedRevisions: 3 })
    await expect(replay(store({ pages: [page(three.slice(0, 2), true), page([three[2]!], true)] }), { maxRevisions: 3, pageSize: 2 })).rejects.toThrow(m)
    await expect(replay(store({ pages: [page(three.slice(0, 2), true), page([three[2]!], false)] }), { maxRevisions: 3, pageSize: 2 })).resolves.toMatchObject({ replayedRevisions: 3 })
    await expect(replay(store({ pages: [page(three.slice(0, 2), true)] }), { maxRevisions: 2, pageSize: 2 })).rejects.toThrow(m)
  })
  it("builds a frozen reconstruction", async () => {
    const none = await replay(store())
    expect(none).toEqual({ resource: target, asOf, revision: null, state: null, deleted: false, replayedRevisions: 0 })
    expect(Object.isFrozen(none)).toBe(true)
    const deleted = await replay(store({ pages: [page([rev(1, "created", { v: 1 }), rev(2, "deleted", null)])] }))
    expect(deleted).toMatchObject({ revision: 2, state: null, deleted: true, replayedRevisions: 2 })
    expect(deleted.asOf).not.toBe(asOf)
    expect(deleted.asOf.getTime()).toBe(10_000)
    await expect(reconstructAsOf(store(), { ...target, extra: () => 1 } as never, asOf)).rejects.toThrow("Temporal reconstruction must contain data only")
  })
})
