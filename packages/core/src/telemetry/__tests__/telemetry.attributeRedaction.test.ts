import { describe, expect, it } from "vitest"
import { boundedTelemetryAttributes, isSensitiveTelemetryKey, SENSITIVE_TELEMETRY_KEY_PATTERNS, TELEMETRY_REDACTED } from "../telemetry"

describe("telemetry attribute redaction", () => {
  it("redacts values under sensitive keys, case-insensitively", () => {
    const attributes = boundedTelemetryAttributes("claimed", {
      claimToken: "tok-123", accessToken: "a", refresh_token: "r", Authorization: "Bearer x", cookie: "c", apiKey: "k", API_KEY: "k2",
      password: "p", passwd: "p2", clientSecret: "s", credentials: "c2", privateKey: "pk", sessionId: "sid", session_id: "sid2", pin: 1234,
      jobId: "j1", attempt: 2,
    })
    expect(attributes).toMatchObject({ jobId: "j1", attempt: 2, pin: 1234, message: "claimed" })
    for (const key of ["claimToken", "accessToken", "refresh_token", "Authorization", "cookie", "apiKey", "API_KEY", "password", "passwd", "clientSecret", "credentials", "privateKey", "sessionId", "session_id"]) {
      expect(attributes[key]).toBe(TELEMETRY_REDACTED)
    }
    expect(isSensitiveTelemetryKey("x-auth-TOKEN")).toBe(true)
    expect(isSensitiveTelemetryKey("orderId")).toBe(false)
    expect(SENSITIVE_TELEMETRY_KEY_PATTERNS.length).toBeGreaterThan(0)
  })
})
