import {
  acknowledgeInboxRecord, appendOutboxDelivery, claimInboxRecord, claimOutboxDelivery, deadLetterInboxRecord, markOutboxDeliveryPublished,
  observeInboxRecord, recordOutboxDeliveryFailure, renewInboxClaim, replayInboxRecord, scheduleInboxRetry,
  type InboxKey, type InboxPort, type InboxRecord, type OutboxDeliveryKey, type OutboxDeliveryRecord, type OutboxStore,
} from "@xonava/core/events"
import { ConfigurationError, ConflictError, type DurableAuthorityProvenanceV1 } from "@xonava/core/domain"
import type { Rng } from "../../../core/src/__tests__/differential/harness.js"

/**
 * Reference model for the real-database delivery differential (inbox and outbox over an atomic record backend).
 *
 * The reference is the PURE core delivery state machine (packages/core/src/events/durability/delivery.ts, normative in
 * docs/spec/events/outbox-inbox.md) applied to an in-memory map under a virtual clock; it shares no code with any
 * adapter. The reference runners `deliverOutboxMessage` / `consumeInboxMessage` are executed against this model as well
 * as against the real stores, so the protocol layer (claim, bounded work, fenced transition, failure classification) is
 * compared too.
 *
 * Time handling. Every adapter judges leases and retry times against the DATABASE clock. The model therefore never lets
 * time pass by itself: leases are minutes long and time moves only through an explicit `advance` op, which the driver
 * realises by translating every stored timestamp that far into the database's past (no real waiting). All durations are
 * multiples of one minute, so a decision is never closer than a minute to the real clock, except at exact equality
 * (`now >= leaseExpiresAt`), where the real elapsed time is non-negative and decides the same way as the model.
 * Absolute timestamps are not comparable between the model and a database; the observable `View` keeps only durations
 * measured from a single transition's `now` and the presence of every other timestamp.
 */

export const T0 = Date.UTC(2030, 5, 1)
export const MINUTE = 60_000
export const HOUR = 3_600_000
export const ADVANCES = [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR] as const

export const SCOPE_A = "fscope:v1:a" as never
export const SCOPE_B = "fscope:v1:b" as never
export const PROVENANCE = { format: "framework.authority-provenance", formatVersion: 1, correlationId: "corr-1" } as unknown as DurableAuthorityProvenanceV1
export const OPERATOR = { format: "framework.authority-provenance", formatVersion: 1, correlationId: "operator" } as unknown as DurableAuthorityProvenanceV1
export const EVENT_TYPE = "order.placed"

/** Inbox cells: a key is consumer + message + scope; the cells share message ids across scopes and consumers. */
export const INBOX_KEYS: readonly InboxKey[] = [
  { consumerKey: "c1", messageId: "m1", scopeId: SCOPE_A },
  { consumerKey: "c1", messageId: "m2", scopeId: SCOPE_A },
  { consumerKey: "c2", messageId: "m1", scopeId: SCOPE_B },
  { consumerKey: "c1", messageId: "m9", scopeId: SCOPE_A },
]
/** Outbox cells: the first and third share a message id across scopes. */
export const OUTBOX_KEYS: readonly OutboxDeliveryKey[] = [
  { messageId: "o1", scopeId: SCOPE_A },
  { messageId: "o2", scopeId: SCOPE_A },
  { messageId: "o1", scopeId: SCOPE_B },
  { messageId: "o9", scopeId: SCOPE_A },
]

export type TokenRef = "latest" | "previous" | "bogus" | "foreign"
export type Owner = "w1" | "w2" | "w3"
export type ReplayVariant = "ok" | "emptyReason" | "longReason" | "unauthorized" | "ineligible"
export type AppendVariant = "ok" | "otherKey" | "otherPayload" | "invalid"
export type Behaviour = "ok" | "transient" | "permanent" | "frameworkTransient"
export type PolicyId = 0 | 1 | 2
/** Runner retry policies as [maxAttempts, constant delay]. */
export const POLICIES: readonly (readonly [number, number])[] = [[1, 0], [2, 0], [3, HOUR]]

