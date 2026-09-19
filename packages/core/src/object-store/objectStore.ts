import { RuntimeCapabilityError, ValidationError } from "../domain/errors"

export type ObjectBytes = Uint8Array | ReadableStream<Uint8Array>
export interface ObjectChecksum { readonly algorithm: "sha256" | "md5" | string; readonly value: string }
export interface ObjectReference { readonly bucket?: string; readonly key: string; readonly version?: string }
export interface ObjectMetadata extends ObjectReference { readonly contentLength: number; readonly contentType?: string; readonly checksum?: ObjectChecksum; readonly etag?: string; readonly lastModified?: Date }
export interface ObjectRequestOptions { readonly signal?: AbortSignal; readonly deadline?: number }
export interface PutObjectInput extends ObjectReference, ObjectRequestOptions { readonly body: ObjectBytes; readonly contentLength: number; readonly contentType?: string; readonly checksum?: ObjectChecksum; readonly metadata?: Readonly<Record<string,string>> }
export interface ObjectReadResult { readonly body: ObjectBytes; readonly metadata: ObjectMetadata }
export interface SignedObjectReference { readonly url: string; readonly expiresAt: Date; readonly headers?: Readonly<Record<string,string>> }

export interface ObjectStore {
  put(input: PutObjectInput): Promise<ObjectMetadata>
  get(reference: ObjectReference & ObjectRequestOptions): Promise<ObjectReadResult | null>
  head(reference: ObjectReference & ObjectRequestOptions): Promise<ObjectMetadata | null>
  delete(reference: ObjectReference & ObjectRequestOptions): Promise<boolean>
  signUpload?(input: ObjectReference & { readonly expiresInMs: number; readonly contentType?: string; readonly contentLength?: number }): Promise<SignedObjectReference>
  signDownload?(input: ObjectReference & { readonly expiresInMs: number }): Promise<SignedObjectReference>
}

export function assertObjectRequestActive(options: ObjectRequestOptions, now = Date.now()): void {
  if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Object request aborted", "AbortError")
  if (options.deadline !== undefined && (!Number.isFinite(options.deadline)||now >= options.deadline)) throw new RuntimeCapabilityError("Object request deadline exceeded", { deadline: options.deadline })
}
export function validateObjectKey(key: string): string { if (!key || key.length > 1024 || key.includes("\0")) throw new ValidationError("Object key must contain 1-1024 non-NUL characters"); return key }
export function requireObjectStore(value: ObjectStore | undefined): ObjectStore { if (!value || typeof value !== "object" || ![value.put, value.get, value.head, value.delete].every(method => typeof method === "function")) throw new RuntimeCapabilityError("ObjectStore capability is not available", { capability:"objectStore" }); return value }

function validateReference(reference:ObjectReference):void{
  if(!reference||typeof reference!=="object"||typeof reference.key!=="string")throw new ValidationError("Object reference is invalid")
  validateObjectKey(reference.key)
  for(const [name,value] of [["bucket",reference.bucket],["version",reference.version]] as const)if(value!==undefined&&(typeof value!=="string"||!value.trim()))throw new ValidationError(`Object ${name} must be a non-empty string`)
}
function validateChecksum(checksum:ObjectChecksum|undefined):void{if(checksum!==undefined&&(!checksum||typeof checksum.algorithm!=="string"||!checksum.algorithm.trim()||typeof checksum.value!=="string"||!checksum.value.trim()))throw new ValidationError("Object checksum is invalid")}
export function validatePutObjectInput(input:PutObjectInput):PutObjectInput{
  validateReference(input);assertObjectRequestActive(input)
  if(!Number.isSafeInteger(input.contentLength)||input.contentLength<0)throw new ValidationError("Object contentLength must be a non-negative safe integer")
  const readable=typeof ReadableStream!=="undefined"&&input.body instanceof ReadableStream
  if(!(input.body instanceof Uint8Array)&&!readable)throw new ValidationError("Object body must be bytes or a readable byte stream")
  if(input.body instanceof Uint8Array&&input.body.byteLength!==input.contentLength)throw new ValidationError("Object byte body does not match declared contentLength")
  if(input.contentType!==undefined&&(typeof input.contentType!=="string"||!input.contentType.trim()))throw new ValidationError("Object contentType must be non-empty")
  validateChecksum(input.checksum)
  if(input.metadata!==undefined){if(!input.metadata||typeof input.metadata!=="object"||Array.isArray(input.metadata))throw new ValidationError("Object metadata must be a string record");for(const [key,value] of Object.entries(input.metadata))if(!key.trim()||typeof value!=="string")throw new ValidationError("Object metadata must contain non-empty string keys and string values")}
  return input
}
export function validateObjectMetadata(metadata:ObjectMetadata):ObjectMetadata{
  validateReference(metadata)
  if(!Number.isSafeInteger(metadata.contentLength)||metadata.contentLength<0)throw new ValidationError("Object metadata contentLength is invalid")
  validateChecksum(metadata.checksum)
  if(metadata.lastModified!==undefined&&(!(metadata.lastModified instanceof Date)||Number.isNaN(metadata.lastModified.getTime())))throw new ValidationError("Object metadata lastModified is invalid")
  return Object.freeze({...metadata,...(metadata.checksum?{checksum:Object.freeze({...metadata.checksum})}:{}),...(metadata.lastModified?{lastModified:new Date(metadata.lastModified)}:{})})
}
export function validateSignedObjectReference(reference:SignedObjectReference,now=Date.now()):SignedObjectReference{
  if(!reference||typeof reference!=="object"||typeof reference.url!=="string"||!reference.url.trim()||!(reference.expiresAt instanceof Date)||Number.isNaN(reference.expiresAt.getTime())||reference.expiresAt.getTime()<=now)throw new ValidationError("Signed object reference is invalid or expired")
  if(reference.headers!==undefined){if(!reference.headers||typeof reference.headers!=="object"||Array.isArray(reference.headers)||Object.entries(reference.headers).some(([key,value])=>!key.trim()||typeof value!=="string"))throw new ValidationError("Signed object headers are invalid")}
  return Object.freeze({...reference,expiresAt:new Date(reference.expiresAt),...(reference.headers?{headers:Object.freeze({...reference.headers})}:{})})
}
