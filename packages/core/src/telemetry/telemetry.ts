import type { DataClassification, FieldDataClassifications } from "../domain/dataClassification"
import { fieldsAllowedForPurpose } from "../domain/dataClassification"
import { ValidationError } from "../domain/errors"

export type TelemetryAttributeValue=string|number|boolean
export type TelemetrySeverity="debug"|"info"|"warn"|"error"
export interface TelemetryEvent { readonly name:string; readonly severity:TelemetrySeverity; readonly timestamp:Date; readonly attributes:Readonly<Record<string,TelemetryAttributeValue>> }
export interface TelemetryPort { emit(event:TelemetryEvent):void|Promise<void> }

export function buildSafeTelemetryAttributes(values:Readonly<Record<string,unknown>>,classifications:FieldDataClassifications):Readonly<Record<string,TelemetryAttributeValue>>{
  const allowed=new Set(fieldsAllowedForPurpose(classifications,"telemetry"));const output:Record<string,TelemetryAttributeValue>={}
  for(const [key,value] of Object.entries(values)){if(!allowed.has(key)||!(typeof value==="string"||typeof value==="number"||typeof value==="boolean")||!Number.isFinite(typeof value==="number"?value:0))continue;if(typeof value==="string"&&new TextEncoder().encode(value).byteLength>1024)throw new ValidationError(`Telemetry attribute '${key}' exceeds 1024 bytes`);output[key]=value}
  return Object.freeze(output)
}
export function explicitlySafeTelemetryAttributes(values:Readonly<Record<string,TelemetryAttributeValue>>,classification:DataClassification="internal"):Readonly<Record<string,TelemetryAttributeValue>>{return buildSafeTelemetryAttributes(values,Object.fromEntries(Object.keys(values).map(key=>[key,classification])))}
/** Telemetry is observational and must never alter framework semantics. */
export function emitTelemetry(port:TelemetryPort|undefined,event:TelemetryEvent):void{if(!port)return;try{const result=port.emit(Object.freeze({...event,attributes:Object.freeze({...event.attributes})}));if(result&&typeof (result as Promise<void>).catch==="function")void (result as Promise<void>).catch(()=>undefined)}catch{/* best effort */}}
export function createNoopTelemetry():TelemetryPort{return {emit(){}}}
