import { expect, it } from "vitest"
import { forAllAsync } from "../../../core/src/__tests__/differential/harness.js"
import type { InboxRecord, OutboxDeliveryRecord } from "@xonava/core/events"
import { INBOX_KEYS, OUTBOX_KEYS, inboxRecordFor, inboxView, outboxRecordFor, outboxView } from "./deliveryStoreDifferentialModel.js"
import { HOUR, MINUTE, PROPERTY_TIMEOUT_MS, classify, type DeliveryDriver } from "./deliveryStoreDifferential.js"

/**
 * Concurrent differential. Concurrency has no deterministic reference run, so each property states the outcome the core
 * state machine allows for EVERY serialisation of the racing calls: one winner per claim, one terminal transition per
 * claimed lease, first-writer-wins appends, and a business effect that commits if and only if its acknowledgement did.
 */

type Kind = "inbox" | "outbox"
const NO_TOKEN = (): number => 0
const inboxKey = INBOX_KEYS[0]!
const outboxKey = OUTBOX_KEYS[0]!

interface Racer { readonly name: string; run(): Promise<unknown> }
type Settled = { name: string; ok: true; value: unknown } | { name: string; ok: false; error: string }

async function race(racers: readonly Racer[]): Promise<Settled[]> {
  return Promise.all(racers.map(async (racer): Promise<Settled> => {
    try { return { name: racer.name, ok: true, value: await racer.run() } } catch (error) { return { name: racer.name, ok: false, error: classify(error) } }
  }))
}

async function create(driver: DeliveryDriver, kind: Kind): Promise<void> {
  await driver.reset()
  if (kind === "inbox") await driver.inbox.observe(inboxRecordFor(0))
  else await driver.outbox.append(outboxRecordFor(0))
}

const claimOne = (driver: DeliveryDriver, kind: Kind, owner: string, leaseMs: number, maxAttempts?: number) =>
  kind === "inbox" ? driver.inbox.claim(inboxKey, owner, leaseMs, maxAttempts) : driver.outbox.claim(outboxKey, owner, leaseMs, maxAttempts)

const stored = (driver: DeliveryDriver, kind: Kind) => (kind === "inbox" ? driver.inbox.get(inboxKey) : driver.outbox.get(outboxKey))

const viewOfRecord = (kind: Kind, record: InboxRecord | OutboxDeliveryRecord | null): string =>
  JSON.stringify(kind === "inbox" ? inboxView(record as InboxRecord | null, NO_TOKEN) : outboxView(record as OutboxDeliveryRecord | null, NO_TOKEN))

async function fail(driver: DeliveryDriver, kind: Kind, token: string, delayMs: number, maxAttempts: number) {
  return kind === "inbox" ? driver.inbox.scheduleRetry(inboxKey, token, "E_PREP", delayMs, maxAttempts) : driver.outbox.recordFailure(outboxKey, token, "E_PREP", delayMs, maxAttempts)
}

// ------------------------------------------------------------------------------------------------ claim race

type Start = "pending" | "expired" | "retryDue" | "exhausted"
interface ClaimRace { kind: Kind; start: Start; workers: number }

