import { appendFileSync } from "node:fs"
import { expect, it } from "vitest"
import { FrameworkCoreError, OptimisticConcurrencyError, ValidationError } from "@xonava/core/domain"
import { consumeInboxMessage, defineConsumer, deliverOutboxMessage, type InboxRecord, type OutboxDeliveryRecord } from "@xonava/core/events"
import type { BackoffPolicy } from "@xonava/core/resilience"
import { forAllAsync, scaledRuns } from "../../../core/src/__tests__/differential/harness.js"
import {
  EVENT_TYPE, HOUR, INBOX_KEYS, MINUTE, OPERATOR, OUTBOX_KEYS, POLICIES, PROVENANCE, T0, describeOps, generateOps, inboxRecordFor, inboxView, outboxRecordFor, outboxView, shrinkOps,
  ModelDelivery, type Behaviour, type DeliverySide, type Op, type TokenRef,
} from "./deliveryStoreDifferentialModel.js"
import { TIMING_SCALE } from "../../../core/src/__tests__/timing.js"

export { HOUR, MINUTE }

/** A real database behind the fenced delivery stores: everything the model also offers, plus isolation and diagnostics. */
export interface DeliveryDriver extends DeliverySide {
  /** Property-name suffix, e.g. "postgres". */
  label: string
  /** True when `InboxPort.acknowledge` runs the local mutation in a database transaction (PostgreSQL, MySQL); false for D1's batch. */
  transactionalAck: boolean
  /** Whether `consumeInboxMessage` can drive the inbox (needs the transactional acknowledge). */
  supportsConsume: boolean
  /** Deletes every delivery record and business effect. */
  reset(): Promise<void>
  /** Base run count of the sequential property at scale 1. */
  lifecycleRuns?: number
  /** Base run count of the concurrency properties at scale 1. */
  concurrencyRuns?: number
  /** Slow transports use short sequences. */
  light?: boolean
}

/** Coverage counters, printed when DELIVERY_STORE_DIFFERENTIAL_STATS is set. */
const COVERAGE = new Map<string, number>()
export function coverage(key: string): void { COVERAGE.set(key, (COVERAGE.get(key) ?? 0) + 1) }
export function printCoverage(label: string): void {
  const file = process.env.DELIVERY_STORE_DIFFERENTIAL_STATS
  if (file) appendFileSync(file, `${label} coverage ${JSON.stringify(Object.fromEntries([...COVERAGE].sort()))}\n`)
}

/** Generous per-test budget: a failing property shrinks. It grows with DIFFERENTIAL_SCALE like the case counts do. */
export const PROPERTY_TIMEOUT_MS = Math.ceil(300_000 * Math.max(1, scaledRuns(100) / 100) * TIMING_SCALE)

/** Stable text for an error, independent of the database driver: framework errors by code, everything else by name and message. */
export function classify(error: unknown, mutationMayFail = false): string {
  if (error instanceof FrameworkCoreError) return error.code
  if (mutationMayFail) return "MUTATION_FAILED"
  return `unexpected:${error instanceof Error ? `${error.name}:${error.message}` : String(error)}`
}

// ------------------------------------------------------------------------------------------------ one side

interface Ctx { side: DeliverySide; issued: Map<string, string[]> }
type Raw = { error: string } | { record: InboxRecord | OutboxDeliveryRecord | null; extra?: unknown }

const cellKey = (kind: "i" | "o", cell: number): string => `${kind}${cell}`

function remember(ctx: Ctx, kind: "i" | "o", cell: number, record: InboxRecord | OutboxDeliveryRecord | null): void {
  const token = record?.claim?.token
  if (token === undefined) return
  const list = ctx.issued.get(cellKey(kind, cell)) ?? []
  if (!list.includes(token)) { list.push(token); ctx.issued.set(cellKey(kind, cell), list) }
}

function tokenFor(ctx: Ctx, kind: "i" | "o", cell: number, ref: TokenRef): string {
  const list = ctx.issued.get(cellKey(kind, cell)) ?? []
  switch (ref) {
    case "latest": return list[list.length - 1] ?? "no-token"
    case "previous": return list[list.length - 2] ?? "no-previous-token"
    case "bogus": return "bogus-token"
    case "foreign": {
      const cells = kind === "i" ? INBOX_KEYS.length : OUTBOX_KEYS.length
      for (let step = 1; step < cells; step++) { const other = ctx.issued.get(cellKey(kind, (cell + step) % cells)); if (other?.length) return other[other.length - 1]! }
      return "no-foreign-token"
    }
  }
}

