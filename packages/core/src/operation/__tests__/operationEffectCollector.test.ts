import { describe, expect, it } from "vitest"
import { ConfigurationError, EffectCollectorDisposedError, EffectCollectorDrainedError } from "../../domain"
import { OperationEffectCollector } from "../operationEffectCollector"

describe("OperationEffectCollector lifecycle", () => {
  it("separates pre-commit and deferred effect phases", async () => {
    const collector = new OperationEffectCollector()
    collector.addBestEffortEffect("post", async () => {})

    const preCommit = collector.takePreCommitEffects()
    expect(collector.lifecycleState).toBe("post-commit")
    expect(preCommit.bestEffortEffects).toHaveLength(1)

    collector.addBestEffortEffect("deferred", async () => {})
    expect(collector.takeDeferredEffects().bestEffortEffects).toHaveLength(1)
    expect(collector.lifecycleState).toBe("deferred-taken")
    expect(() => collector.takeDeferredEffects()).toThrow(EffectCollectorDrainedError)
  })

  it("reopens the deferred phase when a post-commit effect registers more work", () => {
    const collector = new OperationEffectCollector()
    collector.takePreCommitEffects()
    collector.addBestEffortEffect("first", async () => {})

    expect(collector.takeDeferredEffects().bestEffortEffects).toHaveLength(1)
    expect(collector.lifecycleState).toBe("deferred-taken")

    collector.addBestEffortEffect("second", async () => {})
    expect(collector.lifecycleState).toBe("post-commit")
    expect(collector.takeDeferredEffects().bestEffortEffects).toHaveLength(1)
  })

  it("rejects drains outside the committed phase and after disposal", () => {
    const collector = new OperationEffectCollector()
    expect(() => collector.takeDeferredEffects()).toThrow(EffectCollectorDisposedError)

    collector.takePreCommitEffects()
    collector.dispose()
    expect(collector.lifecycleState).toBe("disposed")
    expect(() => collector.takeDeferredEffects()).toThrow(EffectCollectorDisposedError)
    expect(() => collector.addBestEffortEffect("late", async () => {})).toThrow(EffectCollectorDisposedError)
  })

  it("covers initial snapshots and idempotent disposal", () => {
    const record = { id: "outbox-1" } as never
    const collector = new OperationEffectCollector({ outboxRecords: [record] })
    expect(collector.outboxRecords).toEqual([record])
    expect(collector.bestEffortEffects).toEqual([])
    expect(collector.bestEffortEffects).toEqual([])
    collector.addOutboxRecord(record)
    expect(collector.outboxRecords).toHaveLength(2)

    collector.dispose()
    collector.dispose()
    expect(collector.isDisposed).toBe(true)
    expect(collector.outboxRecords).toEqual([])
    expect(() => collector.addBestEffortEffect("late", async () => {})).toThrow(EffectCollectorDisposedError)
  })

  it("bounds deferred effect registration across drain cycles", () => {
    const collector = new OperationEffectCollector()
    collector.takePreCommitEffects()
    collector.addBestEffortEffect("first", async () => {})
    for (let index = 0; index < OperationEffectCollector.defaultMaxDeferredEffects - 1; index += 1) {
      collector.addBestEffortEffect(`extra-${index}`, async () => {})
    }
    expect(() => collector.addBestEffortEffect("third", async () => {})).toThrow(ConfigurationError)
    collector.takeDeferredEffects()
    expect(() => collector.addBestEffortEffect("late", async () => {})).toThrow(ConfigurationError)
  })

  it("collects durable effects as pre-commit outbox records", () => {
    const collector = new OperationEffectCollector()
    const record = { id: "durable-1", topic: "events", payload: { ok: true } } as never

    collector.addOutboxRecord(record)

    expect(collector.takePreCommitEffects().outboxRecords).toEqual([record])
  })
})
