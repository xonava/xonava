// Source of truth for the code blocks in docs/guides/durable-uploads.md.
// documentationExamples.test.ts compiles and runs this module and checks that
// every ```ts block in the guide appears here verbatim.
import {
  ConfigurationError,
  ConflictError,
  ForbiddenError,
  encodeExecutionScopeId,
  evaluatePredicate,
  NotFoundError,
  Predicate,
  ValidationError,
  type PredicateNode,
  type Principal,
  type RequestContext,
} from "@xonava/core/domain"
import type { ObjectMetadata, ObjectStore } from "@xonava/core/object-store"
import { createOperation, type MutationOperationContext, type OperationAuthorizationPort } from "@xonava/core/operation"
import type { PersistenceProvider, UnversionedEntityDescriptor, UnversionedRepository } from "@xonava/core/persistence"
import { defineAttachment, type AttachmentMetadata } from "@xonava/core/storage"

// --8<-- model
export type UploadStatus = "reserved" | "finalized" | "expired" | "deleted"

export interface Reservation {
  id: string
  tenantId: string
  ownerId: string
  objectKey: string
  fileName: string
  contentType: string
  contentLength: number
  sha256: string
  status: UploadStatus
  expiresAtMs: number
}

export interface StoredAttachment {
  id: string
  tenantId: string
  objectKey: string
  objectVersion: string
  fileName: string
  contentType: string
  contentLength: number
  sha256: string
  createdAt: string
}

export const reservationEntity: UnversionedEntityDescriptor<Reservation> = {
  name: "upload_reservation",
  primaryKey: "id",
  tenantField: "tenantId",
  fields: {
    id: { type: "string" },
    tenantId: { type: "string" },
    ownerId: { type: "string" },
    objectKey: { type: "string" },
    fileName: { type: "string" },
    contentType: { type: "string" },
    contentLength: { type: "number" },
    sha256: { type: "string" },
    status: { type: "string" },
    expiresAtMs: { type: "number" },
  },
}

export const attachmentEntity: UnversionedEntityDescriptor<StoredAttachment> = {
  name: "attachment",
  primaryKey: "id",
  tenantField: "tenantId",
  fields: {
    id: { type: "string" },
    tenantId: { type: "string" },
    objectKey: { type: "string" },
    objectVersion: { type: "string" },
    fileName: { type: "string" },
    contentType: { type: "string" },
    contentLength: { type: "number" },
    sha256: { type: "string" },
    createdAt: { type: "string" },
  },
}
// --8<-- end

// --8<-- limits
export const UPLOAD_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  contentTypes: ["image/png", "image/jpeg", "application/pdf"],
  reservationTtlMs: 15 * 60_000,
} as const

export interface ReserveUploadInput {
  /** Chosen by the client and reused on every retry: it is the idempotency key. */
  reservationId: string
  fileName: string
  contentType: string
  contentLength: number
  /** Lowercase hex SHA-256 of the bytes the client will upload. */
  sha256: string
}

function assertReservable(input: ReserveUploadInput): void {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.reservationId)) throw new ValidationError("reservationId must be 8-64 letters, digits or dashes")
  if (input.fileName.trim() === "" || input.fileName.length > 255) throw new ValidationError("fileName must be 1-255 characters")
  if (!(UPLOAD_LIMITS.contentTypes as readonly string[]).includes(input.contentType)) throw new ValidationError("This content type is not accepted")
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1 || input.contentLength > UPLOAD_LIMITS.maxBytes) {
    throw new ValidationError(`contentLength must be between 1 and ${UPLOAD_LIMITS.maxBytes} bytes`)
  }
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new ValidationError("sha256 must be 64 lowercase hex characters")
}
// --8<-- end

// --8<-- authorization
// Identity and tenant come from the trusted request context, never from the input.
function caller(operation: { request?: RequestContext }): { tenantId: string; userId: string } {
  const request = operation.request
  if (!request || request.scope.kind !== "tenant") throw new ForbiddenError("A tenant-scoped session is required")
  return { tenantId: request.scope.tenantId, userId: request.identity.subject.id }
}

const tenantSession: OperationAuthorizationPort<unknown> = {
  async authorize({ operation }) {
    return operation.request?.scope.kind === "tenant"
      ? { allowed: true }
      : { allowed: false, reason: "A tenant-scoped session is required" }
  },
}
// --8<-- end

// --8<-- reserve
export const reserveUpload = createOperation<ReserveUploadInput, Reservation>({
  key: "uploads.reserve",
  kind: "mutation",
  atomicity: { kind: "standard", mode: "required" },
  authorization: tenantSession,
  async execute({ operation, input }: { operation: MutationOperationContext; input: ReserveUploadInput }) {
    const { tenantId, userId } = caller(operation)
    assertReservable(input)
    const reservations = operation.persistence.repository<Reservation>(reservationEntity)
    const existing = await reservations.findById(input.reservationId)
    if (existing) {
      // A retry with the same id and the same request returns the same reservation.
      const same = existing.tenantId === tenantId && existing.ownerId === userId &&
        existing.fileName === input.fileName && existing.contentType === input.contentType &&
        existing.contentLength === input.contentLength && existing.sha256 === input.sha256
      if (!same) throw new ConflictError("reservationId is already used for a different upload")
      return existing
    }
    return reservations.insert({
      id: input.reservationId,
      tenantId,
      ownerId: userId,
      // The key is derived from the tenant and the reservation, never from the file name.
      objectKey: `tenants/${tenantId}/uploads/${input.reservationId}`,
      fileName: input.fileName,
      contentType: input.contentType,
      contentLength: input.contentLength,
      sha256: input.sha256,
      status: "reserved",
      expiresAtMs: operation.services.clock.now().getTime() + UPLOAD_LIMITS.reservationTtlMs,
    })
  },
})
// --8<-- end