function defineClaimRace(driver: DeliveryDriver): void {
  it(`concurrent claims elect exactly one holder and fence the previous one (${driver.label})`, async () => {
    await forAllAsync(`delivery claim race (${driver.label})`, (rng): ClaimRace => ({ kind: rng.pick<Kind>(["inbox", "outbox"]), start: rng.pick<Start>(["pending", "expired", "retryDue", "exhausted"]), workers: 2 + rng.int(5) }), async (config) => {
      const { kind } = config
      await create(driver, kind)
      let previous: string | undefined
      if (config.start !== "pending") {
        const first = (await claimOne(driver, kind, "w0", 5 * MINUTE))!
        previous = first.claim!.token
        if (config.start === "retryDue") { await fail(driver, kind, previous, HOUR, 5); await driver.advance(HOUR) } else await driver.advance(5 * MINUTE)
      }
      const exhausted = config.start === "exhausted"
      const settled = await race(Array.from({ length: config.workers }, (_unused, index): Racer => ({ name: `w${index + 1}`, run: () => claimOne(driver, kind, `w${index + 1}`, 15 * MINUTE, exhausted ? 1 : undefined) })))
      for (const entry of settled) expect(entry.ok, `${entry.name}: ${entry.ok ? "" : entry.error}`).toBe(true)
      const winners = settled.filter((entry) => entry.ok && entry.value !== null) as Extract<Settled, { ok: true }>[]
      expect(winners.map((entry) => entry.name), "exactly one claimer wins").toHaveLength(1)
      const winner = winners[0]!.value as InboxRecord | OutboxDeliveryRecord
      const after = (await stored(driver, kind))!
      expect(viewOfRecord(kind, after)).toBe(viewOfRecord(kind, winner))
      if (exhausted) {
        expect(after.state).toBe("dead_lettered")
        if (kind === "inbox") expect((after as InboxRecord).history.filter((entry) => entry.terminalState === "dead_lettered")).toHaveLength(1)
      } else {
        expect(after).toMatchObject({ state: "claimed", attempt: config.start === "pending" ? 1 : 2, claim: { owner: winners[0]!.name } })
      }
      if (previous !== undefined) {
        const stale: (() => Promise<unknown>)[] = kind === "inbox"
          ? [() => driver.inbox.renew(inboxKey, previous!, MINUTE), () => driver.acknowledgeWithEffect(inboxKey, previous!, "stale", false)]
          : [() => driver.outbox.markPublished(outboxKey, previous!), () => driver.outbox.recordFailure(outboxKey, previous!, "E", 0, 5)]
        for (const attempt of stale) await expect(attempt()).rejects.toMatchObject({ code: "STALE_CLAIM" })
        expect(await driver.effects()).toEqual([])
      }
    }, { runs: driver.concurrencyRuns ?? 50, describe: (config) => JSON.stringify(config) })
  }, PROPERTY_TIMEOUT_MS)
}

// ------------------------------------------------------------------------------------------------ terminal race

type InboxAction = "ack" | "retry" | "deadLetter" | "renew"
type OutboxAction = "publish" | "fail" | "failFinal"
interface FinishRace { kind: Kind; actions: string[] }