export type Op =
  | { t: "observe"; cell: number; valid: boolean }
  | { t: "claim"; cell: number; owner: Owner; leaseMs: number; maxAttempts?: number }
  | { t: "renew"; cell: number; token: TokenRef; leaseMs: number }
  | { t: "ack"; cell: number; token: TokenRef; failMutation: boolean }
  | { t: "retry"; cell: number; token: TokenRef; code: string; delayMs: number; maxAttempts: number }
  | { t: "deadLetter"; cell: number; token: TokenRef; code: string }
  | { t: "replay"; cell: number; variant: ReplayVariant; reason: string }
  | { t: "consume"; cell: number; handler: Behaviour; policy: PolicyId; version: 1 | 2; leaseMs: number }
  | { t: "append"; cell: number; variant: AppendVariant }
  | { t: "oclaim"; cell: number; owner: Owner; leaseMs: number; maxAttempts?: number }
  | { t: "publish"; cell: number; token: TokenRef }
  | { t: "ofail"; cell: number; token: TokenRef; code: string; delayMs: number; maxAttempts: number }
  | { t: "deliver"; cell: number; publisher: Behaviour; policy: PolicyId; leaseMs: number }
  | { t: "advance"; ms: number }

// ------------------------------------------------------------------------------------------------ records

export function inboxRecordFor(cell: number, valid = true): InboxRecord {
  const key = INBOX_KEYS[cell]!
  const at = new Date(T0).toISOString()
  return {
    ...key, consumerDefinitionVersion: 1, state: valid ? "pending" : "claimed", attempt: valid ? 0 : 1, replayGeneration: 0, claim: null,
    firstObservedAt: at, lastObservedAt: at, eventFormatVersion: 1, eventPayloadVersion: 1, originalProvenance: PROVENANCE, replay: { kind: "original-delivery" }, history: [],
  }
}

export function outboxRecordFor(cell: number, variant: AppendVariant = "ok"): OutboxDeliveryRecord {
  const key = OUTBOX_KEYS[cell]!
  const envelope = { messageId: key.messageId, eventType: EVENT_TYPE, payloadVersion: 1, payload: { n: variant === "otherPayload" ? 2 : 1, cell } } as never
  const base: OutboxDeliveryRecord = { envelope, scopeId: key.scopeId, idempotencyKey: variant === "otherKey" ? `k-${cell}-other` : `k-${cell}`, state: "pending", attempt: 0, claim: null }
  return variant === "invalid" ? { ...base, state: "claimed", attempt: 1 } : base
}

// ------------------------------------------------------------------------------------------------ the model

export const inboxKeyOf = (key: InboxKey): string => `${key.scopeId}|${key.consumerKey}|${key.messageId}`
export const outboxKeyOf = (key: OutboxDeliveryKey): string => `${key.scopeId}|${key.messageId}`

function existing<T>(current: T | undefined, message?: string): T {
  if (current === undefined) throw new ConflictError(message)
  return current
}

/** Everything a driver and the model share, so one script executes unchanged against either. */
export interface DeliverySide {
  readonly inbox: InboxPort
  readonly outbox: OutboxStore
  /** Moves the side's clock forward by `ms` (the driver translates every stored timestamp into the database's past). */
  advance(ms: number): Promise<void>
  /** Business-effect ids committed so far, sorted. */
  effects(): Promise<string[]>
  /** Acknowledges with a business effect in the same atomic unit; `failMutation` makes that unit fail after writing the effect. */
  acknowledgeWithEffect(key: InboxKey, token: string, effectId: string, failMutation: boolean): Promise<{ record: InboxRecord; result: string }>
  /** Writes a business effect inside the transaction handed to a `consumeInboxMessage` handler. */
  writeEffect(transaction: unknown, effectId: string): Promise<void>
}

export class ModelDelivery implements DeliverySide {
  private readonly inboxRecords = new Map<string, InboxRecord>()
  private readonly outboxRecords = new Map<string, OutboxDeliveryRecord>()
  private readonly committed = new Set<string>()
  private clock = T0
  private tokenSeq = 0

  private now(): Date { return new Date(this.clock) }
  private token(): string { return `model-token-${++this.tokenSeq}` }
  async advance(ms: number): Promise<void> { this.clock += ms }
  async effects(): Promise<string[]> { return [...this.committed].sort() }
  async writeEffect(transaction: unknown, effectId: string): Promise<void> { (transaction as Set<string>).add(effectId) }
  async acknowledgeWithEffect(key: InboxKey, token: string, effectId: string, failMutation: boolean): Promise<{ record: InboxRecord; result: string }> {
    return this.inbox.acknowledge(key, token, async (transaction) => { await this.writeEffect(transaction, effectId); if (failMutation) throw new Error("crash"); return effectId })
  }

