import type { PredicatePrimitive } from "./predicate"

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
      if (typeof args.value === "number") return args.value
      const num = Number(args.value)
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
        if (args.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(args.value)) {
          throw new PolicyValidationError(`Invalid date value: ${args.value}`)
        }
        const parsed = new Date(args.value)
        if (isNaN(parsed.getTime())) throw new PolicyValidationError(`Invalid date value: ${args.value}`)
        return new Date(parsed.toISOString())
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
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- intentional fallback to string coercion
      return typeof args.value === "string" ? args.value : String(args.value)
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
