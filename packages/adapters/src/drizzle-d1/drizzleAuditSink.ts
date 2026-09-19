import type { AuditRecord, AuditSink, AuditSinkFactory } from "core/events"
import type { PersistenceProvider } from "core/persistence"
import type { DrizzleSessionLike } from "./drizzleRepository"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"
import { getDrizzleSession } from "./drizzlePersistenceProvider"
import { mapAuditRecord, type AuditRecordMapper } from "./drizzlePersistenceProvider"

/**
 * Writes audit records to a D1 SQLite table via an atomic batch.
 *
 * **D1 Audit Contract:**
 *
 * - `newValue` on each {@link AuditRecord} captures *mutation intent* — the command-level
 *   values supplied by the caller — not the database-real post-state. Database defaults,
 *   triggers, generated columns, or server-side transforms can therefore cause the
 *   committed row to differ from what the audit log records.
 * - This gap is an intentional trade-off for atomic batch design: D1 atomic
 *   batches execute as a single write, but there is no read-after-write visibility
 *   inside the batch, so capturing the true post-state would require an extra round-trip
 *   that breaks atomicity guarantees.
 * - Audit writes are **not** transactionally coupled with the business writes they
 *   accompany. The audit insert is part of the same D1 atomic batch, but a failure in
 *   the audit path does not roll back the business mutation, and vice-versa. Consumers
 *   should treat the audit log as an eventually-consistent, intent-level record.
 */
export class DrizzleAuditSink implements AuditSink {
  constructor(
    private readonly db: DrizzleSessionLike,
    private readonly table: AnySQLiteTable,
    private readonly mapRecord: AuditRecordMapper = mapAuditRecord,
  ) {}

  async write(record: AuditRecord): Promise<void> {
    await this.db.insert(this.table).values({
      ...this.mapRecord(record),
      id: record.id,
    })
  }
}

export function createDrizzleAuditSinkFactory(
  table: AnySQLiteTable,
  mapRecord?: AuditRecordMapper,
): AuditSinkFactory {
  return {
    create(persistence: PersistenceProvider) {
      const session = getDrizzleSession(persistence)
      return new DrizzleAuditSink(session, table, mapRecord)
    },
  }
}
