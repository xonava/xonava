import { describe, expect, it, vi } from "vitest"
import { createExecutionContext } from "../executionContext"
import { TenantScopeViolationError } from "../../domain"
import {
  assertDurableJob,
  assertDurableIdentifier,
  assertJobRequesterCanEnqueue,
  assertRequesterCanEnqueueScope,
  assertJobScopeMatches,
  isSystemOrPlatform,
  requesterTenantId,
  requesterToActorId,
  assertJobScopeCanEnqueue,
  requesterJobScope,
  JobScopeMismatchError,
  RetryableJobError,
  PermanentJobError,
  MalformedJobPayloadError,
  InvalidJobPayloadError,
  CorruptJobMetadataError,
  type JobRequester,
} from "../types"

describe("execution context and scope helpers", () => {
  it("creates contexts with defaults and optional execution values", () => {
    const startedAt = new Date("2026-01-01T00:00:00.000Z")
    const signal = new AbortController().signal
    const clock = { now: vi.fn(() => startedAt), sleep: vi.fn(async () => {}) }
    const context = createExecutionContext({
      executionId: "execution-1", jobId: "job-1", jobType: "email", jobVersion: 2, attempt: 1,
      tenantId: "tenant-1", executionScope: { kind: "tenant", tenantId: "tenant-1" }, correlationId: "correlation-1", startedAt, signal, deadline: 123,
      metadata: { source: "test" }, clock, assertLease: async () => {},
    })
    expect(context).toMatchObject({ executionId: "execution-1", tenantId: "tenant-1", metadata: { source: "test" }, signal, deadline: 123, clock })
    expect(createExecutionContext({ jobId: "job", jobType: "test", jobVersion: 1, attempt: 1, tenantId: null, executionScope: { kind: "system", systemKey: "framework" }, correlationId: "c", startedAt, assertLease: async () => {} }).executionScope.kind).toBe("system")
  })

  it("enforces stored job scope and requester tenant boundaries", () => {
    expect(() => assertJobScopeMatches({ kind: "tenant", tenantId: "tenant-1" }, "tenant")).not.toThrow()
    expect(() => assertJobScopeMatches({ kind: "system", systemKey: "framework" }, "system")).not.toThrow()
    expect(() => assertJobScopeMatches({ kind: "platform", platformKey: "default" }, "tenant")).toThrow(JobScopeMismatchError)

    const tenant: JobRequester = { scope: "tenant", tenantId: "tenant-1", actorId: "actor" }
    expect(() => assertJobRequesterCanEnqueue(tenant, "tenant-1")).not.toThrow()
    expect(() => assertJobRequesterCanEnqueue(tenant, null)).toThrow("its tenant")
    expect(() => assertJobRequesterCanEnqueue({ scope: "platform", actorId: "platform" }, "other")).not.toThrow()
    expect(() => assertJobRequesterCanEnqueue({ scope: "system" }, "other")).not.toThrow()
    expect(() => assertRequesterCanEnqueueScope({ scope: "platform", actorId: "platform" }, "platform", null)).not.toThrow()
    expect(() => assertRequesterCanEnqueueScope({ scope: "platform", actorId: "platform" }, "system", null)).toThrow("cannot enqueue system")
    expect(() => assertRequesterCanEnqueueScope({ scope: "platform", actorId: "platform", capabilities: ["enqueue:system"] }, "system", null)).not.toThrow()
    expect(() => assertRequesterCanEnqueueScope(tenant, "system", null)).toThrow("its tenant")
    expect(requesterTenantId(tenant)).toBe("tenant-1")
    expect(requesterTenantId({ scope: "system" })).toBeNull()
    expect(isSystemOrPlatform({ scope: "platform", actorId: "a" })).toBe(true)
    expect(isSystemOrPlatform(tenant)).toBe(false)
    expect(requesterToActorId({ scope: "system" })).toBe("system")
    expect(requesterToActorId({ scope: "platform", actorId: "p" })).toBe("p")
    expect(requesterToActorId(tenant)).toBe("actor")
    expect(requesterJobScope(tenant)).toBe("tenant")
    expect(requesterJobScope({ scope: "platform", actorId: "p" })).toBe("platform")
    expect(requesterJobScope({ scope: "system" })).toBe("system")

    expect(() => assertJobScopeCanEnqueue("tenant", "tenant-1")).not.toThrow()
    expect(() => assertJobScopeCanEnqueue("tenant", null)).toThrow("Tenant jobs require")
    expect(() => assertJobScopeCanEnqueue("platform", undefined)).not.toThrow()
    expect(() => assertJobScopeCanEnqueue("system", null)).not.toThrow()
    expect(() => assertJobScopeCanEnqueue("platform", "tenant-1")).toThrow("platform/system jobs")

    expect(() => assertJobScopeMatches({ kind: "tenant", tenantId: "tenant-1" }, "tenant")).not.toThrow()
    expect(() => assertJobScopeMatches({ kind: "system", systemKey: "framework" }, "system")).not.toThrow()
    expect(() => assertJobScopeMatches({ kind: "system", systemKey: "framework" }, "platform")).toThrow("scope mismatch")
  })

  it("enforces the full requester-to-target enqueue matrix", () => {
    const requesters: Record<string, JobRequester> = {
      system: { scope: "system" },
      platform: { scope: "platform", actorId: "p" },
      platformCap: { scope: "platform", actorId: "p", capabilities: ["enqueue:system"] },
      tenant: { scope: "tenant", tenantId: "t1", actorId: "a" },
    }
    const targets = ["tenant", "platform", "system"] as const
    const allowed: Record<string, readonly string[]> = {
      system: ["tenant", "platform", "system"],
      platform: ["platform"],
      platformCap: ["tenant", "platform", "system"],
      tenant: ["tenant"],
    }
    for (const [name, requester] of Object.entries(requesters)) {
      for (const target of targets) {
        const jobTenant = target === "tenant" ? "t1" : null
        const call = () => assertRequesterCanEnqueueScope(requester, target, jobTenant)
        if (allowed[name]!.includes(target)) expect(call, `${name} -> ${target}`).not.toThrow()
        else expect(call, `${name} -> ${target}`).toThrow(expect.objectContaining({ name: "TenantScopeViolationError" }))
      }
    }
    expect(() => assertRequesterCanEnqueueScope(requesters.tenant!, "tenant", "t2")).toThrow(expect.objectContaining({ name: "TenantScopeViolationError" }))
  })

  it("exposes the job error types with their stable kinds and defaults", () => {
    expect(new RetryableJobError("retry")).toMatchObject({ name: "RetryableJobError", kind: "retryable" })
    expect(new PermanentJobError("permanent")).toMatchObject({ name: "PermanentJobError", kind: "permanent" })
    expect(new MalformedJobPayloadError()).toHaveProperty("message", "Job payload is malformed")
    expect(new InvalidJobPayloadError()).toHaveProperty("message", "Job payload failed schema validation")
    expect(new CorruptJobMetadataError()).toMatchObject({ name: "CorruptJobMetadataError", kind: "permanent", message: "Job metadata is malformed" })
  })
})

