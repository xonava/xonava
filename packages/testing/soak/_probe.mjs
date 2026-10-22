import { Miniflare } from "miniflare"
const [path, id] = process.argv.slice(2)
const mf = new Miniflare({ modules: true, script: `export default { async fetch(r, env) { const c = await r.json(); try { if (c.op==="exec") await env.DB.exec(c.sql); else { const x = await env.DB.prepare(c.sql).bind(...c.p).run(); return Response.json({ok:true, ch:x.meta.changes}) } return Response.json({ok:true}) } catch(e) { return Response.json({err:String(e.message), cause: e.cause && String(e.cause.message)}) } } }`, compatibilityDate: "2025-09-01", d1Databases: { DB: "soak" }, d1Persist: path })
const send = async (b) => (await (await mf.dispatchFetch("http://x/", { method: "POST", body: JSON.stringify(b) })).json())
console.log(id, JSON.stringify(await send({ op: "exec", sql: "CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, w TEXT)" })))
let errs = 0, ok = 0
const t0 = Date.now()
for (let i = 0; i < 300; i++) { const r = await send({ op: "run", sql: "INSERT INTO t VALUES (?,?)", p: [`${id}-${i}`, id] }); if (r.err) { errs++; if (errs < 3) console.log(id, r) } else ok++ }
console.log(id, "ok", ok, "errs", errs, Date.now() - t0, "ms")
await mf.dispose()
