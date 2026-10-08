import { ConfigurationError, type ValidationError } from "../domain"
import { snapshotData } from "../kernel/snapshotData"

export interface RuleSnapshotOptions {
  readonly maxNodes?: number
  /** Error type that structural snapshot failures are reported as. Defaults to ConfigurationError. */
  readonly errorType?: typeof ConfigurationError | typeof ValidationError
}

/** Defensive data snapshot used at the pure rule boundary. */
export function snapshotRuleData<T>(value: T, label: string, options: RuleSnapshotOptions = {}): T {
  try {
    return snapshotData(value, { label, ...(options.maxNodes !== undefined ? { maxNodes: options.maxNodes } : {}) })
  } catch (error) {
    // snapshotData reports structural violations as TypeError/RangeError;
    // surface them as framework errors with the original as the cause.
    if (error instanceof TypeError || error instanceof RangeError) throw new (options.errorType ?? ConfigurationError)(error.message, error)
    throw error
  }
}
