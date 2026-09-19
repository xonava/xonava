import { assertOutboxScope, type OutboxRecord, type OutboxSink, type OutboxSinkFactory } from "core/events"
import type { PersistenceProvider } from "core/persistence"
import type { DrizzleSessionLike } from "./drizzleRepository"
import type { AnyPgTable } from "drizzle-orm/pg-core"
import { getTableColumns, sql, type AnyColumn } from "drizzle-orm"
import { ConfigurationError } from "core/domain"
import { getDrizzleSession } from "./drizzlePersistenceProvider"
import { assertOutboxFingerprintMatches, assertOutboxProtectedFields, fingerprintOutboxRecord } from "../drizzle-shared/outbox"
export type OutboxFingerprintRecord = Pick<OutboxRecord, "type" | "version" | "scopeId" | "aggregateType" | "aggregateId" | "payload">
export { fingerprintOutboxRecord as computeOutboxFingerprint }

export class DrizzleOutboxSink implements OutboxSink {
  constructor(
    private readonly db: DrizzleSessionLike,
    private readonly table: AnyPgTable,
    private readonly mapRecord: (record: OutboxRecord) => Record<string, unknown>,
  ) {}

  async append(record: OutboxRecord): Promise<void> {
    assertOutboxScope(record)
    const mapped = this.mapRecord(record)
    const fingerprint = await fingerprintOutboxRecord(record)
    const columns = getTableColumns(this.table) as Record<string, AnyColumn>
    // Prefer the explicit scope column: unlike nullable tenantId, it can
    // represent platform events in the same uniqueness constraint.
    const scopeColumn = columns.idempotencyScope ?? columns.tenantId
    if (!scopeColumn || !columns.idempotencyKey) {
      throw new ConfigurationError("PostgreSQL outbox requires tenantId or idempotencyScope and idempotencyKey columns")
    }
    if (!columns.idempotencyScope && record.tenantId == null) {
      throw new ConfigurationError("PostgreSQL platform outbox events require an idempotencyScope column")
    }

    const derivedScope = record.scopeId
    assertOutboxProtectedFields(mapped, {
      id: record.id,
      tenantId: record.tenantId,
      idempotencyScope: derivedScope,
      idempotencyKey: record.idempotencyKey,
      eventFingerprint: fingerprint,
    })

    const insertion = this.db.insert(this.table).values({
      ...mapped,
      // The framework owns the durable event identity; mappers cannot replace it.
      id: record.id,
      ...(columns.tenantId ? { tenantId: record.tenantId } : {}),
      ...(columns.idempotencyScope ? { idempotencyScope: derivedScope } : {}),
      idempotencyKey: record.idempotencyKey,
      eventFingerprint: fingerprint,
    })
    if (typeof insertion.onConflictDoNothing !== "function") {
      throw new ConfigurationError("PostgreSQL outbox requires Drizzle onConflictDoNothing support")
    }
    const insertResult = await insertion.onConflictDoNothing({ target: [scopeColumn, columns.idempotencyKey] })
    if (typeof insertResult === "object" && insertResult !== null && "rowCount" in insertResult && (insertResult as { rowCount?: unknown }).rowCount !== 0) return

    const scopeValue = columns.idempotencyScope ? derivedScope : record.tenantId ?? null
    const [existing] = await this.db
      .select()
      .from(this.table)
      .where(sql`${scopeColumn} IS NOT DISTINCT FROM ${scopeValue} AND ${columns.idempotencyKey} = ${record.idempotencyKey}`)
      .limit(1)
    const existingRow = existing as Record<string, unknown> | undefined
    const existingFingerprint = existingRow?.eventFingerprint ?? existingRow?.event_fingerprint
    assertOutboxFingerprintMatches(existingFingerprint, fingerprint)
  }
}

export function createDrizzleOutboxSinkFactory(
  table: AnyPgTable,
  mapRecord: (record: OutboxRecord) => Record<string, unknown>,
): OutboxSinkFactory {
  return {
    create(persistence: PersistenceProvider) {
      const session = getDrizzleSession(persistence)
      return new DrizzleOutboxSink(session, table, mapRecord)
    },
  }
}
