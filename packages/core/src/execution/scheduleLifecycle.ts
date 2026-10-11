import { ConfigurationError } from "../domain"
export interface ScheduleLifecycle { readonly paused: boolean; readonly effectiveFrom?: string; readonly effectiveUntil?: string; readonly remainingOccurrences?: number; readonly calendarExclusionKey?: string; readonly owner?: string; readonly description?: string }

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2})))?$/
/**
 * Strict ISO-8601 instant: a calendar date (UTC midnight) or a date-time with an explicit `Z`/offset.
 * `Date.parse` alone also accepts free text ("foo 5", "1"), rolls impossible dates over ("2026-02-30")
 * and reads zone-less date-times in the host's time zone, so it cannot be the validator.
 */
function parseIsoInstant(text: unknown): number {
  if (typeof text !== "string") return Number.NaN
  const match = ISO_INSTANT.exec(text)
  if (!match) return Number.NaN
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const monthEnd = new Date(0)
  monthEnd.setUTCFullYear(year, month, 0)
  const daysInMonth = monthEnd.getUTCDate()
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return Number.NaN
  if (match[4] !== undefined && (Number(match[4]) > 23 || Number(match[5]) > 59 || (match[6] !== undefined && Number(match[6]) > 59))) return Number.NaN
  if (match[8] !== undefined && (Number(match[8]) > 23 || Number(match[9]) > 59)) return Number.NaN
  return Date.parse(text)
}
export function compileScheduleLifecycle(input: Partial<ScheduleLifecycle> = {}): ScheduleLifecycle {
  const from = input.effectiveFrom === undefined ? undefined : parseIsoInstant(input.effectiveFrom); const until = input.effectiveUntil === undefined ? undefined : parseIsoInstant(input.effectiveUntil)
  if (from !== undefined && !Number.isFinite(from)) throw new ConfigurationError("effectiveFrom must be an ISO timestamp")
  if (until !== undefined && !Number.isFinite(until)) throw new ConfigurationError("effectiveUntil must be an ISO timestamp")
  if (from !== undefined && until !== undefined && from >= until) throw new ConfigurationError("Schedule effective range is empty")
  if (input.remainingOccurrences !== undefined && (!Number.isSafeInteger(input.remainingOccurrences) || input.remainingOccurrences < 0)) throw new ConfigurationError("remainingOccurrences must be a non-negative integer")
  return Object.freeze({ ...input, paused: input.paused ?? false })
}
export function isScheduleEffective(lifecycle: ScheduleLifecycle, now: Date): boolean { const t = now.getTime(); return !lifecycle.paused && (lifecycle.remainingOccurrences === undefined || lifecycle.remainingOccurrences > 0) && (lifecycle.effectiveFrom === undefined || t >= Date.parse(lifecycle.effectiveFrom)) && (lifecycle.effectiveUntil === undefined || t < Date.parse(lifecycle.effectiveUntil)) }
