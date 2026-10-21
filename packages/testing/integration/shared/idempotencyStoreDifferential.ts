import { appendFileSync } from "node:fs"
import { expect, it } from "vitest"
import type { IdempotencyAcquireResult, IdempotencyCommitItem, IdempotencyFinalizationPort, IdempotencyPort, IdempotencyRequest } from "@xonava/core/events"
import { forAllAsync, scaledRuns } from "../../../core/src/__tests__/differential/harness.js"
import { TIMING_SCALE } from "../../../core/src/__tests__/timing.js"
import {
  BOGUS_TOKEN, FINGERPRINTS, HOUR, OWNERS, RefStore, SLOTS, canonicalJson, describeOps, generateOps, shrinkOps,
  type AcquireOutcome, type Fence, type Json, type Op, type ResourceSpec,
} from "./idempotencyStoreDifferentialModel.js"

export { HOUR, SLOTS, FINGERPRINTS }

export type IdempotencyStore = IdempotencyPort<unknown> & IdempotencyFinalizationPort<unknown>

/** Database-normalised view of an idempotency row (raw SQL, independent of the adapter's own decoding). */
export interface RawIdempotencyRow {
  scope: string
  key: string
  fingerprint: string
  token: string
  status: string
  /** Canonical JSON text of the stored response, or null for SQL NULL. */
  result: string | null
  resourceEntity: string | null
  resourceId: string | null
  /** The numeric resource version, or null. */
  resourceVersion: number | null
  /** Canonical JSON text of the pending-invalidation array, or null. */
  pendingInvalidations: string | null
  finalizerClaimOwner: string | null
  finalizerClaimToken: string | null
  hasClaimExpiry: boolean
  hasCompletedAt: boolean
}

export interface IdempotencyDifferentialDriver {
  /** Property-name suffix, e.g. "postgres". */
  label: string
  store: IdempotencyStore
  /** Runs the adapter's durable commit path (interactive transaction on PG/MySQL, atomic batch on D1); throws when the fence is lost. */
  commit(item: IdempotencyCommitItem): Promise<void>
  /** Deletes every row. */
  reset(): Promise<void>
  /** Rewrites the reservation's created_at two hours into the DATABASE's past. */
  expireLease(scope: string, key: string): Promise<void>
  /** Rewrites the finalizer claim expiry one hour into the DATABASE's past. */
  expireClaim(scope: string, key: string): Promise<void>
  dump(): Promise<RawIdempotencyRow[]>
  /** Overwrites the pending-invalidation column with unparseable data. */
  corruptInvalidations?(scope: string, key: string): Promise<void>
  /** Base run count of the sequential property at scale 1. */
  runs?: number
  concurrencyRuns?: number
  /** Slow transports (Miniflare D1) use short sequences and compare the full table only at the end of a sequence. */
  light?: boolean
}

/** Coverage counters, printed when IDEMPOTENCY_STORE_DIFFERENTIAL_STATS is set. */
const COVERAGE = new Map<string, number>()
export function coverage(key: string): void { COVERAGE.set(key, (COVERAGE.get(key) ?? 0) + 1) }
export function printCoverage(label: string): void {
  const file = process.env.IDEMPOTENCY_STORE_DIFFERENTIAL_STATS
  if (file) appendFileSync(file, `${label} coverage ${JSON.stringify(Object.fromEntries([...COVERAGE].sort()))}\n`)
}

/** Generous per-test budget: a failing property shrinks. It grows with DIFFERENTIAL_SCALE like the case counts do. */
export const PROPERTY_TIMEOUT_MS = Math.ceil(300_000 * Math.max(1, scaledRuns(100) / 100) * TIMING_SCALE)

async function attempt<T>(action: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try { return { ok: true, value: await action() } } catch (error) { return { ok: false, error } }
}

function errorName(error: unknown): string { return error instanceof Error ? error.name : String(error) }

