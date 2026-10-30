import { describe, expect, it } from "vitest"
import { CancelledError, TimeoutError, UnavailableError, ValidationError } from "@xonava/core/domain"
import type { ObjectBytes, ObjectStore } from "@xonava/core/object-store"

export interface ObjectStoreContractOptions {
  /** Returns a store over empty or isolated storage. It is called once per test. */
  createStore: () => ObjectStore | Promise<ObjectStore>
  /**
   * Returns a store whose provider rejects every call with an error whose message is `providerFailureText`.
   * Omit both when the store has no provider to fail (for example an in-memory store).
   */
  createFailingStore?: () => ObjectStore | Promise<ObjectStore>
  providerFailureText?: string
}

const textEncoder = new TextEncoder()
const bytesOf = (text: string) => textEncoder.encode(text)

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")
}

async function readAll(body: ObjectBytes): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const item = await reader.read()
    if (item.done) break
    chunks.push(item.value)
  }
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }
  return out
}

interface Probe { readonly stream: ReadableStream<Uint8Array>; readonly state: { pulls: number; cancelled: boolean } }
function probeStream(chunks: readonly Uint8Array[], afterChunk?: (index: number) => void): Probe {
  const state = { pulls: 0, cancelled: false }
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1
      const chunk = chunks[index]
      if (chunk === undefined) { controller.close(); return }
      controller.enqueue(chunk)
      afterChunk?.(index)
      index += 1
    },
    cancel() { state.cancelled = true },
  }, { highWaterMark: 0 })
  return { stream, state }
}

