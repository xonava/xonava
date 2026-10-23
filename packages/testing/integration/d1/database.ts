import { Miniflare } from "miniflare"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ASYNC_D1_WORKER_SCRIPT, asyncD1Binding } from "./asyncD1.js"
import { bootstrapD1Fixture } from "../../fixtures/d1/bootstrap.js"
import { tolerateStaleConnections } from "./staleConnection.js"

export type D1Database = Awaited<ReturnType<Miniflare["getD1Database"]>>

export interface D1Fixture {
  readonly db: D1Database
  readonly persistPath?: string
  /** The HTTP address of the Miniflare worker in front of the database, for clients in other processes (the soak workers). */
  endpoint(): Promise<URL>
  close(): Promise<void>
}

export async function openD1Fixture(persistPath?: string): Promise<D1Fixture> {
  const mf = new Miniflare({
    modules: true,
    script: ASYNC_D1_WORKER_SCRIPT,
    compatibilityDate: "2025-09-01",
    d1Databases: { DB: "framework-certification" },
    ...(persistPath === undefined ? {} : { d1Persist: persistPath }),
  })
  const db = tolerateStaleConnections(asyncD1Binding(mf))
  await bootstrapD1Fixture(db)
  return { db, ...(persistPath === undefined ? {} : { persistPath }), endpoint: () => mf.ready, close: () => mf.dispose() }
}

export async function temporaryD1Fixture(): Promise<D1Fixture & { cleanup(): Promise<void> }> {
  const persistPath = await mkdtemp(join(tmpdir(), "framework-d1-"))
  const fixture = await openD1Fixture(persistPath)
  return { ...fixture, cleanup: () => rm(persistPath, { recursive: true, force: true }) }
}