export class IdempotencyRunner {
  readonly model = new RefStore()
  readonly realTokenBySym = new Map<string, string>()
  readonly symByRealToken = new Map<string, string>()
  readonly realClaimBySym = new Map<string, string>()
  notes: string[] = []
  private claimSequence = 0

  constructor(readonly driver: IdempotencyDifferentialDriver) {
    this.model.onEvent = coverage
  }

  realToken(sym: string): string { return sym === BOGUS_TOKEN ? BOGUS_TOKEN : this.realTokenBySym.get(sym) ?? `unknown-${sym}` }
  realClaimToken(sym: string): string { return sym === BOGUS_TOKEN ? BOGUS_TOKEN : this.realClaimBySym.get(sym) ?? `unknown-${sym}` }

  private register(sym: string, real: string): void {
    this.realTokenBySym.set(sym, real)
    this.symByRealToken.set(real, sym)
  }

  /** The (request, lease-bearing) identity an op fence aims at, resolved against the reference state. */
  private aim(fence: Fence): { slot: number; scope: string; key: string; fingerprint: string; tokenSym: string; token: string } {
    const { scope, key } = SLOTS[fence.slot]!
    const tokenSym = this.model.tokenFor(fence.slot, fence.tok)
    return { slot: fence.slot, scope, key, fingerprint: this.model.fingerprintFor(fence.slot, fence.fp), tokenSym, token: this.realToken(tokenSym) }
  }

  private fail(index: number, op: Op, message: string): never {
    throw new Error(`op ${index} ${JSON.stringify(op)}: ${message}`)
  }

  private compareAcquire(index: number, op: Op, expected: AcquireOutcome, actual: IdempotencyAcquireResult<unknown>): void {
    if (expected.o !== actual.outcome) this.fail(index, op, `acquire outcome: expected ${expected.o}, got ${JSON.stringify(actual)}`)
    if (expected.o === "replay") {
      const got = canonicalJson((actual as { result: unknown }).result)
      if (got !== expected.result) this.fail(index, op, `replay result: expected ${expected.result}, got ${got}`)
    }
    if (expected.o === "business-committed") {
      const receipt = actual as { token: string; resource?: { entity: string; id: string; version?: number }; invalidations?: readonly string[] }
      if (this.symByRealToken.get(receipt.token) !== expected.token) this.fail(index, op, `receipt token: expected ${expected.token}, got ${receipt.token}`)
      const gotResource = receipt.resource ? { entity: receipt.resource.entity, id: receipt.resource.id, ...(receipt.resource.version !== undefined ? { version: receipt.resource.version } : {}) } : null
      if (canonicalJson(gotResource) !== canonicalJson(expected.resource)) this.fail(index, op, `receipt resource: expected ${canonicalJson(expected.resource)}, got ${canonicalJson(gotResource)}`)
      if (canonicalJson(receipt.invalidations ?? []) !== canonicalJson(expected.invalidations)) this.fail(index, op, `receipt invalidations: expected ${canonicalJson(expected.invalidations)}, got ${canonicalJson(receipt.invalidations ?? [])}`)
    }
  }

