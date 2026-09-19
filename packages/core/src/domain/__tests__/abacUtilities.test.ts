import { describe, expect, it } from "vitest"
import { defineAbacModule } from "../abacCatalog"
import { createAbacAuthorizer } from "../abacAuthorizer"
import { bindAbacSecurityDigest } from "../abacBundleIntegrity"
import * as publicDomain from "../index"

const structuralBundle = (defaultEffect: "allow" | "deny") => ({
  mode: "tenant" as const,
  moduleKey: "tenant.records",
  policies: [],
  context: { tenantId: "tenant-1" },
  defaultEffect,
  fieldCatalog: {},
})

describe("ABAC utilities", () => {
  it("returns the catalog descriptor unchanged", () => {
    const catalog = { moduleKey: "tenant.patients", actions: ["read"], capabilities: ["export"], fields: {} }
    expect(defineAbacModule(catalog)).toEqual(catalog)
  })

  it("rejects structural allow-default bundles", () => {
    expect(() => createAbacAuthorizer(structuralBundle("allow") as never)).toThrow("verified")
  })

  it("rejects manually constructed deny bundles without the production brand", () => {
    expect(() => createAbacAuthorizer(structuralBundle("deny") as never)).toThrow("verified")
  })

  it("does not expose an allow-all authorizer from the public domain barrel", () => {
    expect("createAllowAllAbacAuthorizer" in publicDomain).toBe(false)
  })

  it("accepts only a deny-by-default bundle bound by the production factory", async () => {
    const bundle = await bindAbacSecurityDigest(structuralBundle("deny"))
    expect(() => createAbacAuthorizer(bundle)).not.toThrow()
  })
})
