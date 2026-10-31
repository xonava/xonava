import { afterEach, describe, expect, it, vi } from "vitest"
import {
  DURABLE_FORMAT_REGISTRY_V1,
  type DurableFormatRegistration,
} from "../../spec/formatVersions"
import { CanonicalJsonError } from "../canonicalJson"
import {
  INVALID_ENVELOPE_ERROR,
  UNSUPPORTED_FORMAT_ERROR,
  UNSUPPORTED_FORMAT_VERSION_ERROR,
} from "../formatEnvelope"
import {
  COMPILED_DURABLE_FORMAT_REGISTRY_V1,
  FORMAT_DEFAULT_MAX_BYTES_BY_FORMAT,
  assertEnvelopeSupported,
  assertFormatSupported,
  ensureRegistryValid,
  getCompiledFormat,
  getFormatDefaultMaxBytes,
  getFormatRegistration,
  getReadableVersions,
  isFormatVersionReadable,
  listCompiledFormats,
  listFormats,
  validateRegistry,
} from "../formatRegistry"

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

const entry = (formatId: string, formatVersion = 1, kind: string = "framework-envelope"): DurableFormatRegistration =>
  ({ formatId, formatVersion, kind }) as DurableFormatRegistration

describe("compiled registry", () => {
  it("compiles every registration with readable versions [1], frozen", () => {
    expect(DURABLE_FORMAT_REGISTRY_V1.length).toBe(3)
    const entries = COMPILED_DURABLE_FORMAT_REGISTRY_V1.entries
    expect(entries).toEqual(DURABLE_FORMAT_REGISTRY_V1.map((registration) => ({ ...registration, readableVersions: [1] })))
    expect(entries.map((compiled) => compiled.formatId)).toEqual([
      "framework.event-envelope",
      "framework.authority-provenance",
      "framework.execution-scope-id",
    ])
    expect(Object.isFrozen(COMPILED_DURABLE_FORMAT_REGISTRY_V1)).toBe(true)
    expect(Object.isFrozen(entries)).toBe(true)
    for (const compiled of entries) {
      expect(Object.isFrozen(compiled)).toBe(true)
      expect(Object.isFrozen(compiled.readableVersions)).toBe(true)
      expect(compiled.readableVersions).toEqual([1])
      expect(COMPILED_DURABLE_FORMAT_REGISTRY_V1.byFormatId.get(compiled.formatId)).toBe(compiled)
    }
    expect(COMPILED_DURABLE_FORMAT_REGISTRY_V1.byFormatId.size).toBe(3)
    expect(COMPILED_DURABLE_FORMAT_REGISTRY_V1.byFormatId.get("framework.unknown")).toBeUndefined()
  })

  it("lists the same entries through every accessor", () => {
    expect(listFormats()).toBe(COMPILED_DURABLE_FORMAT_REGISTRY_V1.entries)
    expect(listCompiledFormats()).toBe(COMPILED_DURABLE_FORMAT_REGISTRY_V1.entries)
  })

  it("looks formats up by id", () => {
    const compiled = COMPILED_DURABLE_FORMAT_REGISTRY_V1.entries[1]!
    expect(getFormatRegistration(compiled.formatId)).toBe(compiled)
    expect(getCompiledFormat(compiled.formatId)).toBe(compiled)
    expect(getFormatRegistration("nope")).toBeUndefined()
    expect(getCompiledFormat("nope")).toBeUndefined()
    expect(getCompiledFormat("constructor")).toBeUndefined()
    expect(getCompiledFormat("__proto__")).toBeUndefined()
    expect(getReadableVersions(compiled.formatId)).toEqual([1])
    expect(getReadableVersions("nope")).toBeUndefined()
  })

  it("answers version readability per format", () => {
    expect(isFormatVersionReadable("framework.event-envelope", 1)).toBe(true)
    expect(isFormatVersionReadable("framework.event-envelope", 2)).toBe(false)
    expect(isFormatVersionReadable("framework.event-envelope", 0)).toBe(false)
    expect(isFormatVersionReadable("nope", 1)).toBe(false)
  })
})

