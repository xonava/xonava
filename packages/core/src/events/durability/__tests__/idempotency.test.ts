import { describe, expect, it, vi } from "vitest"
import type {
  IdempotencyAcquireResult,
  IdempotencyCommitItem,
  IdempotencyCompletion,
  IdempotencyPort,
  IdempotencyRequest,
  TransactionalIdempotencyPort,
  AtomicBatchIdempotencyPort,
} from "../idempotency"
import { isAtomicBatchIdempotencyPort, isDurableIdempotencyPort, isTransactionalIdempotencyPort } from "../idempotency"
import { createTenantScopedIdempotencyPort } from "../../../persistence/scoped"

type MockStatus = "in-progress" | "business-committed" | "completed"

function createStore(): TransactionalIdempotencyPort<string> {
  const records = new Map<string, { fingerprint: string; token: string; result?: string; status: MockStatus; acquiredAt: number }>()

  return {
    async acquire(request: IdempotencyRequest): Promise<IdempotencyAcquireResult<string>> {
      const recordKey = `${request.scope}:${request.key}`
      const existing = records.get(recordKey)

      if (!existing) {
        const token = `${recordKey}:token`
        records.set(recordKey, { fingerprint: request.fingerprint, token, status: "in-progress", acquiredAt: Date.now() })
        return { outcome: "acquired", token }
      }

      if (existing.fingerprint !== request.fingerprint) return { outcome: "conflict" }
      if (existing.status === "completed" && existing.result !== undefined) {
        return { outcome: "replay", result: existing.result }
      }
      // A committed-but-unfinalized row is never replayed.
      if (existing.status === "business-committed") return { outcome: "business-committed", token: existing.token }
      if (Date.now() - existing.acquiredAt >= (request.leaseDurationMs ?? 30_000)) {
        const token = `${recordKey}:replacement`
        existing.token = token
        existing.acquiredAt = Date.now()
        return { outcome: "acquired", token }
      }
      return { outcome: "in-progress" }
    },

    async renew(lease) {
      const record = records.get(`${lease.scope}:${lease.key}`)
      if (!record || record.token !== lease.token || record.fingerprint !== lease.fingerprint) throw new Error("Idempotency lease renewal lost ownership")
      record.acquiredAt = Date.now()
    },

    async markCommittedInTransaction(completion) {
      const record = records.get(`${completion.scope}:${completion.key}`)
      if (!record || record.token !== completion.token || record.fingerprint !== completion.fingerprint) throw new Error("Idempotency commit lost ownership")
      record.status = "business-committed"
    },

    async complete(completion: IdempotencyCompletion<string>): Promise<void> {
      const record = records.get(`${completion.scope}:${completion.key}`)
      if (!record || record.token !== completion.token || record.fingerprint !== completion.fingerprint) {
        throw new Error("Idempotency completion lost ownership")
      }
      record.result = completion.result
      record.status = "completed"
    },
  }
}

