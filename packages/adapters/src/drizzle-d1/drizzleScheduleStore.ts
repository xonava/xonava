import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm"
import { uuidv7 } from "uuidv7"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"
import { ConfigurationError, ValidationError } from "core/domain"
import type { ScheduleStore, RenewScheduleLeaseArgs, FencedScheduleClaim, FencedAdvanceScheduleArgs, FencedReleaseScheduleArgs } from "core/execution"
import type { ClaimDueSchedulesArgs, ScheduleClaim, ScheduleScope, OverlapPolicy, MisfirePolicy } from "core/execution"
import { assertDurableIdentifier, scheduleOccurrencesConsumed } from "core/execution"
import type { DrizzleColumnMap } from "../drizzle-shared/predicateCompiler"
import type { DrizzleSessionLike } from "./drizzleRepository"
import { d1ColumnInputValue, d1CurrentEpochMilliseconds, d1EpochMillisecondsAfter, getAffectedRows } from "./d1Utils"
import { decodePersistedJobScope } from "../drizzle-shared/jobScope"

export interface DrizzleScheduleStoreConfig {
  schedulesTable: AnySQLiteTable
  columnMap: { schedules: DrizzleColumnMap }
  resolveTenantTimezones?: (db: DrizzleSessionLike, tenantIds: string[], platformTimezone: string) => Promise<Map<string, string>>
}

const PLATFORM_TZ_FALLBACK = "UTC"

function readScheduleScope(row: Record<string, unknown>): ScheduleScope {
  const scope = row.scope
  if (scope !== "tenant" && scope !== "platform" && scope !== "system") {
    throw new ValidationError(`Schedule ${String(row.id)} has a missing or invalid scope`)
  }
  return scope
}

function toScheduleClaim(row: Record<string, unknown>): ScheduleClaim {
  const scope = readScheduleScope(row)
  const tenantId = (row.tenantId as string) ?? null
  return {
    scheduleId: row.id as string, scope, executionScope: decodePersistedJobScope(scope, tenantId), jobType: row.jobType as string,
    jobVersion: row.jobVersion as number, tenantId, payload: row.payload as string,
    cronExpression: row.cronExpression as string, timezone: row.timezone as string,
    overlapPolicy: { type: (row.overlapPolicy as string) ?? "allow" } as OverlapPolicy,
    misfirePolicy: { type: (row.misfirePolicy as string) ?? "fire_now" } as MisfirePolicy,
    nextRunAt: new Date(row.nextRunAt as number), lastRunAt: row.lastRunAt ? new Date(row.lastRunAt as number) : null,
    lastStatus: (row.lastStatus as string) ?? null,
    lifecycle: { paused: Boolean(row.paused), ...(row.effectiveFrom ? { effectiveFrom: new Date(row.effectiveFrom as number).toISOString() } : {}), ...(row.effectiveUntil ? { effectiveUntil: new Date(row.effectiveUntil as number).toISOString() } : {}), ...(row.remainingOccurrences === null || row.remainingOccurrences === undefined ? {} : { remainingOccurrences: Number(row.remainingOccurrences) }), ...(row.calendarExclusionKey ? { calendarExclusionKey: row.calendarExclusionKey as string } : {}), ...(row.owner ? { owner: row.owner as string } : {}), ...(row.description ? { description: row.description as string } : {}) },
  }
}

export class DrizzleScheduleStore implements ScheduleStore {
  private static readonly REQUIRED_SCHEDULE_COLUMNS = [
    "id", "jobType", "jobVersion", "tenantId", "scope", "payload", "cronExpression", "timezone",
    "enabled", "overlapPolicy", "misfirePolicy", "nextRunAt", "lastRunAt", "lastStatus",
    "lastError", "leaseOwner", "leaseExpiresAt", "claimToken",
  ] as const

  constructor(private readonly db: DrizzleSessionLike, private readonly config: DrizzleScheduleStoreConfig, private readonly platformTimezone = PLATFORM_TZ_FALLBACK) {
    const schedules = config.columnMap.schedules
    for (const column of DrizzleScheduleStore.REQUIRED_SCHEDULE_COLUMNS) {
      if (!schedules[column]) {
        throw new ConfigurationError(`Schedule store is missing the required '${column}' column in its column map`)
      }
    }
  }

