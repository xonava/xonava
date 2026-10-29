import { describe, expect, it } from "vitest"
import { ReadModelCancelledError, ReadModelDeadlineExceededError } from ".."

describe("read-model errors", () => {
  it("describes a cancellation", () => {
    const error = new ReadModelCancelledError("why")
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe("Read-model execution was cancelled")
    expect(error.name).toBe("ReadModelCancelledError")
    expect(error.kind).toBe("cancelled")
    expect(error.reason).toBe("why")
    expect(new ReadModelCancelledError().reason).toBeUndefined()
  })
  it("describes an exceeded deadline", () => {
    const error = new ReadModelDeadlineExceededError(42)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe("Read-model execution deadline exceeded")
    expect(error.name).toBe("ReadModelDeadlineExceededError")
    expect(error.kind).toBe("deadline-exceeded")
    expect(error.deadline).toBe(42)
  })
})
