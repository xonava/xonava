import type {
  CronDisambiguation,
  CronTimezoneAdapter,
  LocalDateTime,
  PriorScheduleExecutionStatus,
  ScheduleDefinition,
} from "./types"
import { ValidationError } from "../domain"

const MAX_ITERATIONS = 5256000

function parseField(field: string, min: number, max: number, normalize?: (value: number) => number): Set<number> {
  const values = new Set<number>()

  for (const part of field.split(",")) {
    const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/)
    if (!match) throw new Error(`Invalid cron field value: "${part}"`)

    const range = match[1] === "*"
      ? [min, max]
      : match[1]!.includes("-")
        ? match[1]!.split("-").map(Number)
        : match[2] === undefined
          ? [Number(match[1]), Number(match[1])]
          : [Number(match[1]), max]
    const start = Number(range[0])
    const end = range[1] === undefined ? start : Number(range[1])
    const step = match[2] === undefined ? 1 : Number(match[2])

    if (step <= 0 || !Number.isInteger(step)) throw new Error(`Cron step must be greater than zero: "${part}"`)
    if (start < min || end > max || start > end) throw new Error(`Cron range is outside ${min}-${max}: "${part}"`)

    for (let value = start; value <= end; value += step) values.add(normalize?.(value) ?? value)
  }

  return values
}

export interface ParsedCron {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  daysOfMonthWildcard: boolean
  months: Set<number>
  daysOfWeek: Set<number>
  daysOfWeekWildcard: boolean
}

export function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`Cron expression must have exactly 5 fields, got ${fields.length}: "${expression}"`)

  return {
    minutes: parseField(fields[0]!, 0, 59),
    hours: parseField(fields[1]!, 0, 23),
    daysOfMonth: parseField(fields[2]!, 1, 31),
    daysOfMonthWildcard: fields[2]!.split(",").some((part) => part.startsWith("*")),
    months: parseField(fields[3]!, 1, 12),
    daysOfWeek: parseField(fields[4]!, 0, 7, (value) => value === 7 ? 0 : value),
    daysOfWeekWildcard: fields[4]!.split(",").some((part) => part.startsWith("*")),
  }
}

function normalizeDayOfWeek(value: number): number {
  return value === 7 ? 0 : value
}

function dayMatches(local: LocalDateTime, cron: ParsedCron): boolean {
  if (!cron.months.has(local.month)) return false
  const domMatch = cron.daysOfMonth.has(local.day)
  const dowMatch = cron.daysOfWeek.has(normalizeDayOfWeek(local.dayOfWeek))
  // Vixie cron: a day field starting with "*" (including "*/n") is star-flagged; star-flagged
  // fields are still checked against their value set, and only when neither field is
  // star-flagged does the day-of-month OR day-of-week rule apply.
  if (cron.daysOfMonthWildcard || cron.daysOfWeekWildcard) return domMatch && dowMatch
  return domMatch || dowMatch
}

function matchesLocalCron(local: LocalDateTime, cron: ParsedCron): boolean {
  return dayMatches(local, cron) && cron.hours.has(local.hour) && cron.minutes.has(local.minute)
}

export function matchesCron(date: Date, cron: ParsedCron): boolean {
  return matchesLocalCron({
    year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
    hour: date.getHours(), minute: date.getMinutes(), dayOfWeek: date.getDay(),
  }, cron)
}

function localDateIsValid(local: LocalDateTime): boolean {
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day))
  return date.getUTCFullYear() === local.year && date.getUTCMonth() + 1 === local.month && date.getUTCDate() === local.day
}

function hasPossibleCalendarDate(cron: ParsedCron): boolean {
  // With OR semantics any restricted day-of-week occurs in every month.
  if (!cron.daysOfMonthWildcard && !cron.daysOfWeekWildcard && cron.daysOfWeek.size > 0) return true
  for (let year = 2000; year < 2400; year++) {
    for (const month of cron.months) {
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
      if ([...cron.daysOfMonth].some((day) => day <= days)) return true
    }
  }
  return false
}