describe("assertFormatSupported and assertEnvelopeSupported", () => {
  it("accepts registered formats at readable versions", () => {
    for (const registration of DURABLE_FORMAT_REGISTRY_V1) {
      expect(assertFormatSupported(registration.formatId, 1)).toBeUndefined()
      expect(assertEnvelopeSupported({ format: registration.formatId, version: 1 })).toBeUndefined()
    }
  })

  it("rejects with the exact message and code per failure", () => {
    expectCanonicalError(() => assertFormatSupported("Bad", 1), 'invalid format id "Bad"', INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => assertFormatSupported("framework.event-envelope", 0), "invalid version 0", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => assertFormatSupported("framework.event-envelope", 1.5), "invalid version 1.5", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => assertFormatSupported("not.registered", 1), 'unsupported durable format "not.registered"', UNSUPPORTED_FORMAT_ERROR)
    expectCanonicalError(
      () => assertFormatSupported("framework.event-envelope", 2),
      'unsupported version 2 for format "framework.event-envelope"; readable versions: [1]',
      UNSUPPORTED_FORMAT_VERSION_ERROR,
    )
    // invalid id wins over invalid version, invalid version over unknown format
    expectCanonicalError(() => assertFormatSupported("Bad", 0), 'invalid format id "Bad"', INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => assertFormatSupported("not.registered", 0), "invalid version 0", INVALID_ENVELOPE_ERROR)
  })

  it("assertEnvelopeSupported delegates to assertFormatSupported", () => {
    expectCanonicalError(
      () => assertEnvelopeSupported({ format: "framework.authority-provenance", version: 7 }),
      'unsupported version 7 for format "framework.authority-provenance"; readable versions: [1]',
      UNSUPPORTED_FORMAT_VERSION_ERROR,
    )
    expectCanonicalError(() => assertEnvelopeSupported({ format: "zzz", version: 1 }), 'unsupported durable format "zzz"', UNSUPPORTED_FORMAT_ERROR)
  })
})

describe("validateRegistry", () => {
  it("accepts the default registry and valid custom registries", () => {
    expect(validateRegistry()).toBeUndefined()
    expect(validateRegistry([])).toBeUndefined()
    expect(validateRegistry([entry("a"), entry("b", 7, "identity-encoding")])).toBeUndefined()
  })

  it("rejects an invalid format id", () => {
    expectCanonicalError(() => validateRegistry([entry("A.b")]), 'invalid formatId "A.b"', INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => validateRegistry([entry("ok"), entry("")]), 'invalid formatId ""', INVALID_ENVELOPE_ERROR)
  })

  it("rejects duplicate format ids", () => {
    expectCanonicalError(() => validateRegistry([entry("dup"), entry("other"), entry("dup")]), 'duplicate formatId "dup"', INVALID_ENVELOPE_ERROR)
  })

  it("rejects an invalid format version", () => {
    expectCanonicalError(() => validateRegistry([entry("a.b", 0)]), "invalid formatVersion 0 for a.b", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => validateRegistry([entry("a.b", 1.5)]), "invalid formatVersion 1.5 for a.b", INVALID_ENVELOPE_ERROR)
  })

  it("rejects an unknown kind", () => {
    expectCanonicalError(() => validateRegistry([entry("a.b", 1, "other")]), 'invalid kind "other"', INVALID_ENVELOPE_ERROR)
  })

  it("reports the first problem of an entry in id, duplicate, version, kind order", () => {
    expectCanonicalError(() => validateRegistry([entry("A", 0, "x")]), 'invalid formatId "A"', INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => validateRegistry([entry("a"), entry("a", 0, "x")]), 'duplicate formatId "a"', INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => validateRegistry([entry("a", 0, "x")]), "invalid formatVersion 0 for a", INVALID_ENVELOPE_ERROR)
  })
})

