import { describe, expect, it } from "vitest"
import { Predicate } from "@xonava/core/domain"
import { buildStructuralScope } from "../shared"

describe("E1 compiled structural scope consumption", () => {
  it("combines tenant and soft-delete structural predicates", () => {
    expect(buildStructuralScope(
      { name: "record", tenantField: "tenantId", fields: { tenantId: { type: "string" }, deletedAt: { type: "datetime", nullable: true } }, activeRowFilter: Predicate.isNull("deletedAt") },
      { scope: { kind: "tenant", tenantId: "tenant-a" } } as never,
      { kind: "tenant" },
    )).toEqual(Predicate.and(Predicate.eq("tenantId", "tenant-a"), Predicate.isNull("deletedAt")))
  })
  it("uses the trusted application scope key", () => {
    expect(buildStructuralScope(
      { name: "record", fields: { applicationId: { type: "string" } } },
      { scope: { kind: "application", applicationKey: "app-a" } } as never,
      { kind: "application", field: "applicationId" },
    )).toEqual(Predicate.eq("applicationId", "app-a"))
  })
})
