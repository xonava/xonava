import { uuidv7 } from "uuidv7"
import { assertOutboxScope, type OutboxRecord, type OutboxSink, type OutboxSinkFactory } from "core/events"
import type { PersistenceProvider } from "core/persistence"
import type { DrizzleSessionLike } from "./drizzleRepository"
import type { AnyColumn } from "drizzle-orm"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"
import { and, eq } from "drizzle-orm"
import { ConfigurationError } from "core/domain"
import { getDrizzleSession, PLATFORM_IDEMPOTENCY_SCOPE } from "./drizzlePersistenceProvider"
import { assertOutboxFingerprintMatches, assertOutboxProtectedFields, fingerprintOutboxRecord, outboxProvenanceColumn } from "../drizzle-shared/outbox"
import { getAffectedRows } from "./d1Utils"
import { validateD1AtomicOutboxColumns, type D1OutboxColumns } from "./d1OutboxSchema"

type OutboxColumns = D1OutboxColumns & { idempotencyScope: AnyColumn; idempotencyKey: AnyColumn }

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function scopeAndKey(columns: OutboxColumns, record: OutboxRecord) {
  return and(
    eq(columns.idempotencyScope, record.scopeId),
    eq(columns.idempotencyKey, record.idempotencyKey),
  )
}

export class DrizzleOutboxSink implements OutboxSink {
  constructor(
    private readonly db: DrizzleSessionLike,
    private readonly table: AnySQLiteTable,
    private readonly mapRecord: (record: OutboxRecord) => Record<string, unknown>,
  ) {}

  async append(record: OutboxRecord): Promise<void> {
    assertOutboxScope(record)
    const columns = this.table as OutboxColumns
    validateD1AtomicOutboxColumns(this.table)
    const fingerprint = await fingerprintOutboxRecord(record)
    const mapped = this.mapRecord(record)
    const id = record.id ?? uuidv7()
    const scope = record.scopeId
    assertOutboxProtectedFields(mapped, {
      id,
      tenantId: record.tenantId,
      idempotencyScope: scope,
      idempotencyKey: record.idempotencyKey,
      eventFingerprint: fingerprint,
    })
    const insertion = this.db.insert(this.table).values({
      ...mapped,
      id,
      ...(columns.tenantId ? { tenantId: record.tenantId } : {}),
      idempotencyScope: scope,
      idempotencyKey: record.idempotencyKey,
      eventFingerprint: fingerprint,
      ...outboxProvenanceColumn(columns, record),
    })
    if (typeof (insertion as { onConflictDoNothing?: unknown }).onConflictDoNothing !== "function") {
      throw new ConfigurationError("D1 outbox requires Drizzle onConflictDoNothing support")
    }
    const result = await (insertion as {
      onConflictDoNothing: (config: { target: AnyColumn[] }) => Promise<unknown>
    }).onConflictDoNothing({ target: [columns.idempotencyScope, columns.idempotencyKey] })
    if (getAffectedRows(result) === 0) {
      const conflictRows = await this.db
        .select()
        .from(this.table)
        .where(scopeAndKey(columns, record))
        .limit(1)
      const conflict = conflictRows[0]
      if (!isRow(conflict)) throw new Error("Outbox conflict row disappeared")
      assertOutboxFingerprintMatches(conflict.eventFingerprint, fingerprint)
    }
  }
}

export function createDrizzleOutboxSinkFactory(
  table: AnySQLiteTable,
  mapRecord: (record: OutboxRecord) => Record<string, unknown>,
): OutboxSinkFactory {
  return {
    create(persistence: PersistenceProvider) {
      const session = getDrizzleSession(persistence)
      return new DrizzleOutboxSink(session, table, mapRecord)
    },
  }
}
