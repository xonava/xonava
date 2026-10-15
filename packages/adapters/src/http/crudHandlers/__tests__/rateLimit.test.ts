import { describe, expect, it } from "vitest"
import { normalizeEntityRateLimitSetting } from "../shared"
import type { EntityRateLimitSetting } from "@xonava/core/entity"

describe("normalizeEntityRateLimitSetting", () => {
  it.each(["atomic", "best-effort"] as const)(
    "preserves explicit %s consistency at the core boundary",
    (consistency) => {
      const setting: EntityRateLimitSetting = {
        max: 5,
        timeWindow: "1 minute",
        consistency,
        failureMode: "fail-closed",
        algorithm: "token-bucket",
        cost: 2,
      }

      expect(normalizeEntityRateLimitSetting(setting)).toEqual({
        config: { max: 5, timeWindow: "1 minute", algorithm: "token-bucket", cost: 2 },
        consistency,
        policy: { failureMode: "fail-closed" },
      })
    }
  )

  it("does not add an undefined policy to the core request", () => {
    const setting: EntityRateLimitSetting = {
      max: 1,
      timeWindow: 1000,
      consistency: "atomic",
    }

    expect(normalizeEntityRateLimitSetting(setting)).toEqual({
      config: { max: 1, timeWindow: 1000 },
      consistency: "atomic",
    })
  })
})
