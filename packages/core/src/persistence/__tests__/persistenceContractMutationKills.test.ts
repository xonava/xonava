import { describe, expect, it, vi } from "vitest"
import { Predicate } from "../../domain"
import {
  CancelledError,
  ConfigurationError,
  RuntimeCapabilityError,
  TenantScopeViolationError,
  TimeoutError,
  ValidationError,
} from "../../domain/errors"
import { requireProvenPersistenceCapability, type PersistenceCapabilities } from "../capabilities"
import {
  assertBulkMutationInput,
  validateBulkMutationResult,
  type BulkMutationItemResult,
  type BulkMutationResult,
} from "../bulk"
import {
  assertMatchingPersistenceScope,
  assertVersionedWriteHasExpectedVersion,
  createReadOnlyPersistenceProvider,
  supportsAtomicBatch,
  supportsTenantScopedAtomicBatch,
  type EntityDescriptor,
  type PersistenceProvider,
} from "../provider"
import { assertStreamingReadOptions, enforceBoundedStream, type StreamingReadBatch, type StreamingReadOptions } from "../streaming"
import { createTenantScopedPersistenceProvider } from "../scoped"
import { isCoreTenantScopedProvider } from "../tenantScopeBrand"
import { testRepositoryForDescriptor, type TestRepository } from "./persistenceTestSupport"

const baseCapabilities: PersistenceCapabilities = {
  interactiveTransactions: false,
  atomicBatch: false,
  returningInsert: false,
  readSessions: false,
  jsonQueries: false,
  exactDecimal: false,
  persistentConnection: false,
}

function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error("expected throw")
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected rejection")
}

describe("bulk mutation input validation", () => {
  const item = (id: string, expectedVersion = 1): { id: string; expectedVersion: number } => ({ id, expectedVersion })

  it("rejects a non-positive or non-integer maxItems with the exact message", () => {
    for (const maxItems of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const error = thrown(() => assertBulkMutationInput([item("a")], { maxItems }))
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as Error).message).toBe("Bulk maxItems must be a positive safe integer.")
    }
    expect(() => assertBulkMutationInput([item("a")], { maxItems: 1 })).not.toThrow()
  })

  it("enforces the item count window 1..maxItems", () => {
    const empty = thrown(() => assertBulkMutationInput([], { maxItems: 2 }))
    expect((empty as Error).message).toBe("Bulk item count must be between 1 and 2.")
    const over = thrown(() => assertBulkMutationInput([item("a"), item("b"), item("c")], { maxItems: 2 }))
    expect((over as Error).message).toBe("Bulk item count must be between 1 and 2.")
    expect(() => assertBulkMutationInput([item("a"), item("b")], { maxItems: 2 })).not.toThrow()
  })

  it("rejects duplicate identifiers and non-positive expected versions", () => {
    const duplicate = thrown(() => assertBulkMutationInput([item("a"), item("a")], { maxItems: 5 }))
    expect((duplicate as Error).message).toBe("Bulk mutation contains duplicate identifiers.")

    for (const expectedVersion of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const error = thrown(() => assertBulkMutationInput([item("a", expectedVersion)], { maxItems: 5 }))
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as Error).message).toBe("Bulk mutation expectedVersion must be a positive safe integer.")
    }
    expect(() => assertBulkMutationInput([item("a", Number.MAX_SAFE_INTEGER)], { maxItems: 5 })).not.toThrow()
  })
})

