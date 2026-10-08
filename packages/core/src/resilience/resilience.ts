import { ConfigurationError } from "../domain/errors"
import { MAX_BACKOFF_ATTEMPTS, MAX_BACKOFF_DELAY_MS } from "./backoff"

export type ExternalCallSemantics = {readonly kind:"read"}|{readonly kind:"idempotent-mutation";readonly idempotencyKey:string}|{readonly kind:"non-idempotent-mutation"}
/**
 * Total attempts (at most MAX_BACKOFF_ATTEMPTS) and the initial jittered,
 * exponential backoff. Without `backoffMs`, DEFAULT_RETRY_BACKOFF_MS applies.
 */
export interface RetryPolicy { readonly maxAttempts: number; readonly backoffMs?: number }
/** Initial retry backoff when a retry policy sets no `backoffMs`. */
export const DEFAULT_RETRY_BACKOFF_MS = 100
export interface CircuitBreakerPolicy { readonly failureThreshold: number; readonly resetAfterMs: number }
export interface BulkheadPolicy { readonly maxConcurrent: number; readonly maxQueue?: number }
export interface ResiliencePolicy { readonly timeoutMs?: number; readonly retry?: RetryPolicy; readonly circuitBreaker?: CircuitBreakerPolicy; readonly bulkhead?: BulkheadPolicy }

export function validateResiliencePolicy(policy: ResiliencePolicy, semantics: ExternalCallSemantics): Readonly<ResiliencePolicy> {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new ConfigurationError("Resilience policy must be an object")
  if (!semantics || !["read", "idempotent-mutation", "non-idempotent-mutation"].includes(semantics.kind)) throw new ConfigurationError("External call semantics are invalid")
  for (const [name, value, required] of [["retry", policy.retry, ["maxAttempts"]], ["circuitBreaker", policy.circuitBreaker, ["failureThreshold", "resetAfterMs"]], ["bulkhead", policy.bulkhead, ["maxConcurrent"]]] as const) {
    if (value === undefined) continue
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigurationError(`${name} must be an object`)
    for (const key of required) if (!Object.hasOwn(value, key) || Object.getOwnPropertyDescriptor(value, key)?.value === undefined) throw new ConfigurationError(`${name}.${key} is required`)
  }
  const positive=(value:number|undefined,name:string)=>{if(value!==undefined&&(!Number.isSafeInteger(value)||value<=0)) throw new ConfigurationError(`${name} must be a positive safe integer`)}
  positive(policy.timeoutMs,"timeoutMs");positive(policy.retry?.maxAttempts,"retry.maxAttempts");positive(policy.retry?.backoffMs,"retry.backoffMs");positive(policy.circuitBreaker?.failureThreshold,"circuitBreaker.failureThreshold");positive(policy.circuitBreaker?.resetAfterMs,"circuitBreaker.resetAfterMs");positive(policy.bulkhead?.maxConcurrent,"bulkhead.maxConcurrent")
  // Timers above 2^31-1 ms fire immediately; one shared cap (7 days) bounds every resilience delay.
  if(policy.retry!==undefined&&policy.retry.maxAttempts>MAX_BACKOFF_ATTEMPTS) throw new ConfigurationError(`retry.maxAttempts must not exceed ${MAX_BACKOFF_ATTEMPTS}`)
  if(policy.timeoutMs!==undefined&&policy.timeoutMs>MAX_BACKOFF_DELAY_MS) throw new ConfigurationError(`timeoutMs must not exceed ${MAX_BACKOFF_DELAY_MS}`)
  if(policy.bulkhead?.maxQueue!==undefined&&(!Number.isSafeInteger(policy.bulkhead.maxQueue)||policy.bulkhead.maxQueue<0)) throw new ConfigurationError("bulkhead.maxQueue must be a non-negative safe integer")
  if(semantics.kind==="idempotent-mutation"&&(typeof semantics.idempotencyKey!=="string"||!semantics.idempotencyKey.trim())) throw new ConfigurationError("idempotent mutation requires a non-empty idempotency key")
  if(semantics.kind==="non-idempotent-mutation"&&(policy.retry?.maxAttempts??1)>1) throw new ConfigurationError("non-idempotent external mutations cannot be retried automatically")
  return Object.freeze({...policy,...(policy.retry?{retry:Object.freeze({...policy.retry})}:{}),...(policy.circuitBreaker?{circuitBreaker:Object.freeze({...policy.circuitBreaker})}:{}),...(policy.bulkhead?{bulkhead:Object.freeze({...policy.bulkhead})}:{})})
}
