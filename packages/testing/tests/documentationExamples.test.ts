import { describe, expect, it } from "vitest"
import { CacheService, type CacheAdapter } from "@xonava/core/cache"
import { checkRateLimit, type AtomicRateLimitStore } from "@xonava/core/rate-limit"
import { createNoopTelemetry, emitTelemetry, explicitlySafeTelemetryAttributes } from "@xonava/core/telemetry"
import { validateObjectKey } from "@xonava/core/object-store"
import { supportsInteractiveTransactions } from "@xonava/core/persistence"
import { validateQueryPlan } from "@xonava/core/query"
import { createOperation } from "@xonava/core/operation"
import { defineWorkflow } from "@xonava/core/workflow"

describe("canonical documentation examples", () => {
  it("compiles and executes capability-only cache usage", async () => {
    const values = new Map<string, unknown>()
    const adapter: CacheAdapter = {
      async get<T>(key: string) { return values.get(key) as T | undefined },
      async set<T>(key: string, value: T) { values.set(key, value) },
      async delete(key: string) { return values.delete(key) },
      async has(key: string) { return values.has(key) },
      async clear() { values.clear() },
      async addToTag() {},
      async getTagKeys() { return [] },
      async deleteTag() {},
    }
    const cache = new CacheService({ adapter, defaultTtlMs: 30_000 })
    await cache.set("account:42", { enabled: true })
    await expect(cache.get("account:42")).resolves.toEqual({ enabled: true })
  })

  it("compiles and executes atomic rate-limit usage", async () => {
    const store: AtomicRateLimitStore = {
      async increment() { return { count: 1, resetAt: 60_000 } },
      async incrementAtomically() { return { count: 1, resetAt: 60_000 } },
    }
    await expect(checkRateLimit({ store, key: "tenant:t1", limit: 10, windowMs: 60_000 }))
      .resolves.toEqual({ allowed: true, remaining: 9, resetAt: 60_000 })
  })

  it("compiles standalone telemetry and object-store usage", () => {
    const telemetry = createNoopTelemetry()
    emitTelemetry(telemetry, { name: "docs.example", severity: "info", timestamp: new Date(0), attributes: explicitlySafeTelemetryAttributes({ outcome: "ok" }) })
    expect(validateObjectKey("tenant/t1/object/42")).toBe("tenant/t1/object/42")
  })

  it("keeps persistence, query, operation, and workflow entry points public", () => {
    expect(typeof supportsInteractiveTransactions).toBe("function")
    expect(typeof validateQueryPlan).toBe("function")
    expect(typeof createOperation).toBe("function")
    expect(typeof defineWorkflow).toBe("function")
  })
})