  readonly inbox: InboxPort = {
    observe: async (record) => {
      const key = inboxKeyOf(record)
      const next = observeInboxRecord(this.inboxRecords.get(key) ?? null, record, this.now())
      this.inboxRecords.set(key, next)
      return next
    },
    get: async (key) => this.inboxRecords.get(inboxKeyOf(key)) ?? null,
    claim: async (key, owner, leaseMs, maxAttempts) => {
      const record = existing(this.inboxRecords.get(inboxKeyOf(key)), "Inbox record not observed")
      const next = claimInboxRecord(record, { owner, token: this.token(), leaseMs, now: this.now(), ...(maxAttempts !== undefined ? { maxAttempts } : {}) })
      this.inboxRecords.set(inboxKeyOf(key), next ?? record)
      return next
    },
    renew: async (key, token, leaseMs) => {
      const next = renewInboxClaim(existing(this.inboxRecords.get(inboxKeyOf(key))), { token, leaseMs, now: this.now() })
      this.inboxRecords.set(inboxKeyOf(key), next)
      return next
    },
    acknowledge: async <T>(key: InboxKey, token: string, localMutation: (transaction?: unknown) => Promise<T>) => {
      const record = existing(this.inboxRecords.get(inboxKeyOf(key)))
      const next = acknowledgeInboxRecord(record, token, this.now())
      const staged = new Set<string>()
      const result = await localMutation(staged)
      for (const id of staged) this.committed.add(id)
      this.inboxRecords.set(inboxKeyOf(key), next)
      return { record: next, result }
    },
    scheduleRetry: async (key, token, failureCode, delayMs, maxAttempts) => {
      const next = scheduleInboxRetry(existing(this.inboxRecords.get(inboxKeyOf(key))), { token, code: failureCode, delayMs, maxAttempts, now: this.now() })
      this.inboxRecords.set(inboxKeyOf(key), next)
      return next
    },
    deadLetter: async (key, token, failureCode) => {
      const next = deadLetterInboxRecord(existing(this.inboxRecords.get(inboxKeyOf(key))), { token, code: failureCode, now: this.now() })
      this.inboxRecords.set(inboxKeyOf(key), next)
      return next
    },
    replay: async (key, request) => {
      if (request.authorized !== true) throw new ConfigurationError("Replay requires authorization")
      request.validateReplayEligibility()
      const next = replayInboxRecord(existing(this.inboxRecords.get(inboxKeyOf(key)), "Only dead-lettered delivery may be replayed"), { requestedBy: request.requestedBy, reason: request.reason, now: this.now() })
      this.inboxRecords.set(inboxKeyOf(key), next)
      return next
    },
  }

  readonly outbox: OutboxStore = {
    append: async (record) => {
      const key = outboxKeyOf({ messageId: record.envelope.messageId, scopeId: record.scopeId })
      const next = appendOutboxDelivery(this.outboxRecords.get(key) ?? null, record)
      this.outboxRecords.set(key, next)
      return next
    },
    get: async (key) => this.outboxRecords.get(outboxKeyOf(key)) ?? null,
    claim: async (key, owner, leaseMs, maxAttempts) => {
      const record = existing(this.outboxRecords.get(outboxKeyOf(key)))
      const next = claimOutboxDelivery(record, { owner, token: this.token(), leaseMs, now: this.now(), ...(maxAttempts !== undefined ? { maxAttempts } : {}) })
      this.outboxRecords.set(outboxKeyOf(key), next ?? record)
      return next
    },
    markPublished: async (key, token) => {
      const next = markOutboxDeliveryPublished(existing(this.outboxRecords.get(outboxKeyOf(key))), token, this.now())
      this.outboxRecords.set(outboxKeyOf(key), next)
      return next
    },
    recordFailure: async (key, token, code, delayMs, maxAttempts) => {
      const next = recordOutboxDeliveryFailure(existing(this.outboxRecords.get(outboxKeyOf(key))), { token, code, delayMs, maxAttempts, now: this.now() })
      this.outboxRecords.set(outboxKeyOf(key), next)
      return next
    },
  }
}

