import { vi, type Mock } from "vitest"
import { dispatchDueJobs, type DispatchResult, type DispatcherConfig } from "../dispatcher"
import { createJobRegistry, type JobPayloadUpcaster, type JobRegistry } from "../jobRegistry"
import type { TelemetryEvent, TelemetryPort } from "../../telemetry/telemetry"
import type { ExecutionClock, JobDefinition, JobStore, JobTransitionResult, StoredJob } from "../types"

/** Shared fixtures for the execution test suites (not a test file). */

export const NOW = new Date("2026-03-10T12:00:00.000Z")

export function storedJob(over: Partial<StoredJob> = {}): StoredJob {
  return {
    id: "job-1",
    jobType: "job",
    jobVersion: 1,
    tenantId: null,
    executionScope: { kind: "system", systemKey: "framework" },
    scope: "system",
    payload: "{}",
    status: "running",
    priority: 0,
    attemptsCompleted: 0,
    currentAttempt: 1,
    maxAttempts: 3,
    runAt: NOW,
    nextAttemptAt: null,
    leaseOwner: "w1",
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    claimToken: "claim-secret",
    idempotencyKey: null,
    fingerprint: "fp",
    correlationId: null,
    lastError: null,
    resultPayload: null,
    metadata: null,
    partitionKey: null,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: null,
    ...over,
  }
}

export function definition(over: Partial<JobDefinition> = {}): JobDefinition {
  return {
    type: "job",
    version: 1,
    scope: "system",
    maxAttempts: 3,
    retryDelayMs: 100,
    retryBackoffMultiplier: 2,
    decodePayload: (input) => input as Record<string, unknown>,
    execute: async () => ({ success: true }),
    ...over,
  }
}

export interface StoreMocks {
  claimDue: Mock<JobStore["claimDue"]>
  renewLease: Mock<JobStore["renewLease"]>
  markSucceeded: Mock<JobStore["markSucceeded"]>
  markRetrying: Mock<JobStore["markRetrying"]>
  markFailed: Mock<JobStore["markFailed"]>
  release: Mock<NonNullable<JobStore["release"]>>
}

export interface TestStore {
  store: JobStore
  mocks: StoreMocks
}

const APPLIED: JobTransitionResult = { applied: true }

/** A JobStore of vi.fn mocks that apply every transition; `withRelease: false` omits the optional release primitive. */
export function makeStore(jobs: StoredJob[], options: { withRelease?: boolean } = {}): TestStore {
  const mocks: StoreMocks = {
    claimDue: vi.fn<JobStore["claimDue"]>(async () => jobs),
    renewLease: vi.fn<JobStore["renewLease"]>(async () => true),
    markSucceeded: vi.fn<JobStore["markSucceeded"]>(async () => ({ ...APPLIED })),
    markRetrying: vi.fn<JobStore["markRetrying"]>(async () => ({ ...APPLIED })),
    markFailed: vi.fn<JobStore["markFailed"]>(async () => ({ ...APPLIED })),
    release: vi.fn<NonNullable<JobStore["release"]>>(async () => ({ ...APPLIED })),
  }
  const unused = (): never => {
    throw new Error("unused store method")
  }
  const store: JobStore = {
    enqueue: unused,
    getById: unused,
    getByCorrelationId: unused,
    getLatestPriorScheduleExecution: unused,
    getByIdempotencyKey: unused,
    claimDue: mocks.claimDue,
    renewLease: mocks.renewLease,
    markSucceeded: mocks.markSucceeded,
    markRetrying: mocks.markRetrying,
    markFailed: mocks.markFailed,
    cancel: unused,
    findPending: unused,
    ...(options.withRelease === false ? {} : { release: mocks.release }),
  }
  return { store, mocks }
}

export interface Recorder {
  readonly port: TelemetryPort
  readonly events: TelemetryEvent[]
  /** Every event as a plain `{ severity, ...attributes }` record, in emission order. */
  records(): Array<Record<string, string | number | boolean>>
  /** Attributes of the events whose message equals `message`. */
  find(message: string): Array<Record<string, string | number | boolean>>
  messages(): string[]
}

export function recorder(): Recorder {
  const events: TelemetryEvent[] = []
  const records = (): Array<Record<string, string | number | boolean>> => events.map((event) => ({ severity: event.severity, ...event.attributes }))
  return {
    port: { emit: (event) => { events.push(event) } },
    events,
    records,
    find: (message) => records().filter((record) => record.message === message),
    messages: () => events.map((event) => String(event.attributes.message)),
  }
}

export interface FakeTimer {
  readonly handle: number
  readonly ms: number
  readonly callback: () => void
  cleared: boolean
}

