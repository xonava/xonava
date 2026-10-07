import { RuntimeCapabilityError, RateLimitError, ValidationError } from "../domain/errors"

export interface RateLimitStore {
  readonly capabilities?: RateLimitStoreCapabilities
  increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>
  consume?(request: RateLimitConsumeRequest): Promise<{ count: number; resetAt: number }>
}

/** A store whose bucket increment is a single atomic backend operation. */
export interface AtomicRateLimitStore extends RateLimitStore {
  incrementAtomically(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>
  consumeAtomically?(request: RateLimitConsumeRequest): Promise<{ count: number; resetAt: number }>
}

export type RateLimitAlgorithm = "fixed-window" | "sliding-window" | "token-bucket"
export interface RateLimitStoreCapabilities { readonly algorithms: readonly RateLimitAlgorithm[]; readonly weightedCost: boolean }
export interface RateLimitConsumeRequest { readonly key: string; readonly windowMs: number; readonly algorithm: RateLimitAlgorithm; readonly cost: number }

export interface RateLimitConfig {
  max: number
  timeWindow: string | number
  algorithm?: RateLimitAlgorithm
  cost?: number
  consistency?: RateLimitConsistency
  failureMode?: RateLimitFailureMode
}

export type RateLimitConsistency = "atomic" | "best-effort"
export type RateLimitFailureMode = "fail-closed" | "fail-open"

export interface RateLimitPolicy {
  /** Atomic increments are the security-safe default. */
  consistency?: RateLimitConsistency
  /** Rate-limit infrastructure failures deny the request by default. */
  failureMode?: RateLimitFailureMode
}

export interface RateLimitCheckResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

export function parseTimeWindowMs(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new ValidationError("Rate-limit time window must be a finite positive number.")
    return value
  }
  if (typeof value !== "string") throw new ValidationError("Rate-limit time window must be a string or number.")
  const input = value.trim().toLowerCase()
  const match = input.match(/^(\d{1,9})\s*(ms|millisecond|milliseconds|s|second|seconds|m|minute|minutes|h|hour|hours|d|day|days)$/)
  if (!match) throw new ValidationError(`Invalid rate-limit time window: ${value}`)

  const countText = match[1]
  const unit = match[2]
  if (countText === undefined || unit === undefined) throw new ValidationError(`Invalid rate-limit time window: ${value}`)
  const count = Number.parseInt(countText, 10)
  const unitMs = unit === "ms" || unit.startsWith("millisecond") ? 1 : unit === "s" || unit.startsWith("second") ? 1000 : unit === "m" || unit.startsWith("minute") ? 60_000 : unit === "h" || unit.startsWith("hour") ? 3_600_000 : 86_400_000
  const result = count * unitMs
  if (!Number.isSafeInteger(result) || result <= 0) throw new ValidationError("Rate-limit time window must be a positive safe integer of milliseconds.")
  return result
}

function resolveConsistency(args: { consistency?: RateLimitConsistency; policy?: RateLimitPolicy }): RateLimitConsistency {
  if (args.consistency !== undefined && args.policy?.consistency !== undefined && args.consistency !== args.policy.consistency) {
    throw new ValidationError("Rate-limit consistency and policy options conflict.")
  }
  const consistency = args.consistency ?? args.policy?.consistency
  if (consistency !== undefined && consistency !== "atomic" && consistency !== "best-effort") throw new ValidationError("Rate-limit consistency is invalid.")
  return consistency ?? "atomic"
}

function failOpenResult(limit: number, windowMs: number, nowMs: () => number): RateLimitCheckResult {
  return { allowed: true, remaining: limit, resetAt: nowMs() + windowMs }
}

