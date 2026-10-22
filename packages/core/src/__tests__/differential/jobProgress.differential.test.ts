import { describe, expect, it } from "vitest"
import { forAll, type Rng } from "./harness"
import { ConfigurationError, StaleClaimError } from "../../domain"
import { MAX_JOB_CHECKPOINT_BYTES, assertJobProgressFence, decodeStoredJobCheckpoint, validateJobProgress, type JobProgressFence } from "../../execution/jobProgress"

/** Progress validation, stored-checkpoint decoding and the claim fence against direct reference rules. */

const PERCENTS = [0, 100, 50, 0.5, 99.999, -0, -0.0001, 100.0001, -1, 101, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_VALUE, Number.MIN_VALUE, 1e-320, 33.3333]
const utf8 = (text: string): number => new TextEncoder().encode(text).byteLength

describe("job progress properties", () => {
  it("accepts a percent exactly when it is a finite number in [0, 100]", () => {
    forAll("job progress: percent bounds", (rng) => rng.pick(PERCENTS), (percent) => {
      const valid = Number.isFinite(percent) && percent >= 0 && percent <= 100
      if (valid) expect(() => validateJobProgress({ percent })).not.toThrow()
      else expect(() => validateJobProgress({ percent })).toThrow(ConfigurationError)
    }, { runs: 100 })
  })

  it("bounds a checkpoint by its canonical UTF-8 size, counting bytes rather than characters", () => {
    interface Case { filler: string; fillerBytes: number; delta: number }
    forAll("job progress: checkpoint size is measured in canonical UTF-8 bytes", (rng: Rng): Case => {
      const filler = rng.pick(["a", "é", "€", "\u{1F600}"])
      return { filler, fillerBytes: utf8(filler), delta: rng.pick([-2, -1, 0, 1, 2, 10, -1000, 1000]) }
    }, ({ filler, fillerBytes, delta }) => {
      // {"k":"<filler...>"} is 8 bytes of structure around the string, which must stay in single-string limits.
      const overhead = utf8(JSON.stringify({ k: "" }))
      const target = MAX_JOB_CHECKPOINT_BYTES + delta
      const count = Math.floor((target - overhead) / fillerBytes)
      const checkpoint = { k: filler.repeat(count) }
      const size = utf8(JSON.stringify(checkpoint))
      if (size <= MAX_JOB_CHECKPOINT_BYTES) expect(() => validateJobProgress({ checkpoint }), `size ${size}`).not.toThrow()
      else expect(() => validateJobProgress({ checkpoint }), `size ${size}`).toThrow()
    }, { runs: 100 })
  })

  it("reports checkpoints canonical JSON refuses, and U+0000 anywhere in them, as ConfigurationError", () => {
    const refused: Array<Record<string, unknown>> = [
      { big: 2 ** 53 }, { nested: { list: [-(2 ** 60)] } }, { nul: "a\u0000b" }, { "k\u0000": true }, { deep: [{ x: "ok" }, "\u0000"] },
    ]
    for (const checkpoint of refused) expect(() => validateJobProgress({ checkpoint }), JSON.stringify(checkpoint)).toThrow(ConfigurationError)
    expect(() => validateJobProgress({ checkpoint: { safe: 2 ** 53 - 1, text: "\u0001" } })).not.toThrow()
  })

  it("decodes a stored checkpoint only when it is a JSON object within the byte bound", () => {
    const objects: Array<Record<string, unknown>> = [{}, { a: 1 }, { nested: { list: [1, 2, { b: null }] } }, { "é": "\u{1F600}" }]
    forAll("job progress: stored checkpoint decoding", (rng) => {
      const object = rng.pick(objects)
      const form = rng.pick(["json", "object", "array", "null", "number", "badjson", "empty", "huge-bytes", "huge-array"] as const)
      return { object, form }
    }, ({ object, form }) => {
      switch (form) {
        case "json": expect(decodeStoredJobCheckpoint(JSON.stringify(object))).toEqual(object); break
        case "object": expect(decodeStoredJobCheckpoint(object)).toEqual(object); break
        case "array": expect(() => decodeStoredJobCheckpoint("[]")).toThrow(ConfigurationError); expect(() => decodeStoredJobCheckpoint([])).toThrow(ConfigurationError); break
        case "null": expect(() => decodeStoredJobCheckpoint(null)).toThrow(ConfigurationError); expect(() => decodeStoredJobCheckpoint("null")).toThrow(ConfigurationError); break
        case "number": expect(() => decodeStoredJobCheckpoint(7)).toThrow(ConfigurationError); expect(() => decodeStoredJobCheckpoint("7")).toThrow(ConfigurationError); break
        case "badjson": expect(() => decodeStoredJobCheckpoint("{not json")).toThrow(ConfigurationError); break
        case "empty": expect(() => decodeStoredJobCheckpoint("")).toThrow(ConfigurationError); break
        // Fewer characters than the bound, more bytes than the bound.
        case "huge-bytes": expect(() => decodeStoredJobCheckpoint(`{"k":"${"€".repeat(MAX_JOB_CHECKPOINT_BYTES / 3)}"}`)).toThrow(ConfigurationError); break
        case "huge-array": expect(() => decodeStoredJobCheckpoint(JSON.stringify({ k: "x".repeat(MAX_JOB_CHECKPOINT_BYTES) }))).toThrow(ConfigurationError); break
      }
    }, { runs: 100 })
  })

  it("rejects a progress fence unless job, worker, claim token and attempt all match", () => {
    const base: JobProgressFence = { jobId: "j1", workerId: "w1", claimToken: "tok-1", attempt: 2 }
    forAll("job progress: fence compares every field", (rng) => {
      const field = rng.pick(["jobId", "workerId", "claimToken", "attempt", "none"] as const)
      const supplied: JobProgressFence = { ...base }
      if (field === "jobId") Object.assign(supplied, { jobId: rng.pick(["j2", "J1", "j1 ", ""]) })
      if (field === "workerId") Object.assign(supplied, { workerId: rng.pick(["w2", "W1", ""]) })
      if (field === "claimToken") Object.assign(supplied, { claimToken: rng.pick(["tok-2", "", "TOK-1"]) })
      if (field === "attempt") Object.assign(supplied, { attempt: rng.pick([1, 3, 0, -2, Number.NaN]) })
      return { field, supplied }
    }, ({ field, supplied }) => {
      if (field === "none") expect(() => assertJobProgressFence(base, supplied)).not.toThrow()
      else expect(() => assertJobProgressFence(base, supplied)).toThrow(StaleClaimError)
    }, { runs: 100 })
  })
})
