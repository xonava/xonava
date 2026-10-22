import { expect, it } from "vitest"
import { KvCacheAdapter, type TagGenerationStore } from "@xonava/adapters/cache"
import { forAllAsync, scaledRuns } from "../../../core/src/__tests__/differential/harness.js"
import { TIMING_SCALE } from "../../../core/src/__tests__/timing.js"
import {
  EXOTIC_TAGS, RefGenerations, RefKvGenerations, TAGS, compareRows, describeKvOps, describeStoreOps, describeTag, generateKvOps, generateStoreOps, generateTag, longTag,
  shrinkKvOps, shrinkStoreOps, type KvOp, type StoreOp,
} from "./tagGenerationStoreDifferentialModel.js"

/** Raw generation row, read with SQL independent of the adapter. */
export interface RawGenerationRow { tag: string; generation: number }

export interface TagGenerationStoreDifferentialDriver {
  /** Property-name suffix, e.g. "postgres". */
  label: string
  store: TagGenerationStore
  /** Deletes every generation row. */
  reset(): Promise<void>
  dump(): Promise<RawGenerationRow[]>
  /** Writes a generation row directly (for starting values). */
  seed(tag: string, generation: number): Promise<void>
  /** True for errors a caller is expected to retry (a MySQL deadlock victim); the failed advance changed nothing. */
  retryable?(error: unknown): boolean
  /** Base run count of the sequential property. */
  lifecycleRuns?: number
  /** Base run count of the concurrency properties. */
  concurrencyRuns?: number
  /** Slow transports (Miniflare D1) use short sequences and compare the table only at the end of one. */
  light?: boolean
  /** Upper bound of concurrent workers (the connection pool size). */
  maxWorkers?: number
}

export const PROPERTY_TIMEOUT_MS = Math.ceil(300_000 * Math.max(1, scaledRuns(100) / 100) * TIMING_SCALE)

/** Runs an operation, retrying it when the database aborted it as a deadlock victim. */
async function withRetry<T>(driver: { retryable?(error: unknown): boolean }, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await run() } catch (error) { if (!driver.retryable?.(error) || attempt >= 25) throw error }
  }
}

async function expectTable(driver: TagGenerationStoreDifferentialDriver, model: RefGenerations, what: string): Promise<void> {
  const actual = (await driver.dump()).sort(compareRows)
  expect(actual, what).toEqual(model.dump())
}

export async function runStoreOps(driver: TagGenerationStoreDifferentialDriver, ops: StoreOp[]): Promise<void> {
  await driver.reset()
  const model = new RefGenerations()
  for (const [index, op] of ops.entries()) {
    if (op.k === "advance") expect(await withRetry(driver, () => driver.store.advanceTagGeneration(op.tag)), `step ${index} advance`).toBe(model.advance(op.tag))
    else if (op.k === "get") expect(await driver.store.getTagGeneration(op.tag), `step ${index} get`).toBe(model.get(op.tag))
    else {
      const actual = await Promise.all(op.tags.map((tag) => withRetry(driver, () => driver.store.advanceTagGeneration(tag))))
      const expected = model.burst(op.tags)
      const byTag = new Map<string, string[]>()
      op.tags.forEach((tag, i) => (byTag.get(tag) ?? byTag.set(tag, []).get(tag)!).push(actual[i]!))
      for (const [tag, values] of byTag) expect(values.sort((a, b) => Number(a) - Number(b)), `step ${index} burst on ${describeTag(tag)}`).toEqual(expected.get(tag))
    }
    if (!driver.light) await expectTable(driver, model, `table after step ${index}`)
  }
  await expectTable(driver, model, "final table")
  for (const { tag, generation } of model.dump()) expect(await driver.store.getTagGeneration(tag), `final get of ${describeTag(tag)}`).toBe(String(generation))
}

