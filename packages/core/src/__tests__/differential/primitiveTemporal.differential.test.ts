import { describe, expect, it } from "vitest"
import { forAllAsync, forAll, type Rng } from "./harness"
import { ConfigurationError } from "../../domain/errors"
import { encodeExecutionScopeId } from "../../domain"
import { reconstructAsOf, validateTemporalRevision, validateTemporalSnapshot } from "../../temporal/temporal"
import type { TemporalHistoryStore, TemporalResource, TemporalRevision, TemporalRevisionKind, TemporalSnapshot } from "../../temporal/types"

/**
 * Point-in-time reconstruction is compared with a brute-force oracle (scan the
 * whole history, keep the last revision at or before the instant) over
 * generated lifecycles, with and without acceleration snapshots, with
 * different page sizes and replay bounds, and with exactly one injected store
 * fault that reconstruction must reject.
 */

const resource: TemporalResource = { scopeId: encodeExecutionScopeId({ kind: "system", systemKey: "test" }), entityType: "person", entityId: "p1" }
const T0 = Date.UTC(2026, 0, 1)

type Fault = "none" | "gap" | "duplicate" | "foreign" | "future" | "empty-hasmore" | "bad-first-kind" | "bad-kind" | "deleted-with-state" | "foreign-snapshot" | "future-snapshot" | "ghost-snapshot" | "oversized-page"

interface HistoryCase {
  kinds: TemporalRevisionKind[]
  /** Non-negative increments in ms; zeros give same-instant revisions. */
  gaps: number[]
  asOfOffset: number
  snapshotAt: number | null
  pageSize: number
  maxRevisions: number
  fault: Fault
}

function generateKinds(rng: Rng): TemporalRevisionKind[] {
  const kinds: TemporalRevisionKind[] = ["created"]
  let deleted = false
  const n = rng.int(14)
  for (let i = 0; i < n; i++) {
    if (deleted) { kinds.push("restored"); deleted = false } else if (rng.bool(0.3)) { kinds.push("deleted"); deleted = true } else kinds.push("updated")
  }
  return kinds
}

function generateHistory(rng: Rng): HistoryCase {
  const kinds = generateKinds(rng)
  return {
    kinds,
    gaps: kinds.map(() => rng.pick([0, 0, 1, 1, 10, 1000])),
    asOfOffset: rng.int(Math.max(1, 3000)) - 100,
    snapshotAt: rng.bool(0.5) ? rng.int(kinds.length + 1) : null,
    pageSize: rng.pick([1, 2, 3, 5, 250]),
    maxRevisions: rng.pick([1, 2, 3, 5, 10_000, 10_000]),
    fault: rng.bool(0.45) ? rng.pick(["gap", "duplicate", "foreign", "future", "empty-hasmore", "bad-first-kind", "bad-kind", "deleted-with-state", "foreign-snapshot", "future-snapshot", "ghost-snapshot", "oversized-page"] as const) : "none",
  }
}

function buildHistory(c: HistoryCase): TemporalRevision[] {
  let at = T0
  return c.kinds.map((kind, index) => {
    at += c.gaps[index]!
    return { ...resource, revision: index + 1, occurredAt: new Date(at), kind, state: kind === "deleted" ? null : { rev: index + 1, nested: { at: new Date(at) } } }
  })
}

