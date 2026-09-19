import type {AnyMySqlTable} from "drizzle-orm/mysql-core"
import type { AuditRecord, AuditSink, AuditSinkFactory } from "core/events"
import type { PersistenceProvider } from "core/persistence"
import type {MySqlDatabaseLike} from "./drizzleRepository"
import {getDrizzleMySqlSession} from "./drizzlePersistenceProvider"

export class DrizzleMySqlAuditSink implements AuditSink{
  constructor(private readonly db:MySqlDatabaseLike,private readonly table:AnyMySqlTable){}
  async write(record:AuditRecord){await this.db.insert(this.table).values({id:record.id,createdAt:record.occurredAt,tenantId:record.tenantId,action:record.action,resourceType:record.resourceType,resourceId:record.resourceId,actorId:record.actor.id,actorType:record.actor.kind,oldValue:record.oldValue,newValue:record.newValue,metadata:record.metadata??null})}
}
export const createDrizzleMySqlAuditSinkFactory=(table:AnyMySqlTable):AuditSinkFactory=>({create:(persistence:PersistenceProvider)=>new DrizzleMySqlAuditSink(getDrizzleMySqlSession(persistence),table)})