function nextLocalMinute(local: LocalDateTime): LocalDateTime {
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute + 1))
  return {
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
    hour: date.getUTCHours(), minute: date.getUTCMinutes(), dayOfWeek: date.getUTCDay(),
  }
}

function nextLocalDay(local: LocalDateTime): LocalDateTime {
  const date = localDateIsValid(local)
    ? new Date(Date.UTC(local.year, local.month - 1, local.day + 1))
    : new Date(Date.UTC(local.year, local.month, 1))
  return {
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
    hour: 0, minute: 0, dayOfWeek: date.getUTCDay(),
  }
}

function nextLocalMonth(local: LocalDateTime, months: Set<number>): LocalDateTime {
  const sorted = [...months].sort((a, b) => a - b)
  const next = sorted.find((month) => month > local.month)
  const month = next ?? sorted[0]!
  const year = next === undefined && month <= local.month ? local.year + 1 : local.year
  return { year, month, day: 1, hour: 0, minute: 0, dayOfWeek: new Date(Date.UTC(year, month - 1, 1)).getUTCDay() }
}

function sameLocal(a: LocalDateTime, b: LocalDateTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute
}

function getOffset(date: Date, timezone: string, parts: (date: Date) => LocalDateTime): number {
  const local = parts(date)
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - date.getTime()
}

export function createIntlCronTimezoneAdapter(): CronTimezoneAdapter {
  function toLocalDateTimeParts(utcDate: Date, timezone: string): LocalDateTime {
    let formatter: Intl.DateTimeFormat
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
        weekday: "short", hourCycle: "h23",
      })
    } catch (error) {
      throw new ValidationError(`Invalid timezone: ${timezone}`, { timezone, cause: error })
    }
    const parts = Object.fromEntries(formatter.formatToParts(utcDate).map((part) => [part.type, part.value]))
    const dayOfWeek = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[parts.weekday?.toLowerCase().slice(0, 3) ?? ""] ?? 0
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), dayOfWeek }
  }

  function localToUtc(local: LocalDateTime, timezone: string, disambiguation: CronDisambiguation = "skip"): Date {
    const localMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)
    const offsets = new Set<number>()
    for (const delta of [-2, -1, 0, 1, 2]) offsets.add(getOffset(new Date(localMs + delta * 86400000), timezone, (date) => toLocalDateTimeParts(date, timezone)))

    const candidates = [...offsets]
      .map((offset) => new Date(localMs - offset))
      .filter((date) => sameLocal(toLocalDateTimeParts(date, timezone), local))
      .sort((a, b) => a.getTime() - b.getTime())

    if (candidates.length === 0) {
      if (disambiguation === "reject") throw new Error(`Local time does not exist in ${timezone}`)
      return new Date(Number.NaN)
    }
    if (candidates.length > 1 && disambiguation === "reject") throw new Error(`Local time is ambiguous in ${timezone}`)
    return disambiguation === "later" ? candidates[candidates.length - 1]! : candidates[0]!
  }

  return { toLocalDateTimeParts, localToUtc }
}

function createUtcCronTimezoneAdapter(): CronTimezoneAdapter {
  const toLocalDateTimeParts = (date: Date): LocalDateTime => ({
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
    hour: date.getUTCHours(), minute: date.getUTCMinutes(), dayOfWeek: date.getUTCDay(),
  })
  return {
    toLocalDateTimeParts,
    localToUtc: (local) => new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)),
  }
}

