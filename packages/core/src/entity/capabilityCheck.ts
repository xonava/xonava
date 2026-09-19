import { ConfigurationError } from "../domain"

export type CapabilityCheckConfig =
  | {
      customCapabilityKey: string
      skipCapabilityCheck?: false | undefined
    }
  | {
      skipCapabilityCheck: true
      customCapabilityKey?: never
    }

export interface ResolvedCapabilityKey {
  enabled: boolean
  key?: string
}
export interface EnvironmentCapabilityManifest {
  readonly application: ReadonlySet<string>
  readonly runtime: ReadonlySet<string>
}

export function assertEntityCapabilityAvailable(config: CapabilityCheckConfig, manifest: EnvironmentCapabilityManifest): void {
  const resolved = resolveCapabilityKey(config)
  if (resolved.enabled && !manifest.application.has(resolved.key!)) throw new ConfigurationError(`Required entity capability '${resolved.key}' is unavailable in the environment manifest.`)
}

const CAPABILITY_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9:_-]*$/

/**
 * Runtime guard for a `CapabilityCheckConfig`. The union type already prevents
 * a contradictory config at compile time, but unsound casts can still produce
 * one at runtime (e.g. `{ skipCapabilityCheck: true, customCapabilityKey: "x" }`).
 * This guard normalizes the input so capability routing can never be confused
 * by a caller-declared key that claims both branches.
 */
export function assertCapabilityConfigValid(config: unknown): asserts config is CapabilityCheckConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ConfigurationError("Invalid capability configuration: expected a CapabilityCheckConfig object.")
  }
  const candidate = config as Partial<CapabilityCheckConfig>
  const skip = candidate.skipCapabilityCheck
  if (skip !== undefined && typeof skip !== "boolean") throw new ConfigurationError("skipCapabilityCheck must be boolean.")
  const hasCustomKey = candidate.customCapabilityKey !== undefined
  if (skip === true && hasCustomKey) {
    throw new ConfigurationError(
      "Invalid capability configuration: cannot set both skipCapabilityCheck: true and customCapabilityKey.",
    )
  }
  if (skip !== true && !hasCustomKey) {
    throw new ConfigurationError(
      "Invalid capability configuration: must declare customCapabilityKey or set skipCapabilityCheck: true.",
    )
  }
  if (hasCustomKey &&
      (typeof candidate.customCapabilityKey !== "string" || !CAPABILITY_KEY_PATTERN.test(candidate.customCapabilityKey))) {
    throw new ConfigurationError(
      `Invalid capability configuration: customCapabilityKey "${String(candidate.customCapabilityKey)}" is not a valid capability key.`,
    )
  }
}

/**
 * Resolves and normalizes a capability config into its canonical, unforgeable
 * form. A config that claims both branches, or neither, is rejected.
 */
export function resolveCapabilityKey(config: CapabilityCheckConfig): ResolvedCapabilityKey {
  assertCapabilityConfigValid(config)
  if (config.skipCapabilityCheck === true) return { enabled: false }
  return { enabled: true, key: config.customCapabilityKey }
}
