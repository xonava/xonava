import { describe, expect, it } from "vitest"
import { assertStreamingReadOptions, requireProvenPersistenceCapability } from "../../persistence"

describe("TX1 persistence capability contracts", () => {
  it("accepts only proven execution claims carrying evidence", () => {
    expect(() => requireProvenPersistenceCapability({} as never, "read.streaming")).toThrow(/not proven/)
    expect(() => requireProvenPersistenceCapability({ execution: { "read.streaming": { status: "experimental" } } } as never, "read.streaming")).toThrow(/not proven/)
    expect(() => requireProvenPersistenceCapability({ execution: { "read.streaming": { status: "proven" } } } as never, "read.streaming")).toThrow(/not proven/)
    expect(() => requireProvenPersistenceCapability({ execution: { "read.streaming": { status: "proven", evidence: "tx1/pg-stream.json" } } } as never, "read.streaming")).not.toThrow()
  })

  it("requires bounded, cancellable streaming", () => {
    const signal = new AbortController().signal
    expect(() => assertStreamingReadOptions({ batchSize: 0, signal, deadline: new Date(Date.now() + 1000) })).toThrow(/batchSize/)
    expect(() => assertStreamingReadOptions({ batchSize: 10, signal, deadline: new Date(Date.now() - 1) })).toThrow(/deadline/)
    expect(() => assertStreamingReadOptions({ batchSize: 10, signal, deadline: new Date(Date.now() + 1000) })).not.toThrow()
  })

  it("fails an already-aborted stream before adapter execution", () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled"))
    expect(() => assertStreamingReadOptions({ batchSize: 10, signal: controller.signal, deadline: new Date(Date.now() + 1000) })).toThrow(/cancelled/)
  })
})
