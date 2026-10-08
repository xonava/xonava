import { eq, and, sql, type AnyColumn } from "drizzle-orm"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"
import type { AtomicBatchIdempotencyPort, ClaimedPendingInvalidation, IdempotencyAcquireResult, IdempotencyCompletion, IdempotencyCommitItem, IdempotencyFinalizationPort, IdempotencyRequest } from "core/events"
import type { DrizzleSessionLike } from "./drizzleRepository"
import { d1CurrentEpochMilliseconds, d1EpochMillisecondsAfter, getAffectedRows } from "./d1Utils"
import { parseInvalidations, resolveExistingIdempotency } from "../drizzle-shared/idempotency"
import { validateLeaseDuration, validateLeaseOwner, resolveLeaseLimit } from "../drizzle-shared/lease"

type IdempotencyColumns = AnySQLiteTable & {
  scope: AnyColumn
  key: AnyColumn
  fingerprint: AnyColumn
  token: AnyColumn
  status: AnyColumn
  result: AnyColumn
  pendingInvalidations: AnyColumn
  resourceEntity: AnyColumn
  resourceId: AnyColumn
  resourceVersion: AnyColumn
  createdAt: AnyColumn
  completedAt: AnyColumn
  finalizerClaimOwner: AnyColumn
  finalizerClaimToken: AnyColumn
  finalizerClaimExpiresAt: AnyColumn
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export class DrizzleD1IdempotencyStore<TResult>
  implements AtomicBatchIdempotencyPort<TResult>, IdempotencyFinalizationPort<TResult>
{
  constructor(private readonly db: DrizzleSessionLike, private readonly table: AnySQLiteTable) {}

  async acquire(request: IdempotencyRequest): Promise<IdempotencyAcquireResult<TResult>> {
    const leaseDurationMs = validateLeaseDuration(request.leaseDurationMs)
    const columns = this.table as IdempotencyColumns
    const token = crypto.randomUUID()
    const insertion = this.db.insert(this.table).values({
      id: crypto.randomUUID(),
      scope: request.scope,
      key: request.key,
      fingerprint: request.fingerprint,
      token,
      status: "in-progress",
      result: null,
      createdAt: d1CurrentEpochMilliseconds(),
    }) as { onConflictDoNothing?: (config: { target: AnyColumn[] }) => Promise<unknown> }

    if (typeof insertion.onConflictDoNothing !== "function") {
      throw new Error("D1 idempotency requires an insert conflict primitive")
    }

    const inserted = await insertion.onConflictDoNothing({ target: [columns.scope, columns.key] })
    if (getAffectedRows(inserted) > 0) return { outcome: "acquired", token }

    const rows = await this.db.select().from(this.table)
      .where(and(eq(columns.scope, request.scope), eq(columns.key, request.key)))
      .limit(1)
    const existing = rows[0]
    if (!isRow(existing)) throw new Error("Idempotency reservation disappeared after conflict")
    let existingResolution: IdempotencyAcquireResult<TResult> | undefined
    try {
      existingResolution = resolveExistingIdempotency<TResult>(request, existing)
    } catch (error) {
      await this.poison(existing)
      throw error
    }
    if (existingResolution) return existingResolution
    const takeoverToken = crypto.randomUUID()

    const updated = await this.db.update(this.table).set({
      token: takeoverToken,
      createdAt: d1CurrentEpochMilliseconds(),
    }).where(and(
      eq(columns.scope, request.scope),
      eq(columns.key, request.key),
      eq(columns.fingerprint, request.fingerprint),
      eq(columns.status, "in-progress"),
      sql`${columns.createdAt} < ${d1EpochMillisecondsAfter(-leaseDurationMs)}`,
    ))
    if (getAffectedRows(updated) === 1) return { outcome: "acquired", token: takeoverToken }
    const currentRows = await this.db.select().from(this.table)
      .where(and(eq(columns.scope, request.scope), eq(columns.key, request.key)))
      .limit(1)
    const current = currentRows[0]
    if (!isRow(current)) throw new Error("Idempotency reservation disappeared during takeover")
    try {
      return resolveExistingIdempotency<TResult>(request, current) ?? { outcome: "in-progress" }
    } catch (error) {
      await this.poison(current)
      throw error
    }
  }

  async renew(lease: { scope: string; key: string; fingerprint: string; token: string; leaseDurationMs?: number }): Promise<void> {
    validateLeaseDuration(lease.leaseDurationMs)
    const columns = this.table as IdempotencyColumns
    const updated = await this.db.update(this.table).set({ createdAt: d1CurrentEpochMilliseconds() }).where(and(
      eq(columns.scope, lease.scope), eq(columns.key, lease.key),
      eq(columns.fingerprint, lease.fingerprint), eq(columns.token, lease.token), eq(columns.status, "in-progress"),
    ))
    if (getAffectedRows(updated) !== 1) throw new Error("Idempotency lease renewal lost ownership")
  }

  /** Releases an uncommitted reservation this caller still owns; committed receipts are never touched. */
  async abandon(lease: { scope: string; key: string; fingerprint: string; token: string }): Promise<void> {
    const columns = this.table as IdempotencyColumns
    await this.db.delete(this.table).where(and(
      eq(columns.scope, lease.scope), eq(columns.key, lease.key),
      eq(columns.fingerprint, lease.fingerprint), eq(columns.token, lease.token), eq(columns.status, "in-progress"),
    ))
  }

  createCommitBatchItem(completion: IdempotencyCommitItem): import("core/persistence").AtomicBatchItem<unknown> {
    // The atomic item is a durable commit receipt: stable identity + durable
    // obligations only. The provider pairs it with a DB-enforced ownership
    // assertion that aborts the whole batch on a stale token, and never stores
    // a replayable response. complete() writes the final response.
    return {
      kind: "idempotency",
      commit: {
        scope: completion.scope,
        key: completion.key,
        fingerprint: completion.fingerprint,
        token: completion.token,
        ...(completion.resource ? { resource: completion.resource } : {}),
        ...(completion.invalidations && completion.invalidations.length > 0
          ? { invalidations: [...new Set(completion.invalidations)] }
          : {}),
      },
    }
  }

  async claimPendingInvalidations(args: {
    limit?: number
    claimOwner: string
    leaseMs: number
    claimToken?: string
  }): Promise<ClaimedPendingInvalidation[]> {
    const leaseMs = validateLeaseDuration(args.leaseMs)
    const limit = resolveLeaseLimit(args.limit)
    validateLeaseOwner(args.claimOwner)
    const claimToken = args.claimToken ?? crypto.randomUUID()
    const columns = this.table as IdempotencyColumns
    // Use DB time for expiry to avoid clock divergences (never Date.now() + leaseMs)
    const rows = await this.db.select().from(this.table)
      .where(and(
        eq(columns.status, "business-committed"),
        sql`${columns.pendingInvalidations} IS NOT NULL`,
        sql`(${columns.finalizerClaimExpiresAt} IS NULL OR ${columns.finalizerClaimExpiresAt} < ${d1CurrentEpochMilliseconds()})`,
      ))
      .limit(limit)
    const claimed: ClaimedPendingInvalidation[] = []
    for (const rawRow of rows) {
      const row = rawRow as Record<string, unknown>
      let invalidations: string[]
      try {
        invalidations = parseInvalidations(row.pendingInvalidations)
      } catch {
        await this.db.update(this.table).set({ status: "poisoned" }).where(and(eq(columns.scope, row.scope), eq(columns.key, row.key), eq(columns.token, row.token), eq(columns.status, "business-committed")))
        continue
      }
      const result: unknown = typeof row.result === "string" ? (() => { try { return JSON.parse(row.result) as unknown } catch { return null } })() : null
      // DB-time lease – omit finalizerClaimExpiresAt from returned claim (informational, DB is source of truth)
      const updated = await this.db.update(this.table).set({
        finalizerClaimOwner: args.claimOwner,
        finalizerClaimToken: claimToken,
        finalizerClaimExpiresAt: d1EpochMillisecondsAfter(leaseMs),
      }).where(and(
        eq(columns.scope, row.scope),
        eq(columns.key, row.key),
        eq(columns.token, row.token),
        eq(columns.status, "business-committed"),
        sql`${columns.pendingInvalidations} IS NOT NULL`,
        sql`(${columns.finalizerClaimExpiresAt} IS NULL OR ${columns.finalizerClaimExpiresAt} < ${d1CurrentEpochMilliseconds()})`,
      ))
      if (getAffectedRows(updated) === 1) {
        claimed.push({
          scope: row.scope as string,
          key: row.key as string,
          fingerprint: row.fingerprint as string,
          token: row.token as string,
          invalidations,
          result,
          claimToken,
          claimOwner: args.claimOwner,
        })
      }
    }
    return claimed
  }

  private async poison(row: Record<string, unknown>): Promise<void> {
    const columns = this.table as IdempotencyColumns
    await this.db.update(this.table).set({ status: "poisoned" }).where(and(
      eq(columns.scope, row.scope), eq(columns.key, row.key),
      eq(columns.token, row.token), eq(columns.status, "business-committed"),
    ))
  }

  async ackClaimedInvalidation(request: {
    scope: string
    key: string
    fingerprint: string
    token: string
    claimToken: string
  }): Promise<void> {
    const columns = this.table as IdempotencyColumns
    const updated = await this.db.update(this.table).set({
      pendingInvalidations: null,
      finalizerClaimOwner: null,
      finalizerClaimToken: null,
      finalizerClaimExpiresAt: null,
     }).where(and(
      eq(columns.scope, request.scope), eq(columns.key, request.key),
      eq(columns.fingerprint, request.fingerprint), eq(columns.token, request.token),
      eq(columns.finalizerClaimToken, request.claimToken),
      eq(columns.status, "business-committed"),
      sql`${columns.finalizerClaimExpiresAt} > ${d1CurrentEpochMilliseconds()}`,
    ))
    if (getAffectedRows(updated) !== 1) throw new Error("Idempotency ack claimed invalidations lost ownership or lease expired")
  }

  async completeClaimedInvalidation(completion: IdempotencyCompletion<TResult> & { claimToken: string }): Promise<void> {
    const columns = this.table as IdempotencyColumns
    const updated = await this.db.update(this.table).set({
      status: "completed",
      result: JSON.stringify(completion.result),
      pendingInvalidations: null,
      finalizerClaimOwner: null,
      finalizerClaimToken: null,
      finalizerClaimExpiresAt: null,
      completedAt: d1CurrentEpochMilliseconds(),
     }).where(and(
      eq(columns.scope, completion.scope),
      eq(columns.key, completion.key),
      eq(columns.fingerprint, completion.fingerprint),
      eq(columns.token, completion.token),
      eq(columns.finalizerClaimToken, completion.claimToken),
       sql`${columns.status} = 'business-committed'`,
      sql`${columns.finalizerClaimExpiresAt} > ${d1CurrentEpochMilliseconds()}`,
    ))
    if (getAffectedRows(updated) !== 1) throw new Error("Idempotency complete claimed invalidations lost ownership or lease expired")
  }

  async complete(completion: IdempotencyCompletion<TResult>): Promise<void> {
    const columns = this.table as IdempotencyColumns
    const updated = await this.db.update(this.table).set({
      status: "completed",
      result: JSON.stringify(completion.result),
      pendingInvalidations: null,
      finalizerClaimOwner: null,
      finalizerClaimToken: null,
      finalizerClaimExpiresAt: null,
      completedAt: d1CurrentEpochMilliseconds(),
     }).where(and(
      eq(columns.scope, completion.scope),
      eq(columns.key, completion.key),
      eq(columns.fingerprint, completion.fingerprint),
      eq(columns.token, completion.token),
      sql`${columns.status} = 'business-committed'`,
    ))
    if (getAffectedRows(updated) !== 1) throw new Error("Idempotency completion lost ownership of the reservation")
  }
}

export function createDrizzleD1IdempotencyStore<TResult>(
  db: DrizzleSessionLike,
  table: AnySQLiteTable,
): AtomicBatchIdempotencyPort<TResult> & IdempotencyFinalizationPort<TResult> {
  return new DrizzleD1IdempotencyStore<TResult>(db, table)
}
