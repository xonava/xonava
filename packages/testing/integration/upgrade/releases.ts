import * as currentDomain from "@xonava/core/domain"
import * as currentExecution from "@xonava/core/execution"
import * as currentQuery from "@xonava/core/query"
import * as currentSerialization from "@xonava/core/serialization"
import * as currentCache from "@xonava/adapters/cache"
import * as currentHttp from "@xonava/adapters/http"
import * as currentPg from "@xonava/adapters/drizzle-pg"
import * as previousDomain from "xonava-core-prev/domain"
import * as previousExecution from "xonava-core-prev/execution"
import * as previousQuery from "xonava-core-prev/query"
import * as previousSerialization from "xonava-core-prev/serialization"
import * as previousCache from "xonava-adapters-prev/cache"
import * as previousHttp from "xonava-adapters-prev/http"
import * as previousPg from "xonava-adapters-prev/drizzle-pg"

/**
 * The two sides of every upgrade test. "0.1.0" is the previous published release, installed from the npm registry
 * under the aliases `xonava-core-prev` / `xonava-adapters-prev` (see CONTRIBUTING.md, "Upgrade compatibility alias");
 * vitest.integration.config.ts points the previous adapters at the previous core, so the whole old stack is the
 * published code. "current" is this checkout.
 */
export type Release = "0.1.0" | "current"
export const RELEASES: readonly Release[] = ["0.1.0", "current"]

/** Every ordered (writer, reader) pair: old code writes and new code reads, and the reverse. */
export const DIRECTIONS: ReadonlyArray<readonly [writer: Release, reader: Release]> = [["0.1.0", "current"], ["current", "0.1.0"]]

export type ErrorClass = new (...args: never[]) => Error
type Json = Record<string, unknown>

/** The pure (database-free) building blocks of one release. */
export interface ReleaseOps {
  readonly release: Release
  readonly JobIdempotencyConflictError: ErrorClass
  readonly ConflictError: ErrorClass
  readonly encodeExecutionScopeId: (scope: { kind: string } & Json) => string
  readonly canonicalJsonString: (value: unknown) => string
  readonly legacyJavaScriptOrderJsonString: (value: unknown) => string
  readonly hmacSha256: (key: Uint8Array, payload: Uint8Array) => Uint8Array
  readonly buildJobFingerprintInput: (job: Json, runAt: Date) => Json
  readonly fingerprintJob: (input: Json) => Promise<string>
  readonly jobFingerprintMatches: (stored: string, input: Json) => Promise<boolean>
  readonly JOB_FINGERPRINT_VERSION: number
  readonly encodeCursor: (payload: Json, integrity: CursorIntegrity, maxBytes?: number) => Promise<string>
  readonly decodeCursor: (cursor: string, integrity: CursorIntegrity, maxBytes?: number, options?: { now?: number }) => Promise<Json & { values: readonly unknown[]; expiresAt?: number }>
  readonly createRotatingCursorIntegrity: (current: CursorIntegrity, previous?: readonly CursorIntegrity[]) => CursorIntegrity
  readonly fingerprintJson: (value: unknown) => Promise<string>
  readonly legacyFingerprintJson: (value: unknown) => Promise<string>
  readonly IDEMPOTENCY_FINGERPRINT_VERSION: string
  readonly computeOutboxFingerprint: (record: Json) => Promise<string>
  readonly KvCacheAdapter: new (kv: never) => KvAdapter
  readonly serializeResponse: (response: Response) => Promise<Json>
  readonly deserializeResponse: (serialized: never) => Response
}

export interface CursorIntegrity { sign(payload: Uint8Array): Promise<Uint8Array>; verify(payload: Uint8Array, signature: Uint8Array): Promise<boolean> }

export interface KvAdapter {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, data: T, ttlMs?: number): Promise<void>
  has(key: string): Promise<boolean>
  delete(key: string): Promise<boolean>
  clear(): Promise<void>
  getTagGeneration(tag: string): Promise<string>
  advanceTagGeneration(tag: string): Promise<string>
}

