import { expect, it } from "vitest"
import type { FencedLease } from "@xonava/core/events"
import { forAllAsync } from "../../../core/src/__tests__/differential/harness.js"
import { CELLS, HOUR, MINUTE } from "./leaseStoreDifferentialModel.js"
import { PROPERTY_TIMEOUT_MS, classify, type LeaseDriver } from "./leaseStoreDifferential.js"

/**
 * Concurrent differential. Concurrency has no deterministic reference run, so each property states the outcome the lease
 * contract allows for EVERY serialisation of the racing calls: one winner per grant, a fence that rises by exactly one per
 * grant, and a stored lease equal to the winner's.
 */

const resource = CELLS[0]!

interface Racer { readonly name: string; run(): Promise<unknown> }
type Settled = { name: string; ok: true; value: unknown } | { name: string; ok: false; error: string }

async function race(racers: readonly Racer[]): Promise<Settled[]> {
  return Promise.all(racers.map(async (racer): Promise<Settled> => {
    try { return { name: racer.name, ok: true, value: await racer.run() } } catch (error) { return { name: racer.name, ok: false, error: classify(error) } }
  }))
}

const heldLease = async (driver: LeaseDriver): Promise<FencedLease | null> => {
  const { lease, nowMs } = await driver.peek(resource)
  return lease !== null && nowMs < Date.parse(lease.expiresAt) ? lease : null
}

// ------------------------------------------------------------------------------------------------ acquire / takeover race

type Start = "fresh" | "released" | "expired" | "renewedThenExpired"
interface AcquireRace { start: Start; priorGrants: number; workers: number }

/** Brings the resource to `start` after `priorGrants` earlier grants; returns the last prior lease (the stale holder), if any. */
async function prepare(driver: LeaseDriver, config: AcquireRace): Promise<FencedLease | undefined> {
  await driver.reset()
  if (config.start === "fresh") return undefined
  let last: FencedLease | undefined
  for (let grant = 0; grant < config.priorGrants; grant++) {
    last = (await driver.store.acquire(resource, `prior${grant}`, 5 * MINUTE))!
    if (grant < config.priorGrants - 1) await driver.advance(5 * MINUTE)
  }
  if (config.start === "released") await driver.store.release(last!)
  else if (config.start === "renewedThenExpired") { last = await driver.store.renew(last!, HOUR); await driver.advance(HOUR) } else await driver.advance(5 * MINUTE)
  return last
}

function defineAcquireRace(driver: LeaseDriver): void {
  it(`concurrent acquire and takeover elect exactly one holder with the next fencing token (${driver.label})`, async () => {
    await forAllAsync(`lease acquire race (${driver.label})`, (rng): AcquireRace => ({ start: rng.pick<Start>(["fresh", "released", "expired", "renewedThenExpired"]), priorGrants: 1 + rng.int(3), workers: 2 + rng.int(5) }), async (config) => {
      const stale = await prepare(driver, config)
      const priorFence = config.start === "fresh" ? 0 : config.priorGrants
      const racers: Racer[] = Array.from({ length: config.workers }, (_unused, index) => ({ name: `w${index + 1}`, run: () => driver.store.acquire(resource, `w${index + 1}`, 15 * MINUTE) }))
      if (stale !== undefined) {
        // The previous holder is fenced whatever its calls interleave with.
        racers.push({ name: "stale-renew", run: () => driver.store.renew(stale, MINUTE) }, { name: "stale-release", run: () => driver.store.release(stale) })
      }
      const settled = await race(racers)
      for (const entry of settled) {
        if (entry.name.startsWith("stale")) expect(entry, `${entry.name} must be rejected as stale`).toMatchObject({ ok: false, error: "STALE_CLAIM" })
        else expect(entry.ok, `${entry.name}: ${entry.ok ? "" : entry.error}`).toBe(true)
      }
      const winners = settled.filter((entry): entry is Extract<Settled, { ok: true }> => entry.ok && !entry.name.startsWith("stale") && entry.value !== null)
      expect(winners.map((entry) => entry.name), "exactly one acquirer wins").toHaveLength(1)
      const winner = winners[0]!.value as FencedLease
      expect(winner.fencingToken, "the grant continues the fence by exactly one").toBe(priorFence + 1)
      expect(winner.owner).toBe(winners[0]!.name)
      expect(await heldLease(driver)).toEqual(winner)
      await driver.store.assertCurrent(winner)
      if (stale !== undefined) await expect(driver.store.assertCurrent(stale)).rejects.toMatchObject({ code: "STALE_CLAIM" })
    }, { runs: driver.concurrencyRuns ?? 50, describe: (config) => JSON.stringify(config) })
  }, PROPERTY_TIMEOUT_MS)
}