const policyOf = (id: 0 | 1 | 2): BackoffPolicy => { const [maxAttempts, delay] = POLICIES[id]!; return { maxAttempts, initialDelayMs: delay, backoffMultiplier: 1, maxDelayMs: delay, jitter: "none" } }

async function failure(behaviour: Behaviour): Promise<void> {
  if (behaviour === "transient") throw new Error("down")
  if (behaviour === "permanent") throw new ValidationError("bad message")
  if (behaviour === "frameworkTransient") throw new OptimisticConcurrencyError()
}

async function perform(ctx: Ctx, op: Exclude<Op, { t: "advance" }>, index: number): Promise<Raw> {
  const { side } = ctx
  const ikey = (cell: number) => INBOX_KEYS[cell]!
  const okey = (cell: number) => OUTBOX_KEYS[cell]!
  switch (op.t) {
    case "observe": return { record: await side.inbox.observe(inboxRecordFor(op.cell, op.valid)) }
    case "claim": return { record: await side.inbox.claim(ikey(op.cell), op.owner, op.leaseMs, op.maxAttempts) }
    case "renew": return { record: await side.inbox.renew(ikey(op.cell), tokenFor(ctx, "i", op.cell, op.token), op.leaseMs) }
    case "ack": {
      const done = await side.acknowledgeWithEffect(ikey(op.cell), tokenFor(ctx, "i", op.cell, op.token), `e${index}`, op.failMutation)
      return { record: done.record, extra: done.result }
    }
    case "retry": return { record: await side.inbox.scheduleRetry(ikey(op.cell), tokenFor(ctx, "i", op.cell, op.token), op.code, op.delayMs, op.maxAttempts) }
    case "deadLetter": return { record: await side.inbox.deadLetter(ikey(op.cell), tokenFor(ctx, "i", op.cell, op.token), op.code) }
    case "replay": {
      const reason = op.variant === "emptyReason" ? "" : op.variant === "longReason" ? "x".repeat(1025) : op.reason
      const authorized = (op.variant === "unauthorized" ? false : true) as true
      return { record: await side.inbox.replay(ikey(op.cell), { requestedBy: OPERATOR, reason, authorized, validateReplayEligibility: () => { if (op.variant === "ineligible") throw new Error("ineligible") } }) }
    }
    case "consume": {
      const key = ikey(op.cell)
      const [maxAttempts, delay] = POLICIES[op.policy]!
      const consumer = defineConsumer({ key: key.consumerKey, definitionVersion: 1, eventType: EVENT_TYPE, acceptedPayloadVersions: [1], authority: "event-provenance", retry: { maxAttempts, delayMs: () => delay }, backoff: policyOf(op.policy), transaction: { mode: "required" } })
      const envelope = { format: "framework.event", formatVersion: 1, messageId: key.messageId, eventType: EVENT_TYPE, payloadVersion: op.version, occurredAt: new Date(T0).toISOString(), scope: { kind: "system" }, scopeId: key.scopeId, correlationId: "corr-1", producer: { service: "orders" }, provenance: PROVENANCE, payload: { cell: op.cell } } as never
      const done = await consumeInboxMessage({
        inbox: side.inbox, envelope, consumer, owner: "consumer", leaseMs: op.leaseMs, now: () => new Date(T0), random: () => 0.5,
        handle: async ({ transaction }) => { await side.writeEffect(transaction, `e${index}`); await failure(op.handler); return `r${index}` },
      })
      return { record: done.record, extra: { outcome: done.outcome, result: done.result } }
    }
    case "append": return { record: await side.outbox.append(outboxRecordFor(op.cell, op.variant)) }
    case "oclaim": return { record: await side.outbox.claim(okey(op.cell), op.owner, op.leaseMs, op.maxAttempts) }
    case "publish": return { record: await side.outbox.markPublished(okey(op.cell), tokenFor(ctx, "o", op.cell, op.token)) }
    case "ofail": return { record: await side.outbox.recordFailure(okey(op.cell), tokenFor(ctx, "o", op.cell, op.token), op.code, op.delayMs, op.maxAttempts) }
    case "deliver": {
      const done = await deliverOutboxMessage({ store: side.outbox, publisher: { publish: () => failure(op.publisher) }, key: okey(op.cell), owner: "relay", leaseMs: op.leaseMs, retry: policyOf(op.policy), random: () => 0.5 })
      return { record: done.record, extra: { outcome: done.outcome } }
    }
  }
}

