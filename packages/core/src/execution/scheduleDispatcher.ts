import type { JobStore, NewJob, CronTimezoneAdapter, JobRequester, JobStatus, PriorScheduleExecutionStatus } from "./types"
import { scheduleCorrelationId } from "./types"
import type { FencedScheduleClaim, ScheduleStore } from "./scheduleStore"
import { computeScheduleOccurrences, shouldFireSchedule, calculateNextRun } from "./scheduleCalculator"
import { ValidationError } from "../domain"
import { isScheduleEffective } from "./scheduleLifecycle"
import { createNoopTelemetry, emitTelemetry, explicitlySafeTelemetryAttributes, type TelemetryPort } from "../telemetry/telemetry"

export interface MaterializeResult {
  schedulesProcessed: number
  jobsEnqueued: number
  errors: string[]
}

/** Keep persisted schedule payloads within the same durable admission budget as jobs. */
export const MAX_STORED_SCHEDULE_PAYLOAD_BYTES = 1024 * 1024

class ScheduleLeaseLostError extends Error {
  constructor(scheduleId: string) {
    super(`Schedule ${scheduleId} lease was lost.`)
    this.name = "ScheduleLeaseLostError"
  }
}

export async function materializeDueSchedules(args: {
  scheduleStore: ScheduleStore
  jobStore: JobStore
  workerId: string
  limit?: number
  maxQueueAllOccurrences?: number
  now?: Date
  tzAdapter?: CronTimezoneAdapter
  telemetry?: TelemetryPort
  leaseDurationMs?: number
  decodePayload?: (input: unknown) => Record<string, unknown>
  calendarExclusionProvider?: { isExcluded(key: string, instant: Date): Promise<boolean> }
}): Promise<MaterializeResult> {
  const result: MaterializeResult = { schedulesProcessed: 0, jobsEnqueued: 0, errors: [] }
  const telemetry = args.telemetry ?? createNoopTelemetry()
  const log = {
    info: (message: string, _data?: Record<string, unknown>) => emitTelemetry(telemetry, { name: "execution.schedule", severity: "info", timestamp: new Date(), attributes: explicitlySafeTelemetryAttributes({ message }) }),
    error: (message: string, _data?: Record<string, unknown>) => emitTelemetry(telemetry, { name: "execution.schedule", severity: "error", timestamp: new Date(), attributes: explicitlySafeTelemetryAttributes({ message }) }),
  }
  const now = args.now ?? new Date()
  const leaseDurationMs = args.leaseDurationMs ?? 30_000
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) throw new ValidationError("Schedule lease duration must be finite and positive.")

  const claims = await args.scheduleStore.claimDueSchedules({
    workerId: args.workerId,
    limit: args.limit ?? 20,
    now,
    leaseDurationMs,
  })
  log.info("Schedules claimed", { workerId: args.workerId, claimed: claims.length, leaseDurationMs })

  for (const claim of claims) {
    let renewal: LeaseRenewal | undefined
    try {
      renewal = startLeaseRenewal({
        scheduleStore: args.scheduleStore,
        claim,
        claimToken: claim.claimToken,
        workerId: args.workerId,
        leaseDurationMs,
      })
      const lifecycleExcluded = claim.lifecycle !== undefined && !isScheduleEffective(claim.lifecycle, now)
      const calendarExcluded = claim.lifecycle?.calendarExclusionKey !== undefined && await args.calendarExclusionProvider?.isExcluded(claim.lifecycle.calendarExclusionKey, claim.nextRunAt) === true
      if (lifecycleExcluded || calendarExcluded) {
        await advanceSchedule(args.scheduleStore, { scheduleId: claim.scheduleId, workerId: args.workerId, claimToken: claim.claimToken, nextRunAt: calculateNextRun(claim.cronExpression, now, claim.timezone, args.tzAdapter), lastRunAt: now, lastStatus: "skipped" })
        result.schedulesProcessed += 1
        continue
      }
      const scheduleTz = claim.timezone
      let requester: JobRequester
      if (claim.executionScope.kind === "tenant") {
        requester = { scope: "tenant", tenantId: claim.executionScope.tenantId, actorId: "system" }
      } else if (claim.executionScope.kind === "platform") {
        requester = { scope: "platform", actorId: "scheduler" }
      } else {
        requester = { scope: "system" }
      }

      const queueAllLimit = args.maxQueueAllOccurrences ?? 50
      if (claim.misfirePolicy.type === "queue_all" && (!Number.isInteger(queueAllLimit) || queueAllLimit <= 0)) {
        throw new ValidationError("maxQueueAllOccurrences must be a positive integer")
      }

      const groupPriorExecutionStatus = await getPriorExecutionStatus({
        jobStore: args.jobStore,
        scheduleId: claim.scheduleId,
         // The missed schedule slot, not wall-clock time, is the occurrence identity.
         // This keeps fire_now idempotent after a crash and reclaim.
         currentOccurrence: claim.nextRunAt,
        requester,
      })
      const decision = shouldFireSchedule({
        schedule: {
          cronExpression: claim.cronExpression,
          timezone: scheduleTz,
          enabled: true,
          misfirePolicy: claim.misfirePolicy,
          overlapPolicy: claim.overlapPolicy,
          nextRunAt: claim.nextRunAt,
          lastRunAt: claim.lastRunAt,
          lastStatus: claim.lastStatus,
        },
        now,
        priorExecutionStatus: groupPriorExecutionStatus,
        ...(args.tzAdapter ? { tzAdapter: args.tzAdapter } : {}),
      })

      if (decision === "ignore" || decision === "skip") {
        await advanceSchedule(args.scheduleStore, {
          scheduleId: claim.scheduleId,
          workerId: args.workerId,
           claimToken: claim.claimToken,
          nextRunAt: calculateNextRun(claim.cronExpression, now, scheduleTz, args.tzAdapter),
          lastRunAt: now,
          lastStatus: "skipped",
        })
        result.schedulesProcessed++
        continue
      }

      const occurrences = claim.misfirePolicy.type === "fire_now"
        ? [claim.nextRunAt]
        : computeScheduleOccurrences({
            schedule: {
              cronExpression: claim.cronExpression,
              enabled: true,
              nextRunAt: claim.nextRunAt,
            },
            now,
            // Request one extra occurrence so a configured limit never discards work.
            maxCount: queueAllLimit + 1,
            timezone: scheduleTz,
            ...(args.tzAdapter ? { tzAdapter: args.tzAdapter } : {}),
          })

      if (claim.misfirePolicy.type === "queue_all" && occurrences.length > queueAllLimit) {
        throw new ValidationError(`Schedule ${claim.scheduleId} has more than ${queueAllLimit} missed occurrences`)
      }

      if (occurrences.length === 0) {
        await advanceSchedule(args.scheduleStore, {
          scheduleId: claim.scheduleId,
          workerId: args.workerId,
           claimToken: claim.claimToken,
          nextRunAt: calculateNextRun(claim.cronExpression, now, scheduleTz, args.tzAdapter),
          lastRunAt: now,
          lastStatus: "skipped",
        })
        result.schedulesProcessed++
        continue
      }

      const lastOccurrence = occurrences.at(-1)
      if (!lastOccurrence) {
        throw new ValidationError(`Schedule ${claim.scheduleId} produced no occurrence`)
      }
      // Overlap is evaluated per materialized occurrence: each occurrence is its
      // own identity, so the most recent prior job for THIS occurrence decides
      // whether a queue/skip overlap policy admits it.
      let lastJobStatus: PriorScheduleExecutionStatus | null = null
      for (const occurrence of occurrences) {
        const idempotencyKey = `schedule:${claim.scheduleId}:${occurrence.toISOString()}`

        // P1-08 fencing: validate lease before any idempotency check or durable
        // enqueue. This prevents a stale worker from enqueueing after lease loss.
        await renewal?.assertHeld()

        // A previous attempt may have committed the job before failing to
        // advance the schedule. Avoid submitting that occurrence again. The
        // JobStore must also enforce this key atomically for concurrent runs
        // and fingerprint-conflict detection (P1-08 idempotency).
        const existingJob = await args.jobStore.getByIdempotencyKey({
          key: idempotencyKey,
          requester,
        })
        // Re-fence after the read so a lease lost during the lookup is not
        // ignored before the durable enqueue.
        await renewal?.assertHeld()

        if (claim.misfirePolicy.type === "queue_all") {
          const occurrenceDecision = shouldFireSchedule({
            schedule: {
              cronExpression: claim.cronExpression,
              timezone: scheduleTz,
              enabled: true,
              misfirePolicy: claim.misfirePolicy,
              overlapPolicy: claim.overlapPolicy,
              nextRunAt: claim.nextRunAt,
              lastRunAt: claim.lastRunAt,
              lastStatus: claim.lastStatus,
            },
            now,
            priorExecutionStatus: lastJobStatus ?? groupPriorExecutionStatus,
            ...(args.tzAdapter ? { tzAdapter: args.tzAdapter } : {}),
          })
          if (occurrenceDecision === "skip") continue
        }

        if (existingJob) {
          lastJobStatus = jobStatusToPriorExecutionStatus(existingJob.status)
          continue
        }

        const job: NewJob = {
          executionScope: claim.executionScope,
          jobType: claim.jobType,
          jobVersion: claim.jobVersion,
          payload: decodeSchedulePayload(claim.payload, args.decodePayload),
           runAt: claim.misfirePolicy.type === "fire_now" ? now : occurrence,
          idempotencyKey,
          correlationId: scheduleCorrelationId(claim.scheduleId),
          // queue overlap serializes execution: at most one occurrence of this
          // schedule runs at a time because claimDue never admits a second job
          // of the same partition while one is running.
          ...(claim.overlapPolicy.type === "queue" ? { partitionKey: `schedule:${claim.scheduleId}` } : {}),
        }

        // P2-04 durability: enqueue is the durable side effect; JobStore must
        // atomically enforce idempotencyKey + fingerprint. Log before enqueue
        // for observability.
        log.info("Enqueueing schedule occurrence", { scheduleId: claim.scheduleId, occurrence: occurrence.toISOString(), idempotencyKey })
        await args.jobStore.enqueue({
          requester,
          job,
        })
        result.jobsEnqueued++
        lastJobStatus = "queued"
      }

      // P1-08 fencing: re-validate lease before final durable advance; prevents
      // a stale worker from advancing after lease expiry.
      await renewal?.assertHeld()
      const nextRun = calculateNextRun(
        claim.cronExpression,
        claim.misfirePolicy.type === "fire_now" ? now : lastOccurrence,
        scheduleTz,
        args.tzAdapter,
      )
      if (!nextRun) throw new ValidationError(`Schedule ${claim.scheduleId} has no future occurrence for its cron expression.`)
      await advanceSchedule(args.scheduleStore, {
        scheduleId: claim.scheduleId,
        workerId: args.workerId,
         claimToken: claim.claimToken,
        nextRunAt: nextRun,
        lastRunAt: now,
        lastStatus: "fired",
      })
      log.info("Schedule advanced", { scheduleId: claim.scheduleId, nextRunAt: nextRun.toISOString(), lastStatus: "fired", jobsEnqueuedForSchedule: occurrences.length })

      result.schedulesProcessed++
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const isLeaseLost = error instanceof ScheduleLeaseLostError
      log.error(`Failed to process schedule`, {
        scheduleId: claim.scheduleId,
        workerId: args.workerId,
        claimToken: claim.claimToken,
        error: msg,
        leaseLost: isLeaseLost,
      })

      // P2-04 observability: release lease on failure - don't advance past failed occurrence
      if (!isLeaseLost) {
        await args.scheduleStore.advanceSchedule({
          scheduleId: claim.scheduleId,
          workerId: args.workerId,
          claimToken: claim.claimToken,
          nextRunAt: claim.nextRunAt,
          lastRunAt: now,
          lastStatus: "failed",
        }).catch((bestEffortError) => {
          // P2-04: best-effort lease release failure must be observable
          log.error("Failed to mark schedule failed after processing error", {
            scheduleId: claim.scheduleId,
            workerId: args.workerId,
            claimToken: claim.claimToken,
            originalError: msg,
            bestEffortError: bestEffortError instanceof Error ? bestEffortError.message : String(bestEffortError),
          })
        })
      }

      result.errors.push(msg)
    } finally {
      renewal?.stop()
    }
  }

  log.info("Schedule materialization completed", {
    workerId: args.workerId,
    schedulesProcessed: result.schedulesProcessed,
    jobsEnqueued: result.jobsEnqueued,
    claimed: claims.length,
    errors: result.errors.length,
  })
  return result
}

