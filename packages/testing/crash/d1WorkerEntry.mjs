import { Miniflare } from "miniflare"

const [persistPath, failpoint, mode = "execute"] = process.argv.slice(2)
if (!persistPath || !failpoint) throw new Error("worker requires D1 persistence path and failpoint")
const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('framework-d1-worker') } }",
  compatibilityDate: "2025-09-01",
  d1Databases: { DB: "framework-certification" },
  d1Persist: persistPath,
})
const db = await mf.getD1Database("DB")
await db.exec("CREATE TABLE IF NOT EXISTS framework_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS framework_idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, response TEXT, PRIMARY KEY (scope, key)); CREATE TABLE IF NOT EXISTS framework_outbox (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS framework_audit (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, record_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS framework_cache_generations (scope TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0)")
await db.exec("CREATE TABLE IF NOT EXISTS framework_sequences(scope_id TEXT NOT NULL,name TEXT NOT NULL,period TEXT NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(scope_id,name,period)); CREATE TABLE IF NOT EXISTS framework_temporal_heads(scope_id TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,revision INTEGER NOT NULL,occurred_at_ms INTEGER NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(scope_id,entity_type,entity_id)); CREATE TABLE IF NOT EXISTS framework_temporal_revisions(scope_id TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,revision INTEGER NOT NULL,occurred_at_ms INTEGER NOT NULL,kind TEXT NOT NULL,state TEXT,PRIMARY KEY(scope_id,entity_type,entity_id,revision));")
const pause = async () => {
  process.stdout.write(`FAILPOINT:${failpoint}\n`)
  await new Promise(() => { setInterval(() => undefined, 60_000) })
}
if (failpoint === "before-transaction" && mode === "execute") await pause()
const batch = [
  db.prepare("INSERT OR IGNORE INTO framework_records VALUES('r','t','{}',1)"),
  db.prepare("INSERT OR IGNORE INTO framework_audit VALUES('a','t','r','{}','now')"),
  db.prepare("INSERT OR IGNORE INTO framework_outbox VALUES('o','t','{}','now')"),
  db.prepare("INSERT OR IGNORE INTO framework_cache_generations VALUES('t',1)"),
  db.prepare("INSERT OR IGNORE INTO framework_idempotency VALUES('t','k','fp','committed','{\"id\":\"r\"}')"),
  db.prepare("INSERT OR IGNORE INTO framework_sequences VALUES('t','invoice','all',1)"),
  db.prepare("INSERT OR IGNORE INTO framework_temporal_heads(scope_id,entity_type,entity_id,revision,occurred_at_ms,kind) VALUES('t','record','r',1,1767225600000,'created')"),
  db.prepare("INSERT OR IGNORE INTO framework_temporal_revisions(scope_id,entity_type,entity_id,revision,occurred_at_ms,kind,state) VALUES('t','record','r',1,1767225600000,'created','{\"id\":\"r\"}')"),
]
if ((failpoint === "after-business-before-commit" || failpoint === "after-participants-before-commit") && mode === "execute") await pause()
await db.batch(batch)
if ((failpoint === "after-commit-before-response" || failpoint === "after-commit-before-finalization") && mode === "execute") await pause()
if (failpoint === "during-replay-before-response" && mode === "recover") await pause()
process.stdout.write("COMPLETE\n")
await mf.dispose()
