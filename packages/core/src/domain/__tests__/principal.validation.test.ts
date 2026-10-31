import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../errors"
import { assertPrincipal, createAnonymousPrincipal, isRfc3339UtcInstant, type Principal } from "../principal"

function failure(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error("expected the call to throw")
}

function expectConfig(run: () => unknown, message: string): void {
  const error = failure(run)
  expect(error).toBeInstanceOf(ConfigurationError)
  expect(error.message).toBe(message)
}

const authenticated = { kind: "authenticated", method: "session", authenticatedAt: "2026-09-10T00:00:00.000Z" } as const
const valid: Principal = { id: "u1", kind: "human", authentication: authenticated }

describe("isRfc3339UtcInstant", () => {
  it.each([
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00.1Z",
    "2026-01-01T00:00:00.123Z",
    "2026-01-01T00:00:00.123456789Z",
    "2026-12-31T23:59:59.999Z",
    "2024-02-29T12:00:00Z",
    "2026-01-31T00:00:00Z",
    "2026-04-30T00:00:00Z",
    "0099-06-15T00:00:00Z",
  ])("accepts %s", (value) => {
    expect(isRfc3339UtcInstant(value)).toBe(true)
  })

  it.each([
    "",
    "x2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Zx",
    " 2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z ",
    "20261-01-01T00:00:00Z",
    "026-01-01T00:00:00Z",
    "abcd-01-01T00:00:00Z",
    "2026-1-01T00:00:00Z",
    "2026-ab-01T00:00:00Z",
    "2026-01-1T00:00:00Z",
    "2026-01-abT00:00:00Z",
    "2026-01-01T0:00:00Z",
    "2026-01-01Tab:00:00Z",
    "2026-01-01T00:0:00Z",
    "2026-01-01T00:ab:00Z",
    "2026-01-01T00:00:0Z",
    "2026-01-01T00:00:abZ",
    "2026-01-01T00:00:00.Z",
    "2026-01-01T00:00:00.abcZ",
    "2026-01-01T00:00:00.1234567890Z",
    "2026-01-01T00:00:00",
    "2026-01-01T00:00:00+00:00",
    "2026-01-01 00:00:00Z",
    "2026-01-01T00:00:00z",
  ])("rejects the malformed shape %j", (value) => {
    expect(isRfc3339UtcInstant(value)).toBe(false)
  })

  it.each([
    "2026-00-10T00:00:00Z",
    "2026-13-10T00:00:00Z",
    "2026-01-00T00:00:00Z",
    "2026-01-10T24:00:00Z",
    "2026-01-10T00:60:00Z",
    "2026-01-10T00:00:60Z",
    "2026-02-30T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-01-32T00:00:00Z",
    "2026-02-31T00:00:00Z",
  ])("rejects the out-of-range or non-calendar value %s", (value) => {
    expect(isRfc3339UtcInstant(value)).toBe(false)
  })
})

describe("assertPrincipal", () => {
  it("accepts every principal kind with matching authentication", () => {
    for (const kind of ["human", "service", "system"] as const) {
      expect(() => assertPrincipal({ ...valid, kind })).not.toThrow()
    }
    expect(() => assertPrincipal({ id: "anonymous", kind: "anonymous", authentication: { kind: "anonymous" } })).not.toThrow()
  })

  it("rejects non-object principals and unknown kinds", () => {
    for (const bad of [null, undefined, "u1", 5, true]) {
      expectConfig(() => assertPrincipal(bad as never), "principal.kind is invalid")
    }
    expectConfig(() => assertPrincipal({ ...valid, kind: "robot" } as never), "principal.kind is invalid")
    expectConfig(() => assertPrincipal({ id: "u1", authentication: authenticated } as never), "principal.kind is invalid")
  })

  it("rejects a non-string or blank id", () => {
    expectConfig(() => assertPrincipal({ ...valid, id: "" }), "principal.id must be non-empty")
    expectConfig(() => assertPrincipal({ ...valid, id: "   " }), "principal.id must be non-empty")
    expectConfig(() => assertPrincipal({ ...valid, id: 5 } as never), "principal.id must be non-empty")
    expectConfig(() => assertPrincipal({ ...valid, id: undefined } as never), "principal.id must be non-empty")
  })

  it("rejects missing or non-object authentication", () => {
    for (const bad of [undefined, null, "session", 1]) {
      expectConfig(() => assertPrincipal({ ...valid, authentication: bad } as never), "principal.authentication is invalid")
    }
  })

  it("requires anonymous principals to use anonymous authentication and vice versa", () => {
    expectConfig(() => assertPrincipal({ id: "a", kind: "anonymous", authentication: authenticated }), "anonymous principal must use anonymous authentication")
    expectConfig(() => assertPrincipal({ ...valid, authentication: { kind: "anonymous" } }), "non-anonymous principal must be authenticated")
  })

  it("validates the authentication method", () => {
    expectConfig(() => assertPrincipal({ ...valid, authentication: { ...authenticated, method: "" } }), "authentication.method must be non-empty")
    expectConfig(() => assertPrincipal({ ...valid, authentication: { ...authenticated, method: "  " } }), "authentication.method must be non-empty")
    expectConfig(() => assertPrincipal({ ...valid, authentication: { ...authenticated, method: 7 as never } }), "authentication.method must be non-empty")
  })

  it("validates the authentication instant", () => {
    const message = "authentication.authenticatedAt must be an RFC 3339 UTC instant"
    expectConfig(() => assertPrincipal({ ...valid, authentication: { ...authenticated, authenticatedAt: "yesterday" } }), message)
    expectConfig(() => assertPrincipal({ ...valid, authentication: { ...authenticated, authenticatedAt: 5 as never } }), message)
    expectConfig(() => assertPrincipal({ ...valid, authentication: { ...authenticated, authenticatedAt: "2026-02-31T00:00:00Z" } }), message)
    expectConfig(() => assertPrincipal({ ...valid, authentication: { kind: "authenticated", method: "session" } as never }), message)
  })
})

describe("createAnonymousPrincipal", () => {
  it("validates the id it is given", () => {
    expectConfig(() => createAnonymousPrincipal(" "), "principal.id must be non-empty")
  })

  it("returns a frozen principal with frozen authentication", () => {
    const principal = createAnonymousPrincipal("guest")
    expect(principal).toEqual({ id: "guest", kind: "anonymous", authentication: { kind: "anonymous" } })
    expect(Object.isFrozen(principal)).toBe(true)
    expect(Object.isFrozen(principal.authentication)).toBe(true)
  })
})