async function getPriorExecutionStatus(args: {
  jobStore: JobStore
  scheduleId: string
  currentOccurrence: Date
  requester: JobRequester
}): Promise<PriorScheduleExecutionStatus | null> {
  // A dedicated store primitive answers "what ran before this occurrence".
  // The store resolves the latest prior job in SQL (run_at < beforeOccurrence
  // ORDER BY run_at DESC LIMIT 1) so an unbounded stream of newer correlation
  // jobs can never hide the true prior execution, unlike a top-N list fetch.
  const prior = await args.jobStore.getLatestPriorScheduleExecution({
    scheduleId: args.scheduleId,
    beforeOccurrence: args.currentOccurrence,
    requester: args.requester,
  })
  if (!prior) return null
  return jobStatusToPriorExecutionStatus(prior.status)
}

function jobStatusToPriorExecutionStatus(status: JobStatus): PriorScheduleExecutionStatus {
  switch (status) {
    case "pending":
    case "retrying": return "queued"
    case "running": return "running"
    case "succeeded": return "completed"
    case "failed":
    case "dead_letter": return "failed"
    case "cancelled": return "cancelled"
  }
}

async function advanceSchedule(
  scheduleStore: ScheduleStore,
  args: Parameters<ScheduleStore["advanceSchedule"]>[0],
): Promise<void> {
  if (!await scheduleStore.advanceSchedule(args)) {
    throw new ScheduleLeaseLostError(args.scheduleId)
  }
}