describe("bulk mutation result validation", () => {
  const applied = (id: string): BulkMutationItemResult<string> => ({ id, status: "applied", value: `v-${id}` })
  const rejectedItem = (id: string, code: "not-found" | "stale-version" = "not-found"): BulkMutationItemResult<string> => ({ id, status: "rejected", code })
  const result = (mode: "atomic" | "partial", items: BulkMutationItemResult<string>[], appliedCount: number, rejectedCount: number): BulkMutationResult<string> => ({
    mode,
    items,
    appliedCount,
    rejectedCount,
  })
  const message = (requested: { id: string }[], value: unknown): string =>
    (thrown(() => validateBulkMutationResult(requested, value as BulkMutationResult<string, string>)) as Error).message

  it("rejects malformed envelopes", () => {
    const text = "Bulk mutation result mode or items are invalid."
    expect(message([], null)).toBe(text)
    expect(message([], undefined)).toBe(text)
    expect(message([], { ...result("atomic", [], 0, 0), mode: "other" })).toBe(text)
    expect(message([], { ...result("atomic", [], 0, 0), items: "nope" })).toBe(text)
  })

  it("rejects malformed counters", () => {
    const text = "Bulk mutation result counters are invalid."
    expect(message([], result("partial", [], -1, 1))).toBe(text)
    expect(message([], result("partial", [], 1, -1))).toBe(text)
    expect(message([], result("partial", [], 0.5, -0.5))).toBe(text)
    expect(message([], result("partial", [], Number.NaN, 0))).toBe(text)
    expect(message([], result("partial", [], 0, Number.NaN))).toBe(text)
    expect(message([], result("partial", [], 0, Number.MAX_SAFE_INTEGER + 2))).toBe(text)
    expect(validateBulkMutationResult([], result("partial", [], 0, 0)).items).toEqual([])
  })

  it("rejects unknown item statuses and rejection codes", () => {
    expect(message([{ id: "a" }], result("partial", [null as never], 1, 0))).toBe("Bulk mutation item status is invalid.")
    expect(message([{ id: "a" }], result("partial", [{ id: "a", status: "pending" } as never], 1, 0))).toBe("Bulk mutation item status is invalid.")
    expect(message([{ id: "a" }], result("partial", [{ id: "a", status: "rejected", code: "bogus" } as never], 0, 1))).toBe(
      "Bulk mutation rejection code is invalid.",
    )
    for (const code of ["not-found", "stale-version", "not-authorized", "constraint", "unknown"] as const) {
      expect(() => validateBulkMutationResult([{ id: "a" }], result("partial", [{ id: "a", status: "rejected", code }], 0, 1))).not.toThrow()
    }
  })

  it("checks counts, identity order and counter consistency", () => {
    const counts = "Bulk mutation result counts do not match the request."
    expect(message([{ id: "a" }, { id: "b" }], result("partial", [applied("a")], 1, 0))).toBe(counts)
    expect(message([{ id: "a" }], result("partial", [applied("a")], 1, 1))).toBe(counts)
    expect(message([{ id: "a" }], result("partial", [applied("a")], 0, 0))).toBe(counts)

    expect(message([{ id: "a" }, { id: "b" }], result("partial", [applied("b"), applied("a")], 2, 0))).toBe(
      "Bulk mutation result order or identity does not match the request.",
    )
    expect(message([{ id: "a" }, { id: "b" }], result("partial", [applied("a"), rejectedItem("b")], 2, 0))).toBe(
      "Bulk mutation result counters are invalid.",
    )
    expect(message([{ id: "a" }, { id: "b" }], result("partial", [rejectedItem("a"), rejectedItem("b")], 1, 1))).toBe(
      "Bulk mutation result counters are invalid.",
    )
  })

  it("forbids partially applied atomic results but allows all-or-nothing outcomes", () => {
    const requested = [{ id: "a" }, { id: "b" }]
    expect(message(requested, result("atomic", [applied("a"), rejectedItem("b")], 1, 1))).toBe(
      "Atomic bulk mutation cannot report a partially applied result.",
    )
    expect(() => validateBulkMutationResult(requested, result("atomic", [applied("a"), applied("b")], 2, 0))).not.toThrow()
    expect(() => validateBulkMutationResult(requested, result("atomic", [rejectedItem("a"), rejectedItem("b")], 0, 2))).not.toThrow()
    expect(() => validateBulkMutationResult(requested, result("partial", [applied("a"), rejectedItem("b")], 1, 1))).not.toThrow()
  })

  it("returns a deeply frozen copy that keeps item payloads", () => {
    const source = result("partial", [applied("a"), rejectedItem("b", "stale-version")], 1, 1)
    const out = validateBulkMutationResult([{ id: "a" }, { id: "b" }], source)

    expect(out).toEqual(source)
    expect(out).not.toBe(source)
    expect(Object.isFrozen(out)).toBe(true)
    expect(Object.isFrozen(out.items)).toBe(true)
    expect(out.items.every((entry) => Object.isFrozen(entry))).toBe(true)
    expect(out.items[0]).not.toBe(source.items[0])
    expect(out.items[0]).toEqual({ id: "a", status: "applied", value: "v-a" })
  })
})

