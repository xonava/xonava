import { createHash } from "node:crypto"
import type { Rng } from "../../../core/src/__tests__/differential/harness.js"

/**
 * Pure reference models of cache tag generations (docs/spec/cache.md), independent of the stores:
 *
 * - `RefGenerations`: the shared generation store contract (DbTagGenerationStore, MySqlTagGenerationStore). A tag's
 *   generation is a counter that reads "0" before the first advance, and every advance returns exactly the previous
 *   value plus one. Tags are compared byte-for-byte.
 * - `RefKvGenerations`: the KV adapter's two counter layouts. The observed generation is the single counter when
 *   both agree, "0" when neither exists, and otherwise `h:` + the base64url SHA-256 of the JSON pair. A counter that
 *   only the previous release wrote is adopted into the current layout by a read.
 */

/** Tags up to MAX_CACHE_TAG_BYTES (256) UTF-8 bytes are legal; the rest are the shapes that stress byte-exact keys. */
export const TAGS = ["users", "orders", "tenant:t1", "entity:invoice"] as const
export const EXOTIC_TAGS = {
  caseDifferences: ["Users", "USERS", "users"],
  trailingSpace: ["space", "space ", "space  ", " space"],
  nonAscii: ["café", "café", "日本語", "😀", "ÀÉ", "àé"],
  punctuation: ["a:b", "a:b:", "a'b", "a\"b", "a\\b", "a%b", "a_b", "a b\tc", "tab\t", "new\nline", "100%", "_"],
  /** Spelled like internal KV keys and tagged storage keys. */
  kvLookalikes: ["__generation__:x", "__tag__:x", "__revision__:x", "\"1:abc\":k", "__cachegen__:x"],
} as const
export const LONG_TAG_BYTES = 256

const POOL: readonly string[] = [...TAGS, ...Object.values(EXOTIC_TAGS).flat()]

export function longTag(unit: "a" | "é" | "日"): string {
  const bytes = unit === "a" ? 1 : unit === "é" ? 2 : 3
  return unit.repeat(Math.floor(LONG_TAG_BYTES / bytes)) + "a".repeat(LONG_TAG_BYTES % bytes)
}

export function generateTag(rng: Rng, pool: readonly string[] = POOL): string {
  const roll = rng.int(20)
  if (roll === 0) return longTag(rng.pick(["a", "é", "日"] as const))
  // Few distinct tags so counters actually advance.
  return roll < 14 ? rng.pick(pool.slice(0, 4)) : rng.pick(pool)
}

export function describeTag(tag: string): string {
  return JSON.stringify(tag.length > 24 ? `${tag.slice(0, 8)}...(${tag.length} chars)` : tag)
}

// ---------------------------------------------------------------------------------------------------------------
// Shared generation store

export type StoreOp =
  | { k: "advance"; tag: string }
  | { k: "get"; tag: string }
  /** Several advances issued at once (some on the same tag): each tag's results must be previous+1..previous+n in some order. */
  | { k: "burst"; tags: string[] }

export class RefGenerations {
  private readonly counters = new Map<string, number>()
  get(tag: string): string { return String(this.counters.get(tag) ?? 0) }
  advance(tag: string): string {
    const next = (this.counters.get(tag) ?? 0) + 1
    this.counters.set(tag, next)
    return String(next)
  }
  /** The values a burst may return for each tag, as the sorted list previous+1..previous+n. */
  burst(tags: readonly string[]): Map<string, string[]> {
    const expected = new Map<string, string[]>()
    for (const tag of tags) (expected.get(tag) ?? expected.set(tag, []).get(tag)!).push(this.advance(tag))
    return expected
  }
  dump(): Array<{ tag: string; generation: number }> {
    return [...this.counters].map(([tag, generation]) => ({ tag, generation })).sort(compareRows)
  }
}

export function compareRows(a: { tag: string }, b: { tag: string }): number {
  return Buffer.compare(Buffer.from(a.tag), Buffer.from(b.tag))
}

export function generateStoreOps(rng: Rng, options: { min?: number; max?: number } = {}): StoreOp[] {
  const target = (options.min ?? 5) + rng.int((options.max ?? 30) - (options.min ?? 5) + 1)
  const ops: StoreOp[] = []
  while (ops.length < target) {
    const roll = rng.int(10)
    if (roll < 5) ops.push({ k: "advance", tag: generateTag(rng) })
    else if (roll < 8) ops.push({ k: "get", tag: generateTag(rng) })
    else ops.push({ k: "burst", tags: Array.from({ length: 2 + rng.int(5) }, () => generateTag(rng)) })
  }
  return ops
}

