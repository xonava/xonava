import { emitTelemetry, explicitlySafeTelemetryAttributes, type TelemetryPort } from "../telemetry/telemetry"
import type { ExecutionClock, FencedExternalEffect, JobExecutionContext, JobDefinition, JobExecutionScope } from "./types"

export type { ExecutionClock, FencedExternalEffect, JobExecutionContext }

export interface ExecutionContextFactory {
  fromJob(args: {
    job: { id: string; jobType: string; jobVersion: number; tenantId: string | null; correlationId: string | null; attempt: number; metadata: Record<string, unknown> }
    jobDef: JobDefinition
    now: Date
    signal?: AbortSignal
    clock?: ExecutionClock
  }): JobExecutionContext
}

export function createExecutionContext(args: {
  executionId?: string
  jobId: string
  jobType: string
  jobVersion: number
  attempt: number
  tenantId: string | null
  executionScope: JobExecutionScope
  correlationId: string
  startedAt: Date
  telemetry?: TelemetryPort
  signal?: AbortSignal
  deadline?: number
  metadata?: Record<string, unknown>
  clock?: ExecutionClock
  /** Lease assertion provided by the dispatcher; executed before every fenced effect. */
  assertLease: () => Promise<void>
}): JobExecutionContext {
  const report = (name: string, severity: "warn" | "error" | "debug"): void => {
    if (!args.telemetry) return
    emitTelemetry(args.telemetry, {
      name,
      severity,
      timestamp: new Date(),
      attributes: explicitlySafeTelemetryAttributes({ component: "execution" }),
    })
  }
  /**
   * Framework-owned external effect API. Validates the current lease before
   * executing the effect. This is a lease fence, not an exactly-once guarantee.
   */
  const fencedEffect: FencedExternalEffect = {
    async execute<T>(effect: { effectName: string; idempotencyKey: string; fn: () => Promise<T> }): Promise<T> {
      try {
        await args.assertLease()
      } catch (leaseError) {
        report("execution.fenced_effect.lease_lost", "warn")
        throw leaseError
      }
      report("execution.fenced_effect.started", "debug")
      try {
        const result = await effect.fn()
        report("execution.fenced_effect.succeeded", "debug")
        return result
      } catch (effectError) {
        report("execution.fenced_effect.failed", "error")
        throw effectError
      }
    },
  }
  const context: JobExecutionContext = {
    executionId: args.executionId ?? crypto.randomUUID(),
    jobId: args.jobId,
    jobType: args.jobType,
    jobVersion: args.jobVersion,
    attempt: args.attempt,
    tenantId: args.tenantId,
    executionScope: args.executionScope,
    correlationId: args.correlationId,
    startedAt: args.startedAt,
    ...(args.telemetry ? { telemetry: args.telemetry } : {}),
    metadata: args.metadata ?? {},
    fencedEffect,
  }

  if (args.signal !== undefined) context.signal = args.signal
  if (args.deadline !== undefined) context.deadline = args.deadline
  if (args.clock !== undefined) context.clock = args.clock

  return context
}
