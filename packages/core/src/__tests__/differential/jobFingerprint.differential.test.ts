import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { forAllAsync, type Rng } from "./harness"
import { JOB_FINGERPRINT_VERSION, fingerprintJob, jobFingerprintMatches, type JobFingerprintInput } from "../../execution/jobFingerprint"
import type { JobExecutionScope } from "../../execution/types"

/**
 * Differential test of the job fingerprint against an independent RFC 8785 serializer written here, plus the
 * documented version-4 (omitted maxAttempts was written as 3) and version-3 (also integer-like object keys in
 * JavaScript property order) compatibility.
 */

const KEYS = ["0", "1", "2", "9", "10", "11", "100", "4294967294", "4294967295", "-1", "01", "a", "b", "ab", "", "é", "\u{1F600}", "～", "z", "A"]
const STRINGS = ["", "a", "1", "0", "é", "\u{1F600}", "x y", "tenant:1", "null", "true"]

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

function json(rng: Rng, depth: number): Json {
  const roll = rng.int(depth > 0 ? 9 : 6)
  switch (roll) {
    case 0: return rng.pick(STRINGS)
    case 1: return rng.pick([0, 1, -1, 7, 10, 9, 2 ** 31, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])
    case 2: return rng.pick([0.5, 1.25, -0.125, 1e-7])
    case 3: return rng.bool()
    case 4: return null
    case 5: return rng.pick(STRINGS)
    case 6: case 7: return Array.from({ length: rng.int(4) }, () => json(rng, depth - 1))
    default: return object(rng, depth - 1)
  }
}

function object(rng: Rng, depth: number): { [key: string]: Json } {
  const out: { [key: string]: Json } = {}
  for (const key of rng.shuffle(KEYS).slice(0, rng.int(6))) Object.defineProperty(out, key, { value: json(rng, depth), enumerable: true, writable: true, configurable: true })
  return out
}

function scope(rng: Rng): JobExecutionScope {
  return rng.pick<JobExecutionScope>([{ kind: "tenant", tenantId: "t1" }, { kind: "tenant", tenantId: "t:1" }, { kind: "platform", platformKey: "p" }, { kind: "system", systemKey: "s" }])
}

function generateInput(rng: Rng): JobFingerprintInput {
  return {
    executionScope: scope(rng), jobType: rng.pick(["job", "billing.sync", "é", "a:b"]), jobVersion: 1 + rng.int(3), payload: object(rng, 2),
    runAt: new Date(Date.UTC(2030, 0, 1) + rng.int(5) * 1000 + rng.pick([0, 1, 999])), maxAttempts: rng.pick([null, 1, 3, 5, 2_147_483_647]), priority: rng.pick([0, 1, -1]),
    correlationId: rng.pick([null, "c", "null", ""]), partitionKey: rng.pick([null, "p", ""]), metadata: rng.bool() ? null : object(rng, 1),
  }
}