function makeStore(history: TemporalRevision[], c: HistoryCase, calls: { revisions: number }): TemporalHistoryStore {
  const snapshotSource = c.snapshotAt !== null && c.snapshotAt > 0 ? history[c.snapshotAt - 1] : undefined
  return {
    append: async () => { throw new Error("unused") },
    saveSnapshot: async () => undefined,
    latestSnapshot: async (_resource, asOf) => {
      if (c.fault === "foreign-snapshot") return { ...resource, entityId: "other", revision: 1, occurredAt: new Date(T0 - 1), state: { rev: 1 } }
      if (c.fault === "future-snapshot") return { ...resource, revision: 1, occurredAt: new Date(asOf.getTime() + 1), state: { rev: 1 } }
      if (c.fault === "ghost-snapshot") return { ...resource, revision: 0, occurredAt: new Date(T0 - 1), state: { rev: 0 } }
      if (c.snapshotAt === 0) return null
      if (snapshotSource && snapshotSource.occurredAt <= asOf) return { ...resource, revision: snapshotSource.revision, occurredAt: snapshotSource.occurredAt, state: snapshotSource.state }
      return null
    },
    revisions: async (_resource, options) => {
      calls.revisions++
      const eligible = history.filter((item) => item.revision > options.afterRevision && item.occurredAt <= options.asOf)
      let items = eligible.slice(0, options.limit)
      const hasMore = eligible.length > items.length
      if (calls.revisions === 1 && items.length > 0) {
        const first = items[0]!
        switch (c.fault) {
          case "gap": items = [{ ...first, revision: first.revision + 1 }, ...items.slice(1)]; break
          case "duplicate": items = [first, first, ...items.slice(1)]; break
          case "foreign": items = [{ ...first, entityId: "other" }, ...items.slice(1)]; break
          case "future": items = [{ ...first, occurredAt: new Date(options.asOf.getTime() + 1) }, ...items.slice(1)]; break
          case "empty-hasmore": return { items: [], hasMore: true }
          // More revisions than the requested limit (the next real one when it exists, so only the size is wrong).
          case "oversized-page": items = [...items, eligible[items.length] ?? items[items.length - 1]!]; break
          case "bad-first-kind": if (first.revision === 1) items = [{ ...first, kind: "updated" }, ...items.slice(1)]; break
          case "bad-kind": if (items.length > 0) items = [{ ...first, kind: first.revision === 1 ? "restored" : "created" }, ...items.slice(1)]; break
          case "deleted-with-state": items = [{ ...first, kind: "deleted" }, ...items.slice(1)]; break
          default: break
        }
      }
      return { items, hasMore }
    },
  }
}