let keyCounter = 0
const uniqueKey = (label: string) => `contract/${label}/${Date.now().toString(36)}-${(keyCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** Runs round-trip, absence, metadata, checksum, length, cancellation, deadline, hostile-key, and failure-redaction checks for an ObjectStore. */
export function runObjectStoreContractTests(label: string, options: ObjectStoreContractOptions): void {
  describe(`Object store contract: ${label}`, { concurrent: false }, () => {
    it("round-trips bytes", async () => {
      const store = await options.createStore()
      const key = uniqueKey("bytes")
      const body = new Uint8Array([0, 1, 2, 253, 254, 255])
      const put = await store.put({ key, body, contentLength: body.byteLength })
      expect(put).toMatchObject({ key, contentLength: 6 })
      const read = await store.get({ key })
      expect([...(await readAll(read!.body))]).toEqual([...body])
      expect(read!.metadata).toMatchObject({ key, contentLength: 6 })
      expect(await store.head({ key })).toMatchObject({ key, contentLength: 6 })
      body[0] = 9
      expect((await readAll((await store.get({ key }))!.body))[0]).toBe(0)
    })

    it("round-trips a multi-chunk stream and an empty object", async () => {
      const store = await options.createStore()
      const key = uniqueKey("stream")
      const { stream } = probeStream([bytesOf("hello "), bytesOf("streamed "), bytesOf("world")])
      const put = await store.put({ key, body: stream, contentLength: 20 })
      expect(put.contentLength).toBe(20)
      expect(new TextDecoder().decode(await readAll((await store.get({ key }))!.body))).toBe("hello streamed world")
      const emptyKey = uniqueKey("empty")
      await store.put({ key: emptyKey, body: new Uint8Array(), contentLength: 0 })
      expect((await store.head({ key: emptyKey }))?.contentLength).toBe(0)
      expect((await readAll((await store.get({ key: emptyKey }))!.body)).byteLength).toBe(0)
    })

    it("reports absence on get, head, and delete, and deletes once", async () => {
      const store = await options.createStore()
      const key = uniqueKey("absent")
      expect(await store.get({ key })).toBeNull()
      expect(await store.head({ key })).toBeNull()
      expect(await store.delete({ key })).toBe(false)
      await store.put({ key, body: bytesOf("x"), contentLength: 1 })
      expect(await store.delete({ key })).toBe(true)
      expect(await store.get({ key })).toBeNull()
      expect(await store.head({ key })).toBeNull()
      expect(await store.delete({ key })).toBe(false)
    })

    it("keeps content type, custom metadata, etag, and modification time", async () => {
      const store = await options.createStore()
      const key = uniqueKey("metadata")
      const put = await store.put({ key, body: bytesOf("{}"), contentLength: 2, contentType: "application/json", metadata: { owner: "alice", "Mixed-Case": "Value" } })
      for (const metadata of [put, await store.head({ key }), (await store.get({ key }))!.metadata]) {
        expect(metadata).toMatchObject({ key, contentLength: 2, contentType: "application/json" })
        expect(metadata!.metadata).toEqual({ owner: "alice", "Mixed-Case": "Value" })
        expect(typeof metadata!.etag).toBe("string")
        expect(metadata!.lastModified).toBeInstanceOf(Date)
      }
      const plain = uniqueKey("plain")
      await store.put({ key: plain, body: bytesOf("x"), contentLength: 1 })
      const head = await store.head({ key: plain })
      expect(head?.contentType).toBeUndefined()
      expect(head?.metadata === undefined || Object.keys(head.metadata).length === 0).toBe(true)
    })

    it("honours versions on get, head, and delete", async () => {
      const store = await options.createStore()
      const key = uniqueKey("version")
      const first = await store.put({ key, body: bytesOf("one"), contentLength: 3 })
      const second = await store.put({ key, body: bytesOf("two"), contentLength: 3 })
      if (first.version === undefined || second.version === undefined) throw new Error("A store used with versioned references must report a version from put")
      expect(second.version).not.toBe(first.version)
      expect(await store.head({ key, version: first.version })).toBeNull()
      expect(await store.get({ key, version: first.version })).toBeNull()
      expect(await store.delete({ key, version: first.version })).toBe(false)
      expect((await store.head({ key, version: second.version }))?.version).toBe(second.version)
      expect(new TextDecoder().decode(await readAll((await store.get({ key, version: second.version }))!.body))).toBe("two")
      expect(await store.delete({ key, version: second.version })).toBe(true)
      expect(await store.head({ key })).toBeNull()
    })

    it("accepts a matching sha256 checksum and reports it", async () => {
      const store = await options.createStore()
      const key = uniqueKey("sha-ok")
      const body = bytesOf("checksummed")
      const value = await sha256Hex(body)
      const put = await store.put({ key, body, contentLength: body.byteLength, checksum: { algorithm: "sha256", value } })
      expect(put.checksum).toEqual({ algorithm: "sha256", value })
      expect((await store.head({ key }))?.checksum).toEqual({ algorithm: "sha256", value })
    })

    it("rejects a mismatched, malformed, or unsupported checksum and stores nothing", async () => {
      const store = await options.createStore()
      const key = uniqueKey("sha-bad")
      const body = bytesOf("checksummed")
      await expect(store.put({ key, body, contentLength: body.byteLength, checksum: { algorithm: "sha256", value: "0".repeat(64) } })).rejects.toBeInstanceOf(ValidationError)
      await expect(store.put({ key, body, contentLength: body.byteLength, checksum: { algorithm: "sha256", value: "not-hex" } })).rejects.toBeInstanceOf(ValidationError)
      await expect(store.put({ key, body, contentLength: body.byteLength, checksum: { algorithm: "crc-unknown", value: "00" } })).rejects.toBeInstanceOf(ValidationError)
      expect(await store.head({ key })).toBeNull()
      const kept = uniqueKey("sha-keep")
      await store.put({ key: kept, body: bytesOf("original"), contentLength: 8 })
      await expect(store.put({ key: kept, body: bytesOf("replaced"), contentLength: 8, checksum: { algorithm: "sha256", value: "f".repeat(64) } })).rejects.toBeInstanceOf(ValidationError)
      expect(new TextDecoder().decode(await readAll((await store.get({ key: kept }))!.body))).toBe("original")
    })

    it("rejects a content length that does not match the body", async () => {
      const store = await options.createStore()
      const key = uniqueKey("length")
      await expect(store.put({ key, body: bytesOf("abc"), contentLength: 2 })).rejects.toBeInstanceOf(ValidationError)
      await expect(store.put({ key, body: bytesOf("abc"), contentLength: 4 })).rejects.toBeInstanceOf(ValidationError)
      await expect(store.put({ key, body: probeStream([bytesOf("ab")]).stream, contentLength: 3 })).rejects.toBeInstanceOf(ValidationError)
      await expect(store.put({ key, body: probeStream([bytesOf("ab"), bytesOf("cd")]).stream, contentLength: 3 })).rejects.toBeInstanceOf(ValidationError)
      await expect(store.put({ key, body: bytesOf("abc"), contentLength: -1 })).rejects.toBeInstanceOf(ValidationError)
      expect(await store.head({ key })).toBeNull()
    })

    it("cancels a source stream that overruns its length or is aborted part-way", async () => {
      const store = await options.createStore()
      const key = uniqueKey("early")
      const overrun = probeStream([bytesOf("ab"), bytesOf("cd"), bytesOf("ef")])
      await expect(store.put({ key, body: overrun.stream, contentLength: 3 })).rejects.toBeInstanceOf(ValidationError)
      expect(overrun.state.cancelled).toBe(true)
      const controller = new AbortController()
      const aborted = probeStream([bytesOf("ab"), bytesOf("cd"), bytesOf("ef")], index => { if (index === 0) controller.abort(new Error("stop")) })
      await expect(store.put({ key, body: aborted.stream, contentLength: 6, signal: controller.signal })).rejects.toBeInstanceOf(CancelledError)
      expect(aborted.state.cancelled).toBe(true)
      expect(await store.head({ key })).toBeNull()
    })

    it("fails an already-cancelled request before any I/O", async () => {
      const store = await options.createStore()
      const key = uniqueKey("cancelled")
      await store.put({ key, body: bytesOf("x"), contentLength: 1 })
      const controller = new AbortController()
      controller.abort(new Error("stop"))
      const { signal } = controller
      const untouched = probeStream([bytesOf("y")])
      await expect(store.put({ key: uniqueKey("cancelled-put"), body: untouched.stream, contentLength: 1, signal })).rejects.toBeInstanceOf(CancelledError)
      expect(untouched.state.pulls).toBe(0)
      await expect(store.get({ key, signal })).rejects.toBeInstanceOf(CancelledError)
      await expect(store.head({ key, signal })).rejects.toBeInstanceOf(CancelledError)
      await expect(store.delete({ key, signal })).rejects.toBeInstanceOf(CancelledError)
      expect(await store.head({ key })).not.toBeNull()
    })

    it("fails an expired deadline before any I/O", async () => {
      const store = await options.createStore()
      const key = uniqueKey("deadline")
      await store.put({ key, body: bytesOf("x"), contentLength: 1 })
      const expired = Date.now() - 1
      const untouched = probeStream([bytesOf("y")])
      await expect(store.put({ key: uniqueKey("deadline-put"), body: untouched.stream, contentLength: 1, deadline: expired })).rejects.toBeInstanceOf(TimeoutError)
      expect(untouched.state.pulls).toBe(0)
      await expect(store.get({ key, deadline: expired })).rejects.toBeInstanceOf(TimeoutError)
      await expect(store.head({ key, deadline: expired })).rejects.toBeInstanceOf(TimeoutError)
      await expect(store.delete({ key, deadline: expired })).rejects.toBeInstanceOf(TimeoutError)
      expect(await store.head({ key })).not.toBeNull()
    })

    it("rejects hostile keys on every operation", async () => {
      const store = await options.createStore()
      for (const key of ["", "k".repeat(1025), "bad\0key"]) {
        await expect(store.put({ key, body: bytesOf("x"), contentLength: 1 })).rejects.toBeInstanceOf(ValidationError)
        await expect(store.get({ key })).rejects.toBeInstanceOf(ValidationError)
        await expect(store.head({ key })).rejects.toBeInstanceOf(ValidationError)
        await expect(store.delete({ key })).rejects.toBeInstanceOf(ValidationError)
      }
      const longest = `${uniqueKey("long")}${"k".repeat(1024)}`.slice(-1024)
      await store.put({ key: longest, body: bytesOf("x"), contentLength: 1 })
      expect((await store.head({ key: longest }))?.key).toBe(longest)
      const unusual = `${uniqueKey("unusual")}/../ spaces/ünï/%2e?#`
      await store.put({ key: unusual, body: bytesOf("x"), contentLength: 1 })
      expect((await store.head({ key: unusual }))?.key).toBe(unusual)
    })

    if (options.createFailingStore !== undefined) {
      it("surfaces provider failures as UnavailableError without provider text", async () => {
        const text = options.providerFailureText
        if (!text) throw new Error("providerFailureText is required with createFailingStore")
        const store = await options.createFailingStore!()
        const key = uniqueKey("failing")
        const calls = [
          () => store.put({ key, body: bytesOf("x"), contentLength: 1 }),
          () => store.get({ key }),
          () => store.head({ key }),
          () => store.delete({ key }),
        ]
        for (const call of calls) {
          const error = await call().then(() => undefined, (caught: unknown) => caught)
          expect(error).toBeInstanceOf(UnavailableError)
          const failure = error as UnavailableError
          expect(failure.message).not.toContain(text)
          expect(failure.safeMessage).not.toContain(text)
          expect(JSON.stringify(failure)).not.toContain(text)
          expect(String(failure)).not.toContain(text)
        }
      })
    }
  })
}