describe("durable job payload validation", () => {
  const valid = { executionScope: { kind: "platform" as const, platformKey: "default" }, jobType: "test.job", jobVersion: 1, payload: { ok: true } }

  it("accepts a plain JSON payload and rejects non-plain values", () => {
    expect(() => assertDurableJob(valid)).not.toThrow()
    expect(() => assertDurableJob({ ...valid, payload: { value: new Map([["k", "v"]]) } })).toThrow(TenantScopeViolationError)
    expect(() => assertDurableJob({ ...valid, payload: { value: new Set(["x"]) } })).toThrow(TenantScopeViolationError)
    expect(() => assertDurableJob({ ...valid, payload: { value: new Date() } })).toThrow(TenantScopeViolationError)
    expect(() => assertDurableJob({ ...valid, payload: { value: { toJSON() { return "x" } } } })).toThrow(TenantScopeViolationError)
  })

  it("rejects a circular payload", () => {
    const payload: Record<string, unknown> = { nested: {} }
    payload.nested = payload
    expect(() => assertDurableJob({ ...valid, payload })).toThrow(/circular/i)
  })

  it("rejects payloads that exceed the maximum nesting depth", () => {
    let nested: unknown = {}
    for (let i = 0; i < 60; i++) nested = { next: nested }
    expect(() => assertDurableJob({ ...valid, payload: { nested } })).toThrow(/nesting depth/)
  })

  it("rejects an oversized string value", () => {
    expect(() => assertDurableJob({ ...valid, payload: { data: "x".repeat(70_000) } })).toThrow(/longer than/)
  })

  it("rejects oversized keys and excessive total keys", () => {
    const oversizedKey: Record<string, unknown> = {}
    oversizedKey["k".repeat(70_000)] = 1
    expect(() => assertDurableJob({ ...valid, payload: oversizedKey })).toThrow(/key longer than/)
    const tooManyKeys = Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [`k${i}`, i]))
    expect(() => assertDurableJob({ ...valid, payload: tooManyKeys })).toThrow(/keys/)
  })

  it("rejects a serialized payload and metadata combination over the byte budget", () => {
    const big = { data: Array.from({ length: 20 }, () => "y".repeat(60_000)) }
    expect(() => assertDurableJob({ ...valid, payload: big })).toThrow(/serialized bytes/)
    expect(() => assertDurableJob({ ...valid, payload: { a: "b" }, metadata: big })).toThrow(/serialized bytes/)
  })

  it("rejects undefined, NaN, and Infinity values", () => {
    expect(() => assertDurableJob({ ...valid, payload: { value: undefined } })).toThrow(/non-durable/)
    expect(() => assertDurableJob({ ...valid, payload: { value: Number.NaN } })).toThrow(/non-durable/)
    expect(() => assertDurableJob({ ...valid, payload: { value: Number.POSITIVE_INFINITY } })).toThrow(/non-durable/)
  })

  it("bounds durable identifiers by UTF-8 byte length", () => {
    expect(() => assertDurableJob({ ...valid, jobType: "t".repeat(100) })).not.toThrow()
    expect(() => assertDurableJob({ ...valid, jobType: "t".repeat(101) })).toThrow(/jobType.*100 bytes/)
    // A 50-character multi-byte string exceeds 100 bytes even though it is short.
    expect(() => assertDurableJob({ ...valid, jobType: "水".repeat(50) })).toThrow(/jobType.*100 bytes/)

    expect(() => assertDurableJob({ ...valid, idempotencyKey: "k".repeat(255) })).not.toThrow()
    expect(() => assertDurableJob({ ...valid, idempotencyKey: "k".repeat(256) })).toThrow(/idempotencyKey.*255 bytes/)

    expect(() => assertDurableJob({ ...valid, correlationId: "c".repeat(100) })).not.toThrow()
    expect(() => assertDurableJob({ ...valid, correlationId: "c".repeat(101) })).toThrow(/correlationId.*100 bytes/)

    expect(() => assertDurableIdentifier("w".repeat(100), "workerId", 100)).not.toThrow()
    expect(() => assertDurableIdentifier("w".repeat(101), "workerId", 100)).toThrow(/workerId.*100 bytes/)
  })
})

