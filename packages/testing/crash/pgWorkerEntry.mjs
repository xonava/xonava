import pg from "pg"

const [url, failpoint, mode = "execute"] = process.argv.slice(2)
if (!url || !failpoint) throw new Error("worker requires PostgreSQL URL and failpoint")

const db = new pg.Client({ connectionString: url })
await db.connect()
const pause = async () => {
  process.stdout.write(`FAILPOINT:${failpoint}\n`)
  await new Promise(() => { setInterval(() => undefined, 60_000) })
}

if (failpoint === "before-transaction" && mode === "execute") await pause()
await db.query("BEGIN")
await db.query("INSERT INTO framework_test.records(id,tenant_id,value) VALUES('r','t','{}') ON CONFLICT DO NOTHING")
if (failpoint === "after-business-before-commit" && mode === "execute") await pause()
await db.query("INSERT INTO framework_test.audit(id,tenant_id,record_id,payload) VALUES('a','t','r','{}') ON CONFLICT DO NOTHING")
await db.query("INSERT INTO framework_test.outbox(id,tenant_id,payload) VALUES('o','t','{}') ON CONFLICT DO NOTHING")
await db.query("INSERT INTO framework_test.cache_generations(scope,generation) VALUES('t',1) ON CONFLICT DO NOTHING")
await db.query("INSERT INTO framework_test.idempotency(scope,key,fingerprint,status,response) VALUES('t','k','fp','committed','{\"id\":\"r\"}') ON CONFLICT DO NOTHING")
await db.query("INSERT INTO framework_test.sequences(scope_id,name,period,value) VALUES('t','invoice','all',1) ON CONFLICT DO NOTHING")
await db.query("INSERT INTO framework_test.temporal_heads(scope_id,entity_type,entity_id,revision,occurred_at,kind) VALUES('t','record','r',1,'2026-01-01T00:00:00Z','created') ON CONFLICT DO NOTHING")
await db.query("INSERT INTO framework_test.temporal_revisions(scope_id,entity_type,entity_id,revision,occurred_at,kind,state) VALUES('t','record','r',1,'2026-01-01T00:00:00Z','created','{\"id\":\"r\"}') ON CONFLICT DO NOTHING")
if (failpoint === "after-participants-before-commit" && mode === "execute") await pause()
await db.query("COMMIT")
if ((failpoint === "after-commit-before-response" || failpoint === "after-commit-before-finalization") && mode === "execute") await pause()
if (failpoint === "during-replay-before-response" && mode === "recover") await pause()
process.stdout.write("COMPLETE\n")
await db.end()
