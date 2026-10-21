import { expect, it } from "vitest"
import type { IdempotencyAcquireResult } from "@xonava/core/events"
import { forAllAsync } from "../../../core/src/__tests__/differential/harness.js"
import { HOUR, PROPERTY_TIMEOUT_MS, coverage, type IdempotencyDifferentialDriver } from "./idempotencyStoreDifferential.js"

const SCOPE = "tenant:t1:race"
const FP = ["fp-one", "fp-two", "fp-three"] as const

interface RaceCase { callers: number; fingerprints: number[]; commitInvalidations: boolean }

function generateRace(driver: IdempotencyDifferentialDriver, rng: { int(max: number): number; bool(p?: number): boolean }): RaceCase {
  const callers = 2 + rng.int(driver.light ? 4 : 7)
  return { callers, fingerprints: Array.from({ length: callers }, () => (rng.bool(0.7) ? 0 : 1 + rng.int(2))), commitInvalidations: rng.bool() }
}

const describeRace = (value: RaceCase): string => JSON.stringify(value)

function* shrinkRace(value: RaceCase): Generator<RaceCase> {
  if (value.callers > 2) yield { ...value, callers: value.callers - 1, fingerprints: value.fingerprints.slice(0, value.callers - 1) }
}

/** Every concurrent acquirer of one identity sees a single winner; the rest see in-progress (same fingerprint) or conflict. */
function assertSingleWinner(results: IdempotencyAcquireResult<unknown>[], fingerprints: number[], winnerFingerprint: number): { winner: number; token: string } {
  const winners = results.flatMap((result, index) => (result.outcome === "acquired" ? [index] : []))
  expect(winners, `acquired outcomes: ${JSON.stringify(results)}`).toHaveLength(1)
  const winner = winners[0]!
  expect(fingerprints[winner]).toBe(winnerFingerprint)
  for (const [index, result] of results.entries()) {
    if (index === winner) continue
    expect(result.outcome, `caller ${index} (fingerprint ${fingerprints[index]}) saw ${JSON.stringify(result)}`).toBe(fingerprints[index] === winnerFingerprint ? "in-progress" : "conflict")
  }
  return { winner, token: (results[winner] as { token: string }).token }
}

/**
 * Concurrent acquire races: on a fresh key, and on a lapsed lease. The reservation is unique per (scope, key): exactly
 * one caller wins, and the rest are classified by their fingerprint against the winner's.
 */
export function defineConcurrentAcquireRaces(driver: IdempotencyDifferentialDriver): void {
  it(`concurrent acquires of a fresh key produce exactly one winner (${driver.label})`, async () => {
    await forAllAsync(`idempotency concurrent fresh acquire (${driver.label})`, (rng) => generateRace(driver, rng), async (race) => {
      await driver.reset()
      const request = (index: number) => ({ scope: SCOPE, key: "fresh", fingerprint: FP[race.fingerprints[index]!]!, leaseDurationMs: HOUR })
      const results = await Promise.all(Array.from({ length: race.callers }, (_, index) => driver.store.acquire(request(index))))
      const winnerFingerprint = race.fingerprints[results.findIndex((result) => result.outcome === "acquired")]
      expect(winnerFingerprint).toBeDefined()
      const { token } = assertSingleWinner(results, race.fingerprints, winnerFingerprint!)
      if (new Set(race.fingerprints).size > 1) coverage("race.fresh.conflicting-fingerprints")
      const rows = await driver.dump()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: "in-progress", token, fingerprint: FP[winnerFingerprint!] })
    }, { runs: driver.concurrencyRuns ?? 50, shrink: shrinkRace, describe: describeRace })
  }, PROPERTY_TIMEOUT_MS)

  it(`concurrent acquires of a lapsed lease take it over exactly once (${driver.label})`, async () => {
    await forAllAsync(`idempotency concurrent takeover (${driver.label})`, (rng) => generateRace(driver, rng), async (race) => {
      await driver.reset()
      const holder = await driver.store.acquire({ scope: SCOPE, key: "lapsed", fingerprint: FP[0], leaseDurationMs: HOUR })
      expect(holder.outcome).toBe("acquired")
      const staleToken = (holder as { token: string }).token
      await driver.expireLease(SCOPE, "lapsed")
      const request = (index: number) => ({ scope: SCOPE, key: "lapsed", fingerprint: FP[race.fingerprints[index]!]!, leaseDurationMs: HOUR })
      const results = await Promise.all(Array.from({ length: race.callers }, (_, index) => driver.store.acquire(request(index))))
      // Callers with the reservation's fingerprint compete for the takeover; any other fingerprint conflicts.
      const sameFingerprint = race.fingerprints.map((value) => value === 0)
      const winners = results.flatMap((result, index) => (result.outcome === "acquired" ? [index] : []))
      if (sameFingerprint.some(Boolean)) {
        expect(winners, `takeover outcomes: ${JSON.stringify(results)}`).toHaveLength(1)
        expect(sameFingerprint[winners[0]!]).toBe(true)
        coverage("race.takeover.won")
      } else {
        expect(winners).toHaveLength(0)
      }
      for (const [index, result] of results.entries()) {
        if (winners.includes(index)) continue
        expect(result.outcome, `caller ${index} saw ${JSON.stringify(result)}`).toBe(sameFingerprint[index] ? "in-progress" : "conflict")
      }
      if (winners.length === 1) {
        const newToken = (results[winners[0]!] as { token: string }).token
        expect(newToken).not.toBe(staleToken)
        await expect(driver.store.renew({ scope: SCOPE, key: "lapsed", fingerprint: FP[0], token: staleToken })).rejects.toMatchObject({ name: "ConflictError" })
        await driver.store.renew({ scope: SCOPE, key: "lapsed", fingerprint: FP[0], token: newToken })
      }
    }, { runs: driver.concurrencyRuns ?? 50, shrink: shrinkRace, describe: describeRace })
  }, PROPERTY_TIMEOUT_MS)
}