function defineFinishRace(driver: DeliveryDriver): void {
  it(`racing transitions of one claim commit exactly one terminal outcome and its effect (${driver.label})`, async () => {
    await forAllAsync(`delivery finish race (${driver.label})`, (rng): FinishRace => {
      const kind = rng.pick<Kind>(["inbox", "outbox"])
      const menu: string[] = kind === "inbox" ? ["ack", "retry", "deadLetter", "renew"] : ["publish", "fail", "failFinal"]
      const count = 2 + rng.int(4)
      return { kind, actions: Array.from({ length: count }, () => rng.pick(menu)) }
    }, async ({ kind, actions }) => {
      await create(driver, kind)
      const claimed = (await claimOne(driver, kind, "w1", 15 * MINUTE))!
      const token = claimed.claim!.token
      const racers = actions.map((action, index): Racer => ({
        name: `${action}#${index}`,
        run: () => {
          switch (action) {
            case "ack": return driver.acknowledgeWithEffect(inboxKey, token, `a${index}`, false)
            case "retry": return driver.inbox.scheduleRetry(inboxKey, token, "E_RETRY", HOUR, 5)
            case "deadLetter": return driver.inbox.deadLetter(inboxKey, token, "E_DEAD")
            case "renew": return driver.inbox.renew(inboxKey, token, 10 * MINUTE)
            case "publish": return driver.outbox.markPublished(outboxKey, token)
            case "fail": return driver.outbox.recordFailure(outboxKey, token, "E_RETRY", HOUR, 5)
            default: return driver.outbox.recordFailure(outboxKey, token, "E_FINAL", 0, 1)
          }
        },
      }))
      const settled = await race(racers)
      const terminal = settled.filter((entry) => !entry.name.startsWith("renew"))
      const won = terminal.filter((entry) => entry.ok)
      for (const entry of settled) if (!entry.ok) expect(entry.error, `${entry.name} may only lose to a transition that already consumed the claim`).toBe("STALE_CLAIM")
      if (terminal.length === 0) { expect(settled.every((entry) => entry.ok), "renewals of a live claim all succeed").toBe(true); return }
      expect(won.map((entry) => entry.name), "exactly one terminal transition commits").toHaveLength(1)
      const after = (await stored(driver, kind))!
      const winner = won[0]!.name.split("#")[0]!
      const expectedState = { ack: "processed", renew: "claimed", retry: "retry_scheduled", deadLetter: "dead_lettered", publish: "published", fail: "retry_scheduled", failFinal: "dead_lettered" }[winner as InboxAction | OutboxAction]
      expect(after.state).toBe(expectedState)
      expect(after.claim).toBeNull()
      expect(await driver.effects(), "an acknowledgement's effect commits if and only if it won").toEqual(winner === "ack" ? [`a${won[0]!.name.split("#")[1]}`] : [])
    }, { runs: driver.concurrencyRuns ?? 50, describe: (config) => JSON.stringify(config) })
  }, PROPERTY_TIMEOUT_MS)
}

// ------------------------------------------------------------------------------------------------ creation race

type Variant = "ok" | "otherKey" | "otherPayload"
interface CreationRace { kind: Kind; variants: Variant[] }

function defineCreationRace(driver: DeliveryDriver): void {
  it(`concurrent creation is first-writer-wins and idempotent (${driver.label})`, async () => {
    await forAllAsync(`delivery creation race (${driver.label})`, (rng): CreationRace => {
      const kind = rng.pick<Kind>(["inbox", "outbox"])
      const count = 2 + rng.int(5)
      return { kind, variants: Array.from({ length: count }, () => (kind === "outbox" && rng.bool(0.4) ? rng.pick<Variant>(["otherKey", "otherPayload"]) : "ok")) }
    }, async ({ kind, variants }) => {
      await driver.reset()
      const settled = await race(variants.map((variant, index): Racer => ({
        name: `${variant}#${index}`,
        run: () => (kind === "inbox" ? driver.inbox.observe(inboxRecordFor(0)) : driver.outbox.append(outboxRecordFor(0, variant))),
      })))
      const won = settled.filter((entry): entry is Extract<Settled, { ok: true }> => entry.ok)
      expect(won.length, "the first writer always succeeds").toBeGreaterThan(0)
      for (const entry of settled) if (!entry.ok) expect(entry.error).toBe("CONFLICT")
      const after = await stored(driver, kind)
      const reference = viewOfRecord(kind, after)
      for (const entry of won) expect(viewOfRecord(kind, entry.value as InboxRecord | OutboxDeliveryRecord)).toBe(reference)
      if (kind === "outbox") {
        const record = after as OutboxDeliveryRecord
        const storedVariant: Variant = record.idempotencyKey === "k-0-other" ? "otherKey" : (record.envelope.payload as { n: number }).n === 2 ? "otherPayload" : "ok"
        for (const entry of settled) expect(entry.ok, `${entry.name} is accepted iff it equals the stored record (${storedVariant})`).toBe(entry.name.split("#")[0] === storedVariant)
      }
    }, { runs: driver.concurrencyRuns ?? 50, describe: (config) => JSON.stringify(config) })
  }, PROPERTY_TIMEOUT_MS)
}

export function defineDeliveryConcurrency(driver: DeliveryDriver): void {
  defineClaimRace(driver)
  defineFinishRace(driver)
  defineCreationRace(driver)
}