describe("temporal reconstruction", () => {
  it("reconstructAsOf ≡ brute-force scan of the history (snapshots, paging and bounds included); a single injected store fault is always rejected", async () => {
    await forAllAsync("temporal reconstruction vs scan", generateHistory, async (c) => {
      const history = buildHistory(c)
      const asOf = new Date(history[history.length - 1]!.occurredAt.getTime() + c.asOfOffset - 1000)
      const calls = { revisions: 0 }
      const store = makeStore(history, c, calls)
      const outcome = await reconstructAsOf(store, resource, asOf, { pageSize: Math.min(c.pageSize, c.maxRevisions), maxRevisions: c.maxRevisions }).then((value) => ({ value }), (error: unknown) => ({ error }))

      // Oracle: last revision at or before the instant (inclusive), found by a plain scan.
      let target = 0
      for (const item of history) if (item.occurredAt.getTime() <= asOf.getTime()) target = item.revision
      const snapshotUsable = c.snapshotAt !== null && c.snapshotAt > 0 && history[c.snapshotAt - 1]!.occurredAt.getTime() <= asOf.getTime()
      const baseRevision = snapshotUsable ? c.snapshotAt! : 0
      const replayNeeded = Math.max(target - baseRevision, 0)

      // Which injected faults must be noticed. Snapshot faults always are; page faults only act on a non-empty first page.
      const firstItem = replayNeeded > 0 ? history[baseRevision] : undefined
      let faultBites = false
      switch (c.fault) {
        case "none": break
        case "foreign-snapshot": case "future-snapshot": case "ghost-snapshot": faultBites = true; break
        case "bad-first-kind": faultBites = firstItem !== undefined && firstItem.revision === 1; break
        case "deleted-with-state": faultBites = firstItem !== undefined && firstItem.kind !== "deleted"; break
        default: faultBites = firstItem !== undefined
      }
      if (faultBites) {
        expect((outcome as { error?: unknown }).error, `fault ${c.fault} must be rejected`).toBeInstanceOf(ConfigurationError)
        return
      }
      if (replayNeeded > c.maxRevisions) {
        expect((outcome as { error?: unknown }).error, "replay beyond the bound").toBeInstanceOf(ConfigurationError)
        return
      }
      expect((outcome as { error?: unknown }).error, "honest store must reconstruct").toBeUndefined()
      const result = (outcome as { value: Awaited<ReturnType<typeof reconstructAsOf>> }).value
      const expectedRevision = target === 0 ? null : target
      expect(result.revision).toBe(expectedRevision)
      const last = target === 0 ? undefined : history[target - 1]
      expect(result.deleted).toBe(last !== undefined && last.state === null)
      expect(result.state).toEqual(last === undefined ? null : last.state)
      expect(result.replayedRevisions).toBe(replayNeeded)
      expect(result.asOf.getTime()).toBe(asOf.getTime())
      expect(result.asOf).not.toBe(asOf)
      // Snapshot equivalence: dropping the snapshot must not change the reconstruction.
      if (c.maxRevisions >= history.length) {
        const bare = await reconstructAsOf(makeStore(history, { ...c, snapshotAt: null, fault: "none" }, { revisions: 0 }), resource, asOf, { pageSize: Math.min(c.pageSize, c.maxRevisions), maxRevisions: c.maxRevisions })
        expect({ revision: bare.revision, state: bare.state, deleted: bare.deleted }).toEqual({ revision: result.revision, state: result.state, deleted: result.deleted })
      }
    }, {
      runs: 400,
      describe: (c) => JSON.stringify(c),
      shrink: function* (c: HistoryCase): Generator<HistoryCase> {
        if (c.fault !== "none") yield { ...c, fault: "none" as Fault }
        if (c.snapshotAt !== null) yield { ...c, snapshotAt: null }
        if (c.kinds.length > 1) { const keep = c.kinds.length - 1; yield { ...c, kinds: c.kinds.slice(0, keep), gaps: c.gaps.slice(0, keep), snapshotAt: c.snapshotAt !== null ? Math.min(c.snapshotAt, keep) : null } }
      },
    })
  })

  it("rejects invalid as-of instants and replay limits before touching the store", async () => {
    await forAllAsync("temporal argument validation", (rng) => ({
      asOf: rng.pick([new Date(NaN), "2026-01-01", 0, null, undefined, new Date(0)] as unknown[]),
      max: rng.pick([undefined, 0, -1, 1.5, NaN, 10, Number.MAX_SAFE_INTEGER + 1] as unknown[]),
      page: rng.pick([undefined, 0, -1, 1.5, 5, 11, 250] as unknown[]),
    }), async (c) => {
      let touched = 0
      const store: TemporalHistoryStore = {
        append: async () => { throw new Error("unused") }, saveSnapshot: async () => undefined,
        latestSnapshot: async () => { touched++; return null }, revisions: async () => { touched++; return { items: [], hasMore: false } },
      }
      const max = c.max as number | undefined
      const page = c.page as number | undefined
      const asOfValid = c.asOf instanceof Date && !Number.isNaN(c.asOf.getTime())
      const effectiveMax = max ?? 10_000
      const effectivePage = page ?? Math.min(250, effectiveMax)
      const limitsValid = Number.isSafeInteger(effectiveMax) && effectiveMax >= 1 && Number.isSafeInteger(effectivePage) && effectivePage >= 1 && effectivePage <= effectiveMax
      const outcome = await reconstructAsOf(store, resource, c.asOf as Date, { ...(max !== undefined ? { maxRevisions: max } : {}), ...(page !== undefined ? { pageSize: page } : {}) }).then(() => "ok", (error: unknown) => error)
      if (asOfValid && limitsValid) { expect(outcome).toBe("ok") } else { expect(outcome).toBeInstanceOf(ConfigurationError); expect(touched).toBe(0) }
    }, { runs: 120, describe: (c) => JSON.stringify(c, (_k, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v === undefined ? "<undefined>" : v)) })
  })
})

