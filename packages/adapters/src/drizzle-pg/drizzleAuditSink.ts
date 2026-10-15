import type { AuditRecord, AuditSink, AuditSinkFactory } from "@xonava/core/events"
import type { PersistenceProvider } from "@xonava/core/persistence"
import type { DrizzleSessionLike } from "./drizzleRepository"
import type { AnyPgTable } from "drizzle-orm/pg-core"
import { getDrizzleSession } from "./drizzlePersistenceProvider"

export class DrizzleAuditSink implements AuditSink {
  constructor(
    private readonly db: DrizzleSessionLike,
    private readonly table: AnyPgTable,
  ) {}

  async write(record: AuditRecord): Promise<void> {
    await this.db.insert(this.table).values({
      id: record.id,
      createdAt: record.occurredAt,
      tenantId: record.tenantId,
      action: record.action,
      resourceType: record.resourceType,
      resourceId: record.resourceId,
      actorId: record.actor.id,
      actorType: record.actor.kind,
      // Impersonation is authority provenance, never a Principal field.
      impersonatedByAdminId: null,
      oldValue: record.oldValue ? JSON.stringify(record.oldValue) : null,
      newValue: record.newValue ? JSON.stringify(record.newValue) : null,
      metadata: record.metadata ? JSON.stringify(record.metadata) : null,
    })
  }
}

export function createDrizzleAuditSinkFactory(
  table: AnyPgTable,
): AuditSinkFactory {
  return {
    create(persistence: PersistenceProvider) {
      const session = getDrizzleSession(persistence)
      return new DrizzleAuditSink(session, table)
    },
  }
}
