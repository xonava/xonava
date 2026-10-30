import { describe, expect, it } from "vitest"
import { CanonicalJsonError, encodeBase64UrlUnpadded } from "../../serialization/canonicalJson"
import { EXECUTION_SCOPE_ID_PREFIX } from "../../spec/authority"
import { FORMAT_DEFAULT_MAX_CANONICAL_BYTES, SERIALIZATION_LIMIT_EXCEEDED_ERROR } from "../../spec/formatVersions"
import { decodeExecutionScopeId, encodeExecutionScopeId, executionScopesEqual, isAuthorityNarrowing, isExecutionScopeKind, validateExecutionScope, type ExecutionScope } from "../executionScope"

const LIMIT = FORMAT_DEFAULT_MAX_CANONICAL_BYTES.executionScopeIdentitySource

function failure(run: () => unknown): CanonicalJsonError {
  try {
    run()
  } catch (error) {
    return error as CanonicalJsonError
  }
  throw new Error("expected the call to throw")
}

function expectInvalid(run: () => unknown, message: string, code?: string): void {
  const error = failure(run)
  expect(error).toBeInstanceOf(CanonicalJsonError)
  expect(error.message).toBe(message)
  expect(error.code).toBe(code)
}

const idOf = (json: string): string => `${EXECUTION_SCOPE_ID_PREFIX}${encodeBase64UrlUnpadded(new TextEncoder().encode(json))}`

describe("validateExecutionScope", () => {
  it("rejects non-records and a missing or non-string kind", () => {
    for (const bad of [null, undefined, "tenant", 5, ["tenant"], {}, { kind: 5 }, { kind: null }]) {
      expectInvalid(() => validateExecutionScope(bad), "invalid ExecutionScope: missing kind")
    }
  })

  it("rejects an unknown kind", () => {
    expectInvalid(() => validateExecutionScope({ kind: "public" }), "invalid ExecutionScope kind: public")
  })

  it.each([
    ["application", "applicationKey"],
    ["tenant", "tenantId"],
    ["platform", "platformKey"],
    ["system", "systemKey"],
  ] as const)("validates the %s scope", (kind, key) => {
    const valid = { kind, [key]: "k" }
    expect(validateExecutionScope(valid)).toEqual(valid)
    expect(validateExecutionScope({ ...valid, [key]: " k " })).toEqual({ kind, [key]: " k " })
    const message = `invalid ${kind} scope: ${key} must be non-empty string`
    for (const bad of ["", "   ", 5, null, undefined]) {
      expectInvalid(() => validateExecutionScope({ kind, [key]: bad }), message)
    }
    expectInvalid(() => validateExecutionScope({ ...valid, extra: 1 }), `invalid ${kind} scope: extra keys`)
    expectInvalid(() => validateExecutionScope({ ...valid, extra: undefined }), `invalid ${kind} scope: extra keys`)
    expect(Object.keys(validateExecutionScope({ ...valid }))).toEqual(["kind", key])
  })
})

describe("encodeExecutionScopeId", () => {
  const tenantOfBytes = (bytes: number): ExecutionScope => {
    const overhead = new TextEncoder().encode('{"kind":"tenant","tenantId":""}').byteLength
    return { kind: "tenant", tenantId: "t".repeat(bytes - overhead) }
  }

  it("accepts a canonical form of exactly the limit and rejects one byte more", () => {
    const atLimit = encodeExecutionScopeId(tenantOfBytes(LIMIT))
    expect(atLimit.startsWith(EXECUTION_SCOPE_ID_PREFIX)).toBe(true)
    const error = failure(() => encodeExecutionScopeId(tenantOfBytes(LIMIT + 1)))
    expect(error).toBeInstanceOf(CanonicalJsonError)
    expect(error.message).toBe(`execution scope canonical bytes ${LIMIT + 1} exceeds limit ${LIMIT}`)
    expect(error.code).toBe(SERIALIZATION_LIMIT_EXCEEDED_ERROR)
  })

  it("validates before encoding", () => {
    expectInvalid(() => encodeExecutionScopeId({ kind: "tenant", tenantId: "" }), "invalid tenant scope: tenantId must be non-empty string")
  })
})

