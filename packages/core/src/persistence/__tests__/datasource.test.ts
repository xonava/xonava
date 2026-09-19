import { describe, expect, it } from "vitest"
import { defineReadModelDefinition } from "../../entity/readModelDefinition"
import { validateOperationDefinition } from "../../operation/validateOperationDefinition"

const capabilities = { readConsistency: ["strong" as const], writable: true, localTransactions: true }
describe("D1 datasource architecture", () => {
  it("defaults single-source read models to primary and strong consistency", () => {
    expect(defineReadModelDefinition({ key: "orders" })).toMatchObject({ consistency: "strong", sources: [{ source: "primary" }] })
  })
  it("requires declared canonical multi-source semantics", () => {
    const sources = [{ source: "primary", capabilities }, { source: "analytics", capabilities }]
    expect(() => defineReadModelDefinition({ key: "report", sources })).toThrow(/declare consistency/)
    expect(defineReadModelDefinition({ key: "report", sources, consistency: { kind: "eventual" } }).consistency).toEqual({ kind: "eventual" })
  })
  it("rejects local mutations spanning multiple mutable sources", () => {
    expect(() => validateOperationDefinition({ key: "bad", kind: "mutation", atomicity: { kind: "standard", mode: "required" }, authorization: { authorize: async () => ({ allowed: true }) }, dataAccess: { kind: "declared", datasourceKey: "primary", resources: [{ kind: "entity", key: "a", access: "write" }, { kind: "entity", key: "b", access: "write", source: "secondary" }] }, execute: async () => true })).toThrow(/workflow or event boundary/)
  })
})
