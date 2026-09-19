import type { D1Database } from "../integration/d1/database.js"
export interface CrashOracleState { business: number; audit: number; outbox: number; cacheGeneration: number; receipt: number; version: number }
export async function readD1Oracle(db: D1Database): Promise<CrashOracleState> {
  const count = async (table: string) => Number(await db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)"))
  const record = await db.prepare("SELECT version FROM framework_records WHERE id='r'").first<{ version: number }>()
  const cache = await db.prepare("SELECT generation FROM framework_cache_generations WHERE scope='t'").first<{ generation: number }>()
  return { business: await count("framework_records"), audit: await count("framework_audit"), outbox: await count("framework_outbox"), cacheGeneration: cache?.generation ?? 0, receipt: await count("framework_idempotency"), version: record?.version ?? 0 }
}
export function assertCrashOracle(state: CrashOracleState): void {
  if (![0, 1].includes(state.business)) throw new Error("business mutation count exceeds one")
  const expected = state.business
  if (state.audit !== expected || state.outbox !== expected || state.receipt !== expected || state.cacheGeneration !== expected) throw new Error(`partial durable state: ${JSON.stringify(state)}`)
  if (state.version !== expected) throw new Error(`unexpected entity version: ${state.version}`)
}