describe("idempotency port contract", () => {
  it("reserves, reports in-progress, replays, and detects fingerprint conflicts", async () => {
    const store = createStore()
    const request = { scope: "tenant:one", key: "request-1", fingerprint: "mutation-a" }

    const acquired = await store.acquire(request)
    expect(acquired).toMatchObject({ outcome: "acquired" })
    if (acquired.outcome !== "acquired") throw new Error("expected acquisition")

    await expect(store.acquire(request)).resolves.toEqual({ outcome: "in-progress" })
    await expect(store.acquire({ ...request, fingerprint: "mutation-b" })).resolves.toEqual({ outcome: "conflict" })

    await store.complete({ ...request, token: acquired.token, result: "created-1" })
    await expect(store.acquire(request)).resolves.toEqual({ outcome: "replay", result: "created-1" })
  })

  it("keeps identical keys independent across scopes", async () => {
    const store = createStore()
    const request = { key: "same-key", fingerprint: "same-mutation" }

    await expect(store.acquire({ ...request, scope: "tenant:one" })).resolves.toMatchObject({ outcome: "acquired" })
    await expect(store.acquire({ ...request, scope: "tenant:two" })).resolves.toMatchObject({ outcome: "acquired" })
  })

  it("allows takeover after lease expiry and rejects the old owner", async () => {
    const store = createStore()
    const request = { scope: "tenant:one", key: "lease-key", fingerprint: "mutation", leaseDurationMs: 0 }
    const first = await store.acquire(request)
    if (first.outcome !== "acquired") throw new Error("expected first acquisition")
    const replacement = await store.acquire(request)
    expect(replacement.outcome).toBe("acquired")
    if (replacement.outcome !== "acquired") throw new Error("expected takeover")
    await expect(store.complete({ ...request, token: first.token, result: "old" })).rejects.toThrow("lost ownership")
    await store.complete({ ...request, token: replacement.token, result: "new" })
    await expect(store.acquire(request)).resolves.toEqual({ outcome: "replay", result: "new" })
  })

  it("never replays a committed-but-unfinalized row", async () => {
    const store = createStore()
    const request = { scope: "tenant:one", key: "crash-key", fingerprint: "mutation" }
    const acquired = await store.acquire(request)
    if (acquired.outcome !== "acquired") throw new Error("expected acquisition")

    await store.markCommittedInTransaction({ scope: request.scope, key: request.key, fingerprint: request.fingerprint, token: acquired.token }, {} as never)

    await expect(store.acquire(request)).resolves.toEqual({ outcome: "business-committed", token: acquired.token })

    await store.complete({ ...request, token: acquired.token, result: "final" })
    await expect(store.acquire(request)).resolves.toEqual({ outcome: "replay", result: "final" })
  })

  it("rejects completion for an unknown or mismatched reservation", async () => {
    const store = createStore()
    const request = { scope: "tenant:one", key: "missing-key", fingerprint: "mutation" }

    await expect(store.complete({ ...request, token: "missing-token", result: "result" })).rejects.toThrow("lost ownership")

    const acquired = await store.acquire({ ...request, key: "owned-key" })
    if (acquired.outcome !== "acquired") throw new Error("expected acquisition")
    await expect(store.complete({ scope: request.scope, key: "owned-key", fingerprint: "other", token: acquired.token, result: "result" })).rejects.toThrow("lost ownership")
  })

  it("same actor + same key + role change produces conflict", async () => {
    const store = createStore()
    const base = { scope: "tenant:one", key: "submit-order", fingerprint: "role:admin" }

    const acquired = await store.acquire(base)
    expect(acquired.outcome).toBe("acquired")

    // A second submission with the same key but a different fingerprint
    // (simulating a role change from admin to viewer) must conflict.
    await expect(store.acquire({ ...base, fingerprint: "role:viewer" })).resolves.toEqual({ outcome: "conflict" })
  })

  it("same actor + same key + branch change produces conflict", async () => {
    const store = createStore()
    const base = { scope: "tenant:one", key: "submit-order", fingerprint: "branch:us-east" }

    const acquired = await store.acquire(base)
    expect(acquired.outcome).toBe("acquired")

    // Same key but different branch fingerprint must conflict.
    await expect(store.acquire({ ...base, fingerprint: "branch:eu-west" })).resolves.toEqual({ outcome: "conflict" })
  })

  it("same actor + same key + department change produces conflict", async () => {
    const store = createStore()
    const base = { scope: "tenant:one", key: "submit-order", fingerprint: "dept:engineering" }

    const acquired = await store.acquire(base)
    expect(acquired.outcome).toBe("acquired")

    // Same key but different department fingerprint must conflict.
    await expect(store.acquire({ ...base, fingerprint: "dept:sales" })).resolves.toEqual({ outcome: "conflict" })
  })

  it("classifies durable port capability shapes", () => {
    const transactional = createStore()
    expect(isDurableIdempotencyPort(transactional)).toBe(true)
    expect(isTransactionalIdempotencyPort(transactional)).toBe(true)
    expect(isAtomicBatchIdempotencyPort(transactional)).toBe(false)

    const base: IdempotencyPort<string> = {
      acquire: async () => ({ outcome: "in-progress" }),
      renew: async () => undefined,
      complete: async () => undefined,
    }
    expect(isDurableIdempotencyPort(base)).toBe(false)
  })

  it("rejects foreign scopes before acquire, transactional mark, and atomic commit delegation", async () => {
    const acquire = vi.fn(async () => ({ outcome: "acquired" as const, token: "token" }))
    const markCommittedInTransaction = vi.fn(async () => undefined)
    const createCommitBatchItem = vi.fn((completion: IdempotencyCommitItem) => ({ kind: "idempotency" as const, commit: completion }))
    const port = createTenantScopedIdempotencyPort<string, TransactionalIdempotencyPort<string> & AtomicBatchIdempotencyPort<string>>({
      acquire,
      renew: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      markCommittedInTransaction,
      createCommitBatchItem,
    }, "tenant-a")
    const foreign = { scope: "tenant:8:tenant-b:orders:create", key: "key", fingerprint: "fp" }

    await expect(port.acquire(foreign)).rejects.toThrow("tenant-a")
    await expect(port.markCommittedInTransaction({ ...foreign, token: "token" }, {} as never)).rejects.toThrow("tenant-a")
    expect(() => port.createCommitBatchItem({ ...foreign, token: "token" })).toThrow("tenant-a")
    expect(acquire).not.toHaveBeenCalled()
    expect(markCommittedInTransaction).not.toHaveBeenCalled()
    expect(createCommitBatchItem).not.toHaveBeenCalled()
  })

  it("allows only the bound tenant scope while leaving platform semantics explicit", async () => {
    const acquire = vi.fn(async () => ({ outcome: "acquired" as const, token: "token" }))
    const port = createTenantScopedIdempotencyPort<string, IdempotencyPort<string>>({
      acquire,
      renew: async () => undefined,
      complete: async () => undefined,
    }, "tenant-a")

    await expect(port.acquire({ scope: "tenant:8:tenant-a:orders:create", key: "key", fingerprint: "fp" }))
      .resolves.toEqual({ outcome: "acquired", token: "token" })
    await expect(port.acquire({ scope: "platform:orders:create", key: "key", fingerprint: "fp" }))
      .rejects.toThrow("tenant-a")
  })

  it("does not expose unattenuable finalizer methods on tenant ports", () => {
    const port = createTenantScopedIdempotencyPort<string, IdempotencyPort<string> & {
      claimPendingInvalidations: (...args: never[]) => Promise<unknown>
    }>({ acquire: async () => ({ outcome: "in-progress" }), renew: async () => undefined, complete: async () => undefined, claimPendingInvalidations: async () => [] }, "tenant-a")
    expect((port as unknown as { claimPendingInvalidations?: unknown }).claimPendingInvalidations).toBeUndefined()
  })
})
