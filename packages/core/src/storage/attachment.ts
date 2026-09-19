import type { ExecutionScope } from "../domain/executionScope"
import { validateExecutionScope } from "../domain/executionScope"
import type { ObjectChecksum, ObjectReference } from "../object-store/objectStore"
import { validateObjectKey } from "../object-store/objectStore"
import { ValidationError } from "../domain/errors"

export interface AttachmentMetadataInput {
  readonly id: string
  readonly executionScope: ExecutionScope
  readonly object: ObjectReference
  readonly fileName: string
  readonly contentType: string
  readonly contentLength: number
  readonly checksum?: ObjectChecksum
  readonly classification?: string
  readonly createdAt: Date
}

export interface AttachmentMetadata extends Omit<AttachmentMetadataInput, "createdAt"> {
  /** Canonical immutable timestamp retained with the durable attachment metadata. */
  readonly createdAt: string
}

export function defineAttachment(input: AttachmentMetadataInput): Readonly<AttachmentMetadata> {
  if (!input.id.trim() || !input.fileName.trim() || !input.contentType.trim()) throw new ValidationError("Attachment identity, file name and content type are required")
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 0) throw new ValidationError("Attachment contentLength must be a non-negative safe integer")
  if (!(input.createdAt instanceof Date) || !Number.isFinite(input.createdAt.getTime())) throw new ValidationError("Attachment createdAt must be valid")
  validateObjectKey(input.object.key)
  return Object.freeze({ ...input, createdAt: input.createdAt.toISOString(), executionScope: validateExecutionScope(input.executionScope), object: Object.freeze({ ...input.object }), ...(input.checksum ? { checksum:Object.freeze({ ...input.checksum }) } : {}) })
}