/** Fresh copy with every object's keys inserted in a random order (key order must not matter). */
function permute(rng: Rng, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => permute(rng, item))
  if (value instanceof Date || value === null || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const key of rng.shuffle(Object.keys(value))) Object.defineProperty(out, key, { value: permute(rng, (value as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true })
  return out
}

// ---- independent serializers -----------------------------------------------------------------

const ARRAY_INDEX = /^(0|[1-9]\d*)$/
const isArrayIndex = (key: string): boolean => ARRAY_INDEX.test(key) && Number(key) < 2 ** 32 - 1

/** RFC 8785: members ordered by UTF-16 code units. */
function jcs(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`).join(",")}}`
}

/** Version 3: array-index keys first in numeric order, the remaining keys in RFC 8785 order. */
function legacyOrder(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(legacyOrder).join(",")}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  const indexKeys = keys.filter(isArrayIndex).sort((left, right) => Number(left) - Number(right))
  const rest = keys.filter((key) => !isArrayIndex(key)).sort()
  return `{${[...indexKeys, ...rest].map((key) => `${JSON.stringify(key)}:${legacyOrder(record[key])}`).join(",")}}`
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")
const material = (input: JobFingerprintInput, version: number): unknown => ({ version, job: { ...input, runAt: input.runAt.toISOString() } })
/** Versions 3 and 4 had no encoding for an omitted maxAttempts and wrote 3 for it. */
const legacyInput = (input: JobFingerprintInput): JobFingerprintInput => ({ ...input, maxAttempts: input.maxAttempts ?? 3 })
const referenceV5 = (input: JobFingerprintInput): string => sha256(jcs(material(input, 5)))
const referenceV4 = (input: JobFingerprintInput): string => sha256(jcs(material(legacyInput(input), 4)))
const referenceV3 = (input: JobFingerprintInput): string => sha256(legacyOrder(material(legacyInput(input), 3)))

function mutate(rng: Rng, input: JobFingerprintInput): JobFingerprintInput {
  switch (rng.int(10)) {
    case 0: return { ...input, executionScope: input.executionScope.kind === "tenant" ? { kind: "tenant", tenantId: `${input.executionScope.tenantId}x` } : { kind: "tenant", tenantId: "t1" } }
    case 1: return { ...input, jobType: `${input.jobType}.` }
    case 2: return { ...input, jobVersion: input.jobVersion + 1 }
    case 3: return { ...input, payload: { ...input.payload, "added": rng.pick(STRINGS) } }
    case 4: return { ...input, runAt: new Date(input.runAt.getTime() + 1) }
    // never 3 from an omitted budget: the legacy digests deliberately cannot tell those two apart
    case 5: return { ...input, maxAttempts: input.maxAttempts === null ? 1 : input.maxAttempts + 1 }
    case 6: return { ...input, priority: input.priority + 1 }
    case 7: return { ...input, correlationId: input.correlationId === null ? "" : null }
    case 8: return { ...input, partitionKey: input.partitionKey === null ? "" : null }
    default: return { ...input, metadata: input.metadata === null ? {} : null }
  }
}

describe("job fingerprint properties", () => {
  it("equals the sha256 of an independent RFC 8785 serialization of the versioned material", async () => {
    await forAllAsync("job fingerprint: digest matches an independent canonical serializer", generateInput, async (input) => {
      expect(JOB_FINGERPRINT_VERSION).toBe(5)
      expect(await fingerprintJob(input)).toBe(referenceV5(input))
    }, { runs: 200 })
  })

  it("is deterministic and independent of object key order at every depth", async () => {
    await forAllAsync("job fingerprint: deterministic and key-order independent", (rng) => {
      const input = generateInput(rng)
      return { input, twin: permute(rng, input) as JobFingerprintInput, again: { ...input, runAt: new Date(input.runAt.getTime()) } }
    }, async ({ input, twin, again }) => {
      const digest = await fingerprintJob(input)
      expect(await fingerprintJob(input)).toBe(digest)
      expect(await fingerprintJob(twin)).toBe(digest)
      expect(await fingerprintJob(again)).toBe(digest)
      await expect(jobFingerprintMatches(digest, twin)).resolves.toBe(true)
    }, { runs: 200 })
  })

  it("distinguishes inputs exactly when their canonical material differs", async () => {
    await forAllAsync("job fingerprint: distinct payloads and fields give distinct fingerprints", (rng) => {
      const base = generateInput(rng)
      return { base, others: Array.from({ length: 6 }, () => (rng.bool(0.3) ? generateInput(rng) : mutate(rng, base))) }
    }, async ({ base, others }) => {
      const all = [base, ...others]
      const digests = await Promise.all(all.map((input) => fingerprintJob(input)))
      for (let left = 0; left < all.length; left++) {
        for (let right = left + 1; right < all.length; right++) {
          const sameMaterial = jcs(material(all[left]!, 5)) === jcs(material(all[right]!, 5))
          expect(digests[left] === digests[right], `inputs ${left} and ${right} (same material: ${sameMaterial})`).toBe(sameMaterial)
        }
      }
    }, { runs: 150 })
  })

  it("accepts its own digest and stored version-4 and version-3 digests of the same job, and nothing else", async () => {
    await forAllAsync("job fingerprint: current and legacy version-4 and version-3 digests match only the same job", (rng) => {
      const input = generateInput(rng)
      return { input, other: mutate(rng, input), twin: permute(rng, input) as JobFingerprintInput }
    }, async ({ input, other, twin }) => {
      const current = await fingerprintJob(input)
      const legacy = referenceV3(input)
      const legacy4 = referenceV4(input)
      expect(legacy4).not.toBe(legacy)
      expect(legacy4).not.toBe(current)
      await expect(jobFingerprintMatches(current, input)).resolves.toBe(true)
      await expect(jobFingerprintMatches(legacy, input)).resolves.toBe(true)
      await expect(jobFingerprintMatches(legacy4, input)).resolves.toBe(true)
      await expect(jobFingerprintMatches(legacy, twin)).resolves.toBe(true)
      await expect(jobFingerprintMatches(legacy4, twin)).resolves.toBe(true)
      await expect(jobFingerprintMatches(legacy4, other)).resolves.toBe(false)
      await expect(jobFingerprintMatches(referenceV4(other), input)).resolves.toBe(false)
      await expect(jobFingerprintMatches(current, other)).resolves.toBe(false)
      await expect(jobFingerprintMatches(legacy, other)).resolves.toBe(false)
      await expect(jobFingerprintMatches(referenceV3(other), input)).resolves.toBe(false)
      await expect(jobFingerprintMatches("", input)).resolves.toBe(false)
      await expect(jobFingerprintMatches(current.toUpperCase(), input)).resolves.toBe(false)
      await expect(jobFingerprintMatches(current.slice(1), input)).resolves.toBe(false)
    }, { runs: 200 })
  })
})

describe("job fingerprint: omitted attempt budget", () => {
  it("never confuses an omitted maxAttempts with an explicit number, while legacy digests accept both", async () => {
    await forAllAsync("job fingerprint: omitted maxAttempts is distinct from every explicit number", (rng) => ({ input: { ...generateInput(rng), maxAttempts: null }, explicit: rng.pick([1, 2, 3, 5, 2_147_483_647]) }), async ({ input, explicit }) => {
      const omitted = await fingerprintJob(input)
      const withNumber = { ...input, maxAttempts: explicit }
      expect(await fingerprintJob(withNumber)).not.toBe(omitted)
      await expect(jobFingerprintMatches(omitted, withNumber)).resolves.toBe(false)
      await expect(jobFingerprintMatches(await fingerprintJob(withNumber), input)).resolves.toBe(false)
      // A stored version-4 digest carries no such distinction for the budget 3 it wrote for an omitted value.
      await expect(jobFingerprintMatches(referenceV4(input), { ...input, maxAttempts: 3 })).resolves.toBe(true)
      await expect(jobFingerprintMatches(referenceV4(input), withNumber)).resolves.toBe(explicit === 3)
    }, { runs: 100 })
  })
})