  async step(index: number, op: Op, compareState: boolean): Promise<void> {
    const { store } = this.driver
    switch (op.k) {
      case "acquire": {
        const { scope, key } = SLOTS[op.slot]!
        const fingerprint = FINGERPRINTS[op.fp]
        const request: IdempotencyRequest = { scope, key, fingerprint, ...(op.lease === "hour" ? { leaseDurationMs: HOUR } : op.lease === "zero" ? { leaseDurationMs: 0 } : {}) }
        const expected = this.model.acquire(op.slot, fingerprint, op.lease)
        const actual = await attempt(() => store.acquire(request))
        if (expected === "throws") {
          if (actual.ok) this.fail(index, op, `acquire should have thrown, got ${JSON.stringify(actual.value)}`)
          break
        }
        if (!actual.ok) this.fail(index, op, `acquire threw ${errorName(actual.error)}: ${String((actual.error as Error)?.message)}`)
        this.compareAcquire(index, op, expected, actual.value)
        if (expected.o === "acquired") {
          const token = (actual.value as { token: string }).token
          if (this.symByRealToken.has(token)) this.fail(index, op, `token ${token} was issued twice`)
          this.register(expected.token, token)
        }
        break
      }
      case "renew": {
        const aim = this.aim(op.fence)
        const ok = this.model.renew(aim.slot, aim.fingerprint, aim.tokenSym, op.badLease === true)
        const actual = await attempt(() => store.renew({ scope: aim.scope, key: aim.key, fingerprint: aim.fingerprint, token: aim.token, leaseDurationMs: op.badLease ? -5 : HOUR }))
        if (actual.ok !== ok) this.fail(index, op, `renew: expected ${ok ? "success" : "failure"}, got ${actual.ok ? "success" : `${errorName(actual.error)}`}`)
        break
      }
      case "abandon": {
        const aim = this.aim(op.fence)
        this.model.abandon(aim.slot, aim.fingerprint, aim.tokenSym)
        const actual = await attempt(() => store.abandon!({ scope: aim.scope, key: aim.key, fingerprint: aim.fingerprint, token: aim.token }))
        if (!actual.ok) this.fail(index, op, `abandon threw ${errorName(actual.error)}`)
        break
      }
      case "commit": {
        const aim = this.aim(op.fence)
        const ok = this.model.commit(aim.slot, aim.fingerprint, aim.tokenSym, op.resource, op.inv)
        const item: IdempotencyCommitItem = {
          scope: aim.scope, key: aim.key, fingerprint: aim.fingerprint, token: aim.token,
          ...(op.resource ? { resource: toResource(op.resource) } : {}), ...(op.inv ? { invalidations: [...op.inv] } : {}),
        }
        const actual = await attempt(() => this.driver.commit(item))
        if (actual.ok !== ok) this.fail(index, op, `commit: expected ${ok ? "success" : "failure"}, got ${actual.ok ? "success" : `${errorName(actual.error)}`}`)
        if (!actual.ok && errorName(actual.error) !== "ConflictError") this.fail(index, op, `a lost commit fence must surface as ConflictError, got ${errorName(actual.error)}`)
        break
      }
      case "complete": {
        const aim = this.aim(op.fence)
        const ok = this.model.complete(aim.slot, aim.fingerprint, aim.tokenSym, op.result)
        const actual = await attempt(() => store.complete({ scope: aim.scope, key: aim.key, fingerprint: aim.fingerprint, token: aim.token, result: op.result }))
        if (actual.ok !== ok) this.fail(index, op, `complete: expected ${ok ? "success" : "failure"}, got ${actual.ok ? "success" : `${errorName(actual.error)}`}`)
        break
      }
      case "claim": await this.claim(index, op); break
      case "ack": {
        const aim = this.aim(op.fence)
        const claimSym = this.model.claimTokenFor(aim.slot, op.ctok)
        const ok = this.model.ack(aim.slot, aim.fingerprint, aim.tokenSym, claimSym)
        const actual = await attempt(() => store.ackClaimedInvalidation({ scope: aim.scope, key: aim.key, fingerprint: aim.fingerprint, token: aim.token, claimToken: this.realClaimToken(claimSym) }))
        if (actual.ok !== ok) this.fail(index, op, `ack: expected ${ok ? "success" : "failure"}, got ${actual.ok ? "success" : `${errorName(actual.error)}`}`)
        break
      }
      case "completeClaimed": {
        const aim = this.aim(op.fence)
        const claimSym = this.model.claimTokenFor(aim.slot, op.ctok)
        const ok = this.model.completeClaimed(aim.slot, aim.fingerprint, aim.tokenSym, claimSym, op.result)
        const actual = await attempt(() => store.completeClaimedInvalidation({ scope: aim.scope, key: aim.key, fingerprint: aim.fingerprint, token: aim.token, claimToken: this.realClaimToken(claimSym), result: op.result }))
        if (actual.ok !== ok) this.fail(index, op, `completeClaimed: expected ${ok ? "success" : "failure"}, got ${actual.ok ? "success" : `${errorName(actual.error)}`}`)
        break
      }
      case "expireLease": {
        this.model.expireLease(op.slot)
        const { scope, key } = SLOTS[op.slot]!
        await this.driver.expireLease(scope, key)
        break
      }
      case "expireClaim": {
        this.model.expireClaim(op.slot)
        const { scope, key } = SLOTS[op.slot]!
        await this.driver.expireClaim(scope, key)
        break
      }
    }
    if (compareState) await this.compareState(index, op)
  }