describe("temporal revision and snapshot validation", () => {
  const goodState = { n: 1 }
  function generateRevision(rng: Rng): Record<string, unknown> {
    const wild = rng.bool(0.6)
    const pickBad = <T>(good: T, bad: unknown[]): unknown => (wild && rng.bool(0.15) ? rng.pick(bad) : good)
    const kind = rng.pick(["created", "updated", "deleted", "restored"] as const)
    const revision: Record<string, unknown> = {
      scopeId: pickBad(resource.scopeId, ["", "a".repeat(1025), "x\0y", "x\ny", 5, null]),
      entityType: pickBad("person", ["", "-lead", "a b", ["person"], 5, null, "a".repeat(257), "é"]),
      entityId: pickBad("p1", ["", "bad id", ["p1"], 5, null, { toString: () => "p1" }]),
      revision: pickBad(1 + rng.int(5), [0, -1, 1.5, NaN, "1", Number.MAX_SAFE_INTEGER + 1]),
      occurredAt: pickBad(new Date(T0), [new Date(NaN), "2026-01-01", 5, null]),
      kind: pickBad(kind, ["merged", "", null]),
      state: kind === "deleted" ? (wild && rng.bool(0.3) ? goodState : null) : (wild && rng.bool(0.3) ? rng.pick([null, [1], 5, "s"] as unknown[]) : goodState),
    }
    if (rng.bool(0.3)) revision.eventId = pickBad("evt-1", ["bad id", "", ["evt-1"], 5, null])
    if (rng.bool(0.3)) revision.auditId = pickBad("aud-1", ["bad id", "", ["aud-1"], 5, null])
    return revision
  }

  const isKey = (v: unknown, max: number): boolean => typeof v === "string" && v.length >= 1 && v.length <= max && /^[A-Za-z0-9]/.test(v) && /^[A-Za-z0-9._:-]+$/.test(v)

  it("validateTemporalRevision accepts exactly the documented shapes (identity, lifecycle/state consistency, ids), including non-string identities", () => {
    forAll("temporal revision validity", generateRevision, (r) => {
      const stateOk = r.state === null || (typeof r.state === "object" && r.state !== null && !Array.isArray(r.state))
      const valid = typeof r.scopeId === "string" && r.scopeId.length > 0 && r.scopeId.length <= 1024 && !/[\0\r\n]/.test(r.scopeId)
        && isKey(r.entityType, 256) && isKey(r.entityId, 256)
        && typeof r.revision === "number" && Number.isSafeInteger(r.revision) && r.revision >= 1
        && r.occurredAt instanceof Date && !Number.isNaN(r.occurredAt.getTime())
        && ["created", "updated", "deleted", "restored"].includes(r.kind as string)
        && stateOk && (r.kind === "deleted" ? r.state === null : r.state !== null)
        && (r.eventId === undefined || isKey(r.eventId, 256)) && (r.auditId === undefined || isKey(r.auditId, 256))
      let thrown: unknown
      try { validateTemporalRevision(r as never) } catch (error) { thrown = error }
      if (valid) expect(thrown, "valid revision rejected").toBeUndefined()
      else expect(thrown, "invalid revision accepted").toBeInstanceOf(ConfigurationError)
    }, { runs: 500, describe: (r) => JSON.stringify(r, (_k, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v)) })
  })

  it("validateTemporalSnapshot: revision 0 carries no state; revisions above 0 may carry state or null", () => {
    forAll("temporal snapshot validity", (rng) => ({
      revision: rng.pick([0, 0, 1, 7, -1, 1.5, NaN]),
      state: rng.pick([null, { a: 1 }, [1], 5] as unknown[]),
      at: rng.pick([new Date(T0), new Date(NaN)]),
    }), (c) => {
      const stateOk = c.state === null || (typeof c.state === "object" && !Array.isArray(c.state))
      const valid = Number.isSafeInteger(c.revision) && c.revision >= 0 && !Number.isNaN(c.at.getTime()) && stateOk && !(c.revision === 0 && c.state !== null)
      let thrown: unknown
      let out: TemporalSnapshot | undefined
      try { out = validateTemporalSnapshot({ ...resource, revision: c.revision, occurredAt: c.at, state: c.state as never }) } catch (error) { thrown = error }
      if (valid) { expect(thrown).toBeUndefined(); expect(out!.occurredAt).not.toBe(c.at); expect(out!.occurredAt.getTime()).toBe(c.at.getTime()) } else expect(thrown).toBeInstanceOf(ConfigurationError)
    }, { runs: 150, describe: (c) => JSON.stringify(c, (_k, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v)) })
  })
})
