import { ConfigurationError } from "../domain"
import { parseIsoInstant } from "../kernel/isoInstant"
export interface ScheduleLifecycle { readonly paused: boolean; readonly effectiveFrom?: string; readonly effectiveUntil?: string; readonly remainingOccurrences?: number; readonly calendarExclusionKey?: string; readonly owner?: string; readonly description?: string }

export function compileScheduleLifecycle(input: Partial<ScheduleLifecycle> = {}): ScheduleLifecycle {
  const from = input.effectiveFrom === undefined ? undefined : parseIsoInstant(input.effectiveFrom); const until = input.effectiveUntil === undefined ? undefined : parseIsoInstant(input.effectiveUntil)
  if (from !== undefined && !Number.isFinite(from)) throw new ConfigurationError("effectiveFrom must be an ISO timestamp")
  if (until !== undefined && !Number.isFinite(until)) throw new ConfigurationError("effectiveUntil must be an ISO timestamp")
  if (from !== undefined && until !== undefined && from >= until) throw new ConfigurationError("Schedule effective range is empty")
  if (input.remainingOccurrences !== undefined && (!Number.isSafeInteger(input.remainingOccurrences) || input.remainingOccurrences < 0)) throw new ConfigurationError("remainingOccurrences must be a non-negative integer")
  return Object.freeze({ ...input, paused: input.paused ?? false })
}
export function isScheduleEffective(lifecycle: ScheduleLifecycle, now: Date): boolean { const t = now.getTime(); return !lifecycle.paused && (lifecycle.remainingOccurrences === undefined || lifecycle.remainingOccurrences > 0) && (lifecycle.effectiveFrom === undefined || t >= Date.parse(lifecycle.effectiveFrom)) && (lifecycle.effectiveUntil === undefined || t < Date.parse(lifecycle.effectiveUntil)) }
