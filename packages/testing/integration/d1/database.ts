import { Miniflare } from "miniflare"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootstrapD1Fixture } from "../../fixtures/d1/bootstrap.js"
import { tolerateStaleConnections } from "./staleConnection.js"

const WORKER_SCRIPT = "export default { fetch() { return new Response('framework-d1-fixture') } }"
export type D1Database = Awaited<ReturnType<Miniflare["getD1Database"]>>

export interface D1Fixture {
  readonly db: D1Database
  readonly persistPath?: string
  close(): Promise<void>
}

export async function openD1Fixture(persistPath?: string): Promise<D1Fixture> {
  const mf = new Miniflare({
    modules: true,
    script: WORKER_SCRIPT,
    compatibilityDate: "2025-09-01",
    d1Databases: { DB: "framework-certification" },
    ...(persistPath === undefined ? {} : { d1Persist: persistPath }),
  })
  const db = tolerateStaleConnections(await mf.getD1Database("DB"))
  await bootstrapD1Fixture(db)
  return { db, ...(persistPath === undefined ? {} : { persistPath }), close: () => mf.dispose() }
}

export async function temporaryD1Fixture(): Promise<D1Fixture & { cleanup(): Promise<void> }> {
  const persistPath = await mkdtemp(join(tmpdir(), "framework-d1-"))
  const fixture = await openD1Fixture(persistPath)
  return { ...fixture, cleanup: () => rm(persistPath, { recursive: true, force: true }) }
}