const ops = (release: Release, parts: { domain: unknown; execution: unknown; query: unknown; serialization: unknown; cache: unknown; http: unknown; pg: unknown }): ReleaseOps => {
  const domain = parts.domain as Record<string, unknown>
  const execution = parts.execution as Record<string, unknown>
  const query = parts.query as Record<string, unknown>
  const serialization = parts.serialization as Record<string, unknown>
  const cache = parts.cache as Record<string, unknown>
  const http = parts.http as Record<string, unknown>
  const pg = parts.pg as Record<string, unknown>
  return {
    release,
    JobIdempotencyConflictError: execution.JobIdempotencyConflictError as ErrorClass,
    ConflictError: domain.ConflictError as ErrorClass,
    encodeExecutionScopeId: domain.encodeExecutionScopeId as ReleaseOps["encodeExecutionScopeId"],
    canonicalJsonString: serialization.canonicalJsonString as ReleaseOps["canonicalJsonString"],
    legacyJavaScriptOrderJsonString: serialization.legacyJavaScriptOrderJsonString as ReleaseOps["legacyJavaScriptOrderJsonString"],
    hmacSha256: serialization.hmacSha256 as ReleaseOps["hmacSha256"],
    buildJobFingerprintInput: execution.buildJobFingerprintInput as ReleaseOps["buildJobFingerprintInput"],
    fingerprintJob: execution.fingerprintJob as ReleaseOps["fingerprintJob"],
    jobFingerprintMatches: execution.jobFingerprintMatches as ReleaseOps["jobFingerprintMatches"],
    JOB_FINGERPRINT_VERSION: execution.JOB_FINGERPRINT_VERSION as number,
    encodeCursor: query.encodeCursor as ReleaseOps["encodeCursor"],
    decodeCursor: query.decodeCursor as ReleaseOps["decodeCursor"],
    createRotatingCursorIntegrity: query.createRotatingCursorIntegrity as ReleaseOps["createRotatingCursorIntegrity"],
    fingerprintJson: http.fingerprintJson as ReleaseOps["fingerprintJson"],
    legacyFingerprintJson: http.legacyFingerprintJson as ReleaseOps["legacyFingerprintJson"],
    IDEMPOTENCY_FINGERPRINT_VERSION: http.IDEMPOTENCY_FINGERPRINT_VERSION as string,
    computeOutboxFingerprint: pg.computeOutboxFingerprint as ReleaseOps["computeOutboxFingerprint"],
    KvCacheAdapter: cache.KvCacheAdapter as ReleaseOps["KvCacheAdapter"],
    serializeResponse: http.serializeResponse as ReleaseOps["serializeResponse"],
    deserializeResponse: http.deserializeResponse as ReleaseOps["deserializeResponse"],
  }
}

export const releaseOps: Readonly<Record<Release, ReleaseOps>> = {
  "0.1.0": ops("0.1.0", { domain: previousDomain, execution: previousExecution, query: previousQuery, serialization: previousSerialization, cache: previousCache, http: previousHttp, pg: previousPg }),
  current: ops("current", { domain: currentDomain, execution: currentExecution, query: currentQuery, serialization: currentSerialization, cache: currentCache, http: currentHttp, pg: currentPg }),
}

/** A deterministic HMAC cursor integrity port shared by both releases (the key is the deployment's, not the release's). */
export function hmacCursorIntegrity(ops: ReleaseOps, secret: string): CursorIntegrity {
  const key = new TextEncoder().encode(secret)
  return {
    sign: async (payload) => ops.hmacSha256(key, payload),
    verify: async (payload, signature) => {
      const expected = ops.hmacSha256(key, payload)
      return expected.length === signature.length && expected.every((byte, index) => byte === signature[index])
    },
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