describe("default byte limits", () => {
  it("pins the per-format defaults", () => {
    expect(FORMAT_DEFAULT_MAX_BYTES_BY_FORMAT).toEqual({
      "framework.event-envelope": 1024 * 1024,
      "framework.authority-provenance": 64 * 1024,
      "framework.execution-scope-id": 4 * 1024,
    })
    expect(Object.isFrozen(FORMAT_DEFAULT_MAX_BYTES_BY_FORMAT)).toBe(true)
    expect(getFormatDefaultMaxBytes("framework.event-envelope")).toBe(1048576)
    expect(getFormatDefaultMaxBytes("framework.authority-provenance")).toBe(65536)
    expect(getFormatDefaultMaxBytes("framework.execution-scope-id")).toBe(4096)
  })

  it("returns undefined for unlisted formats, including inherited property names", () => {
    for (const id of ["nope", "constructor", "toString", "__proto__", "hasOwnProperty", ""]) expect(getFormatDefaultMaxBytes(id)).toBeUndefined()
  })
})

describe("ensureRegistryValid", () => {
  afterEach(() => {
    vi.doUnmock("../../spec/formatVersions")
    vi.resetModules()
  })

  async function loadWith(registry: readonly DurableFormatRegistration[]) {
    vi.resetModules()
    vi.doMock("../../spec/formatVersions", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../spec/formatVersions")>()),
      DURABLE_FORMAT_REGISTRY_V1: registry,
    }))
    const registryModule = await import("../formatRegistry")
    const { CanonicalJsonError: FreshError } = await import("../canonicalJson")
    return { ...registryModule, FreshError }
  }

  it("passes for the real registry and validates once", async () => {
    let iterations = 0
    const counted = new Proxy([entry("a.one"), entry("a.two", 1, "identity-encoding")], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) iterations += 1
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    const loaded = await loadWith(counted)
    expect(loaded.listFormats().map((compiled) => compiled.formatId)).toEqual(["a.one", "a.two"])
    const before = iterations
    expect(loaded.ensureRegistryValid()).toBeUndefined()
    expect(iterations).toBe(before + 1)
    expect(loaded.ensureRegistryValid()).toBeUndefined()
    expect(loaded.getFormatRegistration("a.one")?.formatId).toBe("a.one")
    expect(iterations).toBe(before + 1)
  })

  it("propagates registry validation failures and keeps failing", async () => {
    const loaded = await loadWith([entry("a.one", 1, "bogus")])
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = caught(() => loaded.ensureRegistryValid())
      expect(error).toBeInstanceOf(loaded.FreshError)
      expect((error as CanonicalJsonError).message).toBe('invalid kind "bogus"')
      expect((error as CanonicalJsonError).code).toBe(INVALID_ENVELOPE_ERROR)
    }
    expect(caught(() => loaded.getFormatRegistration("a.one"))).toBeInstanceOf(loaded.FreshError)
  })

  it("requires the readable versions to include the current format version", async () => {
    const loaded = await loadWith([entry("ok.format", 1), entry("future.format", 2)])
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = caught(() => loaded.ensureRegistryValid())
      expect(error).toBeInstanceOf(loaded.FreshError)
      expect((error as CanonicalJsonError).message).toBe("readableVersions for future.format must include current formatVersion 2")
      expect((error as CanonicalJsonError).code).toBe(INVALID_ENVELOPE_ERROR)
    }
    expect(caught(() => loaded.getFormatRegistration("ok.format"))).toBeInstanceOf(loaded.FreshError)
  })

  it("the real registry satisfies the invariant", () => {
    expect(ensureRegistryValid()).toBeUndefined()
    for (const compiled of COMPILED_DURABLE_FORMAT_REGISTRY_V1.entries) expect(compiled.readableVersions).toContain(compiled.formatVersion)
  })
})
