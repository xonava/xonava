import { describe, expect, it } from "vitest"
import { MAX_AUDIT_VALUE_DEPTH, buildAuditRecord, classifyAuditValue, defaultAuditSanitizer } from "../audit"

describe("audit port coverage paths", () => {
  it("sanitizes sensitive keys, scalar values, arrays, and nested objects", () => {
    expect(defaultAuditSanitizer("email@example.com and 2026-08-05")).toBe("[redacted] and [redacted]")
    expect(defaultAuditSanitizer(["+1 234 567 8901", 42, null])).toEqual(["+[redacted]", 42, null])
    expect(defaultAuditSanitizer({ patientName: "Alice", safe: { note: "private", value: "ok" } })).toEqual({
      patientName: "[redacted]",
      safe: { note: "[redacted]", value: "ok" },
    })
    expect(defaultAuditSanitizer(false)).toBe(false)
  })

  it("builds defaults while preserving explicit nulls and metadata", () => {
    const occurredAt = new Date("2026-08-05T00:00:00Z")
    const actor = { id: "user-1", kind: "human" as const, authentication: { kind: "authenticated" as const, method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } }
    expect(buildAuditRecord({
      id: "audit-1",
      occurredAt,
      actor,
      action: "update",
      resourceType: "patient",
      resourceId: "patient-1",
      tenantId: null,
      oldValue: null,
      newValue: { status: "active" },
      metadata: { source: "test" },
    })).toEqual(expect.objectContaining({ id: "audit-1", oldValue: null, newValue: { status: "active" }, metadata: { source: "test" } }))
    expect(buildAuditRecord({ id: "audit-2", occurredAt, actor, action: "read", resourceType: "x", resourceId: "y", tenantId: "tenant-1" })).toEqual(expect.objectContaining({ oldValue: null, newValue: null }))
  })

  it("omits classified free-text fields before heuristic sanitization", () => {
    const classified = classifyAuditValue({ note: "email@example.com", status: "ok", nested: { secret: "keep out" } }, {
      note: "omit",
      nested: "include",
    })
    expect(defaultAuditSanitizer(classified)).toEqual({ status: "ok", nested: { secret: "[redacted]" } })
  })

  it("does not create a prototype through JSON __proto__ keys", () => {
    const value = defaultAuditSanitizer(JSON.parse('{"__proto__":{"polluted":true},"safe":1}')) as Record<string, unknown>
    expect(Object.hasOwn(value, "__proto__")).toBe(true)
    expect((value as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it("bounds deep and cyclic audit values without throwing or invoking accessors", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(defaultAuditSanitizer(cyclic)).toEqual({ self: "[circular]" })
    let deep: unknown = { value: "ok" }
    for (let index = 0; index < MAX_AUDIT_VALUE_DEPTH + 2; index += 1) deep = { child: deep }
    expect(JSON.stringify(defaultAuditSanitizer(deep))).toContain("[truncated]")
    let reads = 0
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, "secret", { enumerable: true, get() { reads += 1; return "value" } })
    expect(defaultAuditSanitizer(accessor)).toEqual({ secret: "[redacted]" })
    expect(reads).toBe(0)
  })
})
