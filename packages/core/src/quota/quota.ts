import { encodeExecutionScopeId, validateExecutionScope, type ExecutionScope, type Principal } from "../domain"
import { ValidationError } from "../domain/errors"
import { PRINCIPAL_KINDS } from "../spec/authority"

const principalKinds: ReadonlySet<string> = new Set(PRINCIPAL_KINDS)

export interface QuotaSubject { readonly scope: ExecutionScope; readonly principal?: Pick<Principal,"id"|"kind">; readonly planKey?: string }
export interface QuotaRequest { readonly quotaKey: string; readonly subject: QuotaSubject; readonly amount: number; readonly limit: number; readonly windowMs: number; readonly idempotencyKey?: string }
export interface QuotaDecision { readonly allowed: boolean; readonly used: number; readonly remaining: number; readonly resetAt: number }
export interface QuotaPort { consume(request: QuotaRequest): Promise<QuotaDecision>; inspect?(request: Omit<QuotaRequest,"amount"|"idempotencyKey">): Promise<QuotaDecision> }

export function encodeQuotaSubject(subject: QuotaSubject): string {
  if(!subject||typeof subject!=="object") throw new ValidationError("Quota subject must be valid.")
  const scope=validateExecutionScope(subject.scope)
  if(subject.principal!==undefined && (subject.principal===null||typeof subject.principal!=="object"||typeof subject.principal.id!=="string"||!subject.principal.id.trim()||typeof subject.principal.kind!=="string"||!principalKinds.has(subject.principal.kind))) throw new ValidationError("Quota principal must be valid.")
  if(subject.planKey!==undefined&&(typeof subject.planKey!=="string"||!subject.planKey.trim())) throw new ValidationError("Quota plan key must be non-empty.")
  return [encodeExecutionScopeId(scope),subject.principal?`${encodeURIComponent(subject.principal.kind)}:${encodeURIComponent(subject.principal.id)}`:"all-principals",subject.planKey?`plan:${encodeURIComponent(subject.planKey)}`:"all-plans"].join(":")
}

export function validateQuotaRequest(request: QuotaRequest): QuotaRequest {
  if(!request||typeof request!=="object"||typeof request.quotaKey!=="string"||!request.quotaKey.trim()) throw new ValidationError("Quota key must be non-empty.")
  if(!Number.isSafeInteger(request.amount)||request.amount<=0) throw new ValidationError("Quota amount must be a positive safe integer.")
  if(!Number.isSafeInteger(request.limit)||request.limit<=0) throw new ValidationError("Quota limit must be a positive safe integer.")
  if(!Number.isSafeInteger(request.windowMs)||request.windowMs<=0) throw new ValidationError("Quota window must be a positive safe integer.")
  if(request.idempotencyKey!==undefined&&(typeof request.idempotencyKey!=="string"||!request.idempotencyKey.trim())) throw new ValidationError("Quota idempotency key must be non-empty.")
  encodeQuotaSubject(request.subject)
  return Object.freeze({...request,subject:Object.freeze({...request.subject,scope:Object.freeze({...request.subject.scope}),...(request.subject.principal?{principal:Object.freeze({...request.subject.principal})}:{})})})
}

export function validateQuotaDecision(request:QuotaRequest,decision:QuotaDecision):QuotaDecision{
  if(!decision||typeof decision!=="object"||typeof decision.allowed!=="boolean"||!Number.isSafeInteger(decision.used)||decision.used<0||!Number.isSafeInteger(decision.remaining)||decision.remaining<0||!Number.isFinite(decision.resetAt))throw new ValidationError("Quota provider returned an invalid decision.")
  const consistent=decision.allowed
    ?decision.used<=request.limit&&decision.used+decision.remaining===request.limit
    :decision.used+request.amount>request.limit&&decision.remaining===Math.max(request.limit-decision.used,0)
  if(!consistent)throw new ValidationError("Quota provider returned an inconsistent decision.")
  return Object.freeze({...decision})
}