/** Commit, abandon and complete race on one reservation; the outcomes must be consistent with one serial order. */
export function defineConcurrentOwnershipRaces(driver: IdempotencyDifferentialDriver): void {
  it(`commit and abandon racing on one reservation leave one consistent state (${driver.label})`, async () => {
    await forAllAsync(`idempotency commit/abandon race (${driver.label})`, (rng) => generateRace(driver, rng), async (race) => {
      await driver.reset()
      const base = { scope: SCOPE, key: "ownership", fingerprint: FP[0], leaseDurationMs: HOUR }
      const first = await driver.store.acquire(base)
      const token = (first as { token: string }).token
      const invalidations = race.commitInvalidations ? ["orders"] : []
      const commit = driver.commit({ ...base, token, invalidations }).then(() => "committed" as const, (error: unknown) => (error instanceof Error && error.name === "ConflictError" ? "lost" as const : Promise.reject(error)))
      const abandon = driver.store.abandon!({ ...base, token }).then(() => "abandoned" as const)
      const [committed] = await Promise.all([commit, abandon])
      const rows = await driver.dump()
      if (committed === "committed") {
        // Abandon never touches a committed receipt, whichever order they ran in; a commit that ran first wins.
        coverage("race.ownership.committed")
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ status: "business-committed", token })
      } else {
        coverage("race.ownership.abandoned")
        expect(rows).toHaveLength(0)
      }
    }, { runs: driver.concurrencyRuns ?? 50, shrink: shrinkRace, describe: describeRace })
  }, PROPERTY_TIMEOUT_MS)

  it(`concurrent completions of one receipt let exactly one response win (${driver.label})`, async () => {
    await forAllAsync(`idempotency concurrent complete (${driver.label})`, (rng) => generateRace(driver, rng), async (race) => {
      await driver.reset()
      const base = { scope: SCOPE, key: "complete", fingerprint: FP[0], leaseDurationMs: HOUR }
      const token = ((await driver.store.acquire(base)) as { token: string }).token
      await driver.commit({ ...base, token })
      const outcomes = await Promise.all(Array.from({ length: race.callers }, (_, index) => driver.store.complete({ ...base, token, result: { winner: index } }).then(() => index, () => -1)))
      const winners = outcomes.filter((value) => value >= 0)
      expect(winners, `completion outcomes: ${JSON.stringify(outcomes)}`).toHaveLength(1)
      expect(await driver.store.acquire(base)).toEqual({ outcome: "replay", result: { winner: winners[0] } })
    }, { runs: driver.concurrencyRuns ?? 50, shrink: shrinkRace, describe: describeRace })
  }, PROPERTY_TIMEOUT_MS)
}

/** Concurrent finalizers: every pending obligation is claimed by exactly one of them. */
export function defineConcurrentFinalizerClaims(driver: IdempotencyDifferentialDriver): void {
  it(`concurrent finalizers claim every pending receipt exactly once (${driver.label})`, async () => {
    await forAllAsync(`idempotency concurrent claims (${driver.label})`, (rng) => generateRace(driver, rng), async (race) => {
      await driver.reset()
      const receipts = Math.min(race.callers + 1, driver.light ? 4 : 8)
      const keys = Array.from({ length: receipts }, (_, index) => `claim-${index}`)
      for (const key of keys) {
        const base = { scope: SCOPE, key, fingerprint: FP[0], leaseDurationMs: HOUR }
        const token = ((await driver.store.acquire(base)) as { token: string }).token
        await driver.commit({ ...base, token, invalidations: ["orders"] })
      }
      const batches = await Promise.all(Array.from({ length: race.callers }, (_, index) => driver.store.claimPendingInvalidations({ claimOwner: `finalizer-${index}`, leaseMs: HOUR, limit: race.commitInvalidations ? 2 : 100 })))
      const claimedKeys = batches.flatMap((batch) => batch.map((item) => item.key))
      expect(new Set(claimedKeys).size, `a receipt was claimed twice: ${JSON.stringify(batches)}`).toBe(claimedKeys.length)
      for (const batch of batches) expect(new Set(batch.map((item) => item.claimToken)).size).toBeLessThanOrEqual(1)
      if (!race.commitInvalidations) expect([...claimedKeys].sort()).toEqual([...keys].sort())
      const rows = await driver.dump()
      expect(rows.filter((row) => row.finalizerClaimToken !== null).map((row) => row.key).sort()).toEqual([...claimedKeys].sort())
      if (claimedKeys.length > 1) coverage("race.claims.shared")
    }, { runs: driver.concurrencyRuns ?? 50, shrink: shrinkRace, describe: describeRace })
  }, PROPERTY_TIMEOUT_MS)
}