// ------------------------------------------------------------------------------------------------ observable views

export interface FailureView { code: string; retryable?: boolean }
const failureView = (failure: { code: string; retryable?: boolean } | undefined): FailureView | null => (failure ? { code: failure.code, ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}) } : null)
const ms = (iso: string | undefined): number => Date.parse(iso as string)
/** Deep copy with sorted keys: JSON columns (jsonb, MySQL JSON) do not preserve member order. */
export function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon)
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, member]) => [name, canon(member)]))
  return value
}
/** JSON round trips drop undefined members, so the key set is compared without them. */
const keysOf = (value: object): string[] => Object.entries(value).filter(([, member]) => member !== undefined).map(([name]) => name).sort()

export function inboxView(record: InboxRecord | null, tokenIndex: (token: string) => number): unknown {
  if (record === null) return null
  const observed = ms(record.lastObservedAt)
  return {
    keys: keysOf(record),
    identity: [record.consumerKey, record.messageId, record.scopeId, record.consumerDefinitionVersion, record.eventFormatVersion, record.eventPayloadVersion],
    state: record.state, attempt: record.attempt, replayGeneration: record.replayGeneration,
    claim: record.claim ? { token: tokenIndex(record.claim.token), owner: record.claim.owner, leaseMs: ms(record.claim.leaseExpiresAt) - observed, keys: keysOf(record.claim) } : null,
    retryInMs: record.nextAttemptAt === undefined ? null : ms(record.nextAttemptAt) - ms(record.lastFailure?.occurredAt),
    processedAfterMs: record.processedAt === undefined ? null : ms(record.processedAt) - observed,
    deadLettered: record.deadLetteredAt !== undefined,
    lastFailure: failureView(record.lastFailure),
    history: record.history.map((entry) => ({ generation: entry.generation, terminalState: entry.terminalState, timed: Number.isFinite(ms(entry.at)), failure: failureView(entry.failure) })),
    replay: record.replay.kind === "original-delivery" ? { kind: record.replay.kind } : { kind: record.replay.kind, generation: record.replay.replayGeneration, reason: record.replay.reason, by: canon(record.replay.requestedBy), timed: Number.isFinite(ms(record.replay.requestedAt)) },
    provenance: canon(record.originalProvenance),
  }
}

export function outboxView(record: OutboxDeliveryRecord | null, tokenIndex: (token: string) => number): unknown {
  if (record === null) return null
  return {
    keys: keysOf(record),
    identity: [record.envelope.messageId, record.scopeId, record.idempotencyKey, record.envelope.eventType, record.envelope.payloadVersion, JSON.stringify(record.envelope.payload)],
    state: record.state, attempt: record.attempt,
    claim: record.claim ? { token: tokenIndex(record.claim.token), owner: record.claim.owner, leaseMs: ms(record.claim.leaseExpiresAt) - ms(record.claim.claimedAt), keys: keysOf(record.claim) } : null,
    retryInMs: record.nextAttemptAt === undefined ? null : ms(record.nextAttemptAt) - ms(record.lastFailure?.occurredAt),
    published: record.publishedAt !== undefined,
    lastFailure: failureView(record.lastFailure),
  }
}

// ------------------------------------------------------------------------------------------------ generation

const OWNERS: readonly Owner[] = ["w1", "w2", "w3"]
const LEASES = [5 * MINUTE, 15 * MINUTE] as const
/** Out-of-range lease and delay values reach the core validation (ConfigurationError) through the store. */
const BAD_LEASES = [0, 15 * MINUTE + 1] as const
const DELAYS = [0, HOUR] as const
const BAD_DELAYS = [-1, 7 * 24 * HOUR + 1] as const
const CODES = ["BROKER_DOWN", "E1", "bad code!", "", "x".repeat(65), "a.b:c-d_e"] as const
const TOKENS: readonly TokenRef[] = ["latest", "latest", "latest", "previous", "bogus", "foreign"]
const BEHAVIOURS: readonly Behaviour[] = ["ok", "ok", "transient", "permanent", "frameworkTransient"]

export interface GenerateSize { min: number; max: number; consume?: boolean }