  private async claim(index: number, op: Extract<Op, { k: "claim" }>): Promise<void> {
    const invalid = op.limit === "zero" || op.owner === "empty"
    const owner = op.owner === "empty" ? "" : OWNERS[op.owner]!
    const claimSym = this.model.newClaimToken()
    const explicit = op.explicitToken ? `ct-${++this.claimSequence}-${index}` : undefined
    const candidates = this.model.claimCandidates()
    const limit = op.limit === "zero" ? 0 : op.limit === "default" ? 100 : op.limit
    const actual = await attempt(() => this.driver.store.claimPendingInvalidations({
      ...(op.limit === "default" ? {} : { limit: op.limit === "zero" ? 0 : op.limit }), claimOwner: owner, leaseMs: HOUR, ...(explicit ? { claimToken: explicit } : {}),
    }))
    if (invalid) {
      coverage("claim.invalid-arguments")
      if (actual.ok) this.fail(index, op, "claim with invalid arguments should have thrown")
      return
    }
    if (!actual.ok) this.fail(index, op, `claim threw ${errorName(actual.error)}: ${String((actual.error as Error)?.message)}`)
    const claimed = actual.value
    const expectedCount = Math.min(limit, candidates.length)
    if (claimed.length !== expectedCount) this.fail(index, op, `claim returned ${claimed.length} rows, expected ${expectedCount} (candidates ${JSON.stringify(candidates)})`)
    if (claimed.length === 0) { coverage("claim.empty"); return }
    if (claimed.length < candidates.length) coverage("claim.limited")
    const slots: number[] = []
    for (const item of claimed) {
      const slot = SLOTS.findIndex((candidate) => candidate.scope === item.scope && candidate.key === item.key)
      if (slot < 0 || !candidates.includes(slot) || slots.includes(slot)) this.fail(index, op, `claim returned an unexpected or duplicate row ${item.scope}/${item.key}`)
      slots.push(slot)
    }
    const realClaim = explicit ?? claimed[0]!.claimToken
    this.realClaimBySym.set(claimSym, realClaim)
    const expected = this.model.applyClaim(slots, owner, claimSym)
    for (const item of claimed) {
      const slot = SLOTS.findIndex((candidate) => candidate.scope === item.scope && candidate.key === item.key)
      const want = expected.find((entry) => entry.slot === slot)!
      if (item.claimToken !== realClaim) this.fail(index, op, `claim token differs inside one claim: ${item.claimToken} vs ${realClaim}`)
      if (item.claimOwner !== owner) this.fail(index, op, `claim owner: expected ${owner}, got ${item.claimOwner}`)
      if (item.fingerprint !== want.fingerprint) this.fail(index, op, `claimed fingerprint: expected ${want.fingerprint}, got ${item.fingerprint}`)
      if (this.symByRealToken.get(item.token) !== want.token) this.fail(index, op, `claimed token mismatch for ${item.scope}/${item.key}`)
      if (canonicalJson(item.invalidations) !== canonicalJson(want.invalidations)) this.fail(index, op, `claimed invalidations: expected ${canonicalJson(want.invalidations)}, got ${canonicalJson(item.invalidations)}`)
      if (item.result !== null) this.fail(index, op, `a business-committed row carries no response, got ${JSON.stringify(item.result)}`)
    }
  }