interface LeaseRenewal {
  stop: () => void
  assertHeld: () => Promise<void>
}

function startLeaseRenewal(args: {
  scheduleStore: ScheduleStore
  claim: FencedScheduleClaim
  claimToken: string
  workerId: string
  leaseDurationMs: number
}): LeaseRenewal {
  let stopped = false
  let leaseLost = false
  const interval = setInterval(() => {
    void args.scheduleStore.renewScheduleLease({
      scheduleId: args.claim.scheduleId,
      workerId: args.workerId,
      claimToken: args.claimToken,
      now: new Date(),
      extendByMs: args.leaseDurationMs,
    }).then((renewed) => {
      if (!renewed) leaseLost = true
    }).catch(() => {
      leaseLost = true
    })
  }, Math.max(1, Math.floor(args.leaseDurationMs / 3)))

  return {
    assertHeld: async () => {
      if (leaseLost) throw new ScheduleLeaseLostError(args.claim.scheduleId)
      let renewed: boolean
      try {
        renewed = await args.scheduleStore.renewScheduleLease({
          scheduleId: args.claim.scheduleId,
          workerId: args.workerId,
          claimToken: args.claimToken,
          now: new Date(),
          extendByMs: args.leaseDurationMs,
        })
      } catch {
        // P1-08: any renewal throw is a fence failure; treat as lease lost
        // so the schedule is not incorrectly advanced past the occurrence.
        leaseLost = true
        throw new ScheduleLeaseLostError(args.claim.scheduleId)
      }
      if (!renewed) {
        leaseLost = true
        throw new ScheduleLeaseLostError(args.claim.scheduleId)
      }
    },
    stop: () => {
      if (stopped) return
      stopped = true
      clearInterval(interval)
    },
  }
}

function decodeSchedulePayload(payload: string, decoder?: (input: unknown) => Record<string, unknown>): Record<string, unknown> {
  if (typeof payload !== "string" || new TextEncoder().encode(payload).byteLength > MAX_STORED_SCHEDULE_PAYLOAD_BYTES) {
    throw new ValidationError(`Schedule payload exceeds the maximum of ${MAX_STORED_SCHEDULE_PAYLOAD_BYTES} bytes.`)
  }
  let parsed: unknown
  try {
    parsed = payload ? JSON.parse(payload) : {}
  } catch (error) {
    throw new ValidationError("Schedule payload is not valid JSON.", { cause: error })
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("Schedule payload must be a JSON object.")
  }
  return decoder ? decoder(parsed) : parsed as Record<string, unknown>
}
