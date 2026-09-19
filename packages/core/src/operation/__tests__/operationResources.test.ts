import { describe, expect, expectTypeOf, it } from "vitest"
import {
  defineInfrastructureRawDataAccess,
  defineOperationDataAccess,
  type BaseOperationDefinition,
  type InfrastructureRawDataAccessCapability,
} from "../index"

describe("operation data-access declarations", () => {
  it("creates an immutable declared resource envelope", () => {
    const declaration = defineOperationDataAccess({
      kind: "declared",
      datasourceKey: "primary",
      resources: [
        { kind: "entity", key: "orders", access: "write" },
        { kind: "read-model", key: "customer-summary", access: "read" },
      ],
    })

    expect(Object.isFrozen(declaration)).toBe(true)
    expect(Object.isFrozen(declaration.resources)).toBe(true)
    expect(Object.isFrozen(declaration.resources[0])).toBe(true)
  })

  it("rejects empty and duplicate resource authority", () => {
    expect(() => defineOperationDataAccess({ kind: "declared", datasourceKey: "primary", resources: [] })).toThrow("at least one resource")
    expect(() => defineOperationDataAccess({
      kind: "declared",
      datasourceKey: "primary",
      resources: [
        { kind: "entity", key: "orders", access: "read" },
        { kind: "entity", key: "orders", access: "write" },
      ],
    })).toThrow("Duplicate operation resource")
  })

  it("keeps reviewed raw access out of ordinary operation definitions", () => {
    expectTypeOf<BaseOperationDefinition<unknown, unknown>["dataAccess"]>().not.toEqualTypeOf<InfrastructureRawDataAccessCapability>()
    expect(() => defineInfrastructureRawDataAccess({
      kind: "infrastructure-raw",
      datasourceKey: "primary",
      justification: "",
      reviewKey: "SEC-42",
    })).toThrow("justification")
  })
})
