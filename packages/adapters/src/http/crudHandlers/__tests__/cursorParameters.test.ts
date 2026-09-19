import { describe, expect, it } from "vitest"
import { assertHttpPaginationParameters } from "../list"

describe("Q2 HTTP cursor parameter contract", () => {
  it("rejects ambiguous cursor/offset and dual-direction parameters", () => {
    expect(() => assertHttpPaginationParameters({ cursor: "x", page: "2" }, "cursor")).toThrow(/cannot be combined/)
    expect(() => assertHttpPaginationParameters({ cursor: "x", before: "y" }, "cursor")).toThrow(/cannot be combined/)
  })
  it("rejects cursor parameters on offset routes", () => {
    expect(() => assertHttpPaginationParameters({ cursor: "x" }, "offset")).toThrow(/not enabled/)
  })
  it("accepts one pagination strategy without ambiguity", () => {
    expect(() => assertHttpPaginationParameters({ page: "2", pageSize: "10" }, "offset")).not.toThrow()
    expect(() => assertHttpPaginationParameters({ cursor: "x", limit: "10" }, "cursor")).not.toThrow()
  })
})