  async claimDueSchedules(args: ClaimDueSchedulesArgs): Promise<FencedScheduleClaim[]> {
    assertDurableIdentifier(args.workerId, "workerId", 100)
    // Same guard as the job stores: a non-positive or non-integer limit claims nothing (D1 would read LIMIT -1 as unbounded),
    // and a lease duration that is not a finite, non-negative number would bind NULL / NaN into the lease expiry (0 stays valid: an already-expired claim).
    if (!Number.isSafeInteger(args.limit) || args.limit <= 0 || !Number.isFinite(args.leaseDurationMs) || args.leaseDurationMs < 0) return []
    const schedules = this.config.columnMap.schedules
    const now = args.now ?? new Date()
    const leaseExpiresAt = d1EpochMillisecondsAfter(args.leaseDurationMs)
    const lifecycleConditions = [
      ...(schedules.paused ? [eq(schedules.paused, false)] : []),
      ...(schedules.effectiveFrom ? [or(isNull(schedules.effectiveFrom), lte(schedules.effectiveFrom, now))!] : []),
      ...(schedules.effectiveUntil ? [or(isNull(schedules.effectiveUntil), gt(schedules.effectiveUntil, now))!] : []),
      ...(schedules.remainingOccurrences ? [or(isNull(schedules.remainingOccurrences), gt(schedules.remainingOccurrences, 0))!] : []),
    ]
    // A failed schedule backs off: its lease expiry holds the earliest retry time.
    const notBackingOff = or(sql`COALESCE(${schedules.lastStatus!}, '') <> 'failed'`, isNull(schedules.leaseExpiresAt!), lte(schedules.leaseExpiresAt!, d1ColumnInputValue(schedules.leaseExpiresAt!, now)))!
    // A schedule held by a live claim is not claimable. This belongs in the candidate scan as well as the conditional
    // update: otherwise held schedules (which sort first) use up the claim limit and starve the rest.
    const leaseFree = or(
      sql`(${schedules.lastStatus!} IS NULL OR ${schedules.lastStatus!} != 'running')`,
      sql`${schedules.leaseExpiresAt!} IS NULL`,
      lte(schedules.leaseExpiresAt!, d1CurrentEpochMilliseconds()),
    )!
    const selection: Record<string, unknown> = {
       id: schedules.id!, scope: schedules.scope!, jobType: schedules.jobType!, jobVersion: schedules.jobVersion!, tenantId: schedules.tenantId!,
      payload: schedules.payload!, cronExpression: schedules.cronExpression!, timezone: schedules.timezone!,
      overlapPolicy: schedules.overlapPolicy!, misfirePolicy: schedules.misfirePolicy!, nextRunAt: schedules.nextRunAt!,
      lastRunAt: schedules.lastRunAt!, lastStatus: schedules.lastStatus!,
    }
    for (const key of ["paused", "effectiveFrom", "effectiveUntil", "remainingOccurrences", "calendarExclusionKey", "owner", "description"] as const) if (schedules[key]) selection[key] = schedules[key]
    const eligible = await this.db.select(selection).from(this.config.schedulesTable).where(and(eq(schedules.enabled!, true), lte(schedules.nextRunAt!, now), ...lifecycleConditions, notBackingOff, leaseFree))
      .orderBy(sql`${asc(schedules.nextRunAt!)}`).limit(args.limit).offset(0)
    const priorStatuses = new Map((eligible as Record<string, unknown>[]).map((row) => [row.id as string, row.lastStatus as string | null]))
    const claimed: Array<{ id: string; token: string }> = []
    for (const row of eligible as Record<string, unknown>[]) {
      const claimToken = uuidv7()
      const result = await this.db.update(this.config.schedulesTable).set({ lastStatus: "running", leaseOwner: args.workerId, leaseExpiresAt, claimToken }).where(and(
        eq(schedules.id!, row.id as string), eq(schedules.enabled!, true), lte(schedules.nextRunAt!, now), notBackingOff,
        // The read above is only a candidate scan. Ownership is won here by
        // the conditional update, which D1 serializes per database.
        leaseFree,
      ))
      if (getAffectedRows(result) > 0) claimed.push({ id: row.id as string, token: claimToken })
    }
    if (claimed.length === 0) return []
    const rows = await this.db.select().from(this.config.schedulesTable).where(and(
      or(...claimed.map(({ id, token }) => and(eq(schedules.id!, id), eq(schedules.claimToken!, token)))),
      eq(schedules.leaseOwner!, args.workerId), eq(schedules.lastStatus!, "running"), gt(schedules.leaseExpiresAt!, d1CurrentEpochMilliseconds()),
    )).limit(claimed.length)
    // The re-read has no defined order; hand the claims back oldest-due first, the order they were won in.
    const claimOrder = new Map(claimed.map(({ id }, index) => [id, index]))
    const resultClaims = [...(rows as Record<string, unknown>[])].sort((a, b) => claimOrder.get(a.id as string)! - claimOrder.get(b.id as string)!).map((row) => ({
      // Claiming marks the scheduler lease as running. Keep the execution state
      // observed before that write for overlapPolicy decisions.
      ...toScheduleClaim({ ...row, lastStatus: priorStatuses.get(row.id as string) ?? null }),
      claimToken: row.claimToken as string,
    }))
    const tenantIds = resultClaims.filter((claim) => claim.tenantId !== null).map((claim) => claim.tenantId as string)
    if (tenantIds.length > 0 && this.config.resolveTenantTimezones) {
      const tzMap = await this.config.resolveTenantTimezones(this.db, tenantIds, this.platformTimezone)
      for (const claim of resultClaims) {
        if (claim.tenantId && tzMap.has(claim.tenantId)) claim.timezone = tzMap.get(claim.tenantId)!
      }
    }
    for (const claim of resultClaims) {
      if (!claim.timezone) claim.timezone = this.platformTimezone
    }
    return resultClaims
  }