export interface FakeClock extends ExecutionClock {
  readonly timers: FakeTimer[]
  readonly cleared: unknown[]
  /** Every sleep the dispatcher asked for; `resolve`/`reject` settle it by hand. */
  readonly sleeps: Array<{ ms: number; signal: AbortSignal | undefined; resolve: () => void; reject: (reason: unknown) => void }>
  nowCalls: number
  /** Replaces what `now()` returns from now on. */
  setNow(value: Date): void
  /** Runs the callback of the nth timer set through the clock. */
  fire(index: number): void
}

export interface FakeClockOptions {
  start?: Date
  /** Milliseconds `now()` advances after each call (default 0). */
  step?: number
  /** false builds a clock without setTimeout/clearTimeout so the dispatcher falls back to global timers. */
  timers?: boolean
  /** How sleep behaves: "abortable" resolves when the signal aborts (like the system clock); "never" ignores the signal. */
  sleep?: "abortable" | "never"
}

export function fakeClock(options: FakeClockOptions = {}): FakeClock {
  let current = options.start ?? NOW
  const step = options.step ?? 0
  const timers: FakeTimer[] = []
  const cleared: unknown[] = []
  const sleeps: FakeClock["sleeps"] = []
  const clock: FakeClock = {
    timers,
    cleared,
    sleeps,
    nowCalls: 0,
    now: () => {
      clock.nowCalls += 1
      const value = current
      if (step !== 0) current = new Date(current.getTime() + step)
      return value
    },
    setNow: (value) => { current = value },
    sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
      sleeps.push({ ms, signal, resolve, reject })
      if (options.sleep === "never") return
      if (signal?.aborted) resolve()
      signal?.addEventListener("abort", () => resolve(), { once: true })
    }),
    fire: (index) => { timers[index]!.callback() },
  }
  if (options.timers !== false) {
    clock.setTimeout = (callback, ms) => {
      const timer: FakeTimer = { handle: timers.length + 1000, ms, callback, cleared: false }
      timers.push(timer)
      return timer.handle
    }
    clock.clearTimeout = (handle) => {
      cleared.push(handle)
      const timer = timers.find((candidate) => candidate.handle === handle)
      if (timer) timer.cleared = true
    }
  }
  return clock
}

export interface RunOptions {
  job?: Partial<StoredJob>
  definition?: Partial<JobDefinition>
  jobs?: StoredJob[]
  withRelease?: boolean
  config?: Partial<DispatcherConfig>
  upcasters?: readonly JobPayloadUpcaster[]
  extraDefinitions?: JobDefinition[]
  /** Skip registering the default definition. */
  noDefinition?: boolean
  /** Do not attach the recording telemetry port (its log writes read the clock). */
  noTelemetry?: boolean
  /** Use the dispatcher's built-in system clock instead of the fake clock. */
  systemClock?: boolean
  /** Adjust the store before the run. */
  prepare?: (mocks: StoreMocks) => void
}

export interface RunOutcome {
  result: DispatchResult
  rec: Recorder
  mocks: StoreMocks
  store: JobStore
  registry: JobRegistry
  job: StoredJob
}

export function baseConfig(store: JobStore, registry: JobRegistry, over: Partial<DispatcherConfig> = {}): DispatcherConfig {
  return { store, registry, workerId: "w1", leaseDurationMs: 900, claimLimit: 5, requester: { scope: "system" }, ...over }
}

/** Runs one dispatch tick over one (or the given) claimed job(s) with a recording telemetry port. */
export async function runOnce(options: RunOptions = {}): Promise<RunOutcome> {
  const job = storedJob(options.job)
  const { store, mocks } = makeStore(options.jobs ?? [job], options.withRelease === undefined ? {} : { withRelease: options.withRelease })
  options.prepare?.(mocks)
  const registry = createJobRegistry(options.upcasters ? { upcasters: options.upcasters } : undefined)
  if (!options.noDefinition) registry.register(definition(options.definition))
  for (const extra of options.extraDefinitions ?? []) registry.register(extra)
  const rec = recorder()
  const defaults: Partial<DispatcherConfig> = {
    ...(options.noTelemetry ? {} : { telemetry: rec.port }),
    ...(options.systemClock ? {} : { clock: fakeClock() }),
  }
  const result = await dispatchDueJobs(baseConfig(store, registry, { ...defaults, ...options.config }))
  return { result, rec, mocks, store, registry, job }
}

/** A promise settled by hand. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Lets pending microtasks and zero-delay timers run. */
export async function flush(times = 5): Promise<void> {
  for (let index = 0; index < times; index++) await new Promise<void>((resolve) => setImmediate(resolve))
}