const isInboxOp = (op: Op): boolean => ["observe", "claim", "renew", "ack", "retry", "deadLetter", "replay", "consume"].includes(op.t)

async function readCell(ctx: Ctx, kind: "i" | "o", cell: number): Promise<InboxRecord | OutboxDeliveryRecord | null> {
  const record = kind === "i" ? await ctx.side.inbox.get(INBOX_KEYS[cell]!) : await ctx.side.outbox.get(OUTBOX_KEYS[cell]!)
  remember(ctx, kind, cell, record)
  return record
}

function viewOf(ctx: Ctx, kind: "i" | "o", cell: number, record: InboxRecord | OutboxDeliveryRecord | null): unknown {
  const tokenIndex = (token: string): number => (ctx.issued.get(cellKey(kind, cell)) ?? []).indexOf(token)
  return kind === "i" ? inboxView(record as InboxRecord | null, tokenIndex) : outboxView(record as OutboxDeliveryRecord | null, tokenIndex)
}

/** Runs one op on a side. Returns what the caller observed and the touched record as it is stored afterwards. */
async function step(ctx: Ctx, op: Op, index: number): Promise<{ outcome: string; after: string }> {
  if (op.t === "advance") { await ctx.side.advance(op.ms); return { outcome: "advanced", after: "" } }
  const kind = isInboxOp(op) ? "i" : "o"
  let raw: Raw
  try { raw = await perform(ctx, op, index) } catch (error) { raw = { error: classify(error, op.t === "ack" && op.failMutation) } }
  const stored = await readCell(ctx, kind, op.cell)
  if ("record" in raw) remember(ctx, kind, op.cell, raw.record)
  const outcome = "error" in raw ? { error: raw.error } : { record: viewOf(ctx, kind, op.cell, raw.record), extra: raw.extra }
  return { outcome: JSON.stringify(outcome), after: JSON.stringify(viewOf(ctx, kind, op.cell, stored)) }
}

function summary(outcome: string): string {
  const parsed = JSON.parse(outcome) as { error?: string; record?: { state?: string } | null; extra?: { outcome?: string } }
  if (parsed.error !== undefined) return `error ${parsed.error}`
  return `${parsed.extra?.outcome ?? "ok"}${parsed.record?.state ? ` -> ${parsed.record.state}` : ""}`
}

export async function runSequence(driver: DeliveryDriver, ops: Op[]): Promise<void> {
  await driver.reset()
  const model = new ModelDelivery()
  const reference: Ctx = { side: model, issued: new Map() }
  const real: Ctx = { side: driver, issued: new Map() }
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]!
    const expected = await step(reference, op, index)
    const actual = await step(real, op, index)
    if (op.t !== "advance") coverage(`${op.t}/${summary(expected.outcome)}`)
    if (expected.outcome !== actual.outcome) throw new Error(`op ${index} (${JSON.stringify(op)}): outcome differs\n  model: ${expected.outcome}\n  store: ${actual.outcome}`)
    if (expected.after !== actual.after) throw new Error(`op ${index} (${JSON.stringify(op)}): stored record differs\n  model: ${expected.after}\n  store: ${actual.after}`)
  }
  for (let cell = 0; cell < INBOX_KEYS.length; cell++) {
    const [a, b] = [viewOf(reference, "i", cell, await readCell(reference, "i", cell)), viewOf(real, "i", cell, await readCell(real, "i", cell))]
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`final inbox cell ${cell} differs\n  model: ${JSON.stringify(a)}\n  store: ${JSON.stringify(b)}`)
  }
  for (let cell = 0; cell < OUTBOX_KEYS.length; cell++) {
    const [a, b] = [viewOf(reference, "o", cell, await readCell(reference, "o", cell)), viewOf(real, "o", cell, await readCell(real, "o", cell))]
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`final outbox cell ${cell} differs\n  model: ${JSON.stringify(a)}\n  store: ${JSON.stringify(b)}`)
  }
  expect(await driver.effects(), "committed business effects").toEqual(await model.effects())
}