  async compareState(index: number, op: Op | undefined): Promise<void> {
    const rows = await this.driver.dump()
    const where = op ? `after op ${index} ${JSON.stringify(op)}` : "at the end of the sequence"
    const bySlot = new Map<number, RawIdempotencyRow>()
    for (const row of rows) {
      const slot = SLOTS.findIndex((candidate) => candidate.scope === row.scope && candidate.key === row.key)
      if (slot < 0 || bySlot.has(slot)) throw new Error(`${where}: unexpected or duplicate row ${row.scope}/${row.key}`)
      bySlot.set(slot, row)
    }
    const diffs: string[] = []
    for (const slot of new Set([...bySlot.keys(), ...this.model.rows.keys()])) {
      const real = bySlot.get(slot)
      const ref = this.model.rows.get(slot)
      const name = `slot ${slot}`
      if (!real || !ref) { diffs.push(`${name}: ${ref ? "row missing in the database" : "unexpected row in the database"} (${JSON.stringify(real)})`); continue }
      const check = (field: string, expected: unknown, actual: unknown): void => { if (expected !== actual) diffs.push(`${name}.${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`) }
      check("fingerprint", ref.fingerprint, real.fingerprint)
      check("status", ref.status, real.status)
      check("token", ref.token, this.symByRealToken.get(real.token))
      check("result", ref.result, real.result)
      check("resourceEntity", ref.resource?.entity ?? null, real.resourceEntity)
      check("resourceId", ref.resource?.id ?? null, real.resourceId)
      check("resourceVersion", ref.resource?.version ?? null, real.resourceVersion)
      check("pendingInvalidations", ref.invalidations === null ? null : canonicalJson(ref.invalidations), real.pendingInvalidations)
      check("claimOwner", ref.claim?.owner ?? null, real.finalizerClaimOwner)
      check("claimToken", ref.claim ? this.realClaimToken(ref.claim.token) : null, real.finalizerClaimToken)
      check("hasClaimExpiry", ref.claim !== null, real.hasClaimExpiry)
      check("hasCompletedAt", ref.status !== "in-progress", real.hasCompletedAt)
    }
    if (diffs.length > 0) throw new Error(`database state differs ${where}:\n${diffs.join("\n")}`)
  }
}

function toResource(spec: ResourceSpec): { entity: string; id: string; version?: number } {
  return { entity: spec.entity, id: spec.id, ...(spec.version !== undefined ? { version: spec.version } : {}) }
}

export async function runIdempotencySequence(driver: IdempotencyDifferentialDriver, ops: Op[]): Promise<void> {
  await driver.reset()
  const runner = new IdempotencyRunner(driver)
  for (let index = 0; index < ops.length; index++) await runner.step(index, ops[index]!, driver.light !== true)
  await runner.compareState(ops.length - 1, undefined)
}

/** Registers the sequential store-contract differential for a driver. */
export function defineIdempotencyDifferential(driver: IdempotencyDifferentialDriver): void {
  it(`idempotency sequences match the reference store (${driver.label})`, async () => {
    await forAllAsync(`idempotency store lifecycle differential (${driver.label})`, (rng) => generateOps(rng, driver.light ? { min: 10, max: 18 } : undefined), (ops) => runIdempotencySequence(driver, ops), {
      runs: driver.runs ?? 60, shrink: shrinkOps, describe: describeOps, maxShrinkSteps: 150,
    })
  }, PROPERTY_TIMEOUT_MS)
}

const REQUEST = { scope: "tenant:t1:regression", key: "regression-key", fingerprint: "fp-one", leaseDurationMs: HOUR }

