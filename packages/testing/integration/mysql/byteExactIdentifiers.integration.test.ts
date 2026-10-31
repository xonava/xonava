import mysql from "mysql2/promise"
import type { Pool, RowDataPacket } from "mysql2/promise"
import { drizzle } from "drizzle-orm/mysql2"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createDrizzleMySqlIdempotencyStore, DrizzleMySqlSequenceStore, DrizzleMySqlTemporalHistoryStore, mysqlSequenceSchemaSql, mysqlTemporalSchemaSql,
} from "@xonava/adapters/drizzle-mysql"
import { bootstrapMySqlFixture } from "../../fixtures/mysql/bootstrap.js"
import { mysqlIdempotency } from "../../fixtures/mysql/schema.js"
import { mysqlCertificationUrl } from "./database.js"

// Identifier columns compare byte-for-byte (docs/spec/sequence.md): 'a' vs 'a ' (PAD SPACE), 'K' vs 'k' (case folding) and
// non-ASCII scopes must stay distinct. FIXTURE is built by the fixture migrations (including 0006); ADAPTER by the adapters' own DDL.
const FIXTURE = "framework_byte_exact_fixture"
const ADAPTER = "framework_byte_exact_adapter"
const SCOPES = ["a", "a ", "K", "k", "é", "é", "日本語", "😀", "A".repeat(1024), `${"A".repeat(1023)}B`] as const

function urlFor(database: string): string { const url = new URL(mysqlCertificationUrl()); url.pathname = `/${database}`; return url.toString() }

describe("MySQL byte-exact identifier columns", () => {
  let admin: Pool
  let fixture: Pool
  let adapter: Pool
  beforeAll(async () => {
    admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    for (const database of [FIXTURE, ADAPTER]) { await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.query(`CREATE DATABASE \`${database}\``) }
    fixture = mysql.createPool({ uri: urlFor(FIXTURE), connectionLimit: 6 })
    adapter = mysql.createPool({ uri: urlFor(ADAPTER), connectionLimit: 6 })
    await bootstrapMySqlFixture(fixture)
    await bootstrapMySqlFixture(fixture) // re-applying the migrations is harmless
    await adapter.query(mysqlSequenceSchemaSql())
    for (const statement of mysqlTemporalSchemaSql().split(";").map((value) => value.trim()).filter(Boolean)) await adapter.query(statement)
  })
  afterAll(async () => {
    await fixture?.end(); await adapter?.end()
    for (const database of [FIXTURE, ADAPTER]) await admin?.query(`DROP DATABASE IF EXISTS \`${database}\``)
    await admin?.end()
  })

  for (const [label, pool] of [["fixture migrations", () => fixture], ["adapter DDL", () => adapter]] as const) {
    describe(label, () => {
      it("sequences count every distinct scope separately", async () => {
        const store = new DrizzleMySqlSequenceStore(pool())
        for (const scope of SCOPES) expect(await store.next(scope as never, "invoice", "never")).toBe(1)
        for (const scope of SCOPES) expect(await store.next(scope as never, "invoice", "never")).toBe(2)
        const [rows] = await pool().query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM sequences")
        expect(Number(rows[0]!.n)).toBe(SCOPES.length)
      })
      it("temporal history keeps distinct scopes apart", async () => {
        const store = new DrizzleMySqlTemporalHistoryStore<{ v: string }>(pool())
        for (const scope of SCOPES) {
          const resource = { scopeId: scope as never, entityType: "invoice", entityId: "one" }
          expect((await store.append({ ...resource, occurredAt: new Date(1_000), kind: "created", state: { v: scope.slice(0, 4) } })).revision).toBe(1)
          expect((await store.append({ ...resource, occurredAt: new Date(2_000), kind: "updated", state: { v: "u" } })).revision).toBe(2)
          await store.saveSnapshot({ ...resource, revision: 2, occurredAt: new Date(2_000), state: { v: "s" } })
        }
        for (const scope of SCOPES) {
          const resource = { scopeId: scope as never, entityType: "invoice", entityId: "one" }
          const page = await store.revisions(resource, { afterRevision: 0, asOf: new Date(10_000), limit: 10 })
          expect(page.items.map((item) => [item.scopeId, item.revision])).toEqual([[scope, 1], [scope, 2]])
          expect((await store.latestSnapshot(resource, new Date(10_000)))?.scopeId).toBe(scope)
        }
      })
    })
  }

  it("idempotency scopes and keys differing by case, trailing space or Unicode do not collide", async () => {
    const store = createDrizzleMySqlIdempotencyStore<unknown>(drizzle(fixture) as never, mysqlIdempotency)
    const identities = [["scope", "key"], ["scope", "key "], ["scope", "KEY"], ["SCOPE", "key"], ["scope ", "key"], ["scopé", "ключ"], ["scope", "😀"]] as const
    for (const [scope, key] of identities) expect((await store.acquire({ scope, key, fingerprint: `${scope}|${key}`, leaseDurationMs: 60_000 })).outcome).toBe("acquired")
    for (const [scope, key] of identities) expect((await store.acquire({ scope, key, fingerprint: `${scope}|${key}`, leaseDurationMs: 60_000 })).outcome).not.toBe("acquired")
    const [rows] = await fixture.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM idempotency")
    expect(Number(rows[0]!.n)).toBe(identities.length)
  })

  it("every identifier column of the fixture schema uses a NO PAD binary collation", async () => {
    const [rows] = await fixture.query<RowDataPacket[]>(
      "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLLATION_NAME AS co FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE IN ('varchar','char')")
    // Domain data (not identifiers), and sequence/temporal names, periods and keys limited to [A-Za-z0-9._:-] or digits (ascii_bin is exact for them).
    const exempt = new Set(["records.name", "schedules.cron_expression", "schedules.description"])
    const bad = rows.filter((r) => !exempt.has(`${r.t}.${r.c}`) && !String(r.t).startsWith("temporal_") && r.t !== "sequences" && r.co !== "utf8mb4_0900_bin").map((r) => `${r.t}.${r.c}: ${r.co}`)
    expect(bad).toEqual([])
    for (const table of ["jobs", "schedules"]) expect(rows.find((r) => r.t === table && r.c === "scope_key")?.co).toBe("utf8mb4_0900_bin")
    const [generated] = await fixture.query<RowDataPacket[]>("SELECT GENERATION_EXPRESSION AS e FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND COLUMN_NAME = 'active_partition_tenant'")
    expect(String(generated[0]!.e)).toContain("scope_key")
    const [padding] = await fixture.query<RowDataPacket[]>("SELECT 'a' = 'a ' COLLATE utf8mb4_0900_bin AS padded")
    expect(Number(padding[0]!.padded)).toBe(0)
  })
})
