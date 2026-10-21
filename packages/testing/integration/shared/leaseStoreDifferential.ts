import { appendFileSync } from "node:fs"
import { expect, it } from "vitest"
import { FrameworkCoreError } from "@xonava/core/domain"
import type { FencedLease, LeasePort } from "@xonava/core/events"
import { forAllAsync, scaledRuns } from "../../../core/src/__tests__/differential/harness.js"
import { TIMING_SCALE } from "../../../core/src/__tests__/timing.js"
import { shiftTimestamps } from "./deliveryStoreDifferential.js"
import {
  CELLS, DAY, HOUR, MINUTE, ModelLease, T0, describeOps, generateOps, heldView, leaseView, shrinkOps,
  type LeaseSide, type Op, type Ref,
} from "./leaseStoreDifferentialModel.js"

export { DAY, HOUR, MINUTE, shiftTimestamps }

/** A real database behind a fenced lease store. */
export interface LeaseDriver extends LeaseSide {
  /** Property-name suffix, e.g. "postgres". */
  label: string
  /** Deletes every lease row. */
  reset(): Promise<void>
  /** Base run count of the sequential property at scale 1. */
  lifecycleRuns?: number
  /** Base run count of the concurrency properties at scale 1. */
  concurrencyRuns?: number
  /** Slow transports use short sequences. */
  light?: boolean
}

/** Coverage counters, printed when LEASE_STORE_DIFFERENTIAL_STATS is set. */
const COVERAGE = new Map<string, number>()
export function coverage(key: string): void { COVERAGE.set(key, (COVERAGE.get(key) ?? 0) + 1) }
export function printCoverage(label: string): void {
  const file = process.env.LEASE_STORE_DIFFERENTIAL_STATS
  if (file) appendFileSync(file, `${label} coverage ${JSON.stringify(Object.fromEntries([...COVERAGE].sort()))}\n`)
}

/** Generous per-test budget: a failing property shrinks. It grows with DIFFERENTIAL_SCALE like the case counts do. */
export const PROPERTY_TIMEOUT_MS = Math.ceil(300_000 * Math.max(1, scaledRuns(100) / 100) * TIMING_SCALE)

/** Stable text for an error, independent of the database driver: framework errors by code, everything else by name and message. */
export function classify(error: unknown): string {
  if (error instanceof FrameworkCoreError) return error.code
  return `unexpected:${error instanceof Error ? `${error.name}:${error.message}` : String(error)}`
}

// ------------------------------------------------------------------------------------------------ one side

interface Ctx { side: LeaseSide; tokens: string[]; issued: Map<number, FencedLease[]>; renewed: Map<number, FencedLease> }

const tokenIndex = (ctx: Ctx) => (token: string): number => {
  let index = ctx.tokens.indexOf(token)
  if (index < 0) { ctx.tokens.push(token); index = ctx.tokens.length - 1 }
  return index
}

const unissued = (cell: number): FencedLease => ({ resource: CELLS[cell]!, owner: "w1", claimToken: "never-issued", fencingToken: 1, acquiredAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + HOUR).toISOString() })

function resolve(ctx: Ctx, cell: number, ref: Ref): FencedLease {
  const list = ctx.issued.get(cell) ?? []
  const latest = list[list.length - 1]
  switch (ref) {
    case "latest": return latest ?? unissued(cell)
    case "previous": return list[list.length - 2] ?? unissued(cell)
    case "renewed": return ctx.renewed.get(cell) ?? latest ?? unissued(cell)
    case "wrongToken": return { ...(latest ?? unissued(cell)), claimToken: "bogus-token" }
    case "wrongFence": return { ...(latest ?? unissued(cell)), fencingToken: (latest ?? unissued(cell)).fencingToken + 7 }
    case "wrongOwner": return { ...(latest ?? unissued(cell)), owner: "intruder" }
    // The caller's own copy of expiresAt must never extend a lease.
    case "forgedExpiry": return { ...(latest ?? unissued(cell)), expiresAt: new Date(T0 + 10 * DAY).toISOString() }
    case "unissued": return unissued(cell)
  }
}

const invalidInput = (op: Op): boolean =>
  op.t === "acquire" ? op.owner === "" || !(op.durationMs >= 1 && op.durationMs <= DAY) : op.t === "renew" ? !(op.durationMs >= 1 && op.durationMs <= DAY) : false

