import type { PredicatePrimitive } from "./predicate"
import { parseRfc3339Timestamp } from "./evaluatePredicate"

export type AbacFieldType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "identifier"
  | "string-array"

export class PolicyValidationError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message)
    this.name = "PolicyValidationError"
  }
}

export function coercePolicyValue(args: {
  type: AbacFieldType
  value: unknown
}): PredicatePrimitive {
  switch (args.type) {
    case "number": {
      // Only finite numbers or numeric strings; never Number(null|""|true|[]).
      if (args.value === null) return null
      const num = typeof args.value === "number" ? args.value
        : typeof args.value === "string" && args.value.trim() !== "" ? Number(args.value)
          : Number.NaN
      if (!Number.isFinite(num)) {
        throw new PolicyValidationError(`Invalid number value: ${String(args.value)}`, { value: args.value })
      }
      return num
    }

    case "boolean": {
      if (args.value === true || args.value === false) return args.value
      if (args.value === "true") return true
      if (args.value === "false") return false
      throw new PolicyValidationError(`Invalid boolean value: ${String(args.value)}`, { value: args.value })
    }

    case "date":
    case "datetime": {
      if (args.value instanceof Date) {
        if (Number.isNaN(args.value.getTime())) throw new PolicyValidationError(`Invalid date value: ${String(args.value)}`)
        return new Date(args.value.getTime())
      }
      if (typeof args.value === "string") {
        // Strict RFC 3339 only: a date is a real calendar YYYY-MM-DD and a
        // datetime must carry an offset, so no literal depends on host-local
        // time or lenient host parsing.
        const isDate = args.value.length === 10
        const time = isDate === (args.type === "date") ? parseRfc3339Timestamp(args.value) : null
        if (time === null) throw new PolicyValidationError(`Invalid ${args.type} value: ${args.value}`)
        return new Date(time)
      }
      throw new PolicyValidationError(`Invalid date value: ${String(args.value)}`)
    }

    case "string-array":
      throw new PolicyValidationError(
        "string-array values must be provided through a list operator (in, includesAny, includesAll)"
      )

    case "identifier":
    case "string":
    default: {
      if (args.value === null) return null
      if (typeof args.value === "string") return args.value
      if ((typeof args.value === "number" && Number.isFinite(args.value)) || typeof args.value === "boolean") return String(args.value)
      throw new PolicyValidationError(`Invalid ${args.type} value of type ${typeof args.value}`, { value: args.value })
    }
  }
}

export function coercePolicyValueList(args: {
  type: AbacFieldType
  values: unknown[]
}): { success: true; values: PredicatePrimitive[] } | { success: false; errors: PolicyValidationError[] } {
  if (args.type === "string-array") {
    const result: string[] = []
    for (let i = 0; i < args.values.length; i++) {
      if (typeof args.values[i] !== "string") {
        return { success: false, errors: [new PolicyValidationError(`Expected string, got ${typeof args.values[i]}`)] }
      }
      result.push(args.values[i] as string)
    }
    return { success: true, values: result }
  }

  const errors: PolicyValidationError[] = []
  const result: PredicatePrimitive[] = []
  for (let i = 0; i < args.values.length; i++) {
    try {
      result.push(coercePolicyValue({ type: args.type, value: args.values[i] }))
    } catch (original) {
      const err = original instanceof Error ? original : new Error(String(original))
      errors.push(new PolicyValidationError(
        err.message,
        { index: i, value: args.values[i], cause: (original as PolicyValidationError).details },
      ))
    }
  }
  if (errors.length > 0) return { success: false, errors }
  return { success: true, values: result }
}
