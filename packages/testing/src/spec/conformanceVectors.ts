import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const CONFORMANCE_VECTOR_SCHEMA = "framework.conformance-vectors"

export const CONFORMANCE_VECTOR_SCHEMA_VERSION = 1

export type ConformanceVectorKind =
  | "canonical-json"
  | "execution-scope-id"
  | "fingerprint"
  | "architecture-invariant"
  | "predicate"

export interface ConformanceVector {
  readonly id: string
  readonly kind: ConformanceVectorKind
  readonly formatVersion: number
  readonly input: unknown
  readonly expected: unknown
  /** Exact UTF-8 bytes, lowercase hexadecimal, for language-neutral vectors. */
  readonly expectedUtf8Hex?: string
  /** SHA-256 of the exact canonical bytes, lowercase hexadecimal. */
  readonly expectedSha256?: string
}

export interface ConformanceVectorFile {
  readonly schema: typeof CONFORMANCE_VECTOR_SCHEMA
  readonly schemaVersion: number
  readonly suiteId: string
  readonly suiteVersion: number
  readonly vectors: readonly ConformanceVector[]
}

export interface ConformanceVectorSuite {
  readonly suiteId: string
  readonly suiteVersion: number
  readonly vectors: readonly ConformanceVector[]
}

export const RESERVED_CONFORMANCE_SUITE_IDS = [
  "canonical-json",
  "execution-scope-id",
  "fingerprints",
] as const

export type ReservedConformanceSuiteId = (typeof RESERVED_CONFORMANCE_SUITE_IDS)[number]

const VECTOR_KINDS: readonly ConformanceVectorKind[] = [
  "canonical-json",
  "execution-scope-id",
  "fingerprint",
  "architecture-invariant",
  "predicate",
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseVectorFile(path: string, raw: string): ConformanceVectorFile {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) {
    throw new Error(`${path}: conformance vector file must be a JSON object`)
  }
  if (parsed.schema !== CONFORMANCE_VECTOR_SCHEMA) {
    throw new Error(`${path}: unexpected schema ${String(parsed.schema)}`)
  }
  if (parsed.schemaVersion !== CONFORMANCE_VECTOR_SCHEMA_VERSION) {
    throw new Error(`${path}: unsupported schemaVersion ${String(parsed.schemaVersion)}`)
  }
  if (typeof parsed.suiteId !== "string" || parsed.suiteId.length === 0) {
    throw new Error(`${path}: suiteId must be a non-empty string`)
  }
  if (typeof parsed.suiteVersion !== "number" || !Number.isInteger(parsed.suiteVersion) || parsed.suiteVersion < 1) {
    throw new Error(`${path}: suiteVersion must be a positive integer`)
  }
  if (!Array.isArray(parsed.vectors)) {
    throw new Error(`${path}: vectors must be an array`)
  }
  const seenIds = new Set<string>()
  for (const entry of parsed.vectors) {
    if (!isRecord(entry)) {
      throw new Error(`${path}: each vector must be an object`)
    }
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error(`${path}: vector id must be a non-empty string`)
    }
    if (seenIds.has(entry.id)) {
      throw new Error(`${path}: duplicate vector id ${entry.id}`)
    }
    seenIds.add(entry.id)
    if (typeof entry.kind !== "string" || !VECTOR_KINDS.includes(entry.kind as ConformanceVectorKind)) {
      throw new Error(`${path}: vector ${entry.id} has unknown kind ${String(entry.kind)}`)
    }
    if (
      typeof entry.formatVersion !== "number" ||
      !Number.isInteger(entry.formatVersion) ||
      entry.formatVersion < 1
    ) {
      throw new Error(`${path}: vector ${entry.id} formatVersion must be a positive integer`)
    }
    for (const field of ["expectedUtf8Hex", "expectedSha256"] as const) {
      const value = entry[field]
      if (value !== undefined && (typeof value !== "string" || !/^[0-9a-f]+$/.test(value) || value.length % 2 !== 0)) {
        throw new Error(`${path}: vector ${entry.id} ${field} must be lowercase hexadecimal`)
      }
    }
    if (entry.expectedSha256 !== undefined && (entry.expectedSha256 as string).length !== 64) {
      throw new Error(`${path}: vector ${entry.id} expectedSha256 must contain 32 bytes`)
    }
  }
  return parsed as unknown as ConformanceVectorFile
}

export function loadConformanceVectors(vectorsDirectory: string): readonly ConformanceVectorSuite[] {
  if (!existsSync(vectorsDirectory)) {
    return []
  }
  const suites: ConformanceVectorSuite[] = []
  for (const entry of readdirSync(vectorsDirectory)) {
    if (!entry.endsWith(".json")) continue
    const path = join(vectorsDirectory, entry)
    const file = parseVectorFile(path, readFileSync(path, "utf8"))
    suites.push({
      suiteId: file.suiteId,
      suiteVersion: file.suiteVersion,
      vectors: file.vectors,
    })
  }
  return suites.sort((a, b) => (a.suiteId < b.suiteId ? -1 : a.suiteId > b.suiteId ? 1 : 0))
}