// --8<-- put
/**
 * Runs outside any database transaction. The caller must have loaded `reservation`
 * from the database under the caller's own session and checked its owner.
 */
export async function putReservedObject(args: {
  store: ObjectStore
  reservation: Reservation
  body: Uint8Array
  now: Date
}): Promise<ObjectMetadata> {
  const { store, reservation, body, now } = args
  if (reservation.status !== "reserved" || now.getTime() >= reservation.expiresAtMs) {
    throw new ConflictError("The upload reservation is not open")
  }
  // The store verifies the declared length and SHA-256 and refuses a mismatch.
  // Putting the same bytes again under the same key replaces the object with an identical one.
  return store.put({
    key: reservation.objectKey,
    body,
    contentLength: reservation.contentLength,
    contentType: reservation.contentType,
    checksum: { algorithm: "sha256", value: reservation.sha256 },
    metadata: { reservationId: reservation.id },
  })
}
// --8<-- end

// --8<-- finalize
async function claim(
  reservations: UnversionedRepository<Reservation>,
  id: string,
  from: UploadStatus,
  to: UploadStatus,
): Promise<Reservation | null> {
  if (!reservations.updateOneWhereReturning) throw new ConfigurationError("The persistence adapter must support updateOneWhereReturning")
  // One conditional write decides between a finalizer and a cleanup run.
  return reservations.updateOneWhereReturning(Predicate.and(Predicate.eq("id", id), Predicate.eq("status", from)), { status: to })
}

function assertMatchesReservation(head: ObjectMetadata, reservation: Reservation): void {
  if (head.contentLength !== reservation.contentLength || head.contentLength > UPLOAD_LIMITS.maxBytes) {
    throw new ValidationError("The stored object size does not match the reservation")
  }
  if (head.checksum?.algorithm !== "sha256" || head.checksum.value.toLowerCase() !== reservation.sha256) {
    throw new ValidationError("The stored object checksum does not match the reservation")
  }
  if (head.contentType !== reservation.contentType) throw new ValidationError("The stored object type does not match the reservation")
  if (head.metadata?.reservationId !== reservation.id) throw new ValidationError("The stored object does not belong to this reservation")
}

function toAttachment(row: StoredAttachment): Readonly<AttachmentMetadata> {
  return defineAttachment({
    id: row.id,
    executionScope: { kind: "tenant", tenantId: row.tenantId },
    object: { key: row.objectKey, version: row.objectVersion },
    fileName: row.fileName,
    contentType: row.contentType,
    contentLength: row.contentLength,
    checksum: { algorithm: "sha256", value: row.sha256 },
    createdAt: new Date(row.createdAt),
  })
}

export function createFinalizeUpload(store: ObjectStore) {
  return createOperation<{ reservationId: string }, Readonly<AttachmentMetadata>>({
    key: "uploads.finalize",
    kind: "mutation",
    atomicity: { kind: "standard", mode: "required" },
      authorization: tenantSession,
    async execute({ operation, input }: { operation: MutationOperationContext; input: { reservationId: string } }) {
      const { tenantId, userId } = caller(operation)
      const reservations = operation.persistence.repository<Reservation>(reservationEntity)
      const attachments = operation.persistence.repository<StoredAttachment>(attachmentEntity)
      const reservation = await reservations.findById(input.reservationId)
      // Another tenant's or another user's reservation looks like a missing one.
      if (!reservation || reservation.tenantId !== tenantId || reservation.ownerId !== userId) throw new NotFoundError("Upload reservation not found")

      if (reservation.status === "finalized") {
        // Retry after success: return the attachment that already exists.
        const done = await attachments.findById(reservation.id)
        if (done) return toAttachment(done)
      }
      const now = operation.services.clock.now()
      if (reservation.status !== "reserved" || now.getTime() >= reservation.expiresAtMs) throw new ConflictError("The upload reservation has expired")

      // The provider's own metadata decides, not the client's claims.
      const head = await store.head({ key: reservation.objectKey })
      if (!head) throw new ConflictError("The object has not been uploaded")
      assertMatchesReservation(head, reservation)

      if (!(await claim(reservations, reservation.id, "reserved", "finalized"))) {
        throw new ConflictError("The upload reservation was finalized or expired concurrently")
      }
      return toAttachment(await attachments.insert({
        id: reservation.id,
        tenantId,
        objectKey: reservation.objectKey,
        objectVersion: head.version ?? "",
        fileName: reservation.fileName,
        contentType: reservation.contentType,
        contentLength: head.contentLength,
        sha256: reservation.sha256,
        createdAt: now.toISOString(),
      }))
    },
  })
}
// --8<-- end

