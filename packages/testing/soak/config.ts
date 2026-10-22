/** Soak configuration, read from the environment (documented in CONTRIBUTING.md, "Soak testing"). */
export type SoakAdapter = "d1" | "pg" | "mysql"

export interface SoakConfig {
  readonly minutes: number
  readonly workers: number
  readonly seed: number
  /** Lease for jobs, schedules and workflows. Short on purpose: a killed worker's claims are reclaimed within seconds. */
  readonly leaseMs: number
  /** Each worker clock is offset by a random amount within +-skewMs; it must stay well inside the lease. */
  readonly skewMs: number
  readonly killMinMs: number
  readonly killMaxMs: number
  readonly drainTimeoutMs: number
  readonly schedules: number
  readonly runId: string
}

function integer(name: string, fallback: number, min: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be a number >= ${min}`)
  return value
}

export function readSoakConfig(): SoakConfig {
  const leaseMs = integer("SOAK_LEASE_MS", 4_000, 1_000)
  const skewMs = integer("SOAK_SKEW_MS", 300, 0)
  if (skewMs * 4 > leaseMs) throw new Error("SOAK_SKEW_MS must stay within a quarter of SOAK_LEASE_MS (lease tolerance)")
  return {
    minutes: integer("SOAK_MINUTES", 30, 0.05),
    workers: Math.floor(integer("SOAK_WORKERS", 3, 2)),
    seed: Math.floor(integer("SOAK_SEED", Date.now() % 1_000_000_000, 0)),
    leaseMs,
    skewMs,
    killMinMs: integer("SOAK_KILL_MIN_MS", 3_000, 200),
    killMaxMs: integer("SOAK_KILL_MAX_MS", 9_000, 300),
    drainTimeoutMs: integer("SOAK_DRAIN_TIMEOUT_MS", 180_000, 5_000),
    schedules: Math.floor(integer("SOAK_SCHEDULES", 6, 1)),
    runId: process.env.FRAMEWORK_CONFORMANCE_RUN_ID ?? "local-latest",
  }
}

/** The adapters this run covers: D1 always, PostgreSQL and MySQL when their URLs are configured; SOAK_ADAPTERS narrows or names them. */
export function selectedAdapters(): { run: SoakAdapter[]; notConfigured: SoakAdapter[] } {
  const configured: Record<SoakAdapter, boolean> = { d1: true, pg: Boolean(process.env.FRAMEWORK_TEST_PG_URL), mysql: Boolean(process.env.FRAMEWORK_TEST_MYSQL_URL) }
  const requested = (process.env.SOAK_ADAPTERS ?? "").split(",").map((value) => value.trim()).filter(Boolean)
  const all: SoakAdapter[] = ["d1", "pg", "mysql"]
  for (const name of requested) if (!all.includes(name as SoakAdapter)) throw new Error(`SOAK_ADAPTERS names unknown adapter "${name}"`)
  const wanted = requested.length > 0 ? (requested as SoakAdapter[]) : all
  const run = wanted.filter((adapter) => configured[adapter])
  // An explicitly requested adapter without a database is an error, not a silent skip.
  const missing = wanted.filter((adapter) => !configured[adapter])
  if (requested.length > 0 && missing.length > 0) throw new Error(`SOAK_ADAPTERS requests ${missing.join(", ")} but the database URL is not configured`)
  return { run, notConfigured: missing }
}
