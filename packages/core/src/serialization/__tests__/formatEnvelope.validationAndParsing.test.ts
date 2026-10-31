import { describe, expect, it } from "vitest"
import { CanonicalJsonError } from "../canonicalJson"
import {
  INVALID_ENVELOPE_ERROR,
  UNSUPPORTED_FORMAT_VERSION_ERROR,
  assertEnvelopeVersionSupported,
  assertReadableVersion,
  createEnvelope,
  isEnvelopeReadable,
  isReadableVersion,
  isValidFormatId,
  isValidVersion,
  isVersionSupported,
  parseEnvelope,
  validateEnvelope,
} from "../formatEnvelope"

function caught(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

function expectCanonicalError(fn: () => unknown, message: string, code: string): void {
  const error = caught(fn)
  expect(error).toBeInstanceOf(CanonicalJsonError)
  expect((error as CanonicalJsonError).message).toBe(message)
  expect((error as CanonicalJsonError).code).toBe(code)
}

describe("isValidFormatId", () => {
  it("accepts lowercase alphanumeric ids with dots, underscores and dashes after the first character", () => {
    for (const id of ["a", "0", "9a", "framework.event-envelope", "a.b_c-d", "a-", "a.", "a_", "abc123", "a".repeat(256)]) {
      expect(isValidFormatId(id), id.slice(0, 20)).toBe(true)
    }
  })

  it("rejects everything else, including over-long ids and anchored-regex escapes", () => {
    for (const id of ["", "a".repeat(257), "A", "aB", "-a", ".a", "_a", " a", "a ", "a b", "a\n", "\na", "a/b", "a:b", "aé", "a\u0000", "é"]) {
      expect(isValidFormatId(id), JSON.stringify(id.slice(0, 20))).toBe(false)
    }
    expect(isValidFormatId(`${"a".repeat(255)}!`)).toBe(false)
  })

  it("rejects non-strings", () => {
    for (const id of [undefined, null, 1, {}, ["a"], Symbol("a")]) expect(isValidFormatId(id as never)).toBe(false)
  })
})

describe("isValidVersion", () => {
  it("accepts integers from 1 to MAX_SAFE_INTEGER", () => {
    for (const version of [1, 2, 255, 2 ** 31, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) expect(isValidVersion(version)).toBe(true)
  })

  it("rejects zero, negatives, fractions, unsafe and non-numeric values", () => {
    for (const version of [0, -0, -1, 0.5, 1.5, Number.MAX_SAFE_INTEGER + 1, 2 ** 53 + 2, Number.NaN, Infinity, -Infinity, "1", null, undefined, 1n]) {
      expect(isValidVersion(version as never), String(version)).toBe(false)
    }
  })
})

describe("readable version predicates", () => {
  it("agree on membership", () => {
    expect(isReadableVersion(1, [1, 2])).toBe(true)
    expect(isReadableVersion(2, [1, 2])).toBe(true)
    expect(isReadableVersion(3, [1, 2])).toBe(false)
    expect(isReadableVersion(1, [])).toBe(false)
    expect(isVersionSupported(2, [1, 2])).toBe(true)
    expect(isVersionSupported(3, [1, 2])).toBe(false)
    expect(isEnvelopeReadable({ format: "a", version: 2 }, [1, 2])).toBe(true)
    expect(isEnvelopeReadable({ format: "a", version: 3 }, [1, 2])).toBe(false)
  })
})

describe("assertReadableVersion", () => {
  it("rejects invalid versions before checking readability", () => {
    for (const version of [0, 1.5, -1, Number.NaN]) {
      expectCanonicalError(() => assertReadableVersion(version, [version]), `invalid version ${version}`, INVALID_ENVELOPE_ERROR)
    }
  })

  it("reports an unsupported version with and without a format label", () => {
    expectCanonicalError(
      () => assertReadableVersion(3, [1, 2]),
      "unsupported durable format version 3; readable versions: [1, 2]",
      UNSUPPORTED_FORMAT_VERSION_ERROR,
    )
    expectCanonicalError(
      () => assertReadableVersion(3, [1, 2], "my.format"),
      'unsupported durable format version 3 for format "my.format"; readable versions: [1, 2]',
      UNSUPPORTED_FORMAT_VERSION_ERROR,
    )
    expectCanonicalError(
      () => assertReadableVersion(2, [], ""),
      'unsupported durable format version 2 for format ""; readable versions: []',
      UNSUPPORTED_FORMAT_VERSION_ERROR,
    )
    expectCanonicalError(
      () => assertReadableVersion(9, [7]),
      "unsupported durable format version 9; readable versions: [7]",
      UNSUPPORTED_FORMAT_VERSION_ERROR,
    )
  })

  it("passes for readable versions", () => {
    expect(assertReadableVersion(2, [1, 2], "a")).toBeUndefined()
  })

  it("assertEnvelopeVersionSupported labels the error with the envelope format", () => {
    expectCanonicalError(
      () => assertEnvelopeVersionSupported({ format: "a.b", version: 4 }, [1]),
      'unsupported durable format version 4 for format "a.b"; readable versions: [1]',
      UNSUPPORTED_FORMAT_VERSION_ERROR,
    )
    expect(assertEnvelopeVersionSupported({ format: "a.b", version: 1 }, [1])).toBeUndefined()
  })
})

describe("createEnvelope", () => {
  it("builds { format, version, payload } in that key order", () => {
    const envelope = createEnvelope("a.b", 3, { x: 1 })
    expect(envelope).toEqual({ format: "a.b", version: 3, payload: { x: 1 } })
    expect(Object.keys(envelope as object)).toEqual(["format", "version", "payload"])
    expect(createEnvelope("a", 1, null)).toEqual({ format: "a", version: 1, payload: null })
    expect(createEnvelope("a", 1, 0)).toEqual({ format: "a", version: 1, payload: 0 })
    expect(createEnvelope("a", 1, "")).toEqual({ format: "a", version: 1, payload: "" })
  })

  it("rejects an invalid format id, version or undefined payload with exact messages", () => {
    expectCanonicalError(() => createEnvelope("Bad", 1, 1), 'invalid format id "Bad"', INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => createEnvelope("", 1, 1), 'invalid format id ""', INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => createEnvelope("a", 0, 1), "invalid format version 0", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => createEnvelope("a", 1.5, 1), "invalid format version 1.5", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => createEnvelope("a", 1, undefined), "envelope payload must not be undefined", INVALID_ENVELOPE_ERROR)
    // format is checked first, then version, then payload
    expectCanonicalError(() => createEnvelope("Bad", 0, undefined), 'invalid format id "Bad"', INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => createEnvelope("a", 0, undefined), "invalid format version 0", INVALID_ENVELOPE_ERROR)
  })
})

describe("parseEnvelope", () => {
  it("returns the three members of a valid envelope", () => {
    const parsed = parseEnvelope({ format: "a.b", version: 2, payload: { k: [1] } })
    expect(parsed).toEqual({ format: "a.b", version: 2, payload: { k: [1] } })
    expect(Object.keys(parsed)).toEqual(["format", "version", "payload"])
    expect(parseEnvelope({ payload: null, version: 1, format: "a" })).toEqual({ format: "a", version: 1, payload: null })
    expect(parseEnvelope({ format: "a", version: 1, payload: undefined })).toEqual({ format: "a", version: 1, payload: undefined })
  })

  it("accepts null-prototype envelopes", () => {
    const envelope = Object.assign(Object.create(null) as Record<string, unknown>, { format: "a", version: 1, payload: 1 })
    expect(parseEnvelope(envelope)).toEqual({ format: "a", version: 1, payload: 1 })
  })

  it("rejects non plain objects", () => {
    class Envelope {
      format = "a"
      version = 1
      payload = 1
    }
    for (const value of [null, undefined, 1, "x", true, [], [1], new Envelope(), new Map(), Object.create({ format: "a" }) as object, () => 1]) {
      expectCanonicalError(() => parseEnvelope(value), "envelope must be a plain object", INVALID_ENVELOPE_ERROR)
    }
  })

  it("rejects an invalid format member", () => {
    expectCanonicalError(() => parseEnvelope({ version: 1, payload: 1 }), "invalid envelope format undefined", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => parseEnvelope({ format: 5, version: 1, payload: 1 }), "invalid envelope format 5", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => parseEnvelope({ format: "BAD", version: 1, payload: 1 }), 'invalid envelope format "BAD"', INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => parseEnvelope({ format: "", version: 1, payload: 1 }), 'invalid envelope format ""', INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => parseEnvelope({ format: null, version: 1, payload: 1 }), "invalid envelope format null", INVALID_ENVELOPE_ERROR)
  })

  it("rejects an invalid version member", () => {
    expectCanonicalError(() => parseEnvelope({ format: "a", payload: 1 }), "invalid envelope version undefined", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => parseEnvelope({ format: "a", version: "1", payload: 1 }), 'invalid envelope version "1"', INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => parseEnvelope({ format: "a", version: 0, payload: 1 }), "invalid envelope version 0", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => parseEnvelope({ format: "a", version: 1.5, payload: 1 }), "invalid envelope version 1.5", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => parseEnvelope({ format: "a", version: -1, payload: 1 }), "invalid envelope version -1", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => parseEnvelope({ format: "a", version: Number.NaN, payload: 1 }), "invalid envelope version null", INVALID_ENVELOPE_ERROR)
    expect(parseEnvelope({ format: "a", version: Number.MAX_SAFE_INTEGER, payload: 1 }).version).toBe(Number.MAX_SAFE_INTEGER)
    expectCanonicalError(
      () => parseEnvelope({ format: "a", version: Number.MAX_SAFE_INTEGER + 1, payload: 1 }),
      `invalid envelope version ${JSON.stringify(Number.MAX_SAFE_INTEGER + 1)}`,
      INVALID_ENVELOPE_ERROR,
    )
  })

  it("checks the format before the version, and both before the payload and unknown members", () => {
    expectCanonicalError(() => parseEnvelope({ format: "BAD", version: 0 }), 'invalid envelope format "BAD"', INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => parseEnvelope({ format: "a", version: 0, extra: 1 }), "invalid envelope version 0", INVALID_ENVELOPE_ERROR)
  })

  it("rejects a missing payload and unknown members", () => {
    expectCanonicalError(() => parseEnvelope({ format: "a", version: 1 }), "envelope is missing its payload", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(
      () => parseEnvelope({ format: "a", version: 1, payload: 1, zeta: 1, extra: 2 }),
      'envelope has unknown members ["zeta","extra"]',
      INVALID_ENVELOPE_ERROR,
    )
    expectCanonicalError(() => parseEnvelope({ format: "a", version: 1, extra: 1 }), "envelope is missing its payload", INVALID_ENVELOPE_ERROR)
    // an inherited payload does not count
    const inherited = Object.assign(Object.create({ payload: 1 }) as Record<string, unknown>, { format: "a", version: 1 })
    expectCanonicalError(() => parseEnvelope(inherited), "envelope must be a plain object", INVALID_ENVELOPE_ERROR)
  })
})

describe("validateEnvelope", () => {
  it("returns nothing for a valid envelope and throws for an invalid one", () => {
    expect(validateEnvelope({ format: "a", version: 1, payload: 1 })).toBeUndefined()
    expectCanonicalError(() => validateEnvelope({ format: "a", version: 1 }), "envelope is missing its payload", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => validateEnvelope(null), "envelope must be a plain object", INVALID_ENVELOPE_ERROR)
  })
})