function getNextLocalOccurrence(
  cron: ParsedCron,
  afterUtc: Date,
  timezone: string,
  adapter: CronTimezoneAdapter,
  disambiguation: CronDisambiguation,
): Date | null {
  if (!hasPossibleCalendarDate(cron)) return null
  let local = nextLocalMinute(adapter.toLocalDateTimeParts(afterUtc, timezone))
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (!localDateIsValid(local)) {
      local = nextLocalDay(local)
      continue
    }
    if (!cron.months.has(local.month)) {
      local = nextLocalMonth(local, cron.months)
      continue
    }
    if (!dayMatches(local, cron)) {
      local = nextLocalDay(local)
      continue
    }
    if (!cron.hours.has(local.hour)) {
      const nextHour = [...cron.hours].sort((a, b) => a - b).find((hour) => hour > local.hour)
      local = nextHour === undefined ? nextLocalDay(local) : { ...local, hour: nextHour, minute: 0 }
      continue
    }
    if (!cron.minutes.has(local.minute)) {
      const nextMinute = [...cron.minutes].sort((a, b) => a - b).find((minute) => minute > local.minute)
      local = nextMinute === undefined ? nextLocalMinute({ ...local, minute: 59 }) : { ...local, minute: nextMinute }
      continue
    }
    if (matchesLocalCron(local, cron)) {
      const candidate = adapter.localToUtc(local, timezone, disambiguation)
      if (candidate && candidate > afterUtc && sameLocal(adapter.toLocalDateTimeParts(candidate, timezone), local)) return candidate
    }
    local = nextLocalMinute(local)
  }
  return null
}

export interface ScheduleCalculationOptions {
  disambiguation?: CronDisambiguation
}

export function getNextOccurrence(
  expression: string,
  after: Date,
  timezone?: string,
  tzAdapter?: CronTimezoneAdapter,
  options: ScheduleCalculationOptions = {},
): Date | null {
  const cron = parseCronExpression(expression)
  const adapter = tzAdapter ?? (timezone === undefined ? createUtcCronTimezoneAdapter() : createIntlCronTimezoneAdapter())
  const zone = timezone ?? "UTC"
  return getNextLocalOccurrence(cron, after, zone, adapter, options.disambiguation ?? "skip")
}

export function shouldFireSchedule(args: {
  schedule: Pick<ScheduleDefinition, "cronExpression" | "timezone" | "enabled" | "misfirePolicy" | "overlapPolicy" | "nextRunAt" | "lastRunAt" | "lastStatus">
  now: Date
  priorExecutionStatus?: PriorScheduleExecutionStatus | null
  tzAdapter?: CronTimezoneAdapter
}): "fire" | "skip" | "queue" | "ignore" {
  if (!args.schedule.enabled || !args.schedule.nextRunAt || args.now < args.schedule.nextRunAt) return "ignore"
  if ((args.now.getTime() - args.schedule.nextRunAt.getTime()) / 60000 > 60 && args.schedule.misfirePolicy.type === "skip") return "skip"
  switch (args.schedule.overlapPolicy.type) {
    case "skip":
      if (args.priorExecutionStatus === "queued" || args.priorExecutionStatus === "running" ||
        (args.priorExecutionStatus == null && args.schedule.lastStatus === "running")) return "skip"
      return "fire"
    case "queue":
      return "queue"
    case "allow":
      return "fire"
  }
  return "fire"
}

export function computeScheduleOccurrences(args: {
  schedule: Pick<ScheduleDefinition, "cronExpression" | "enabled" | "nextRunAt">
  now: Date
  maxCount: number
  timezone?: string
  tzAdapter?: CronTimezoneAdapter
  disambiguation?: CronDisambiguation
}): Date[] {
  if (!args.schedule.enabled || !args.schedule.nextRunAt || args.maxCount <= 0) return []
  const results: Date[] = []
  let current = args.schedule.nextRunAt
  if (current <= args.now) results.push(current)
  while (results.length < args.maxCount) {
    const next = getNextOccurrence(
      args.schedule.cronExpression,
      current,
      args.timezone,
      args.tzAdapter,
      args.disambiguation === undefined ? {} : { disambiguation: args.disambiguation },
    )
    if (!next || next > args.now) break
    results.push(next)
    current = next
  }
  return results
}

export function calculateNextRun(
  expression: string,
  after: Date,
  timezone?: string,
  tzAdapter?: CronTimezoneAdapter,
  options?: ScheduleCalculationOptions,
): Date | null {
  return getNextOccurrence(expression, after, timezone, tzAdapter, options)
}

// Invalid month days (for example February 30 or February 29 in a non-leap year) follow cron's skip policy.