  async advanceSchedule(args: FencedAdvanceScheduleArgs): Promise<boolean> {
    if (!args.claimToken) return false
    const schedules = this.config.columnMap.schedules
    const values: Record<string, unknown> = { nextRunAt: args.nextRunAt, lastRunAt: args.lastRunAt, lastStatus: args.lastStatus, lastError: args.lastError ?? null, leaseOwner: null, leaseExpiresAt: null, claimToken: null }
    const consumed = scheduleOccurrencesConsumed(args)
    if (schedules.remainingOccurrences && consumed > 0) values.remainingOccurrences = sql`CASE WHEN ${schedules.remainingOccurrences} IS NULL THEN NULL ELSE MAX(${schedules.remainingOccurrences} - ${consumed}, 0) END`
    // Failure backoff: no owner or token, so the row is unleased, but it is not claimable before retryAt.
    if (args.lastStatus === "failed" && args.retryAt) values.leaseExpiresAt = d1ColumnInputValue(schedules.leaseExpiresAt!, args.retryAt)
    const result = await this.db.update(this.config.schedulesTable).set(values).where(and(eq(schedules.id!, args.scheduleId), eq(schedules.leaseOwner!, args.workerId), eq(schedules.claimToken!, args.claimToken), eq(schedules.lastStatus!, "running"), gt(schedules.leaseExpiresAt!, d1CurrentEpochMilliseconds())))
    return getAffectedRows(result) > 0
  }

  async renewScheduleLease(args: RenewScheduleLeaseArgs): Promise<boolean> {
    assertDurableIdentifier(args.workerId, "workerId", 100)
    const schedules = this.config.columnMap.schedules
    // Only a positive extension is meaningful. The absolute expiry is computed
    // on the database clock so writes never mix app and DB time, and a renewal
    // moves the expiry forward only: a smaller extension never shortens a lease.
    if (!Number.isFinite(args.extendByMs) || args.extendByMs <= 0) return false
    const leaseExpiresAt = d1EpochMillisecondsAfter(args.extendByMs)
    const result = await this.db.update(this.config.schedulesTable).set({ leaseExpiresAt: sql`MAX(${schedules.leaseExpiresAt!}, ${leaseExpiresAt})` }).where(and(
      eq(schedules.id!, args.scheduleId), eq(schedules.leaseOwner!, args.workerId), eq(schedules.claimToken!, args.claimToken),
      eq(schedules.lastStatus!, "running"), gt(schedules.leaseExpiresAt!, d1CurrentEpochMilliseconds()),
    ))
    return getAffectedRows(result) > 0
  }

  async releaseSchedule(args: FencedReleaseScheduleArgs): Promise<boolean> {
    if (!args.claimToken) return false
    const schedules = this.config.columnMap.schedules
    const result = await this.db.update(this.config.schedulesTable).set({ lastStatus: "idle", leaseOwner: null, leaseExpiresAt: null, claimToken: null }).where(and(eq(schedules.id!, args.scheduleId), eq(schedules.leaseOwner!, args.workerId), eq(schedules.claimToken!, args.claimToken), eq(schedules.lastStatus!, "running"), gt(schedules.leaseExpiresAt!, d1CurrentEpochMilliseconds())))
    return getAffectedRows(result) > 0
  }
}

export function createDrizzleScheduleStore(db: DrizzleSessionLike, config: DrizzleScheduleStoreConfig, platformTimezone?: string): DrizzleScheduleStore {
  return new DrizzleScheduleStore(db, config, platformTimezone)
}