describe("streaming read options", () => {
  const future = (): Date => new Date(Date.now() + 60_000)
  const options = (extra: Partial<StreamingReadOptions> = {}): StreamingReadOptions => ({
    batchSize: 2,
    signal: new AbortController().signal,
    deadline: future(),
    ...extra,
  })

  it("validates batch size, signal and deadline with exact messages", () => {
    for (const batchSize of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const error = thrown(() => assertStreamingReadOptions(options({ batchSize })))
      expect(error).toBeInstanceOf(TypeError)
      expect((error as Error).message).toBe("stream batchSize must be a positive safe integer")
    }
    expect(() => assertStreamingReadOptions(options({ batchSize: 1 }))).not.toThrow()

    const signal = thrown(() => assertStreamingReadOptions(options({ signal: {} as never })))
    expect(signal).toBeInstanceOf(TypeError)
    expect((signal as Error).message).toBe("stream signal must be an AbortSignal")

    for (const deadline of ["2030-01-01" as never, new Date(Number.NaN), Number.POSITIVE_INFINITY as never]) {
      const error = thrown(() => assertStreamingReadOptions(options({ deadline })))
      expect(error).toBeInstanceOf(TypeError)
      expect((error as Error).message).toBe("stream deadline must be a valid Date")
    }
  })

  it("surfaces a typed abort reason unchanged and wraps any other reason", () => {
    const cancelled = new CancelledError("stop")
    const timeout = new TimeoutError("late")
    const a = new AbortController()
    a.abort(cancelled)
    expect(thrown(() => assertStreamingReadOptions(options({ signal: a.signal })))).toBe(cancelled)
    const b = new AbortController()
    b.abort(timeout)
    expect(thrown(() => assertStreamingReadOptions(options({ signal: b.signal })))).toBe(timeout)

    const c = new AbortController()
    c.abort("because")
    const wrapped = thrown(() => assertStreamingReadOptions(options({ signal: c.signal })))
    expect(wrapped).toBeInstanceOf(CancelledError)
    expect((wrapped as Error).message).toBe("stream was cancelled")
    expect((wrapped as CancelledError).details).toBe("because")
  })

  it("treats a deadline equal to now as exceeded", () => {
    const now = new Date("2026-10-01T00:00:00.000Z")
    const error = thrown(() => assertStreamingReadOptions(options({ deadline: new Date(now.getTime()) }), now))
    expect(error).toBeInstanceOf(TimeoutError)
    expect((error as Error).message).toBe("stream deadline exceeded")
    expect(() => assertStreamingReadOptions(options({ deadline: new Date(now.getTime() + 1) }), now)).not.toThrow()
  })
})

