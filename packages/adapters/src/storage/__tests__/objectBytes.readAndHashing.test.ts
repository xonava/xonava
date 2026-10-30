import { describe, expect, it } from "vitest"
import { TimeoutError, ValidationError } from "@xonava/core/domain"
import { declaredSha256, readObjectBytes, sha256Hex } from "../objectBytes"

const MISMATCH = "Object contentLength does not match body bytes"
const streamOf = (...chunks: number[][]) => new ReadableStream<Uint8Array>({ start(c) { for (const chunk of chunks) c.enqueue(new Uint8Array(chunk)); c.close() } })

describe("readObjectBytes", () => {
  it("returns a copy of a byte body", async () => {
    const source = new Uint8Array([1, 2, 3])
    const bytes = await readObjectBytes(source, 3, {})
    expect([...bytes]).toEqual([1, 2, 3])
    expect(bytes).not.toBe(source)
    source[0] = 9
    expect(bytes[0]).toBe(1)
  })

  it("concatenates every chunk at the right offsets and unlocks the stream", async () => {
    const stream = streamOf([1, 2], [3], [4, 5, 6])
    const bytes = await readObjectBytes(stream, 6, {})
    expect([...bytes]).toEqual([1, 2, 3, 4, 5, 6])
    expect(bytes.byteLength).toBe(6)
    expect(stream.locked).toBe(false)
  })

  it("reads an empty stream as zero bytes", async () => {
    expect((await readObjectBytes(streamOf(), 0, {})).byteLength).toBe(0)
  })

  it("accepts a stream that supplies exactly contentLength bytes in one chunk", async () => {
    expect([...(await readObjectBytes(streamOf([7, 8, 9]), 3, {}))]).toEqual([7, 8, 9])
  })

  it("rejects a stream longer than contentLength at the first excess chunk and cancels the producer", async () => {
    let cancelled = 0
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { pulls += 1; c.enqueue(new Uint8Array([1, 2])) },
      cancel() { cancelled += 1 },
    })
    const error = await readObjectBytes(stream, 3, {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toBe(MISMATCH)
    expect(cancelled).toBe(1)
    expect(pulls).toBeLessThanOrEqual(4)
    expect(stream.locked).toBe(false)
  })

  it("rejects a stream shorter than contentLength with the exact message", async () => {
    const error = await readObjectBytes(streamOf([1, 2]), 3, {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toBe(MISMATCH)
  })

  it("does not cancel the producer after a successful read", async () => {
    let cancelled = 0
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); c.close() }, cancel() { cancelled += 1 } })
    const reader = stream.getReader()
    const spy = { read: () => reader.read(), cancel: () => { cancelled += 1; return reader.cancel() }, releaseLock: () => reader.releaseLock() }
    stream.getReader = (() => spy) as never
    await readObjectBytes(stream, 1, {})
    expect(cancelled).toBe(0)
  })

  it("stops with the abort reason between chunks, cancels the producer and releases the lock", async () => {
    const controller = new AbortController()
    let cancelled = 0
    let chunk = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { chunk += 1; c.enqueue(new Uint8Array([chunk])); if (chunk === 1) controller.abort() },
      cancel() { cancelled += 1 },
    })
    await expect(readObjectBytes(stream, 10, { signal: controller.signal })).rejects.toThrow("Object request was cancelled")
    expect(cancelled).toBe(1)
    expect(stream.locked).toBe(false)
  })

  it("stops on an expired deadline before reading", async () => {
    await expect(readObjectBytes(streamOf([1]), 1, { deadline: Date.now() - 1 })).rejects.toBeInstanceOf(TimeoutError)
  })
})

describe("declaredSha256", () => {
  const digest = "AbCdEf0123456789".repeat(4)
  it("returns undefined without a checksum", () => { expect(declaredSha256(undefined)).toBeUndefined() })
  it("lowercases a valid digest and accepts the algorithm in any case", () => {
    expect(declaredSha256({ algorithm: "sha256", value: digest })).toBe(digest.toLowerCase())
    expect(declaredSha256({ algorithm: "SHA256", value: digest })).toBe(digest.toLowerCase())
  })
  it("rejects other algorithms with the exact message", () => {
    expect(() => declaredSha256({ algorithm: "md5", value: digest })).toThrow(new ValidationError("Object checksum algorithm is not supported; use sha256"))
  })
  it("rejects malformed digests: wrong length, non-hex, anchors", () => {
    const message = "Object sha256 checksum must be 64 hexadecimal characters"
    for (const value of ["a".repeat(63), "a".repeat(65), "g".repeat(64), `${"a".repeat(64)}\n`, `\n${"a".repeat(64)}`, ""]) {
      expect(() => declaredSha256({ algorithm: "sha256", value })).toThrow(message)
    }
    expect(declaredSha256({ algorithm: "sha256", value: "A".repeat(64) })).toBe("a".repeat(64))
  })
})

describe("sha256Hex", () => {
  it("hashes bytes to zero-padded lowercase hex", async () => {
    expect(await sha256Hex(new Uint8Array([1, 2, 3]))).toBe("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81")
    expect(await sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  })
})
