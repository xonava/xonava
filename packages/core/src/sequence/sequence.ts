import { ConfigurationError } from "../domain"
import type { SequenceAllocation, SequenceAllocationRequest, SequenceDefinition, SequenceResetPeriod, SequenceStore } from "./types"

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const PREFIX = /^[A-Za-z0-9._/: -]{0,64}$/
const periods: readonly SequenceResetPeriod[] = ["never", "year", "month", "day"]

export function validateSequenceDefinition(value: SequenceDefinition): Readonly<Required<Pick<SequenceDefinition, "name" | "padding" | "reset">> & Pick<SequenceDefinition, "prefix">> {
  if (!value || !KEY.test(value.name)) throw new ConfigurationError("Sequence name is invalid")
  const padding = value.padding ?? 0, reset = value.reset ?? "never"
  if (!Number.isSafeInteger(padding) || padding < 0 || padding > 32) throw new ConfigurationError("Sequence padding must be an integer from 0 to 32")
  if (!periods.includes(reset)) throw new ConfigurationError("Sequence reset period is invalid")
  if (value.prefix !== undefined && !PREFIX.test(value.prefix)) throw new ConfigurationError("Sequence prefix is invalid")
  return Object.freeze({ name: value.name, padding, reset, ...(value.prefix === undefined ? {} : { prefix: value.prefix }) })
}

export function sequencePeriod(reset: SequenceResetPeriod, at: Date): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new ConfigurationError("Sequence allocation time is invalid")
  const year = String(at.getUTCFullYear()).padStart(4, "0")
  if (reset === "never") return "all"
  if (reset === "year") return year
  const month = String(at.getUTCMonth() + 1).padStart(2, "0")
  if (reset === "month") return `${year}-${month}`
  return `${year}-${month}-${String(at.getUTCDate()).padStart(2, "0")}`
}

export async function allocateSequence(store: SequenceStore, request: SequenceAllocationRequest): Promise<SequenceAllocation> {
  if (!request || typeof request.scopeId !== "string" || !request.scopeId || request.scopeId.length > 1024 || /[\0\r\n]/.test(request.scopeId)) throw new ConfigurationError("Sequence scope is invalid")
  const definition = validateSequenceDefinition(request.definition), period = sequencePeriod(definition.reset, request.at ?? new Date())
  const value = await store.next(request.scopeId, definition.name, period)
  if (!Number.isSafeInteger(value) || value < 1) throw new ConfigurationError("Sequence store returned an invalid value")
  const formatted = `${definition.prefix ?? ""}${String(value).padStart(definition.padding, "0")}`
  return Object.freeze({ scopeId: request.scopeId, name: definition.name, period, value, formatted })
}