// --8<-- cleanup
/**
 * Invoke from a scheduled job. It uses a system-scoped persistence provider because it
 * spans tenants; it needs no request context. Each run handles one page of candidates.
 */
export async function cleanupExpiredUploads(args: {
  persistence: PersistenceProvider
  store: ObjectStore
  now: Date
}): Promise<{ deleted: number; kept: number }> {
  const { persistence, store, now } = args
  const reservations = persistence.repository<Reservation>(reservationEntity)
  const attachments = persistence.repository<StoredAttachment>(attachmentEntity)
  // "expired" rows are ones an earlier run claimed but did not finish: pick them up again.
  const candidates = await reservations.findMany({
    filter: Predicate.or(
      Predicate.and(Predicate.eq("status", "reserved"), Predicate.lte("expiresAtMs", now.getTime())),
      Predicate.eq("status", "expired"),
    ),
  })
  let deleted = 0
  let kept = 0
  for (const row of candidates.rows) {
    // Claim first. If a finalizer won, the claim fails and the object is left alone.
    if (row.status === "reserved" && !(await claim(reservations, row.id, "reserved", "expired"))) { kept += 1; continue }
    // Belt and braces: never delete an object that any attachment references.
    const referenced = await attachments.findMany({ filter: Predicate.eq("objectKey", row.objectKey) })
    if (referenced.rows.length > 0) { kept += 1; continue }
    // delete reports false when the object is already gone; both outcomes are fine.
    await store.delete({ key: row.objectKey })
    await reservations.update(row.id, { status: "deleted" })
    deleted += 1
  }
  return { deleted, kept }
}
// --8<-- end

// ---------------------------------------------------------------------------
// Test support, not shown in the guide: an in-memory persistence provider and
// a request context.
// ---------------------------------------------------------------------------
export function inMemoryDatabase() {
  const tables = new Map<string, Map<string, Record<string, unknown>>>()
  const table = (name: string) => {
    let rows = tables.get(name)
    if (!rows) { rows = new Map(); tables.set(name, rows) }
    return rows
  }
  const persistence = {
    dialect: "test",
    capabilities: { interactiveTransactions: true, atomicBatch: false, returningInsert: true, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100 },
    repository: (entity: { name: string }) => {
      const rows = table(entity.name)
      const select = (filter?: PredicateNode) => [...rows.values()].filter((row) => !filter || evaluatePredicate(row, filter))
      return {
        findById: async (id: string) => (rows.has(id) ? { ...rows.get(id) } : null),
        findMany: async ({ filter }: { filter?: PredicateNode } = {}) => ({ rows: select(filter).map((row) => ({ ...row })), rowCount: select(filter).length, page: 1, pageSize: 100 }),
        insert: async (row: Record<string, unknown>) => {
          if (rows.has(row.id as string)) throw new ConflictError("duplicate primary key")
          rows.set(row.id as string, { ...row })
          return { ...row }
        },
        update: async (id: string, patch: Record<string, unknown>) => {
          const updated = { ...rows.get(id), ...patch }
          rows.set(id, updated)
          return { ...updated }
        },
        updateOneWhereReturning: async (filter: PredicateNode, patch: Record<string, unknown>) => {
          const current = select(filter)[0]
          if (!current) return null
          const updated = { ...current, ...patch }
          rows.set(updated.id as string, updated)
          return { ...updated }
        },
        delete: async (id: string) => { rows.delete(id) },
      }
    },
    runInTransaction: async <T>(work: (provider: PersistenceProvider) => Promise<T>) => work(provider),
  }
  const provider: PersistenceProvider = persistence as never
  return { persistence: provider, table }
}

/** Stands in for the transport adapter: a request bound to one operation key. */
export function sessionRequest(tenantId: string, userId: string, operationKey: string): RequestContext {
  const principal: Principal = {
    id: userId,
    kind: "human",
    authentication: { kind: "authenticated", method: "session", authenticatedAt: new Date().toISOString() },
  }
  const scope = { kind: "tenant", tenantId } as const
  const scopeId = encodeExecutionScopeId(scope)
  const issuedAt = new Date().toISOString()
  return {
    requestId: "request-1",
    correlationId: "correlation-1",
    identity: { actor: principal, subject: principal },
    scope,
    scopeId,
    authority: {
      identity: { actor: principal, subject: principal },
      correlationId: "correlation-1",
      grant: {
        grantId: "grant-1",
        source: { kind: "route", routeKey: "uploads" },
        target: { scope, scopeId },
        purpose: "upload",
        reason: "authenticated user",
        issuedAt,
        policy: { policyKey: "uploads", policyVersion: 1, policyDigest: "uploads", evaluatedAt: issuedAt, authorizationModel: "snapshot" },
        delegationChain: [],
        impersonation: { kind: "none" },
      },
    },
    route: { routeKey: "uploads", operationKey, definitionVersion: 1 },
    signal: new AbortController().signal,
  }
}
