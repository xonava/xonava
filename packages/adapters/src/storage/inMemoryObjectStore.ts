import { assertObjectRequestActive, validateObjectKey, type ObjectBytes, type ObjectMetadata, type ObjectReadResult, type ObjectReference, type ObjectStore, type PutObjectInput } from "@xonava/core/object-store"
import { ValidationError } from "@xonava/core/domain"

interface Entry { readonly bytes: Uint8Array; readonly metadata: ObjectMetadata }
const identity = (reference: ObjectReference) => `${reference.bucket ?? ""}\0${reference.key}`
async function readBytes(body: ObjectBytes, options: Pick<PutObjectInput,"signal"|"deadline">): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body.slice()
  const reader=body.getReader(); const chunks:Uint8Array[]=[]; let length=0
  try { for (;;) { assertObjectRequestActive(options); const item=await reader.read(); if (item.done) break; chunks.push(item.value); length+=item.value.byteLength } }
  finally { reader.releaseLock() }
  const bytes=new Uint8Array(length); let offset=0; for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength} return bytes
}

/** Deterministic reference adapter for conformance tests; it intentionally has no signed-URL capability. */
export class InMemoryObjectStore implements ObjectStore {
  private readonly entries=new Map<string,Entry>(); private version=0
  async put(input:PutObjectInput):Promise<ObjectMetadata>{ assertObjectRequestActive(input); validateObjectKey(input.key); if(!Number.isSafeInteger(input.contentLength)||input.contentLength<0) throw new ValidationError("Object contentLength must be a non-negative safe integer"); const bytes=await readBytes(input.body,input); if(bytes.byteLength!==input.contentLength) throw new ValidationError("Object contentLength does not match body bytes"); const metadata:ObjectMetadata=Object.freeze({...(input.bucket?{bucket:input.bucket}:{}),key:input.key,version:String(++this.version),contentLength:bytes.byteLength,...(input.contentType?{contentType:input.contentType}:{}),...(input.checksum?{checksum:Object.freeze({...input.checksum})}:{}),etag:`mem-${this.version}-${bytes.byteLength}`,lastModified:new Date()}); this.entries.set(identity(input),{bytes,metadata}); return metadata }
  async get(reference:ObjectReference & {signal?:AbortSignal;deadline?:number}):Promise<ObjectReadResult|null>{ assertObjectRequestActive(reference); validateObjectKey(reference.key); const entry=this.entries.get(identity(reference)); return entry?{body:entry.bytes.slice(),metadata:entry.metadata}:null }
  async head(reference:ObjectReference & {signal?:AbortSignal;deadline?:number}):Promise<ObjectMetadata|null>{ assertObjectRequestActive(reference); validateObjectKey(reference.key); return this.entries.get(identity(reference))?.metadata??null }
  async delete(reference:ObjectReference & {signal?:AbortSignal;deadline?:number}):Promise<boolean>{ assertObjectRequestActive(reference); validateObjectKey(reference.key); return this.entries.delete(identity(reference)) }
}
