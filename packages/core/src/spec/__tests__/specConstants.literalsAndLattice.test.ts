import { describe, expect, it } from "vitest"
import {
  AUTHORITY_LATTICE_TRANSITIONS,
  isExplicitDelegation,
  transitionsFrom,
  type AuthorityTransition,
} from "../authority"
import { DURABLE_FORMAT_REGISTRY_V1, SERIALIZATION_LIMIT_EXCEEDED_ERROR } from "../formatVersions"
import {
  BINARY_JSON_ENCODING,
  CANONICALIZATION_VERSION,
  DIGEST_ALGORITHM_VERSION,
  ENVELOPE_TIMESTAMP_PRECISION,
} from "../versions"

describe("spec literal constants", () => {
  it("pins the version literals", () => {
    expect(CANONICALIZATION_VERSION).toBe("jcs-rfc8785-v1")
    expect(DIGEST_ALGORITHM_VERSION).toBe("sha256-v1")
    expect(ENVELOPE_TIMESTAMP_PRECISION).toBe("rfc3339-utc-milliseconds")
    expect(BINARY_JSON_ENCODING).toBe("base64url-unpadded")
  })

  it("pins the serialization limit error code and the durable format registry", () => {
    expect(SERIALIZATION_LIMIT_EXCEEDED_ERROR).toBe("SERIALIZATION_LIMIT_EXCEEDED")
    expect(DURABLE_FORMAT_REGISTRY_V1).toEqual([
      { formatId: "framework.event-envelope", formatVersion: 1, kind: "framework-envelope" },
      { formatId: "framework.authority-provenance", formatVersion: 1, kind: "framework-envelope" },
      { formatId: "framework.execution-scope-id", formatVersion: 1, kind: "identity-encoding" },
    ])
  })
})

describe("authority lattice", () => {
  it("lists exactly the permitted transitions", () => {
    expect(AUTHORITY_LATTICE_TRANSITIONS).toEqual([
      { from: "root", to: "application", mechanism: "bootstrap-resolution" },
      { from: "root", to: "tenant", mechanism: "bootstrap-resolution" },
      { from: "root", to: "platform", mechanism: "bootstrap-resolution" },
      { from: "root", to: "system", mechanism: "bootstrap-resolution" },
      { from: "platform", to: "delegated-tenant", mechanism: "explicit-delegation" },
      { from: "system", to: "delegated-tenant", mechanism: "explicit-delegation" },
    ])
  })

  it("filters transitions by source node", () => {
    expect(transitionsFrom("root").map((t) => t.to)).toEqual(["application", "tenant", "platform", "system"])
    expect(transitionsFrom("platform")).toEqual([{ from: "platform", to: "delegated-tenant", mechanism: "explicit-delegation" }])
    expect(transitionsFrom("tenant")).toEqual([])
  })

  it("recognises only explicit delegation", () => {
    const explicit: AuthorityTransition = { from: "platform", to: "delegated-tenant", mechanism: "explicit-delegation" }
    const bootstrap: AuthorityTransition = { from: "root", to: "tenant", mechanism: "bootstrap-resolution" }
    expect(isExplicitDelegation(explicit)).toBe(true)
    expect(isExplicitDelegation(bootstrap)).toBe(false)
  })
})
