import { pgSchemaName } from "./pgSchemaName"
import { pgDate } from "./pgUtils"
import type { NewTemporalRevision, TemporalHistoryStore, TemporalResource, TemporalRevision, TemporalRevisionPage, TemporalSnapshot } from "@xonava/core/temporal"
import { validateTemporalRevision, validateTemporalSnapshot } from "@xonava/core/temporal"
import { ConflictError } from "@xonava/core/domain"

interface PgResult { rows: Record<string, unknown>[] }
export interface PgTemporalClient { query(text: string, values?: unknown[]): Promise<PgResult> }
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T
function decode<T extends Readonly<Record<string, unknown>>>(row: Record<string, unknown>): TemporalRevision<T> {
  return validateTemporalRevision({ scopeId: String(row.scope_id) as TemporalResource["scopeId"], entityType: String(row.entity_type), entityId: String(row.entity_id), revision: Number(row.revision), occurredAt: pgDate(row.occurred_at), kind: row.kind as TemporalRevision["kind"], state: row.state == null ? null : json<T>(row.state), ...(row.entity_version == null ? {} : { entityVersion: Number(row.entity_version) }), ...(row.event_id == null ? {} : { eventId: String(row.event_id) }), ...(row.audit_id == null ? {} : { auditId: String(row.audit_id) }) })
}

export class DrizzlePgTemporalHistoryStore<T extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> implements TemporalHistoryStore<T> {
  constructor(private readonly db: PgTemporalClient, private readonly schema = "public") { pgSchemaName(schema) }
  async append(value: NewTemporalRevision<T>): Promise<TemporalRevision<T>> {
    const input = validateTemporalRevision({ ...value, revision: 1 })
    // PostgreSQL evaluates CHECK constraints on the proposed row before it
    // resolves ON CONFLICT, so an upsert that proposes revision 1 with a
    // non-"created" kind always fails. Advance an existing head with a guarded
    // UPDATE (row-locked, re-checked after the lock) and insert a new head only
    // for "created". Anything else returns no row and is rejected below.
    const h = `${this.schema}.temporal_heads`
    const result = await this.db.query(`WITH advanced AS (UPDATE ${h} SET revision=revision+1,occurred_at=$4,kind=$5::text WHERE scope_id=$1 AND entity_type=$2 AND entity_id=$3 AND occurred_at<=$4 AND ((kind='deleted' AND $5::text='restored') OR (kind<>'deleted' AND $5::text IN ('updated','deleted'))) RETURNING revision), created AS (INSERT INTO ${h}(scope_id,entity_type,entity_id,revision,occurred_at,kind) SELECT $1,$2,$3,1,$4,$5::text WHERE $5::text='created' AND NOT EXISTS (SELECT 1 FROM advanced) ON CONFLICT(scope_id,entity_type,entity_id) DO NOTHING RETURNING revision), next AS (SELECT revision FROM advanced UNION ALL SELECT revision FROM created) INSERT INTO ${this.schema}.temporal_revisions(scope_id,entity_type,entity_id,revision,occurred_at,kind,state,entity_version,event_id,audit_id) SELECT $1,$2,$3,next.revision,$4,$5::text,$6::jsonb,$7,$8,$9 FROM next RETURNING *`, [input.scopeId, input.entityType, input.entityId, input.occurredAt, input.kind, input.state === null ? null : JSON.stringify(input.state), input.entityVersion ?? null, input.eventId ?? null, input.auditId ?? null])
    if (!result.rows[0]) throw new ConflictError("Temporal revision rejected: not chronological, not a valid lifecycle transition, or the entity already exists")
    return decode<T>(result.rows[0])
  }
  async saveSnapshot(value: TemporalSnapshot<T>): Promise<void> { const s = validateTemporalSnapshot(value); await this.db.query(`INSERT INTO ${this.schema}.temporal_snapshots(scope_id,entity_type,entity_id,revision,occurred_at,state) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`, [s.scopeId, s.entityType, s.entityId, s.revision, s.occurredAt, s.state === null ? null : JSON.stringify(s.state)]) }
  async latestSnapshot(resource: TemporalResource, asOf: Date): Promise<TemporalSnapshot<T> | null> { const result = await this.db.query(`SELECT * FROM ${this.schema}.temporal_snapshots WHERE scope_id=$1 AND entity_type=$2 AND entity_id=$3 AND occurred_at<=$4 ORDER BY revision DESC LIMIT 1`, [resource.scopeId, resource.entityType, resource.entityId, asOf]); const row = result.rows[0]; return row ? validateTemporalSnapshot({ ...resource, revision: Number(row.revision), occurredAt: pgDate(row.occurred_at), state: row.state == null ? null : json<T>(row.state) }) : null }
  async revisions(resource: TemporalResource, options: { afterRevision: number; asOf: Date; limit: number }): Promise<TemporalRevisionPage<T>> { const result = await this.db.query(`SELECT * FROM ${this.schema}.temporal_revisions WHERE scope_id=$1 AND entity_type=$2 AND entity_id=$3 AND revision>$4 AND occurred_at<=$5 ORDER BY revision LIMIT $6`, [resource.scopeId, resource.entityType, resource.entityId, options.afterRevision, options.asOf, options.limit + 1]); return { items: result.rows.slice(0, options.limit).map(decode<T>), hasMore: result.rows.length > options.limit } }
}

/** DDL for this store in the given schema. */
export function postgresTemporalSchemaSql(schema = "public"): string {
  pgSchemaName(schema)
  return `CREATE TABLE IF NOT EXISTS ${schema}.temporal_heads(scope_id text NOT NULL,entity_type text NOT NULL,entity_id text NOT NULL,revision bigint NOT NULL CHECK(revision>0),occurred_at timestamptz NOT NULL,kind text NOT NULL CHECK(kind IN ('created','updated','deleted','restored')),CHECK(revision>1 OR kind='created'),PRIMARY KEY(scope_id,entity_type,entity_id));CREATE TABLE IF NOT EXISTS ${schema}.temporal_revisions(scope_id text NOT NULL,entity_type text NOT NULL,entity_id text NOT NULL,revision bigint NOT NULL CHECK(revision>0),occurred_at timestamptz NOT NULL,kind text NOT NULL CHECK(kind IN ('created','updated','deleted','restored')),state jsonb,entity_version bigint,event_id text,audit_id text,CHECK((kind='deleted' AND state IS NULL) OR (kind<>'deleted' AND state IS NOT NULL)),PRIMARY KEY(scope_id,entity_type,entity_id,revision));CREATE INDEX IF NOT EXISTS temporal_revisions_time_idx ON ${schema}.temporal_revisions(scope_id,entity_type,entity_id,occurred_at,revision);CREATE TABLE IF NOT EXISTS ${schema}.temporal_snapshots(scope_id text NOT NULL,entity_type text NOT NULL,entity_id text NOT NULL,revision bigint NOT NULL CHECK(revision>=0),occurred_at timestamptz NOT NULL,state jsonb,PRIMARY KEY(scope_id,entity_type,entity_id,revision));`
}
/** @deprecated use postgresTemporalSchemaSql(schema); kept for the test fixture schema. */
export const POSTGRES_TEMPORAL_SCHEMA_SQL = postgresTemporalSchemaSql("framework_test")
