import type {
  ScheduleClaim,
  ClaimDueSchedulesArgs,
  AdvanceScheduleArgs,
  ReleaseScheduleArgs,
} from "./types"

/** An opaque value that changes for every successful schedule claim. */
export type ScheduleClaimToken = string

export type FencedScheduleClaim = ScheduleClaim & {
  /** Fresh opaque token returned by the store that owns the schedule lease. */
  claimToken: ScheduleClaimToken
}

export type RenewScheduleLeaseArgs = {
  scheduleId: string
  workerId: string
  claimToken: ScheduleClaimToken
  now: Date
  extendByMs: number
}

export type FencedAdvanceScheduleArgs = AdvanceScheduleArgs & {
  claimToken: ScheduleClaimToken
}

export type FencedReleaseScheduleArgs = ReleaseScheduleArgs & {
  claimToken: ScheduleClaimToken
}

export interface ScheduleStore {
  /** Atomically claims due schedules; each returned claim carries a fresh opaque claimToken fencing the lease. */
  claimDueSchedules(args: ClaimDueSchedulesArgs): Promise<FencedScheduleClaim[]>
  /** Advances the schedule only if the claimToken still fences the lease; returns false on lease loss. */
  advanceSchedule(args: FencedAdvanceScheduleArgs): Promise<boolean>
  /** Releases the lease without advancing; fenced by claimToken. */
  releaseSchedule(args: FencedReleaseScheduleArgs): Promise<boolean>
  /**
   * Atomically verifies the claimToken and extends its lease, returning false
   * on lease loss or token mismatch. The resulting expiry must move
   * monotonically forward: a delayed request with an older `now` must never
   * shorten the lease established by a newer request.
   */
  renewScheduleLease(args: RenewScheduleLeaseArgs): Promise<boolean>
}

/** Validates that a fenced claim token is present and durable (P1-08). */
export function assertFencedScheduleClaim(claimToken: string | null | undefined, scheduleId: string): asserts claimToken is string {
  if (!claimToken || typeof claimToken !== "string" || claimToken.trim().length === 0) {
    throw new Error(`Schedule ${scheduleId} has no claim token; lease was not fenced`)
  }
}