describe("decodeExecutionScopeId", () => {
  it("round-trips at the size limit and rejects a larger decoded payload", () => {
    const overhead = new TextEncoder().encode('{"kind":"tenant","tenantId":""}').byteLength
    const atLimit: ExecutionScope = { kind: "tenant", tenantId: "t".repeat(LIMIT - overhead) }
    expect(decodeExecutionScopeId(encodeExecutionScopeId(atLimit))).toEqual(atLimit)
    const oversized = idOf(`{"kind":"tenant","tenantId":"${"t".repeat(LIMIT - overhead + 1)}"}`)
    expectInvalid(() => decodeExecutionScopeId(oversized), `decoded scope bytes ${LIMIT + 1} exceeds limit`, SERIALIZATION_LIMIT_EXCEEDED_ERROR)
  })

  it("rejects malformed identifiers with exact messages", () => {
    expectInvalid(() => decodeExecutionScopeId(5 as never), "scopeId must be string")
    expectInvalid(() => decodeExecutionScopeId("tenant:abc"), `scopeId must start with ${EXECUTION_SCOPE_ID_PREFIX}`)
    expectInvalid(() => decodeExecutionScopeId(""), `scopeId must start with ${EXECUTION_SCOPE_ID_PREFIX}`)
    expectInvalid(() => decodeExecutionScopeId(EXECUTION_SCOPE_ID_PREFIX), "scopeId missing base64url payload")
  })

  it("rejects invalid UTF-8", () => {
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])
    expectInvalid(() => decodeExecutionScopeId(`${EXECUTION_SCOPE_ID_PREFIX}${encodeBase64UrlUnpadded(bytes)}`), "scopeId contains invalid UTF-8")
  })

  it("rejects non-canonical but otherwise valid encodings", () => {
    expectInvalid(() => decodeExecutionScopeId(idOf('{"tenantId":"t","kind":"tenant"}')), "scopeId is not canonical: re-encoding mismatch")
    expectInvalid(() => decodeExecutionScopeId(idOf('{"kind":"tenant", "tenantId":"t"}')), "scopeId is not canonical: re-encoding mismatch")
  })

  it("validates the decoded structure", () => {
    expectInvalid(() => decodeExecutionScopeId(idOf('{"kind":"public"}')), "invalid ExecutionScope kind: public")
    expectInvalid(() => decodeExecutionScopeId(idOf("[]")), "invalid ExecutionScope: missing kind")
  })
})

describe("scope relations", () => {
  const tenant: ExecutionScope = { kind: "tenant", tenantId: "t" }
  const tenant2: ExecutionScope = { kind: "tenant", tenantId: "t2" }
  const platform: ExecutionScope = { kind: "platform", platformKey: "p" }
  const system: ExecutionScope = { kind: "system", systemKey: "s" }
  const application: ExecutionScope = { kind: "application", applicationKey: "a" }

  it("compares scopes by canonical identity", () => {
    expect(executionScopesEqual(tenant, { kind: "tenant", tenantId: "t" })).toBe(true)
    expect(executionScopesEqual(tenant, tenant2)).toBe(false)
    expect(executionScopesEqual(tenant, platform)).toBe(false)
  })

  it("narrows only from platform or system to a tenant, or to an equal scope", () => {
    expect(isAuthorityNarrowing(platform, tenant)).toBe(true)
    expect(isAuthorityNarrowing(system, tenant)).toBe(true)
    expect(isAuthorityNarrowing(application, tenant)).toBe(false)
    expect(isAuthorityNarrowing(tenant, tenant2)).toBe(false)
    expect(isAuthorityNarrowing(tenant, tenant)).toBe(true)
    expect(isAuthorityNarrowing(platform, platform)).toBe(true)
    expect(isAuthorityNarrowing(platform, system)).toBe(false)
    expect(isAuthorityNarrowing(platform, application)).toBe(false)
    expect(isAuthorityNarrowing(tenant, platform)).toBe(false)
  })

  it("narrows kinds", () => {
    expect(isExecutionScopeKind(tenant, "tenant")).toBe(true)
    expect(isExecutionScopeKind(tenant, "platform")).toBe(false)
  })
})
