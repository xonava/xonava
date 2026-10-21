import { assertObjectRequestActive, validateObjectKey, validatePutObjectInput, type ObjectMetadata, type ObjectReadResult, type ObjectReference, type ObjectRequestOptions, type ObjectStore, type PutObjectInput } from "@xonava/core/object-store"
import { ValidationError } from "@xonava/core/domain"
import { declaredSha256, readObjectBytes, sha256Hex } from "./objectBytes"

interface Entry { readonly bytes: Uint8Array; readonly metadata: ObjectMetadata }
const identity = (reference: ObjectReference) => `${reference.bucket ?? ""}\0${reference.key}`

/** Deterministic reference adapter for conformance tests; it intentionally has no signed-URL capability. It verifies sha256 checksums, keeps custom metadata, and answers versioned reads with absence when the version is not current. */
export class InMemoryObjectStore implements ObjectStore {
  private readonly entries=new Map<string,Entry>(); private version=0
  private current(reference:ObjectReference & ObjectRequestOptions):Entry|undefined{ assertObjectRequestActive(reference); validateObjectKey(reference.key); const entry=this.entries.get(identity(reference)); return entry&&(reference.version===undefined||reference.version===entry.metadata.version)?entry:undefined }
  async put(input:PutObjectInput):Promise<ObjectMetadata>{
    validatePutObjectInput(input)
    const expected=declaredSha256(input.checksum)
    const bytes=await readObjectBytes(input.body,input.contentLength,input)
    if(bytes.byteLength!==input.contentLength) throw new ValidationError("Object contentLength does not match body bytes")
    if(expected!==undefined&&await sha256Hex(bytes)!==expected) throw new ValidationError("Object checksum does not match body bytes")
    assertObjectRequestActive(input)
    const metadata:ObjectMetadata=Object.freeze({...(input.bucket?{bucket:input.bucket}:{}),key:input.key,version:String(++this.version),contentLength:bytes.byteLength,...(input.contentType?{contentType:input.contentType}:{}),...(expected!==undefined?{checksum:Object.freeze({algorithm:"sha256",value:expected})}:{}),...(input.metadata?{metadata:Object.freeze({...input.metadata})}:{}),etag:`mem-${this.version}-${bytes.byteLength}`,lastModified:new Date()})
    this.entries.set(identity(input),{bytes,metadata}); return metadata
  }
  async get(reference:ObjectReference & ObjectRequestOptions):Promise<ObjectReadResult|null>{ const entry=this.current(reference); return entry?{body:entry.bytes.slice(),metadata:entry.metadata}:null }
  async head(reference:ObjectReference & ObjectRequestOptions):Promise<ObjectMetadata|null>{ return this.current(reference)?.metadata??null }
  async delete(reference:ObjectReference & ObjectRequestOptions):Promise<boolean>{ return this.current(reference)?this.entries.delete(identity(reference)):false }
}