// ------------------------------------------------------------------------------------------------ fence sequence

function defineFenceSequence(driver: LeaseDriver): void {
  it(`rounds of racing grants, releases and expiries yield fencing tokens 1..n without gap or repeat (${driver.label})`, async () => {
    await forAllAsync(`lease fence sequence (${driver.label})`, (rng) => ({ rounds: 3 + rng.int(4), workers: 2 + rng.int(4), ends: Array.from({ length: 6 }, () => rng.pick(["release", "expire"] as const)) }), async ({ rounds, workers, ends }) => {
      await driver.reset()
      const fences: number[] = []
      const tokens = new Set<string>()
      for (let round = 0; round < rounds; round++) {
        const settled = await race(Array.from({ length: workers }, (_unused, index): Racer => ({ name: `r${round}w${index}`, run: () => driver.store.acquire(resource, `w${index}`, 5 * MINUTE) })))
        const won = settled.filter((entry): entry is Extract<Settled, { ok: true }> => entry.ok && entry.value !== null)
        for (const entry of settled) expect(entry.ok, entry.ok ? "" : `${entry.name}: ${entry.error}`).toBe(true)
        expect(won, `round ${round}: exactly one winner`).toHaveLength(1)
        const lease = won[0]!.value as FencedLease
        fences.push(lease.fencingToken)
        tokens.add(lease.claimToken)
        if (ends[round]! === "release") await driver.store.release(lease)
        else await driver.advance(5 * MINUTE)
        await expect(driver.store.assertCurrent(lease)).rejects.toMatchObject({ code: "STALE_CLAIM" })
      }
      expect(fences).toEqual(Array.from({ length: rounds }, (_unused, index) => index + 1))
      expect(tokens.size, "every grant has its own claim token").toBe(rounds)
    }, { runs: driver.concurrencyRuns ?? 50, describe: (config) => JSON.stringify(config) })
  }, PROPERTY_TIMEOUT_MS)
}

// ------------------------------------------------------------------------------------------------ holder races

type Action = "renew" | "release" | "assert"
function defineHolderRace(driver: LeaseDriver): void {
  it(`racing renew, release and assert of one live lease serialise, and release ends the lease (${driver.label})`, async () => {
    await forAllAsync(`lease holder race (${driver.label})`, (rng) => ({ actions: Array.from({ length: 2 + rng.int(5) }, () => rng.pick<Action>(["renew", "release", "assert"])), rival: rng.bool() }), async ({ actions, rival }) => {
      await driver.reset()
      const lease = (await driver.store.acquire(resource, "holder", 15 * MINUTE))!
      const racers: Racer[] = actions.map((action, index) => ({
        name: `${action}#${index}`,
        run: () => action === "renew" ? driver.store.renew(lease, 30 * MINUTE) : action === "release" ? driver.store.release(lease) : driver.store.assertCurrent(lease),
      }))
      // A rival cannot take a live lease, whatever the holder does at the same time, until the release lands.
      if (rival) racers.push({ name: "rival", run: () => driver.store.acquire(resource, "rival", MINUTE) })
      const settled = await race(racers)
      const releases = settled.filter((entry) => entry.name.startsWith("release"))
      expect(releases.filter((entry) => entry.ok), "at most one release succeeds").toHaveLength(releases.length === 0 ? 0 : 1)
      for (const entry of settled) {
        if (entry.name === "rival") { expect(entry.ok).toBe(true); continue }
        if (!entry.ok) expect(entry.error, `${entry.name} may only lose to a release that already ended the lease`).toBe("STALE_CLAIM")
        if (!entry.ok) expect(releases.length, "a stale outcome needs a release").toBeGreaterThan(0)
      }
      const rivalGrant = settled.find((entry) => entry.name === "rival")
      const held = await heldLease(driver)
      if (releases.length === 0) {
        expect(rivalGrant === undefined || (rivalGrant.ok && rivalGrant.value === null), "no release, no takeover").toBe(true)
        expect(held).toMatchObject({ owner: "holder", claimToken: lease.claimToken, fencingToken: 1 })
      } else if (rivalGrant?.ok && rivalGrant.value !== null) {
        const granted = rivalGrant.value as FencedLease
        expect(granted.fencingToken, "a grant after the release continues the fence").toBe(2)
        expect(held).toEqual(granted)
      } else {
        expect(held, "the released lease stays released").toBeNull()
      }
    }, { runs: driver.concurrencyRuns ?? 50, describe: (config) => JSON.stringify(config) })
  }, PROPERTY_TIMEOUT_MS)
}

export function defineLeaseConcurrency(driver: LeaseDriver): void {
  defineAcquireRace(driver)
  defineFenceSequence(driver)
  defineHolderRace(driver)
}
