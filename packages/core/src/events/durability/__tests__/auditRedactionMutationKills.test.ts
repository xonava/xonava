import { describe, expect, it } from "vitest"
import { AUDIT_REDACTION_PLACEHOLDER, redactSensitiveText } from "../auditRedaction"

describe("auditRedaction mutation kills", () => {
  it("exports the exact placeholder", () => {
    expect(AUDIT_REDACTION_PLACEHOLDER).toBe("[redacted]")
  })

  it("treats the letters A, Z, a and z as email local-part and domain characters", () => {
    expect(redactSensitiveText("A@example.com")).toBe("[redacted]")
    expect(redactSensitiveText("Z@example.com")).toBe("[redacted]")
    expect(redactSensitiveText("a@example.com")).toBe("[redacted]")
    expect(redactSensitiveText("z@example.com")).toBe("[redacted]")
    expect(redactSensitiveText("x@Example.COM")).toBe("[redacted]")
    expect(redactSensitiveText("x@az.AZ")).toBe("[redacted]")
    expect(redactSensitiveText("x@example.Zz")).toBe("[redacted]")
  })

  it("accepts every special character of the local part, including the percent sign", () => {
    expect(redactSensitiveText("a%b@example.com")).toBe("[redacted]")
    expect(redactSensitiveText("a.b_c%d+e-f@example.com")).toBe("[redacted]")
    expect(redactSensitiveText("%a@example.com")).toBe("%[redacted]")
    expect(redactSensitiveText("a b@example.com")).toBe("a [redacted]")
  })
})
