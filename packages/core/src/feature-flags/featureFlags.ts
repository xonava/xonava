import type {ExecutionScope,Principal} from "../domain"
import {ValidationError} from "../domain/errors"

export type FeatureFlagValue=boolean|string|number
export interface FeatureFlagContext {readonly scope:ExecutionScope;readonly principal?:Pick<Principal,"id"|"kind">;readonly attributes?:Readonly<Record<string,string|number|boolean>>}
export interface FeatureFlagFact {readonly key:string;readonly value:FeatureFlagValue;readonly variant?:string;readonly reason:string;readonly evaluatedAt:Date;readonly expiresAt?:Date}
export interface FeatureFlagProvider {evaluate(key:string,context:FeatureFlagContext):Promise<FeatureFlagFact>}
export function validateFeatureFlagFact(fact:FeatureFlagFact,expectedKey?:string):FeatureFlagFact{
  const value:unknown=fact
  if(typeof value!=="object"||value===null)throw new ValidationError("Feature flag provider returned an invalid fact.")
  const candidate=value as Partial<FeatureFlagFact>
  const validValue=typeof candidate.value==="boolean"||typeof candidate.value==="string"||(typeof candidate.value==="number"&&Number.isFinite(candidate.value))
  if(typeof candidate.key!=="string"||!candidate.key.trim()||(expectedKey!==undefined&&candidate.key!==expectedKey)||!validValue||(candidate.variant!==undefined&&(typeof candidate.variant!=="string"||!candidate.variant.trim()))||typeof candidate.reason!=="string"||!candidate.reason.trim()||!(candidate.evaluatedAt instanceof Date)||Number.isNaN(candidate.evaluatedAt.getTime())||(candidate.expiresAt!==undefined&&(!(candidate.expiresAt instanceof Date)||Number.isNaN(candidate.expiresAt.getTime())||candidate.expiresAt<=candidate.evaluatedAt))) throw new ValidationError("Feature flag provider returned an invalid fact.")
  return Object.freeze({...fact,evaluatedAt:new Date(fact.evaluatedAt),...(fact.expiresAt?{expiresAt:new Date(fact.expiresAt)}:{})})
}