describe("fencedEffect lease assertion", () => {
  const baseArgs = {
    jobId: "job-1",
    jobType: "test",
    jobVersion: 1,
    attempt: 1,
    tenantId: null,
    executionScope: { kind: "system" as const, systemKey: "framework" },
    correlationId: "c",
    startedAt: new Date(),
  }

  it("calls assertLease before executing the effect function", async () => {
    const assertLease = vi.fn(async () => {})
    const context = createExecutionContext({ ...baseArgs, assertLease })
    const fn = vi.fn(async () => "result")
    const result = await context.fencedEffect.execute({ effectName: "test", idempotencyKey: "test-1", fn })
    expect(assertLease).toHaveBeenCalledOnce()
    expect(fn).toHaveBeenCalledOnce()
    expect(result).toBe("result")
  })

  it("does not invoke the effect function when assertLease rejects", async () => {
    const assertLease = vi.fn(async () => { throw new Error("Job lease was lost") })
    const context = createExecutionContext({ ...baseArgs, assertLease })
    const fn = vi.fn(async () => "result")
    await expect(context.fencedEffect.execute({ effectName: "test", idempotencyKey: "test-2", fn })).rejects.toThrow("Job lease was lost")
    expect(fn).not.toHaveBeenCalled()
  })

  it("fences a stale worker whose renewLease returned false (assertLease rejects)", async () => {
    const assertLease = vi.fn(async () => { throw new Error("Stale worker: lease renewal failed") })
    const context = createExecutionContext({ ...baseArgs, assertLease })
    const fn = vi.fn(async () => {
      throw new Error("Should never be called — lease was lost")
    })
    await expect(
      context.fencedEffect.execute({ effectName: "payment-gateway", idempotencyKey: "payment-1", fn }),
    ).rejects.toThrow("Stale worker: lease renewal failed")
    expect(fn).not.toHaveBeenCalled()
    expect(assertLease).toHaveBeenCalledOnce()
  })
})