async function perform(ctx: Ctx, op: Exclude<Op, { t: "advance" }>): Promise<FencedLease | "ok" | null> {
  const { store } = ctx.side
  switch (op.t) {
    case "acquire": {
      const lease = await store.acquire(CELLS[op.cell]!, op.owner, op.durationMs)
      if (lease !== null) ctx.issued.set(op.cell, [...(ctx.issued.get(op.cell) ?? []), lease])
      return lease
    }
    case "renew": {
      const lease = await store.renew(resolve(ctx, op.cell, op.ref), op.durationMs)
      ctx.renewed.set(op.cell, lease)
      return lease
    }
    case "release": await store.release(resolve(ctx, op.cell, op.ref)); return "ok"
    case "assert": await store.assertCurrent(resolve(ctx, op.cell, op.ref)); return "ok"
  }
}

/** Runs one op on a side. Returns what the caller observed, the stored row as an observer sees it, and a probe of the newest lease. */
async function step(ctx: Ctx, op: Op): Promise<{ outcome: string; after: string }> {
  if (op.t === "advance") { await ctx.side.advance(op.ms); return { outcome: "advanced", after: "" } }
  let outcome: unknown
  try {
    const result = await perform(ctx, op)
    const { nowMs } = await ctx.side.peek(CELLS[op.cell]!)
    outcome = { value: result === "ok" ? "ok" : leaseView(result, tokenIndex(ctx), nowMs) }
  } catch (error) { outcome = { error: invalidInput(op) && !(error instanceof FrameworkCoreError) ? "INVALID" : classify(error) } }
  const { lease, nowMs } = await ctx.side.peek(CELLS[op.cell]!)
  const newest = (ctx.issued.get(op.cell) ?? []).at(-1)
  let probe = "none"
  if (newest !== undefined) probe = await ctx.side.store.assertCurrent(newest).then(() => "current", (error) => classify(error))
  return { outcome: JSON.stringify(outcome), after: JSON.stringify({ held: heldView(lease, tokenIndex(ctx), nowMs), probe }) }
}

function summary(outcome: string): string {
  const parsed = JSON.parse(outcome) as { error?: string; value?: { fence?: number } | string | null }
  if (parsed.error !== undefined) return `error ${parsed.error}`
  return parsed.value === null ? "null" : typeof parsed.value === "string" ? parsed.value : parsed.value && parsed.value.fence !== undefined && parsed.value.fence > 1 ? "granted fence>1" : "granted"
}

export async function runSequence(driver: LeaseDriver, ops: Op[]): Promise<void> {
  await driver.reset()
  const reference: Ctx = { side: new ModelLease(), tokens: [], issued: new Map(), renewed: new Map() }
  const real: Ctx = { side: driver, tokens: [], issued: new Map(), renewed: new Map() }
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]!
    const expected = await step(reference, op)
    const actual = await step(real, op)
    if (op.t !== "advance") coverage(`${op.t}/${summary(expected.outcome)}`)
    if (expected.outcome !== actual.outcome) throw new Error(`op ${index} (${JSON.stringify(op)}): outcome differs\n  model: ${expected.outcome}\n  store: ${actual.outcome}`)
    if (expected.after !== actual.after) throw new Error(`op ${index} (${JSON.stringify(op)}): stored lease differs\n  model: ${expected.after}\n  store: ${actual.after}`)
  }
  for (let cell = 0; cell < CELLS.length; cell++) {
    const [m, r] = [await reference.side.peek(CELLS[cell]!), await real.side.peek(CELLS[cell]!)]
    const [a, b] = [heldView(m.lease, tokenIndex(reference), m.nowMs), heldView(r.lease, tokenIndex(real), r.nowMs)]
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`final cell ${cell} differs\n  model: ${JSON.stringify(a)}\n  store: ${JSON.stringify(b)}`)
  }
}

/** Registers the sequential lease differential for a driver. */
export function defineLeaseDifferential(driver: LeaseDriver): void {
  it(`lease lifecycle sequences match the reference model (${driver.label})`, async () => {
    await forAllAsync(`lease store differential (${driver.label})`, (rng) => generateOps(rng, driver.light ? { min: 12, max: 30 } : { min: 20, max: 50 }), (ops) => runSequence(driver, ops), {
      runs: driver.lifecycleRuns ?? 60, shrink: shrinkOps, describe: describeOps, maxShrinkSteps: 150,
    })
  }, PROPERTY_TIMEOUT_MS)
}

// ------------------------------------------------------------------------------------------------ regressions

