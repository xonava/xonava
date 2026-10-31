# Durable uploads

A file upload touches two systems that cannot commit together: your database and the object store. This guide builds a protocol that stays correct when a request is retried, a process crashes between the two, or two workers race. The protocol has four steps: **reserve**, **upload**, **finalize**, and **clean up**.

Every `ts` block below is compiled and executed by the documentation-example test (`packages/testing/tests/documentationExamples.test.ts`, source in `packages/testing/tests/durableUploadsExample.ts`), and that test fails if a block here drifts from the compiled source. Imports use only public paths from [`package-exports.md`](../reference/package-exports.md): `@xonava/core/operation`, `@xonava/core/object-store`, `@xonava/core/storage` and, for the store itself, `@xonava/adapters/storage` (`InMemoryObjectStore` in tests, `R2ObjectStore` on Cloudflare).

## The database and the object store are not atomic

No transaction spans both. Any ordering of "write the row" and "write the object" can be interrupted between the two:

- Object first, row second: a crash leaves an **orphan object** that no row refers to.
- Row first, object second: a crash leaves a **dangling row** that points to nothing.

This protocol accepts orphan objects and makes them harmless and collectable. The database row is the source of truth. An object only counts once a finalized attachment refers to it, and the cleanup step removes every object that never got one.

| Step | Where it runs | What it changes | Safe to repeat because |
| --- | --- | --- | --- |
| Reserve | operation transaction | inserts a reservation row | the client-chosen `reservationId` is the key; the same request returns the same row |
| Upload | outside any transaction | puts one object under a reservation-derived key | the same key and the same bytes replace the object with an identical one |
| Finalize | operation transaction | claims the reservation, inserts the attachment | a finalized reservation returns its existing attachment |
| Clean up | scheduled job | deletes objects of expired, unfinalized reservations | deleting a missing object is a no-op |

## Where authorization and limits run

- **Authorization** runs in the operation's `authorization` port, before `execute`, for reserve and finalize. The tenant and the user come from the trusted request context, never from the input. The upload step has no operation of its own: whichever endpoint accepts the bytes must load the reservation from the database under the caller's session and check its owner before it calls `putReservedObject`. A reservation id alone is not authority.
- **Size and type limits** run in three places. Reserve rejects a declared size or content type outside the limits, so no reservation exists for a disallowed upload. The object store verifies the declared length and SHA-256 against the bytes it receives and refuses a mismatch. Finalize checks the provider's own metadata against the reservation again. The limits in the reservation are the declared ones; only the provider's metadata proves what was stored.
- **Tenant isolation** comes from the object key, which is derived from the tenant and the reservation id and never from the file name, and from tenant-scoped persistence in production. The example filters by tenant itself because its in-memory database is not scoped.

## 1. Model the reservation and the attachment

The reservation row records what the client promised: size, type and SHA-256. Its status moves `reserved` to `finalized`, or `reserved` to `expired` to `deleted`. The attachment row is what the rest of your application refers to; it is built with `defineAttachment` from `@xonava/core/storage`.

```ts
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
```

## 2. Set the limits and authorize

```ts
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
```

```ts
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
```

## 3. Reserve, in the operation transaction

The reservation row is written by an operation, so it commits atomically with anything else the operation does. The client picks `reservationId` and reuses it on every retry. A retry with identical parameters returns the existing reservation; the same id with different parameters is a conflict.

```ts
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
```

## 4. Upload under the reserved key

The upload runs outside the transaction: holding a database transaction open during a network transfer ties up a connection for as long as the upload takes. The key is the one stored in the reservation. The declared length and SHA-256 travel with the `put`, and the reservation id is stored as custom metadata so finalize can tell that the object belongs to this reservation.

```ts
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
```

The reservation check before the `put` is advisory. Nothing stops a reservation from expiring or being claimed between the check and the `put`; that is safe because finalize and cleanup decide using the database, not this check.

## 5. Finalize, reconciling with `head`

Finalize does not trust the client's claim that the upload worked. It calls `head` and compares the provider's size, SHA-256, content type and reservation tag with the reservation. An object that is missing, the wrong size, the wrong checksum, or carries no checksum is refused and left in place for cleanup. A refused finalize changes nothing in the database.

When the object matches, finalize makes one conditional write that moves the reservation from `reserved` to `finalized`. If that write loses to a concurrent finalize or cleanup, finalize fails and its transaction rolls back. The attachment records the exact object version `head` returned, so later overwrites of the key do not silently change what the attachment refers to.

```ts
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
```

Calling finalize again after success returns the stored attachment instead of failing, so a client that lost the response can retry.

## 6. Clean up expired reservations

An object is an orphan when its reservation expired without being finalized: the client never came back, or the process crashed after the `put` and before finalize. Cleanup finds those reservations and deletes their objects.

Cleanup claims a reservation before it deletes anything. It moves `reserved` to `expired` with the same conditional write finalize uses, so for any one reservation exactly one of finalize and cleanup wins. If finalize wins, cleanup leaves the object alone. If cleanup wins, a later finalize sees an expired reservation and refuses. Cleanup then checks that no attachment refers to the key, deletes the object, and marks the reservation `deleted`. A crash after the claim leaves the row `expired`, and the next run finishes the job.

```ts
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
```

This guide shows cleanup as a plain function that a scheduled job calls. It does not register a job definition: wire it into whichever schedule and job runner you use (see [events, jobs, and workflows](events-and-workflows.md)), run it often enough that orphans do not accumulate, and keep it idempotent as shown. Each run handles one page of candidates, so a backlog drains over several runs.

## Retry behaviour at a glance

| Interrupted after | What the client does | Result |
| --- | --- | --- |
| reserve committed, response lost | repeats reserve with the same `reservationId` | the same reservation |
| `put` completed, response lost | repeats the upload | an identical object replaces the first |
| `put` completed, no finalize ever | nothing | cleanup deletes the object after the reservation expires |
| finalize committed, response lost | repeats finalize | the same attachment |
| cleanup claimed, did not delete | nothing | the next cleanup run deletes the object and marks the row `deleted` |

## Caveats

- **Not atomic.** A `deleted` row with a surviving object, or a finalized attachment with a missing object, can still appear if the object store loses data on its own. Finalize proves the object existed at that moment, not that it still exists.
- **Cloudflare R2.** `R2ObjectStore.put` buffers the whole declared-length body in memory, so size limits must be small enough for a Worker, and the limits step above matters. R2's `delete` reports nothing, so the store answers from a preceding `head`; a concurrent writer between the two calls can make the boolean stale, and a versioned delete is check-then-delete. See [object store](../spec/object-store.md). Cleanup does not depend on the boolean. A new `put` to a key after its reservation was claimed by cleanup could be removed by a late delete, which is why the upload step refuses reservations that are not open and why keys are never reused across reservations.
- **Clock skew.** Expiry compares the operation clock with the reservation's stored time. Finalize and cleanup run on different machines, so choose a reservation lifetime that leaves a margin well above any plausible clock difference and above the longest upload.
- **Keys are derived, not chosen.** Never build the object key from the client's file name. The file name is kept as display metadata on the attachment.
- **Specification.** The rules behind this protocol are in [attachments](../spec/attachments.md) and [object store](../spec/object-store.md).