describe("bounded stream enforcement", () => {
  async function* source<T>(batches: StreamingReadBatch<T>[]): AsyncIterable<StreamingReadBatch<T>> {
    for (const batch of batches) yield batch
  }
  const bounded = (extra: Partial<StreamingReadOptions & { maxItems: number }> = {}): StreamingReadOptions & { maxItems: number } => ({
    batchSize: 2,
    maxItems: 3,
    signal: new AbortController().signal,
    deadline: new Date(Date.now() + 60_000),
    ...extra,
  })
  async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = []
    for await (const value of iterable) out.push(value)
    return out
  }

  it("validates the options before pulling any batch", async () => {
    const pulled = vi.fn()
    async function* spy(): AsyncIterable<StreamingReadBatch<number>> {
      pulled()
      yield { items: [1], batchNumber: 0 }
    }
    const expired = await rejected(drain(enforceBoundedStream(spy(), bounded({ deadline: new Date(0) }))))
    expect(expired).toBeInstanceOf(TimeoutError)
    expect(pulled).not.toHaveBeenCalled()

    const empty = await rejected(drain(enforceBoundedStream(source<number>([]), bounded({ deadline: new Date(0) }))))
    expect(empty).toBeInstanceOf(TimeoutError)
  })

  it("requires a positive safe maxItems", async () => {
    for (const maxItems of [0, -1, 1.5, Number.NaN]) {
      const error = await rejected(drain(enforceBoundedStream(source<number>([]), bounded({ maxItems }))))
      expect(error).toBeInstanceOf(TypeError)
      expect((error as Error).message).toBe("stream maxItems must be a positive safe integer")
    }
    await expect(drain(enforceBoundedStream(source<number>([]), bounded({ maxItems: 1 })))).resolves.toEqual([])
  })

  it("checks the deadline again on every pull", async () => {
    let current = new Date("2026-10-01T00:00:00.000Z")
    const options = bounded({ deadline: new Date("2026-10-01T00:00:10.000Z") })
    const iterator = enforceBoundedStream(
      source([{ items: [1], batchNumber: 0 }, { items: [2], batchNumber: 1 }]),
      options,
      () => current,
    )[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({ value: { batchNumber: 0 }, done: false })
    current = new Date("2026-10-01T00:00:10.000Z")
    const error = await rejected(iterator.next())
    expect(error).toBeInstanceOf(TimeoutError)
    expect((error as Error).message).toBe("stream deadline exceeded")
  })

  it("rejects out-of-order, empty, oversized and over-limit batches", async () => {
    const run = (batches: StreamingReadBatch<number>[], extra: Partial<StreamingReadOptions & { maxItems: number }> = {}): Promise<unknown> =>
      rejected(drain(enforceBoundedStream(source(batches), bounded(extra))))

    const order = await run([{ items: [1], batchNumber: 1 }])
    expect(order).toBeInstanceOf(TypeError)
    expect((order as Error).message).toBe("stream batchNumber must be contiguous and zero-based")
    expect(((await run([{ items: [1], batchNumber: 0 }, { items: [2], batchNumber: 0 }])) as Error).message).toBe(
      "stream batchNumber must be contiguous and zero-based",
    )
    expect(((await run([{ items: [1], batchNumber: 0.5 }])) as Error).message).toBe("stream batchNumber must be contiguous and zero-based")
    expect(((await run([{ items: [1], batchNumber: Number.NaN }])) as Error).message).toBe("stream batchNumber must be contiguous and zero-based")

    const emptyBatch = await run([{ items: [], batchNumber: 0 }])
    expect((emptyBatch as Error).message).toBe("stream adapter returned an empty or oversized batch")
    const oversized = await run([{ items: [1, 2, 3], batchNumber: 0 }], { maxItems: 10 })
    expect((oversized as Error).message).toBe("stream adapter returned an empty or oversized batch")

    const over = await run([{ items: [1, 2], batchNumber: 0 }, { items: [3, 4], batchNumber: 1 }])
    expect((over as Error).message).toBe("stream exceeded maxItems")
  })

  it("yields frozen copies and accepts exactly maxItems across batches", async () => {
    const first = { items: [1, 2], batchNumber: 0 }
    const out = await drain(enforceBoundedStream(source([first, { items: [3], batchNumber: 1 }]), bounded()))

    expect(out).toEqual([{ items: [1, 2], batchNumber: 0 }, { items: [3], batchNumber: 1 }])
    expect(out[0]).not.toBe(first)
    expect(out[0]!.items).not.toBe(first.items)
    expect(Object.isFrozen(out[0])).toBe(true)
    expect(Object.isFrozen(out[0]!.items)).toBe(true)
  })

  it("does not fail a completed source because the deadline passed afterwards", async () => {
    let current = new Date("2026-10-01T00:00:00.000Z")
    const options = bounded({ deadline: new Date("2026-10-01T00:00:10.000Z") })
    async function* late(): AsyncIterable<StreamingReadBatch<number>> {
      yield { items: [1], batchNumber: 0 }
      current = new Date("2026-10-01T00:01:00.000Z")
    }
    await expect(drain(enforceBoundedStream(late(), options, () => current))).resolves.toHaveLength(1)
  })
})