/** Registers the sequential store-vs-reference differential (advance, read, bursts, byte-exact tags). */
export function defineTagGenerationDifferential(driver: TagGenerationStoreDifferentialDriver): void {
  it(`tag generations match the reference model (${driver.label})`, async () => {
    await forAllAsync(`tag generation store lifecycle differential (${driver.label})`, (rng) => generateStoreOps(rng, driver.light ? { min: 4, max: 10 } : {}), (ops) => runStoreOps(driver, ops), {
      runs: driver.lifecycleRuns ?? 60, shrink: shrinkStoreOps, describe: describeStoreOps, maxShrinkSteps: 100,
    })
  }, PROPERTY_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------------------------------------------
// Concurrency

type Action = { tag: number; read: boolean }
interface ConcurrentCase { workers: number; burst: boolean; tags: string[]; plan: Action[][] }

/**
 * Several workers advance and read the same few tags at once against the real database. Every tag must hand out
 * exactly 1..n to its n advances (no duplicate, no lost update), a worker that does not burst sees its own advances
 * strictly increase and never reads a generation older than its own last advance or read, and the table ends at n.
 */
export function defineConcurrentInvalidation(driver: TagGenerationStoreDifferentialDriver): void {
  it(`concurrent invalidation hands out 1..n per tag and reads never go backwards (${driver.label})`, async () => {
    await forAllAsync(`tag generation store concurrent invalidation (${driver.label})`, (rng): ConcurrentCase => {
      const workers = 2 + rng.int(Math.min(driver.maxWorkers ?? 10, 10) - 1)
      const rounds = 2 + rng.int(driver.light ? 3 : 6)
      const tags = Array.from({ length: 1 + rng.int(3) }, () => generateTag(rng))
      return { workers, burst: rng.bool(0.4), tags, plan: Array.from({ length: workers }, () => Array.from({ length: rounds }, () => ({ tag: rng.int(tags.length), read: rng.bool(0.35) }))) }
    }, async (c) => {
      await driver.reset()
      const advanced = new Map<string, number[]>()
      const reads: Array<{ tag: string; value: number }> = []
      const work = async (actions: Action[]): Promise<void> => {
        const last = new Map<string, number>()
        const step = async ({ tag: index, read }: Action): Promise<void> => {
          const tag = c.tags[index]!
          if (read) {
            const value = Number(await driver.store.getTagGeneration(tag))
            reads.push({ tag, value })
            if (!c.burst) { expect(value, `read of ${describeTag(tag)} went backwards`).toBeGreaterThanOrEqual(last.get(tag) ?? 0); last.set(tag, value) }
          } else {
            const value = Number(await withRetry(driver, () => driver.store.advanceTagGeneration(tag)))
            ;(advanced.get(tag) ?? advanced.set(tag, []).get(tag)!).push(value)
            if (!c.burst) { expect(value, `advance of ${describeTag(tag)} did not exceed this worker's last observation`).toBeGreaterThan(last.get(tag) ?? 0); last.set(tag, value) }
          }
        }
        if (c.burst) await Promise.all(actions.map(step))
        else for (const action of actions) await step(action)
      }
      await Promise.all(c.plan.map(work))
      const rows = new Map((await driver.dump()).map((row) => [row.tag, row.generation]))
      expect(rows.size, "row count").toBe(advanced.size)
      for (const [tag, values] of advanced) {
        expect([...values].sort((a, b) => a - b), `generations handed out for ${describeTag(tag)}`).toEqual(Array.from({ length: values.length }, (_, i) => i + 1))
        expect(rows.get(tag), `final generation of ${describeTag(tag)}`).toBe(values.length)
        expect(await driver.store.getTagGeneration(tag), `final read of ${describeTag(tag)}`).toBe(String(values.length))
      }
      for (const { tag, value } of reads) expect(value, `read of ${describeTag(tag)} beyond the advances issued`).toBeLessThanOrEqual(advanced.get(tag)?.length ?? 0)
    }, { runs: driver.concurrencyRuns ?? 50, describe: (c) => `${c.workers} workers, burst=${c.burst}\ntags: ${c.tags.map(describeTag).join(", ")}\nplan: ${JSON.stringify(c.plan.map((actions) => actions.map((a) => `${a.read ? "r" : "a"}${a.tag}`)))}` })
  }, PROPERTY_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------------------------------------------
// Deterministic regressions

/** Deterministic cases that pin down the contract at its edges. */
export function defineTagGenerationRegressions(driver: TagGenerationStoreDifferentialDriver): void {
  const distinctTags = async (tags: readonly string[]): Promise<void> => {
    await driver.reset()
    for (const tag of tags) expect(await driver.store.getTagGeneration(tag), `read of unadvanced ${describeTag(tag)}`).toBe("0")
    for (const tag of tags) expect(await driver.store.advanceTagGeneration(tag), `first advance of ${describeTag(tag)}`).toBe("1")
    for (const tag of tags) expect(await driver.store.getTagGeneration(tag), `read of ${describeTag(tag)}`).toBe("1")
    expect((await driver.dump()).length).toBe(tags.length)
  }

  it(`a tag that was never advanced reads "0" and reading does not create a row (${driver.label})`, async () => {
    await driver.reset()
    expect(await driver.store.getTagGeneration("never")).toBe("0")
    expect(await driver.dump()).toEqual([])
    expect(await driver.store.advanceTagGeneration("never")).toBe("1")
    expect(await driver.dump()).toEqual([{ tag: "never", generation: 1 }])
  })

  it(`advancing continues from an existing row and never touches another tag (${driver.label})`, async () => {
    await driver.reset()
    await driver.seed("seeded", 41)
    await driver.seed("bystander", 7)
    expect(await driver.store.getTagGeneration("seeded")).toBe("41")
    expect(await driver.store.advanceTagGeneration("seeded")).toBe("42")
    expect(await driver.store.getTagGeneration("seeded")).toBe("42")
    expect((await driver.dump()).sort(compareRows)).toEqual([{ tag: "bystander", generation: 7 }, { tag: "seeded", generation: 42 }])
  })

  it(`tags are compared byte-for-byte: case, trailing space and Unicode normalisation differences are distinct (${driver.label})`, async () => {
    await distinctTags(EXOTIC_TAGS.caseDifferences)
    await distinctTags(EXOTIC_TAGS.trailingSpace)
    await distinctTags(EXOTIC_TAGS.nonAscii)
    await distinctTags(EXOTIC_TAGS.punctuation)
    await distinctTags(EXOTIC_TAGS.kvLookalikes)
  })

  it(`tags of the maximum length (256 UTF-8 bytes) are stored and distinct (${driver.label})`, async () => {
    const ascii = longTag("a")
    const tags = [ascii, `${ascii.slice(0, -1)}b`, "é".repeat(128), "日".repeat(85) + "a"]
    expect(tags.map((tag) => new TextEncoder().encode(tag).length)).toEqual([256, 256, 256, 256])
    await distinctTags(tags)
  })

  it(`successive advances return consecutive generations as decimal strings (${driver.label})`, async () => {
    await driver.reset()
    const seen: string[] = []
    for (let i = 0; i < 12; i++) seen.push(await driver.store.advanceTagGeneration(TAGS[0]))
    expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)))
  })
}

// ---------------------------------------------------------------------------------------------------------------
// KV adapter, dual counter layouts

const CURRENT_PREFIX = "__cachegen__:"
const LEGACY_PREFIX = "__cache__:__generation__:"
const GENERATION_PATTERN = /^\d+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PROBE_KEY = "__generation__:\"1:probe\":value"

/** A fake KV namespace whose operations yield a configurable number of times, so concurrent callers interleave. */
class FakeKv {
  readonly store = new Map<string, string>()
  failWrites = false
  yields: () => number = () => 0
  private async yieldTurns(): Promise<void> { for (let i = this.yields(); i > 0; i--) await Promise.resolve() }
  async get(key: string, options?: { type: "json" }): Promise<unknown> {
    await this.yieldTurns()
    const value = this.store.get(key)
    if (value === undefined) return null
    return options?.type === "json" ? JSON.parse(value) as unknown : value
  }
  async put(key: string, value: string): Promise<void> {
    await this.yieldTurns()
    if (this.failWrites) throw new Error("KV PUT failed")
    this.store.set(key, value)
  }
  async delete(key: string): Promise<void> { await this.yieldTurns(); this.store.delete(key) }
  async list(options?: { prefix?: string }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
    await this.yieldTurns()
    return { keys: [...this.store.keys()].filter((name) => !options?.prefix || name.startsWith(options.prefix)).map((name) => ({ name })), list_complete: true }
  }
  raw(key: string): string | undefined {
    const value = this.store.get(key)
    return value === undefined ? undefined : JSON.parse(value) as string
  }
}

function newKv(): { kv: FakeKv; adapter: KvCacheAdapter } {
  const kv = new FakeKv()
  return { kv, adapter: new KvCacheAdapter(kv as never) }
}

function expectCounters(kv: FakeKv, model: RefKvGenerations, tag: string, what: string): void {
  const state = model.state(tag)
  expect({ current: kv.raw(`${CURRENT_PREFIX}${tag}`), legacy: kv.raw(`${LEGACY_PREFIX}${tag}`) }, what).toEqual({ current: state.current, legacy: state.legacy })
}

/** Registers the KV adapter's dual-layout generation differential against its reference model. */
export function defineKvGenerationDifferential(label: string): void {
  it(`KV tag generations read and advance both counter layouts like the reference model (${label})`, async () => {
    await forAllAsync(`kv tag generation dual layout differential (${label})`, generateKvOps, async (ops: KvOp[]) => {
      const { kv, adapter } = newKv()
      const model = new RefKvGenerations()
      const seenObservations = new Map<string, Set<string>>()
      const observe = (tag: string, value: string, what: string, mustBeNew: boolean): void => {
        const seen = seenObservations.get(tag) ?? seenObservations.set(tag, new Set()).get(tag)!
        if (mustBeNew) expect(seen.has(value), `${what}: observed generation ${value} was already observed before the advance`).toBe(false)
        seen.add(value)
      }
      const advanced = new Set<string>()
      for (const [index, op] of ops.entries()) {
        const what = `step ${index} ${op.k} ${describeTag(op.tag)}`
        if (op.k === "advance") {
          const id = await adapter.advanceTagGeneration(op.tag)
          expect(id, `${what} id`).toMatch(GENERATION_PATTERN)
          expect(advanced.has(id), `${what} id repeated`).toBe(false)
          advanced.add(id)
          model.advance(op.tag, id)
          const value = await adapter.getTagGeneration(op.tag)
          expect(value, `${what} read back`).toBe(id)
          observe(op.tag, value, what, true)
        } else if (op.k === "oldAdvance") {
          await kv.put(`${LEGACY_PREFIX}${op.tag}`, JSON.stringify(op.id))
          model.oldAdvance(op.tag, op.id)
          const value = await adapter.getTagGeneration(op.tag)
          expect(value, `${what} observed`).toBe(model.get(op.tag, true))
          // A change to either counter must change what the current release observes.
          observe(op.tag, value, what, true)
        } else if (op.k === "get") {
          const value = await adapter.getTagGeneration(op.tag)
          expect(value, what).toBe(model.get(op.tag, true))
          observe(op.tag, value, what, false)
        } else if (op.k === "oldGet") {
          const expected = model.oldGet(op.tag)
          const raw = kv.raw(`${LEGACY_PREFIX}${op.tag}`)
          expect(raw ?? "0", what).toBe(expected)
        } else if (op.k === "getWritesFail") {
          kv.failWrites = true
          try {
            const value = await adapter.getTagGeneration(op.tag)
            expect(value, what).toBe(model.get(op.tag, false))
          } finally { kv.failWrites = false }
        } else {
          await adapter.set(PROBE_KEY, "tagged value")
          await adapter.clear()
          expect(await adapter.has(PROBE_KEY), `${what}: tagged value survived clear`).toBe(false)
          expect(await adapter.getTagGeneration(op.tag), `${what}: counters changed by clear`).toBe(model.get(op.tag, true))
        }
        expectCounters(kv, model, op.tag, `${what} raw counters`)
      }
    }, { runs: 60, shrink: shrinkKvOps, describe: describeKvOps, maxShrinkSteps: 100 })
  }, PROPERTY_TIMEOUT_MS)
}

interface KvConcurrentCase { workers: number; legacyWriters: number; yields: number[]; preAdvance: boolean }

/**
 * Several instances advance one tag at once on interleaved KV operations (some are still on the previous release and
 * write only the legacy counter). Each instance that reads, advances and reads again must observe a different
 * generation afterwards (a fence), and afterwards one more advance must converge both counters to a single token.
 */
export function defineKvConcurrentInvalidation(label: string): void {
  it(`KV concurrent invalidation fences every reader and converges on the next advance (${label})`, async () => {
    await forAllAsync(`kv tag generation concurrent invalidation (${label})`, (rng): KvConcurrentCase => ({
      workers: 2 + rng.int(6), legacyWriters: rng.int(3), preAdvance: rng.bool(0.5), yields: Array.from({ length: 64 }, () => rng.int(4)),
    }), async (c) => {
      const { kv, adapter } = newKv()
      const tag = "contended"
      if (c.preAdvance) await adapter.advanceTagGeneration(tag)
      let cursor = 0
      kv.yields = () => c.yields[cursor++ % c.yields.length]!
      const ids: string[] = []
      await Promise.all([
        ...Array.from({ length: c.workers }, async () => {
          const before = await adapter.getTagGeneration(tag)
          ids.push(await adapter.advanceTagGeneration(tag))
          const after = await adapter.getTagGeneration(tag)
          expect(after, "generation observed after an own advance equals the one observed before it").not.toBe(before)
        }),
        ...Array.from({ length: c.legacyWriters }, async (_, i) => {
          const before = await adapter.getTagGeneration(tag)
          const id = `${1_800_000_000_000 + i}:00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
          await kv.put(`${LEGACY_PREFIX}${tag}`, JSON.stringify(id))
          expect(await adapter.getTagGeneration(tag), "generation observed after a previous-release advance").not.toBe(before)
        }),
      ])
      kv.yields = () => 0
      expect(new Set(ids).size, "advances returned distinct generations").toBe(ids.length)
      const settled = await adapter.advanceTagGeneration(tag)
      expect(await adapter.getTagGeneration(tag), "next advance converges both counters").toBe(settled)
      expect({ current: kv.raw(`${CURRENT_PREFIX}${tag}`), legacy: kv.raw(`${LEGACY_PREFIX}${tag}`) }).toEqual({ current: settled, legacy: settled })
    }, { runs: 50, describe: (c) => JSON.stringify({ ...c, yields: c.yields.join("") }) })
  }, PROPERTY_TIMEOUT_MS)
}