function lease(rng: Rng): number { return rng.bool(0.06) ? rng.pick(BAD_LEASES) : rng.pick(LEASES) }
function delay(rng: Rng): number { return rng.bool(0.06) ? rng.pick(BAD_DELAYS) : rng.pick(DELAYS) }
function claimLimit(rng: Rng): number | undefined { return rng.bool(0.05) ? 0 : rng.pick([undefined, undefined, 1, 2, 3]) }

export function generateOp(rng: Rng, consume = true): Op {
  const cell = rng.int(INBOX_KEYS.length)
  const weights: [number, () => Op][] = [
    [8, () => ({ t: "observe", cell, valid: rng.bool(0.9) })],
    [12, () => ({ t: "claim", cell, owner: rng.pick(OWNERS), leaseMs: lease(rng), ...limit(claimLimit(rng)) })],
    [5, () => ({ t: "renew", cell, token: rng.pick(TOKENS), leaseMs: lease(rng) })],
    [8, () => ({ t: "ack", cell, token: rng.pick(TOKENS), failMutation: rng.bool(0.25) })],
    [7, () => ({ t: "retry", cell, token: rng.pick(TOKENS), code: rng.pick(CODES), delayMs: delay(rng), maxAttempts: rng.bool(0.05) ? 0 : 1 + rng.int(3) })],
    [4, () => ({ t: "deadLetter", cell, token: rng.pick(TOKENS), code: rng.pick(CODES) })],
    [5, () => ({ t: "replay", cell, variant: rng.pick<ReplayVariant>(["ok", "ok", "ok", "emptyReason", "longReason", "unauthorized", "ineligible"]), reason: rng.pick(["operator replay", "fixed upstream"]) })],
    [consume ? 7 : 0, () => ({ t: "consume", cell, handler: rng.pick(BEHAVIOURS), policy: rng.pick<PolicyId>([0, 1, 2]), version: rng.bool(0.1) ? 2 : 1, leaseMs: rng.pick(LEASES) })],
    [7, () => ({ t: "append", cell, variant: rng.pick<AppendVariant>(["ok", "ok", "ok", "otherKey", "otherPayload", "invalid"]) })],
    [10, () => ({ t: "oclaim", cell, owner: rng.pick(OWNERS), leaseMs: lease(rng), ...limit(claimLimit(rng)) })],
    [6, () => ({ t: "publish", cell, token: rng.pick(TOKENS) })],
    [7, () => ({ t: "ofail", cell, token: rng.pick(TOKENS), code: rng.pick(CODES), delayMs: delay(rng), maxAttempts: rng.bool(0.05) ? 0 : 1 + rng.int(3) })],
    [7, () => ({ t: "deliver", cell, publisher: rng.pick(BEHAVIOURS), policy: rng.pick<PolicyId>([0, 1, 2]), leaseMs: rng.pick(LEASES) })],
    [13, () => ({ t: "advance", ms: rng.pick(ADVANCES) })],
  ]
  const total = weights.reduce((sum, [weight]) => sum + weight, 0)
  let pick = rng.int(total)
  for (const [weight, make] of weights) {
    if (pick < weight) return make()
    pick -= weight
  }
  throw new Error("unreachable")
}

function limit(value: number | undefined): { maxAttempts?: number } { return value === undefined ? {} : { maxAttempts: value } }

export function generateOps(rng: Rng, size: GenerateSize = { min: 24, max: 60 }): Op[] {
  const count = size.min + rng.int(size.max - size.min + 1)
  const ops: Op[] = []
  for (let index = 0; index < count; index++) ops.push(generateOp(rng, size.consume ?? true))
  return ops
}

export function* shrinkOps(ops: Op[]): Generator<Op[]> {
  if (ops.length > 2) {
    yield ops.slice(0, Math.ceil(ops.length / 2))
    yield ops.slice(Math.floor(ops.length / 2))
  }
  for (let size = Math.min(8, ops.length - 1); size >= 1; size = Math.floor(size / 2)) {
    for (let start = 0; start + size <= ops.length; start += size) yield [...ops.slice(0, start), ...ops.slice(start + size)]
    if (size === 1) break
  }
}

export function describeOps(ops: Op[]): string {
  return ops.map((op, index) => `${index}: ${JSON.stringify(op)}`).join("\n")
}