/** Deterministic cases for the properties of the fenced lease that matter most; each fails if the property is lost. */
export function defineLeaseRegressions(driver: LeaseDriver): void {
  const resource = CELLS[0]!
  const store = (): LeasePort => driver.store

  it(`the fencing token keeps rising across release and expiry, and old holders stay fenced (${driver.label})`, async () => {
    await driver.reset()
    const first = (await store().acquire(resource, "w1", 5 * MINUTE))!
    expect(first.fencingToken).toBe(1)
    await store().release(first)
    const second = (await store().acquire(resource, "w2", 5 * MINUTE))!
    expect(second.fencingToken, "a grant after release continues the fence").toBe(2)
    await driver.advance(5 * MINUTE)
    const third = (await store().acquire(resource, "w3", 5 * MINUTE))!
    expect(third.fencingToken, "a takeover of an expired lease continues the fence").toBe(3)
    expect(new Set([first.claimToken, second.claimToken, third.claimToken]).size).toBe(3)
    for (const stale of [first, second]) {
      await expect(store().assertCurrent(stale)).rejects.toMatchObject({ code: "STALE_CLAIM" })
      await expect(store().renew(stale, MINUTE)).rejects.toMatchObject({ code: "STALE_CLAIM" })
      await expect(store().release(stale)).rejects.toMatchObject({ code: "STALE_CLAIM" })
    }
    await store().assertCurrent(third)
  })

  it(`a lease that lapsed on the database clock cannot be renewed, released or asserted by its holder (${driver.label})`, async () => {
    await driver.reset()
    const lease = (await store().acquire(resource, "w1", 5 * MINUTE))!
    expect(await store().acquire(resource, "w1", 5 * MINUTE), "not re-entrant for the same owner").toBeNull()
    await driver.advance(5 * MINUTE)
    await expect(store().renew(lease, MINUTE)).rejects.toMatchObject({ code: "STALE_CLAIM" })
    await expect(store().release(lease)).rejects.toMatchObject({ code: "STALE_CLAIM" })
    await expect(store().assertCurrent(lease)).rejects.toMatchObject({ code: "STALE_CLAIM" })
  })

  it(`renewal extends from the database clock and ignores the caller's copy of the expiry (${driver.label})`, async () => {
    await driver.reset()
    const lease = (await store().acquire(resource, "w1", 5 * MINUTE))!
    await driver.advance(4 * MINUTE)
    const renewed = await store().renew({ ...lease, expiresAt: new Date(T0 + 10 * DAY).toISOString() }, 5 * MINUTE)
    expect(renewed).toMatchObject({ owner: "w1", claimToken: lease.claimToken, fencingToken: 1 })
    expect(Date.parse(renewed.acquiredAt), "renewal keeps the original grant time (shifted with the stored row)").toBe(Date.parse(lease.acquiredAt) - 4 * MINUTE)
    const stored = await driver.peek(resource)
    expect(Math.round((Date.parse(stored.lease!.expiresAt) - stored.nowMs) / MINUTE)).toBe(5)
    await driver.advance(5 * MINUTE)
    await expect(store().assertCurrent(lease)).rejects.toMatchObject({ code: "STALE_CLAIM" })
  })

  it(`resources that differ by case, trailing space, namespace or scope are independent (${driver.label})`, async () => {
    await driver.reset()
    const leases = await Promise.all(CELLS.map((cell) => store().acquire(cell, "w1", HOUR)))
    expect(leases.every((lease) => lease !== null && lease.fencingToken === 1)).toBe(true)
    await store().release(leases[0]!)
    for (const lease of leases.slice(1)) await store().assertCurrent(lease!)
  })

  it(`invalid owners and durations are rejected before any state changes (${driver.label})`, async () => {
    await driver.reset()
    // The port may reject or throw synchronously; either way the call must fail.
    const fails = async (call: () => Promise<unknown>): Promise<void> => { await expect((async () => call())()).rejects.toThrow() }
    await fails(() => store().acquire(resource, "", MINUTE))
    for (const duration of [0, -1, DAY + 1, Number.NaN]) await fails(() => store().acquire(resource, "w1", duration))
    const lease = (await store().acquire(resource, "w1", MINUTE))!
    expect(lease.fencingToken, "rejected calls consume no fence").toBe(1)
    for (const duration of [0, DAY + 1]) await fails(() => store().renew(lease, duration))
    await store().assertCurrent(lease)
    expect((await store().acquire(resource, "w2", DAY))).toBeNull()
  })
}