async function acquireOwned(driver: IdempotencyDifferentialDriver, request: IdempotencyRequest = REQUEST): Promise<string> {
  const first = await driver.store.acquire(request)
  if (first.outcome !== "acquired") throw new Error(`expected acquired, got ${JSON.stringify(first)}`)
  return first.token
}

/**
 * Deterministic regressions for the contract corners the lifecycle differential relies on.
 */
export function defineIdempotencyRegressions(driver: IdempotencyDifferentialDriver): void {
  it(`every JSON response value replays exactly, including falsy and null ones (${driver.label})`, async () => {
    const values: Json[] = [null, false, 0, "", "created", [], {}, { a: [1, { b: null }] }, "{\"looks\":\"like json\"}", "[1,2]", "null"]
    for (const [index, value] of values.entries()) {
      await driver.reset()
      const request = { ...REQUEST, key: `replay-${index}` }
      const token = await acquireOwned(driver, request)
      await driver.commit({ ...request, token })
      await driver.store.complete({ ...request, token, result: value })
      const replay = await driver.store.acquire(request)
      expect(replay, `replay of ${JSON.stringify(value)}`).toMatchObject({ outcome: "replay" })
      expect(canonicalJson((replay as { result: unknown }).result), `replay of ${JSON.stringify(value)}`).toBe(canonicalJson(value))
    }
  }, PROPERTY_TIMEOUT_MS)

  it(`keys and scopes that differ only in letter case are distinct reservations (${driver.label})`, async () => {
    await driver.reset()
    const lower = await acquireOwned(driver, { ...REQUEST, key: "case-key" })
    const upper = await driver.store.acquire({ ...REQUEST, key: "CASE-KEY", fingerprint: "fp-two" })
    expect(upper).toMatchObject({ outcome: "acquired" })
    expect((upper as { token: string }).token).not.toBe(lower)
    const otherScope = await driver.store.acquire({ ...REQUEST, scope: "TENANT:T1:REGRESSION", key: "case-key" })
    expect(otherScope).toMatchObject({ outcome: "acquired" })
  }, PROPERTY_TIMEOUT_MS)

  it(`a lease that lapsed is taken over exactly once and the old owner is fenced off (${driver.label})`, async () => {
    await driver.reset()
    const stale = await acquireOwned(driver)
    await driver.expireLease(REQUEST.scope, REQUEST.key)
    const fresh = await acquireOwned(driver)
    expect(fresh).not.toBe(stale)
    await expect(driver.store.renew({ ...REQUEST, token: stale })).rejects.toBeDefined()
    await expect(driver.commit({ ...REQUEST, token: stale })).rejects.toMatchObject({ name: "ConflictError" })
    expect(await driver.store.acquire(REQUEST)).toEqual({ outcome: "in-progress" })
    await driver.commit({ ...REQUEST, token: fresh })
    expect(await driver.store.acquire(REQUEST)).toMatchObject({ outcome: "business-committed", token: fresh })
  }, PROPERTY_TIMEOUT_MS)

  it(`a corrupted receipt is poisoned, never replayed or re-acquired (${driver.label})`, async () => {
    if (!driver.corruptInvalidations) return
    await driver.reset()
    const token = await acquireOwned(driver)
    await driver.commit({ ...REQUEST, token, invalidations: ["a"] })
    await driver.corruptInvalidations(REQUEST.scope, REQUEST.key)
    await expect(driver.store.acquire(REQUEST)).rejects.toBeDefined()
    expect((await driver.dump())[0]).toMatchObject({ status: "poisoned" })
    expect(await driver.store.acquire({ ...REQUEST, fingerprint: "fp-two" })).toEqual({ outcome: "conflict" })
    const again = await driver.store.acquire(REQUEST)
    expect(again.outcome).not.toBe("acquired")
    expect(again.outcome).not.toBe("replay")
  }, PROPERTY_TIMEOUT_MS)
}
