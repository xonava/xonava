import { ConfigurationError } from "../domain"
import { assertEntityVersion } from "../serialization"
import { snapshotData } from "../kernel/snapshotData"
import type { TemporalHistoryStore, TemporalReconstruction, TemporalResource, TemporalRevision, TemporalSnapshot } from "./types"

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
// RegExp#test coerces its argument (["a"] and 5 would match), so identities must be checked as strings first.
const isKey = (value: unknown): boolean => typeof value === "string" && KEY_PATTERN.test(value)
function validDate(value: unknown): value is Date { return value instanceof Date && !Number.isNaN(value.getTime()) }
function resource(value: TemporalResource): void { if (!value || typeof value.scopeId !== "string" || !value.scopeId || value.scopeId.length > 1024 || /[\0\r\n]/.test(value.scopeId) || !isKey(value.entityType) || !isKey(value.entityId)) throw new ConfigurationError("Temporal resource identity is invalid") }
function revision(value: number, allowZero = false): void { if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new ConfigurationError("Temporal revision must be a positive safe integer") }
function state(value: unknown): void { if (value !== null && (!value || typeof value !== "object" || Array.isArray(value))) throw new ConfigurationError("Temporal state must be a record or null") }

export function validateTemporalRevision<TState extends Readonly<Record<string, unknown>>>(value: TemporalRevision<TState>): TemporalRevision<TState> {
  resource(value); revision(value.revision); if (!validDate(value.occurredAt)) throw new ConfigurationError("Temporal revision timestamp is invalid")
  if (!["created", "updated", "deleted", "restored"].includes(value.kind)) throw new ConfigurationError("Temporal revision kind is invalid")
  state(value.state)
  if (value.kind === "deleted" && value.state !== null) throw new ConfigurationError("Deleted temporal revision must have null state")
  if (value.kind !== "deleted" && value.state === null) throw new ConfigurationError("Non-deleted temporal revision must have state")
  if (value.entityVersion !== undefined) assertEntityVersion(value.entityVersion)
  for (const [name, id] of [["event", value.eventId], ["audit", value.auditId]] as const) if (id !== undefined && !isKey(id)) throw new ConfigurationError(`Temporal ${name} identity is invalid`)
  return snapshotData(value, { label: "Temporal revision" })
}

export function validateTemporalSnapshot<TState extends Readonly<Record<string, unknown>>>(value: TemporalSnapshot<TState>): TemporalSnapshot<TState> {
  resource(value); revision(value.revision, true); if (!validDate(value.occurredAt)) throw new ConfigurationError("Temporal snapshot timestamp is invalid"); state(value.state)
  if (value.revision === 0 && value.state !== null) throw new ConfigurationError("A revision-0 temporal snapshot cannot carry state")
  return snapshotData(value, { label: "Temporal snapshot" })
}

export async function reconstructAsOf<TState extends Readonly<Record<string, unknown>>>(store: TemporalHistoryStore<TState>, target: TemporalResource, asOf: Date, options: { maxRevisions?: number; pageSize?: number } = {}): Promise<TemporalReconstruction<TState>> {
  resource(target); if (!validDate(asOf)) throw new ConfigurationError("Temporal as-of timestamp is invalid")
  const max = options.maxRevisions ?? 10_000, pageSize = options.pageSize ?? Math.min(250, max)
  if (!Number.isSafeInteger(max) || max < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > max) throw new ConfigurationError("Temporal replay limits are invalid")
  const base = await store.latestSnapshot(target, asOf)
  let currentRevision = 0, currentState: TState | null = null, replayed = 0, cursor = 0
  if (base) { const checked = validateTemporalSnapshot<TState>(base); if (checked.scopeId !== target.scopeId || checked.entityType !== target.entityType || checked.entityId !== target.entityId) throw new ConfigurationError("Temporal store returned a snapshot outside the request"); if (checked.occurredAt > asOf) throw new ConfigurationError("Temporal store returned a future snapshot"); currentRevision = checked.revision; cursor = checked.revision; currentState = checked.state }
  while (true) {
    const page = await store.revisions(target, { afterRevision: cursor, asOf, limit: Math.min(pageSize, max - replayed) })
    if (!page || !Array.isArray(page.items) || typeof page.hasMore !== "boolean" || (page.hasMore && page.items.length === 0)) throw new ConfigurationError("Temporal store returned an invalid revision page")
    for (const raw of page.items) {
      const item = validateTemporalRevision<TState>(raw)
      if (item.scopeId !== target.scopeId || item.entityType !== target.entityType || item.entityId !== target.entityId || item.occurredAt > asOf) throw new ConfigurationError("Temporal store returned a revision outside the request")
      if (item.revision !== cursor + 1) throw new ConfigurationError("Temporal revision stream is not contiguous")
      if (cursor === 0 && item.kind !== "created") throw new ConfigurationError("Temporal revision stream must begin with creation")
      if (cursor > 0 && currentState === null && item.kind !== "restored") throw new ConfigurationError("Deleted temporal state must be restored before further updates")
      if (cursor > 0 && currentState !== null && item.kind !== "updated" && item.kind !== "deleted") throw new ConfigurationError("Active temporal state only accepts update or deletion")
      cursor = currentRevision = item.revision; currentState = item.state; replayed++
      if (replayed > max) throw new ConfigurationError("Temporal replay exceeds the configured revision limit")
    }
    if (!page.hasMore) break
    if (replayed >= max) throw new ConfigurationError("Temporal replay exceeds the configured revision limit")
  }
  return snapshotData({ resource: target, asOf, revision: currentRevision || null, state: currentState, deleted: currentRevision > 0 && currentState === null, replayedRevisions: replayed }, { label: "Temporal reconstruction" })
}