export async function checkRateLimit(args: {
  store: RateLimitStore
  key: string
  limit: number
  windowMs: number
  policy?: RateLimitPolicy
  consistency?: RateLimitConsistency
  failureMode?: RateLimitFailureMode
  nowMs?: () => number
  algorithm?: RateLimitAlgorithm
  cost?: number
}): Promise<RateLimitCheckResult> {
  if (typeof args.key !== "string" || args.key.trim().length === 0) throw new ValidationError("Rate-limit key must be non-empty.")
  if (!Number.isFinite(args.limit) || args.limit <= 0) throw new ValidationError("Rate-limit max must be positive.")
  if (!Number.isFinite(args.windowMs) || args.windowMs <= 0) throw new ValidationError("Rate-limit window must be positive.")
  const algorithm = args.algorithm ?? "fixed-window"
  const cost = args.cost ?? 1
  if (!(["fixed-window", "sliding-window", "token-bucket"] as const).includes(algorithm)) throw new ValidationError("Rate-limit algorithm is invalid.")
  if (!Number.isSafeInteger(cost) || cost <= 0) throw new ValidationError("Rate-limit cost must be a positive safe integer.")
  const consistency = resolveConsistency(args)
  const failureMode = args.failureMode ?? args.policy?.failureMode ?? "fail-closed"
  if (failureMode !== "fail-open" && failureMode !== "fail-closed") throw new ValidationError("Rate-limit failure mode is invalid.")
  if (args.failureMode !== undefined && args.policy?.failureMode !== undefined && args.failureMode !== args.policy.failureMode) throw new ValidationError("Rate-limit failure mode options conflict.")
  // Fail-open is an availability trade-off that only makes sense for an
  // approximate limiter. An atomic (security) limit always fails closed, so
  // requesting both is a configuration error rather than a silent downgrade.
  if (failureMode === "fail-open" && consistency === "atomic") throw new ValidationError("Rate-limit fail-open requires best-effort consistency; atomic limits always fail closed.")
  const nowMs = args.nowMs ?? Date.now

  try {
    const atomicStore = isAtomicRateLimitStore(args.store) ? args.store : undefined
    if (consistency === "atomic" && !atomicStore) {
      throw new RuntimeCapabilityError("atomicIncrement")
    }

    const capabilities = args.store.capabilities
    if (capabilities && !capabilities.algorithms.includes(algorithm)) throw new RuntimeCapabilityError(`rateLimitAlgorithm:${algorithm}`)
    if (cost !== 1 && capabilities?.weightedCost !== true) throw new RuntimeCapabilityError("weightedRateLimitCost")
    if ((algorithm !== "fixed-window" || cost !== 1) && (consistency === "atomic" ? !atomicStore!.consumeAtomically : !args.store.consume)) throw new RuntimeCapabilityError("rateLimitConsume")
    const request = { key: args.key, windowMs: args.windowMs, algorithm, cost }
    const bucket = consistency === "atomic"
      ? atomicStore!.consumeAtomically ? await atomicStore!.consumeAtomically(request) : await atomicStore!.incrementAtomically(args.key, args.windowMs)
      : args.store.consume ? await args.store.consume(request) : await args.store.increment(args.key, args.windowMs)
    if (!Number.isFinite(bucket.count) || bucket.count < 0 || !Number.isFinite(bucket.resetAt)) {
      throw new ValidationError("Rate-limit store returned an invalid bucket.")
    }
    const remaining = Math.max(args.limit - bucket.count, 0)

    return {
      allowed: bucket.count <= args.limit,
      remaining,
      resetAt: bucket.resetAt,
    }
  } catch (error) {
    if (error instanceof RuntimeCapabilityError || error instanceof ValidationError) throw error
    if (failureMode === "fail-open" && consistency === "best-effort") return failOpenResult(args.limit, args.windowMs, nowMs)
    throw error
  }
}

function isAtomicRateLimitStore(store: RateLimitStore): store is AtomicRateLimitStore {
  return typeof (store as Partial<AtomicRateLimitStore>).incrementAtomically === "function"
}

export async function enforceRateLimit(args: {
  store: RateLimitStore
  key: string
  config: RateLimitConfig
  policy?: RateLimitPolicy
  consistency?: RateLimitConsistency
  failureMode?: RateLimitFailureMode
  nowMs?: () => number
}): Promise<RateLimitCheckResult> {
  if (!Number.isFinite(args.config.max) || args.config.max <= 0) throw new ValidationError("Rate-limit max must be positive.")
  for (const key of ["consistency", "failureMode"] as const) {
    if (args.config[key] !== undefined && ((args[key] !== undefined && args[key] !== args.config[key]) || (args.policy?.[key] !== undefined && args.policy[key] !== args.config[key]))) throw new ValidationError(`Rate-limit ${key} configuration conflicts with explicit options.`)
  }
  const windowMs = parseTimeWindowMs(args.config.timeWindow)
  const result = await checkRateLimit({
    store: args.store,
    key: args.key,
    limit: args.config.max,
    windowMs,
    algorithm: args.config.algorithm ?? "fixed-window",
    cost: args.config.cost ?? 1,
    ...(args.policy !== undefined ? { policy: args.policy } : {}),
    ...((args.consistency ?? args.config.consistency) !== undefined ? { consistency: (args.consistency ?? args.config.consistency)! } : {}),
    ...((args.failureMode ?? args.config.failureMode) !== undefined ? { failureMode: (args.failureMode ?? args.config.failureMode)! } : {}),
    ...(args.nowMs !== undefined ? { nowMs: args.nowMs } : {}),
  })

  if (!result.allowed) {
    throw new RateLimitError(Math.max(result.resetAt - (args.nowMs?.() ?? Date.now()), 0))
  }

  return result
}