export function* shrinkStoreOps(ops: StoreOp[]): Iterable<StoreOp[]> {
  for (let i = 0; i < ops.length; i++) yield [...ops.slice(0, i), ...ops.slice(i + 1)]
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    if (op.k !== "burst") continue
    yield [...ops.slice(0, i), ...op.tags.map((tag) => ({ k: "advance", tag }) as StoreOp), ...ops.slice(i + 1)]
    if (op.tags.length > 2) for (let j = 0; j < op.tags.length; j++) yield [...ops.slice(0, i), { k: "burst", tags: op.tags.filter((_, index) => index !== j) }, ...ops.slice(i + 1)]
  }
}

export function describeStoreOps(ops: StoreOp[]): string {
  return ops.map((op, index) => op.k === "burst" ? `${index}: burst [${op.tags.map(describeTag).join(", ")}]` : `${index}: ${op.k} ${describeTag(op.tag)}`).join("\n")
}

// ---------------------------------------------------------------------------------------------------------------
// KV adapter, two counter layouts

export type KvOp =
  /** The current release advances: legacy counter first, then the current one. */
  | { k: "advance"; tag: string }
  /** An instance still on the previous release advances only the legacy counter. */
  | { k: "oldAdvance"; tag: string; id: string }
  | { k: "get"; tag: string }
  /** The previous release reads only the legacy counter. */
  | { k: "oldGet"; tag: string }
  /** A read while every KV write fails: adoption of a legacy counter is best effort and must not fail the read. */
  | { k: "getWritesFail"; tag: string }
  /** Stores a tagged value (CacheService's storage key shape) and clears the cache: counters survive, values do not. */
  | { k: "clear"; tag: string }

export interface KvCounters { current?: string; legacy?: string }

/** base64url SHA-256 of the JSON pair, written out from the spec. */
export function digestOf(counters: KvCounters): string {
  return `h:${createHash("sha256").update(JSON.stringify([counters.current ?? null, counters.legacy ?? null])).digest("base64url")}`
}

export class RefKvGenerations {
  private readonly counters = new Map<string, KvCounters>()
  private of(tag: string): KvCounters { return this.counters.get(tag) ?? this.counters.set(tag, {}).get(tag)! }

  /** The observed generation, adopting a legacy-only counter into the current layout when `adopt` (a read that can write). */
  get(tag: string, adopt: boolean): string {
    const state = this.of(tag)
    if (state.current === undefined && state.legacy !== undefined && adopt) state.current = state.legacy
    if (state.current === undefined && state.legacy === undefined) return "0"
    if (state.current !== undefined && state.current === state.legacy) return state.current
    return digestOf(state)
  }
  advance(tag: string, id: string): void { const state = this.of(tag); state.legacy = id; state.current = id }
  oldAdvance(tag: string, id: string): void { this.of(tag).legacy = id }
  oldGet(tag: string): string { return this.of(tag).legacy ?? "0" }
  state(tag: string): KvCounters { return { ...this.of(tag) } }
}

export function generateKvOps(rng: Rng): KvOp[] {
  const pool: readonly string[] = [...TAGS.slice(0, 2), ...EXOTIC_TAGS.kvLookalikes, "café"]
  const target = 4 + rng.int(20)
  const ops: KvOp[] = []
  let counter = 0
  while (ops.length < target) {
    const tag = rng.bool(0.7) ? rng.pick(pool.slice(0, 2)) : rng.pick(pool)
    const roll = rng.int(12)
    if (roll < 3) ops.push({ k: "advance", tag })
    else if (roll < 5) ops.push({ k: "oldAdvance", tag, id: `${1_700_000_000_000 + counter++}:00000000-0000-4000-8000-${String(rng.int(1e6)).padStart(12, "0")}` })
    else if (roll < 8) ops.push({ k: "get", tag })
    else if (roll < 9) ops.push({ k: "oldGet", tag })
    else if (roll < 11) ops.push({ k: "getWritesFail", tag })
    else ops.push({ k: "clear", tag })
  }
  return ops
}

export function* shrinkKvOps(ops: KvOp[]): Iterable<KvOp[]> {
  for (let i = 0; i < ops.length; i++) yield [...ops.slice(0, i), ...ops.slice(i + 1)]
}

export function describeKvOps(ops: KvOp[]): string {
  return ops.map((op, index) => `${index}: ${op.k} ${describeTag(op.tag)}${op.k === "oldAdvance" ? ` id=${op.id}` : ""}`).join("\n")
}
