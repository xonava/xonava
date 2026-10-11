import { ConfigurationError } from "../domain"
import type { SequenceAllocation, SequenceAllocationRequest, SequenceDefinition, SequenceResetPeriod, SequenceStore } from "./types"

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const PREFIX = /^[A-Za-z0-9._/: -]{0,64}$/
const periods: readonly SequenceResetPeriod[] = ["never", "year", "month", "day"]

const SEPARATOR = /^[A-Za-z0-9._/: -]{0,4}$/

type ValidatedSequenceDefinition = Readonly<Required<Pick<SequenceDefinition, "name" | "padding" | "reset" | "timeZone" | "periodFormat" | "periodSeparator">> & Pick<SequenceDefinition, "prefix">>

const formatters = new Map<string, Intl.DateTimeFormat>()
const MAX_CACHED_TIME_ZONES = 64

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    try {
      // The era is requested so a year before 1 CE (which Intl reports as an era year, e.g. 44 BC -> "44") is never aliased onto the CE year.
      formatter = new Intl.DateTimeFormat("en-US", { timeZone, era: "short", year: "numeric", month: "2-digit", day: "2-digit", hourCycle: "h23" })
    } catch {
      throw new ConfigurationError("Sequence time zone is invalid")
    }
    // Bounded cache: time zones come from definitions, but never trust that blindly.
    if (formatters.size >= MAX_CACHED_TIME_ZONES) formatters.delete(formatters.keys().next().value!)
    formatters.set(timeZone, formatter)
  }
  return formatter
}

export function validateSequenceDefinition(value: SequenceDefinition): ValidatedSequenceDefinition {
  if (!value || typeof value.name !== "string" || !KEY.test(value.name)) throw new ConfigurationError("Sequence name is invalid")
  const padding = value.padding ?? 0, reset = value.reset ?? "never"
  if (!Number.isSafeInteger(padding) || padding < 0 || padding > 32) throw new ConfigurationError("Sequence padding must be an integer from 0 to 32")
  if (!periods.includes(reset)) throw new ConfigurationError("Sequence reset period is invalid")
  // RegExp#test coerces its argument, so a non-string (an array, null, a number) must be rejected before matching.
  if (value.prefix !== undefined && (typeof value.prefix !== "string" || !PREFIX.test(value.prefix))) throw new ConfigurationError("Sequence prefix is invalid")
  const timeZone = value.timeZone ?? "UTC"
  if (typeof timeZone !== "string" || timeZone.length > 64) throw new ConfigurationError("Sequence time zone is invalid")
  zonedFormatter(timeZone)
  // A resetting counter restarts at 1 each period, so its formatted values repeat unless they carry the period.
  // The format is never defaulted for such a counter: a silent default would either repeat identifiers or change
  // an existing series' format on upgrade. `"none"` is an explicit choice (the period is shown elsewhere).
  if (reset !== "never" && value.periodFormat === undefined)
    throw new ConfigurationError("A resetting sequence must declare periodFormat; use \"compact\" or \"iso\" to keep formatted values unique, or \"none\" if the period is carried elsewhere")
  const periodFormat = value.periodFormat ?? "none"
  if (!["none", "compact", "iso"].includes(periodFormat)) throw new ConfigurationError("Sequence period format is invalid")
  if (periodFormat !== "none" && reset === "never") throw new ConfigurationError("A sequence without a reset period has no period to embed")
  const periodSeparator = value.periodSeparator ?? "-"
  if (typeof periodSeparator !== "string" || !SEPARATOR.test(periodSeparator)) throw new ConfigurationError("Sequence period separator is invalid")
  return Object.freeze({ name: value.name, padding, reset, timeZone, periodFormat, periodSeparator, ...(value.prefix === undefined ? {} : { prefix: value.prefix }) })
}

/** The reset period containing `at`, evaluated in `timeZone` (default UTC). */
export function sequencePeriod(reset: SequenceResetPeriod, at: Date, timeZone = "UTC"): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new ConfigurationError("Sequence allocation time is invalid")
  if (reset === "never") return "all"
  const parts = Object.fromEntries(zonedFormatter(timeZone).formatToParts(at).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]))
  if (parts.era !== "AD") throw new ConfigurationError("Sequence allocation time is invalid")
  const year = String(parts.year).padStart(4, "0")
  if (reset === "year") return year
  if (reset === "month") return `${year}-${parts.month}`
  return `${year}-${parts.month}-${parts.day}`
}

export async function allocateSequence(store: SequenceStore, request: SequenceAllocationRequest, now: () => Date = () => new Date()): Promise<SequenceAllocation> {
  if (!request || typeof request.scopeId !== "string" || !request.scopeId || request.scopeId.length > 1024 || /[\0\r\n]/.test(request.scopeId)) throw new ConfigurationError("Sequence scope is invalid")
  const definition = validateSequenceDefinition(request.definition)
  const period = sequencePeriod(definition.reset, request.at ?? now(), definition.timeZone)
  const value = await store.next(request.scopeId, definition.name, period)
  if (!Number.isSafeInteger(value) || value < 1) throw new ConfigurationError("Sequence store returned an invalid value")
  const periodToken = definition.periodFormat === "none" ? "" : `${definition.periodFormat === "compact" ? period.replaceAll("-", "") : period}${definition.periodSeparator}`
  const formatted = `${definition.prefix ?? ""}${periodToken}${String(value).padStart(definition.padding, "0")}`
  return Object.freeze({ scopeId: request.scopeId, name: definition.name, period, value, formatted })
}