/** Registers the sequential delivery differential for a driver. */
export function defineDeliveryDifferential(driver: DeliveryDriver): void {
  it(`inbox and outbox delivery sequences match the core state machines (${driver.label})`, async () => {
    await forAllAsync(`delivery store differential (${driver.label})`, (rng) => generateOps(rng, driver.light ? { min: 10, max: 20, consume: driver.supportsConsume } : { min: 24, max: 60, consume: driver.supportsConsume }), (ops) => runSequence(driver, ops), {
      runs: driver.lifecycleRuns ?? 60, shrink: shrinkOps, describe: describeOps, maxShrinkSteps: 150,
    })
  }, PROPERTY_TIMEOUT_MS)
}

// ------------------------------------------------------------------------------------------------ regressions

/** Deterministic cases for the properties of the fenced state machine that matter most; each fails if the property is lost. */
export function defineDeliveryRegressions(driver: DeliveryDriver): void {
  const key = INBOX_KEYS[0]!
  const okey = OUTBOX_KEYS[0]!

  it(`a failed acknowledgement mutation leaves neither the effect nor the transition (${driver.label})`, async () => {
    await driver.reset()
    await driver.inbox.observe(inboxRecordFor(0))
    const claimed = (await driver.inbox.claim(key, "w1", 5 * MINUTE))!
    await expect(driver.acknowledgeWithEffect(key, claimed.claim!.token, "bad", true)).rejects.toThrow()
    expect(await driver.effects()).toEqual([])
    expect(await driver.inbox.get(key)).toMatchObject({ state: "claimed", attempt: 1, claim: { token: claimed.claim!.token } })
    const done = await driver.acknowledgeWithEffect(key, claimed.claim!.token, "good", false)
    expect(done).toMatchObject({ result: "good", record: { state: "processed", claim: null } })
    expect(await driver.effects()).toEqual(["good"])
    await expect(driver.acknowledgeWithEffect(key, claimed.claim!.token, "again", false)).rejects.toMatchObject({ code: "STALE_CLAIM" })
    expect(await driver.effects()).toEqual(["good"])
  })

  it(`a lease that lapses on the database clock is taken over and the old token is fenced (${driver.label})`, async () => {
    await driver.reset()
    await driver.inbox.observe(inboxRecordFor(0))
    const first = (await driver.inbox.claim(key, "w1", 5 * MINUTE))!
    expect(await driver.inbox.claim(key, "w2", 5 * MINUTE)).toBeNull()
    await driver.advance(5 * MINUTE)
    const second = (await driver.inbox.claim(key, "w2", 5 * MINUTE))!
    expect(second).toMatchObject({ attempt: 2, claim: { owner: "w2" } })
    expect(second.claim!.token).not.toBe(first.claim!.token)
    await expect(driver.inbox.renew(key, first.claim!.token, MINUTE)).rejects.toMatchObject({ code: "STALE_CLAIM" })
    await expect(driver.acknowledgeWithEffect(key, first.claim!.token, "late", false)).rejects.toMatchObject({ code: "STALE_CLAIM" })
    expect(await driver.effects()).toEqual([])
  })

  it(`an operation on a record that was never observed or appended is a conflict (${driver.label})`, async () => {
    await driver.reset()
    const unseen = INBOX_KEYS[3]!
    await expect(driver.inbox.claim(unseen, "w1", MINUTE)).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(driver.inbox.renew(unseen, "t", MINUTE)).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(driver.acknowledgeWithEffect(unseen, "t", "none", false)).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(driver.inbox.scheduleRetry(unseen, "t", "E", 0, 3)).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(driver.inbox.deadLetter(unseen, "t", "E")).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(driver.inbox.replay(unseen, { requestedBy: OPERATOR, reason: "r", authorized: true, validateReplayEligibility: () => undefined })).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await driver.inbox.get(unseen)).toBeNull()
    const unsent = OUTBOX_KEYS[3]!
    await expect(driver.outbox.claim(unsent, "w1", MINUTE)).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(driver.outbox.markPublished(unsent, "t")).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(driver.outbox.recordFailure(unsent, "t", "E", 0, 3)).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await driver.outbox.get(unsent)).toBeNull()
  })

  it(`a crashed final attempt dead-letters at the next claim instead of starting another (${driver.label})`, async () => {
    await driver.reset()
    await driver.outbox.append(outboxRecordFor(0))
    const claimed = (await driver.outbox.claim(okey, "relay", 5 * MINUTE, 1))!
    expect(claimed).toMatchObject({ state: "claimed", attempt: 1 })
    await driver.advance(5 * MINUTE)
    const dead = await driver.outbox.claim(okey, "relay", 5 * MINUTE, 1)
    expect(dead).toMatchObject({ state: "dead_lettered", attempt: 1, claim: null, lastFailure: { code: "LEASE_EXPIRED" } })
    await expect(driver.outbox.markPublished(okey, claimed.claim!.token)).rejects.toMatchObject({ code: "STALE_CLAIM" })
    expect(await driver.outbox.claim(okey, "relay", 5 * MINUTE, 1)).toBeNull()
  })

  it(`a retry is not claimable until its delay has passed, and a dead-lettered inbox record replays under a new generation (${driver.label})`, async () => {
    await driver.reset()
    await driver.inbox.observe(inboxRecordFor(0))
    const claimed = (await driver.inbox.claim(key, "w1", 5 * MINUTE))!
    const retry = await driver.inbox.scheduleRetry(key, claimed.claim!.token, "BROKER_DOWN", HOUR, 2)
    expect(retry).toMatchObject({ state: "retry_scheduled", claim: null, lastFailure: { code: "BROKER_DOWN", retryable: true } })
    expect(await driver.inbox.claim(key, "w2", 5 * MINUTE)).toBeNull()
    await driver.advance(HOUR)
    const again = (await driver.inbox.claim(key, "w2", 5 * MINUTE, 2))!
    expect(again).toMatchObject({ state: "claimed", attempt: 2 })
    expect(again.nextAttemptAt).toBeUndefined()
    const dead = await driver.inbox.scheduleRetry(key, again.claim!.token, "BROKER_DOWN", 0, 2)
    expect(dead).toMatchObject({ state: "dead_lettered", history: [{ generation: 0, terminalState: "dead_lettered", failure: { code: "BROKER_DOWN", retryable: false } }] })
    const replayed = await driver.inbox.replay(key, { requestedBy: OPERATOR, reason: "fixed", authorized: true, validateReplayEligibility: () => undefined })
    expect(replayed).toMatchObject({ state: "pending", attempt: 0, replayGeneration: 1, replay: { kind: "replayed", replayGeneration: 1, reason: "fixed" }, history: [{ generation: 0 }] })
  })

  if (!driver.transactionalAck) {
    it(`the generic acknowledge is refused on a backend without transactions and changes nothing (${driver.label})`, async () => {
      await driver.reset()
      await driver.inbox.observe(inboxRecordFor(0))
      const claimed = (await driver.inbox.claim(key, "w1", 5 * MINUTE))!
      expect(() => driver.inbox.acknowledge(key, claimed.claim!.token, async () => "x")).toThrowError(expect.objectContaining({ code: "CONFIGURATION_ERROR" }))
      expect(await driver.inbox.get(key)).toMatchObject({ state: "claimed", claim: { token: claimed.claim!.token } })
    })
  }
}

// ------------------------------------------------------------------------------------------------ driver helper

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/

/** Translates every ISO timestamp of a stored record `deltaMs` into the past (the effect of the database clock moving forward). */
export function shiftTimestamps(value: unknown, deltaMs: number): unknown {
  if (typeof value === "string") return ISO.test(value) ? new Date(Date.parse(value) - deltaMs).toISOString() : value
  if (Array.isArray(value)) return value.map((member) => shiftTimestamps(member, deltaMs))
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, member]) => [name, shiftTimestamps(member, deltaMs)]))
  return value
}