describe("persistence capability claims", () => {
  const claim = (execution?: PersistenceCapabilities["execution"]): PersistenceCapabilities => (execution ? { ...baseCapabilities, execution } : baseCapabilities)

  it("accepts a proven claim with evidence", () => {
    expect(() => requireProvenPersistenceCapability(claim({ "read.streaming": { status: "proven", evidence: "suite#1" } }), "read.streaming")).not.toThrow()
  })

  it("reports the capability and effective status when a claim is not usable", () => {
    const cases: [PersistenceCapabilities, string][] = [
      [claim(), "unsupported"],
      [claim({}), "unsupported"],
      [claim({ "read.streaming": { status: "unsupported" } }), "unsupported"],
      [claim({ "read.streaming": { status: "experimental", evidence: "x" } }), "experimental"],
      [claim({ "read.streaming": { status: "proven" } }), "proven"],
      [claim({ "read.streaming": { status: "proven", evidence: "" } }), "proven"],
      [claim({ "read.streaming": { status: "proven", evidence: 5 as never } }), "proven"],
    ]
    for (const [capabilities, status] of cases) {
      const error = thrown(() => requireProvenPersistenceCapability(capabilities, "read.streaming"))
      expect(error).toBeInstanceOf(RuntimeCapabilityError)
      expect((error as Error).message).toBe('Persistence capability "read.streaming" is not proven.')
      expect((error as RuntimeCapabilityError).details).toEqual({ capability: "read.streaming", status })
    }
  })

  it("looks the claim up by the requested capability", () => {
    const capabilities = claim({ "read.streaming": { status: "proven", evidence: "e" } })
    const error = thrown(() => requireProvenPersistenceCapability(capabilities, "locking.pessimistic"))
    expect((error as RuntimeCapabilityError).details).toEqual({ capability: "locking.pessimistic", status: "unsupported" })
  })
})

describe("core tenant scope brand", () => {
  it("only recognises providers minted by the core wrapper", () => {
    const plain = { dialect: "memory", capabilities: baseCapabilities, repository: vi.fn() } as unknown as PersistenceProvider
    const scoped = createTenantScopedPersistenceProvider(plain, "tenant-a")

    expect(isCoreTenantScopedProvider(scoped)).toBe(true)
    expect(isCoreTenantScopedProvider(plain)).toBe(false)
    expect(isCoreTenantScopedProvider({ ...scoped })).toBe(false)
    expect(isCoreTenantScopedProvider({})).toBe(false)
    for (const value of [null, undefined, 5, "x", () => undefined]) expect(isCoreTenantScopedProvider(value)).toBe(false)
  })
})

