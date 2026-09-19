import {ValidationError} from "../domain/errors"

export type HealthStatus="healthy"|"degraded"|"unhealthy"
export interface HealthComponent {readonly key:string;readonly status:HealthStatus;readonly critical:boolean;readonly checkedAt:Date;readonly message?:string}
export interface HealthReport {readonly live:boolean;readonly ready:boolean;readonly status:HealthStatus;readonly checkedAt:Date;readonly components:readonly HealthComponent[]}
export interface HealthPort {checkLiveness():Promise<readonly HealthComponent[]>;checkReadiness():Promise<readonly HealthComponent[]>}

export function aggregateHealth(liveness:readonly HealthComponent[],readiness:readonly HealthComponent[],checkedAt=new Date()):HealthReport{
  if(!(checkedAt instanceof Date)||Number.isNaN(checkedAt.getTime())||!Array.isArray(liveness)||!Array.isArray(readiness)) throw new ValidationError("Health report time must be valid.")
  const statuses=new Set<HealthStatus>(["healthy","degraded","unhealthy"]);const seen=new Set<string>();const components=[...liveness,...readiness].map(component=>{if(!component||typeof component!=="object"||typeof component.key!=="string"||!component.key.trim()||seen.has(component.key)||!statuses.has(component.status)||typeof component.critical!=="boolean"||!(component.checkedAt instanceof Date)||Number.isNaN(component.checkedAt.getTime())||(component.message!==undefined&&typeof component.message!=="string")) throw new ValidationError("Health components require unique non-empty keys, valid status, and valid times.");seen.add(component.key);return Object.freeze({...component,checkedAt:new Date(component.checkedAt)})})
  const live=liveness.every(x=>x.status!=="unhealthy"||!x.critical);const ready=live&&readiness.every(x=>x.status!=="unhealthy"||!x.critical)
  const status=!live||!ready?"unhealthy":components.some(x=>x.status!=="healthy")?"degraded":"healthy"
  return Object.freeze({live,ready,status,checkedAt:new Date(checkedAt),components:Object.freeze(components)})
}
