import { describe, expect, it } from "vitest"
import { ValidationError } from "../../domain/errors"
import { defineAttachment, type AttachmentMetadataInput } from ".."

const input = (o: Record<string, unknown> = {}): AttachmentMetadataInput => ({
  id: "a1", executionScope: { kind: "tenant", tenantId: "t1" }, object: { key: "t1/a1" }, fileName: "a.txt", contentType: "text/plain",
  contentLength: 1, createdAt: new Date("2026-01-02T03:04:05.000Z"), ...o,
}) as AttachmentMetadataInput
const fails = (o: Record<string, unknown>, message: string) => {
  try { defineAttachment(input(o)) } catch (e) {
    expect(e).toBeInstanceOf(ValidationError)
    expect((e as Error).message).toBe(message)
    return
  }
  throw new Error(`expected: ${message}`)
}

describe("defineAttachment", () => {
  it("requires non-blank identity, file name and content type", () => {
    const m = "Attachment identity, file name and content type are required"
    for (const key of ["id", "fileName", "contentType"]) { fails({ [key]: "" }, m); fails({ [key]: "   " }, m) }
  })
  it("requires a non-negative safe integer length", () => {
    const m = "Attachment contentLength must be a non-negative safe integer"
    for (const contentLength of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1"]) fails({ contentLength }, m)
    expect(defineAttachment(input({ contentLength: 0 })).contentLength).toBe(0)
    expect(defineAttachment(input({ contentLength: Number.MAX_SAFE_INTEGER })).contentLength).toBe(Number.MAX_SAFE_INTEGER)
  })
  it("requires a valid creation date", () => {
    const m = "Attachment createdAt must be valid"
    fails({ createdAt: new Date(Number.NaN) }, m)
    fails({ createdAt: "2026-01-02T03:04:05.000Z" }, m)
    fails({ createdAt: 5 }, m)
  })
  it("returns a frozen canonical copy", () => {
    const object = { bucket: "files", key: "t1/a1", version: "v1" }
    const checksum = { algorithm: "sha256", value: "abc" }
    const out = defineAttachment(input({ object, checksum, classification: "pii" }))
    expect(out).toStrictEqual({
      id: "a1", executionScope: { kind: "tenant", tenantId: "t1" }, object: { bucket: "files", key: "t1/a1", version: "v1" },
      fileName: "a.txt", contentType: "text/plain", contentLength: 1, checksum: { algorithm: "sha256", value: "abc" }, classification: "pii",
      createdAt: "2026-01-02T03:04:05.000Z",
    })
    expect(Object.isFrozen(out)).toBe(true)
    expect(Object.isFrozen(out.object)).toBe(true)
    expect(Object.isFrozen(out.checksum)).toBe(true)
    expect(out.object).not.toBe(object)
    expect(out.checksum).not.toBe(checksum)
    expect("checksum" in defineAttachment(input())).toBe(false)
  })
})
