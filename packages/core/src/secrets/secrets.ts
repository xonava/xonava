import {ValidationError} from "../domain/errors"

declare const secretReferenceBrand:unique symbol
export type SecretReference=Readonly<{readonly provider:string;readonly key:string;readonly version?:string;readonly [secretReferenceBrand]:true}>
export interface SecretValue {readonly value:string|Uint8Array;readonly expiresAt?:Date;dispose?():void}
export interface SecretProvider {resolve(reference:SecretReference,options?:{readonly signal?:AbortSignal;readonly deadline?:number}):Promise<SecretValue>}

export function secretReference(provider:string,key:string,version?:string):SecretReference{
  if(typeof provider!=="string"||typeof key!=="string"||(version!==undefined&&typeof version!=="string")||!provider.trim()||!key.trim()||(version!==undefined&&!version.trim())) throw new ValidationError("Secret references require non-empty provider, key and optional version.")
  return Object.freeze({provider,key,...(version!==undefined?{version}: {})}) as SecretReference
}
export function isSecretReference(value:unknown):value is SecretReference{return typeof value==="object"&&value!==null&&typeof (value as {provider?:unknown}).provider==="string"&&Boolean((value as {provider:string}).provider.trim())&&typeof (value as {key?:unknown}).key==="string"&&Boolean((value as {key:string}).key.trim())&&!("value" in value)}