describe("persistence provider helpers", () => {
  const entity: EntityDescriptor<{ id: string; version: number }> = {
    name: "ver",
    primaryKey: "id",
    versionField: "version",
    fields: { id: { type: "string" }, version: { type: "number" } },
  }
  const plainProvider = (extra: Record<string, unknown> = {}, capabilities: Partial<PersistenceCapabilities> = {}): PersistenceProvider =>
    ({ dialect: "memory", capabilities: { ...baseCapabilities, ...capabilities }, repository: vi.fn(), ...extra }) as unknown as PersistenceProvider

  it("allows replacing persistence only when scopes stay compatible", () => {
    const unscopedA = plainProvider()
    const unscopedB = plainProvider()
    const tenantA = createTenantScopedPersistenceProvider(unscopedA, "tenant-a")
    const tenantB = createTenantScopedPersistenceProvider(unscopedA, "tenant-b")

    expect(() => assertMatchingPersistenceScope(unscopedA, unscopedB)).not.toThrow()
    expect(() => assertMatchingPersistenceScope(unscopedA, tenantA)).not.toThrow()
    expect(() => assertMatchingPersistenceScope(tenantA, createTenantScopedPersistenceProvider(unscopedB, "tenant-a"))).not.toThrow()

    const downgrade = thrown(() => assertMatchingPersistenceScope(tenantA, unscopedA))
    expect(downgrade).toBeInstanceOf(TenantScopeViolationError)
    expect((downgrade as Error).message).toBe('Cannot replace tenant-scoped persistence for "tenant-a" with unscoped persistence.')
    const swap = thrown(() => assertMatchingPersistenceScope(tenantA, tenantB))
    expect((swap as Error).message).toBe('Cannot replace tenant-scoped persistence for "tenant-a" with persistence for "tenant-b".')
  })

  it("detects atomic batch support from capabilities and the executor contract", () => {
    const execute = vi.fn()
    const encoder = { encode: vi.fn() }
    const unscoped = (extra: Record<string, unknown>, capabilities: Partial<PersistenceCapabilities> = {}): PersistenceProvider =>
      plainProvider(extra, { atomicBatch: true, ...capabilities })

    expect(supportsAtomicBatch(unscoped({ executeAtomicBatch: execute }))).toBe(true)
    expect(supportsAtomicBatch(unscoped({ executeAtomicBatch: execute }, { atomicBatchScope: "unscoped" }))).toBe(true)
    expect(supportsAtomicBatch(unscoped({}))).toBe(false)
    expect(supportsAtomicBatch(unscoped({ executeAtomicBatch: execute }, { atomicBatch: false }))).toBe(false)
    expect(supportsAtomicBatch(unscoped({ executeAtomicBatch: execute }, { atomicBatchScope: "other" as never }))).toBe(false)
    expect(supportsAtomicBatch(unscoped({ executeAtomicBatch: execute }, { atomicBatchScope: "other" as never }))).toBe(false)

    const tenantScoped = { atomicBatchScope: "tenant-scoped" as const }
    const contract = { executeAtomicBatch: execute, tenantId: "t", commandEncoder: encoder }
    expect(supportsAtomicBatch(unscoped(contract, tenantScoped))).toBe(true)
    expect(supportsAtomicBatch(unscoped({ ...contract, tenantId: 5 }, tenantScoped))).toBe(false)
    expect(supportsAtomicBatch(unscoped({ ...contract, commandEncoder: undefined }, tenantScoped))).toBe(false)
    expect(supportsAtomicBatch(unscoped({ ...contract, commandEncoder: {} }, tenantScoped))).toBe(false)
    expect(supportsAtomicBatch(unscoped({ ...contract, executeAtomicBatch: undefined }, tenantScoped))).toBe(false)
    // An unscoped executor is not enough for a tenant-scoped claim.
    expect(supportsAtomicBatch(unscoped({ executeAtomicBatch: execute }, tenantScoped))).toBe(false)
  })

  it("requires the full tenant-scoped contract for tenant-scoped atomic batches", () => {
    const execute = vi.fn()
    const contract = { executeAtomicBatch: execute, tenantId: "t", commandEncoder: { encode: vi.fn() } }
    const scoped = (extra: Record<string, unknown>, capabilities: Partial<PersistenceCapabilities> = {}): PersistenceProvider =>
      plainProvider(extra, { atomicBatch: true, atomicBatchScope: "tenant-scoped", ...capabilities })

    expect(supportsTenantScopedAtomicBatch(scoped(contract))).toBe(true)
    expect(supportsTenantScopedAtomicBatch(scoped(contract, { atomicBatch: false }))).toBe(false)
    expect(supportsTenantScopedAtomicBatch(scoped(contract, { atomicBatchScope: "unscoped" }))).toBe(false)
    expect(supportsTenantScopedAtomicBatch(scoped(contract, { atomicBatchScope: undefined as never }))).toBe(false)
    expect(supportsTenantScopedAtomicBatch(scoped({ ...contract, tenantId: 1 }))).toBe(false)
    expect(supportsTenantScopedAtomicBatch(scoped({ ...contract, commandEncoder: undefined }))).toBe(false)
    expect(supportsTenantScopedAtomicBatch(scoped({ ...contract, commandEncoder: {} }))).toBe(false)
    expect(supportsTenantScopedAtomicBatch(scoped({ ...contract, executeAtomicBatch: undefined }))).toBe(false)
  })

  it("requires a usable expected version on versioned writes", () => {
    const message = (options?: Parameters<typeof assertVersionedWriteHasExpectedVersion>[1], increments?: boolean): string =>
      (thrown(() => assertVersionedWriteHasExpectedVersion(entity, options, increments)) as Error).message
    const required = 'Versioned entity "ver" requires optimisticConcurrency.expectedVersion'

    expect(message(undefined)).toBe(required)
    expect(message({})).toBe(required)
    expect(message({ optimisticConcurrency: {} as never })).toBe(required)
    expect(message({ optimisticConcurrency: { expectedVersion: null as never } })).toBe(required)
    expect(thrown(() => assertVersionedWriteHasExpectedVersion(entity, undefined))).toBeInstanceOf(ConfigurationError)

    expect(() => assertVersionedWriteHasExpectedVersion(entity, { optimisticConcurrency: { expectedVersion: 0 } })).not.toThrow()
    expect(() => assertVersionedWriteHasExpectedVersion({ ...entity, versionField: undefined } as never, undefined)).not.toThrow()
  })

  it("lets only non-incrementing writes use the terminal version", () => {
    const terminal = { optimisticConcurrency: { expectedVersion: Number.MAX_SAFE_INTEGER } }
    const increment = thrown(() => assertVersionedWriteHasExpectedVersion(entity, terminal))
    expect((increment as Error).message).toBe("Entity version cannot be incremented beyond the maximum safe integer.")
    expect(() => assertVersionedWriteHasExpectedVersion(entity, terminal, false)).not.toThrow()

    const invalid = { optimisticConcurrency: { expectedVersion: -1 } }
    expect((thrown(() => assertVersionedWriteHasExpectedVersion(entity, invalid)) as Error).message).toBe(
      "Entity version must be a non-negative safe integer.",
    )
    expect((thrown(() => assertVersionedWriteHasExpectedVersion(entity, invalid, false)) as Error).message).toBe(
      "Entity version must be a non-negative safe integer.",
    )
  })
})

