import {outboxProvenanceColumn} from "../drizzle-shared/outbox"
import {and,eq,getTableColumns,sql,type AnyColumn} from "drizzle-orm"
import type {AnyMySqlTable} from "drizzle-orm/mysql-core"
import {ConfigurationError} from "core/domain"
import type { OutboxRecord, OutboxSink, OutboxSinkFactory } from "core/events"
import type { PersistenceProvider } from "core/persistence"
import {assertOutboxFingerprintMatches,assertOutboxProtectedFields,fingerprintOutboxRecord} from "../drizzle-shared/outbox"
import type {MySqlDatabaseLike} from "./drizzleRepository"
import {getDrizzleMySqlSession} from "./drizzlePersistenceProvider"

export class DrizzleMySqlOutboxSink implements OutboxSink{
  constructor(private readonly db:MySqlDatabaseLike,private readonly table:AnyMySqlTable,private readonly mapRecord:(record:OutboxRecord)=>Record<string,unknown>){}
  async append(record:OutboxRecord){const columns=getTableColumns(this.table) as Record<string,AnyColumn>;const scopeColumn=columns.idempotencyScope??columns.tenantId;if(!scopeColumn||!columns.idempotencyKey||!columns.id||!columns.eventFingerprint)throw new ConfigurationError("MySQL outbox requires id, idempotency scope, idempotency key and event fingerprint columns");const scope=record.scopeId;const fingerprint=await fingerprintOutboxRecord(record);const mapped=this.mapRecord(record);assertOutboxProtectedFields(mapped,{id:record.id,tenantId:record.tenantId,idempotencyScope:scope,idempotencyKey:record.idempotencyKey,eventFingerprint:fingerprint});await this.db.insert(this.table).values({...mapped,...outboxProvenanceColumn(columns,record),id:record.id,...(columns.tenantId?{tenantId:record.tenantId??null}:{}),...(columns.idempotencyScope?{idempotencyScope:scope}:{}),idempotencyKey:record.idempotencyKey,eventFingerprint:fingerprint}).onDuplicateKeyUpdate({set:{id:sql`${columns.id}`}});const [existing]=await this.db.select().from(this.table).where(and(eq(scopeColumn,scope),eq(columns.idempotencyKey,record.idempotencyKey))).limit(1);if(!existing)throw new Error("MySQL outbox conflict row disappeared");assertOutboxFingerprintMatches((existing as Record<string,unknown>).eventFingerprint,fingerprint)}
}
export const createDrizzleMySqlOutboxSinkFactory=(table:AnyMySqlTable,mapRecord:(record:OutboxRecord)=>Record<string,unknown>):OutboxSinkFactory=>({create:(persistence:PersistenceProvider)=>new DrizzleMySqlOutboxSink(getDrizzleMySqlSession(persistence),table,mapRecord)})
