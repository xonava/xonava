import { describe, expect, it } from "vitest"
import { ConfigurationError } from "@xonava/core/domain"
import { assertD1BatchLimits, D1BatchLimitExceededError, estimateD1Statement } from "../d1BatchLimits"

const limits = { maxBindParams: 3, maxStatementBytes: 10, maxBatchItems: 2 }
const est = (bindParams: number, statementBytes: number) => ({ bindParams, statementBytes })
const catching = (run: () => void): D1BatchLimitExceededError => {
  try { run() } catch (error) { return error as D1BatchLimitExceededError }
  throw new Error("expected the limit check to throw")
}

describe("D1BatchLimitExceededError", () => {
  it("carries a stable code, name, message and details", () => {
    const error = new D1BatchLimitExceededError({ limit: "maxBindParams", actual: 5, maximum: 3, statementIndex: 1 })
    expect(error).toBeInstanceOf(D1BatchLimitExceededError)
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe("D1_BATCH_LIMIT_EXCEEDED")
    expect(error.name).toBe("D1BatchLimitExceededError")
    expect(error.message).toBe("D1 atomic batch exceeds maxBindParams: 5 > 3")
    expect(error.details).toEqual({ limit: "maxBindParams", actual: 5, maximum: 3, statementIndex: 1 })
  })
})

describe("estimateD1Statement", () => {
  it("counts bind parameters and UTF-8 bytes of the statement text", () => {
    expect(estimateD1Statement({ toSQL: () => ({ sql: "select ?", params: [1] }) })).toEqual({ bindParams: 1, statementBytes: 8 })
    expect(estimateD1Statement({ toSQL: () => ({ sql: "café €", params: [] }) })).toEqual({ bindParams: 0, statementBytes: 9 })
    expect(estimateD1Statement({ toSQL: () => ({ sql: "", params: [1, 2, 3] }) })).toEqual({ bindParams: 3, statementBytes: 0 })
  })

  it("rejects values that are not executable queries", () => {
    const expected = new ConfigurationError("D1 atomic batches require executable Drizzle queries with a toSQL method")
    const withToSql = Object.assign(() => undefined, { toSQL: () => ({ sql: "x", params: [] }) })
    for (const value of [null, undefined, "select 1", 5, {}, { toSQL: "no" }, { toSQL: null }, withToSql]) {
      expect(() => estimateD1Statement(value)).toThrow(expected)
    }
  })

  it("rejects queries whose inspection fails or returns an unusable shape", () => {
    const expected = new ConfigurationError("D1 atomic batch could not inspect a Drizzle query safely")
    expect(() => estimateD1Statement({ toSQL: () => { throw new Error("secret sql text") } })).toThrow(expected)
    for (const result of [undefined, null, {}, { sql: 5, params: [] }, { sql: "x" }, { sql: "x", params: "no" }, { params: [] }, { sql: null, params: [] }]) {
      expect(() => estimateD1Statement({ toSQL: () => result })).toThrow(expected)
    }
  })
})

describe("assertD1BatchLimits", () => {
  it("accepts batches exactly at every limit", () => {
    expect(() => assertD1BatchLimits([est(3, 10), est(3, 10)], limits)).not.toThrow()
    expect(() => assertD1BatchLimits([], limits)).not.toThrow()
  })

  it("rejects one item too many before inspecting statements", () => {
    const error = catching(() => assertD1BatchLimits([est(99, 99), est(0, 0), est(0, 0)], limits))
    expect(error.message).toBe("D1 atomic batch exceeds maxBatchItems: 3 > 2")
    expect(error.details).toEqual({ limit: "maxBatchItems", actual: 3, maximum: 2 })
    expect(error.details).not.toHaveProperty("statementIndex")
  })

  it("rejects the first statement over the bind-parameter limit, with its index", () => {
    const error = catching(() => assertD1BatchLimits([est(3, 1), est(4, 1)], limits))
    expect(error.message).toBe("D1 atomic batch exceeds maxBindParams: 4 > 3")
    expect(error.details).toEqual({ limit: "maxBindParams", actual: 4, maximum: 3, statementIndex: 1 })
  })

  it("rejects the first statement over the byte limit, with its index", () => {
    const error = catching(() => assertD1BatchLimits([est(1, 10), est(1, 11)], limits))
    expect(error.message).toBe("D1 atomic batch exceeds maxStatementBytes: 11 > 10")
    expect(error.details).toEqual({ limit: "maxStatementBytes", actual: 11, maximum: 10, statementIndex: 1 })
  })

  it("checks bind parameters before bytes within a statement, and statements in order", () => {
    expect(catching(() => assertD1BatchLimits([est(4, 11)], limits)).details.limit).toBe("maxBindParams")
    expect(catching(() => assertD1BatchLimits([est(1, 11), est(4, 1)], limits)).details).toMatchObject({ limit: "maxStatementBytes", statementIndex: 0 })
  })
})