describe("read-only persistence provider", () => {
  type Row = { id: string }
  const entity: EntityDescriptor<Row> = { name: "row", primaryKey: "id", fields: { id: { type: "string" } } }

  it("exposes only read methods and forwards arguments", async () => {
    const findById = vi.fn(async () => ({ id: "1" }))
    const findOneWhere = vi.fn(async () => ({ id: "2" }))
    const findMany = vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 1 }))
    const repository = { findById, findOneWhere, findMany, insert: vi.fn(), update: vi.fn(), delete: vi.fn() }
    const base = { dialect: "memory", capabilities: baseCapabilities, repository: () => repository } as unknown as PersistenceProvider

    const readOnly = createReadOnlyPersistenceProvider(base)
    expect(readOnly.dialect).toBe("memory")
    expect(readOnly.capabilities).toBe(baseCapabilities)
    expect(readOnly).not.toHaveProperty("tenantId")
    expect(readOnly).not.toHaveProperty("runInTransaction")
    expect(Object.isFrozen(readOnly)).toBe(true)

    const repo = readOnly.repository<Row, string>(entity)
    expect(Object.isFrozen(repo)).toBe(true)
    expect(Object.keys(repo).sort()).toEqual(["findById", "findMany", "findOneWhere"])
    await expect(repo.findById("1")).resolves.toEqual({ id: "1" })
    expect(findById).toHaveBeenCalledWith("1")
    const filter = Predicate.eq("id", "2")
    await expect(repo.findOneWhere!(filter)).resolves.toEqual({ id: "2" })
    expect(findOneWhere).toHaveBeenCalledWith(filter)
    const query = { filter }
    await repo.findMany(query)
    expect(findMany).toHaveBeenCalledWith(query)
  })

  it("omits findOneWhere when the repository lacks it and keeps the tenant of scoped providers", () => {
    const repository: TestRepository<Row> = { findById: vi.fn(), findMany: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() }
    const base = { dialect: "memory", capabilities: baseCapabilities, repository: () => repository } as unknown as PersistenceProvider
    const tenant = createReadOnlyPersistenceProvider(createTenantScopedPersistenceProvider(base, "tenant-a"))

    expect(createReadOnlyPersistenceProvider(base).repository<Row, string>(entity)).not.toHaveProperty("findOneWhere")
    expect(tenant.tenantId).toBe("tenant-a")
  })

  it("runs interactive transactions in read-only mode over a read-only inner provider", async () => {
    const innerRepository: TestRepository<Row> = { findById: vi.fn(), findMany: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() }
    const inner = { dialect: "memory", capabilities: baseCapabilities, repository: () => innerRepository } as unknown as PersistenceProvider
    const runInTransaction = vi.fn(async (work: (tx: PersistenceProvider) => Promise<unknown>) => work(inner))
    const capabilities = { ...baseCapabilities, interactiveTransactions: true }
    const base = { dialect: "memory", capabilities, repository: () => innerRepository, runInTransaction } as unknown as PersistenceProvider

    const readOnly = createReadOnlyPersistenceProvider(base) as unknown as {
      capabilities: unknown
      runInTransaction(work: (tx: Record<string, unknown>) => Promise<unknown>, options?: unknown): Promise<unknown>
    }
    expect(readOnly.capabilities).toBe(capabilities)
    expect(Object.isFrozen(readOnly)).toBe(true)

    const seen = await readOnly.runInTransaction(async (tx) => tx, { isolationLevel: "serializable" })
    expect(runInTransaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "serializable", accessMode: "read only" })
    expect(seen).toMatchObject({ dialect: "memory" })
    expect(testRepositoryForDescriptor<Row>(seen as never, entity)).not.toHaveProperty("insert")

    await readOnly.runInTransaction(async () => undefined)
    expect(runInTransaction).toHaveBeenLastCalledWith(expect.any(Function), { accessMode: "read only" })
  })
})
