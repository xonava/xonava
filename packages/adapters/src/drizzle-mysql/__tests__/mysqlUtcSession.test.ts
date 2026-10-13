import { describe, expect, it } from "vitest"
import { ConfigurationError } from "core/domain"
import { assertMySqlUtcSession } from "../mysqlPredicate"

const session = (winter: unknown, summer: unknown) => ({ query: async () => [[{ winter, summer }], []] as [unknown, unknown] })

describe("assertMySqlUtcSession", () => {
  it("accepts a UTC session", async () => {
    await expect(assertMySqlUtcSession(session(1704067200, 1719792000))).resolves.toBeUndefined()
    await expect(assertMySqlUtcSession(session("1704067200", "1719792000"))).resolves.toBeUndefined()
  })

  it("rejects a fixed offset, and a named zone that is UTC only part of the year", async () => {
    await expect(assertMySqlUtcSession(session(1704067200 - 5 * 3600, 1719792000 - 5 * 3600))).rejects.toBeInstanceOf(ConfigurationError)
    await expect(assertMySqlUtcSession(session(1704067200, 1719792000 - 3600))).rejects.toThrow(/UTC/)
    await expect(assertMySqlUtcSession(session(null, null))).rejects.toThrow(/UTC/)
  })
})
