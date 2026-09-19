import { describe, expect, it } from "vitest"
import { applyAuthorizationPlanToResult } from "../../operation/authorizationPlanEnforcement"
import { createAuthorizedExecutionPlan } from "../authorizedExecutionPlan"

const principal = { kind: "human", id: "actor", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-18T00:00:00.000Z" } } as const
function plan() {
  return createAuthorizedExecutionPlan({
    identity: { actor: principal, subject: principal }, scope: { kind: "tenant", tenantId: "t1" }, action: "records.read", operationKind: "read",
    readableFields: new Set(["id", "short", "partial", "hashed", "nullable"]), writableFields: new Set<string>(), dynamicFacts: [],
    obligations: [{ kind: "mask", field: "short", strategy: "partial" }, { kind: "mask", field: "partial", strategy: "partial" }, { kind: "mask", field: "hashed", strategy: "hash" }, { kind: "mask", field: "nullable", strategy: "redact" }],
    policy: { key: "records", version: 1, digest: "a".repeat(64) },
  })
}

describe("authorization result projection", () => {
  it("returns unplanned and scalar values unchanged", () => {
    expect(applyAuthorizationPlanToResult(undefined, { secret: true })).toEqual({ secret: true })
    expect(applyAuthorizationPlanToResult(plan(), null)).toBeNull()
    expect(applyAuthorizationPlanToResult(plan(), "value")).toBe("value")
    const date = new Date("2026-09-18T00:00:00Z")
    expect(applyAuthorizationPlanToResult(plan(), date)).toBe(date)
  })

  it("projects arrays and applies partial, fallback, hash, and null masking", () => {
    const result = applyAuthorizationPlanToResult(plan(), [{ id: "1", short: "x", partial: "alice", hashed: "secret", nullable: null, hidden: true }])
    expect(result[0]).toEqual({ id: "1", short: "[REDACTED]", partial: "a***e", hashed: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), nullable: null })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result[0])).toBe(true)
  })

  it("projects paged rows, removes hidden fields, and corrects rowCount", () => {
    const result = applyAuthorizationPlanToResult(plan(), { rows: [{ id: "1", hidden: true }, { id: "2", hidden: true }], rowCount: 99, page: 1 })
    expect(result).toEqual({ rows: [{ id: "1" }, { id: "2" }], rowCount: 2, page: 1 })
    expect(Object.isFrozen(result.rows)).toBe(true)
  })
})
