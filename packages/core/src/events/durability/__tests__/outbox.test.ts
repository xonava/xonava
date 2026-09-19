import { describe, expect, it } from "vitest"
import { normalizeOutboxRecord } from "../outbox"

describe("outbox record normalization", () => {
  it("uses defaults only for omitted identity and timestamp values", () => {
    const occurredAt = new Date("2026-08-05T00:00:00Z")
    const defaults = { id: "generated", occurredAt }
    expect(normalizeOutboxRecord({ type: "created", version: 1, scope: { kind: "platform", platformKey: "test" }, scopeId: "fscope:v1:eyJraW5kIjoicGxhdGZvcm0iLCJwbGF0Zm9ybUtleSI6InRlc3QifQ" as never, aggregateType: "row", aggregateId: "1", payload: {}, idempotencyKey: "1" }, defaults)).toMatchObject({ id: "generated", occurredAt })
    const explicit = new Date("2026-08-04T00:00:00Z")
    expect(normalizeOutboxRecord({ id: "provided", occurredAt: explicit, type: "updated", version: 1, scope: { kind: "platform", platformKey: "test" }, scopeId: "fscope:v1:eyJraW5kIjoicGxhdGZvcm0iLCJwbGF0Zm9ybUtleSI6InRlc3QifQ" as never, aggregateType: "row", aggregateId: "1", payload: {}, idempotencyKey: "2" }, defaults)).toMatchObject({ id: "provided", occurredAt: explicit })
  })
})
