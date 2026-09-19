import { describe, expect, it } from "vitest"
import type { JobStore } from "core/execution"
import type { ScheduleStore } from "core/execution"
import type { OutboxRecord, OutboxSink } from "core/events"

export interface JobStoreConcurrencyContractOptions {
  createStore: () => JobStore
  requester?: Parameters<JobStore["claimDue"]>[0]["requester"]
  now?: Date
}

export function runJobStoreConcurrencyContractTests(label: string, options: JobStoreConcurrencyContractOptions): void {
  describe.sequential(`Job-store concurrency contract: ${label}`, () => {
    it("fences stale claims from renewal and completion", async () => {
      const store = options.createStore()
      const now = options.now ?? new Date("2026-08-10T12:00:00.000Z")
      const requester = options.requester ?? { scope: "system" as const }
      const executionScope = requester.scope === "tenant" ? { kind: "tenant" as const, tenantId: requester.tenantId } : requester.scope === "platform" ? { kind: "platform" as const, platformKey: "default" } : { kind: "system" as const, systemKey: "framework" }
      await store.enqueue({ requester, job: { executionScope, jobType: "contract.job", jobVersion: 1, payload: {}, runAt: now } })

      const first = (await store.claimDue({ requester, workerId: "worker-1", leaseDurationMs: 1_000, limit: 1, now }))[0]
      expect(first?.claimToken).toEqual(expect.any(String))
      const second = (await store.claimDue({ requester, workerId: "worker-2", leaseDurationMs: 1_000, limit: 1, now: new Date(now.getTime() + 1_001) }))[0]
      expect(second?.claimToken).toEqual(expect.any(String))
      expect(second?.claimToken).not.toBe(first?.claimToken)

      await expect(store.renewLease({ jobId: first!.id, workerId: "worker-1", claimToken: first!.claimToken!, extendByMs: 10_000 })).resolves.toBe(false)
      await expect(store.markSucceeded({ jobId: first!.id, workerId: "worker-1", claimToken: first!.claimToken!, attempt: first!.currentAttempt })).resolves.toMatchObject({ applied: false, reason: "LEASE_LOST" })
      await expect(store.markSucceeded({ jobId: second!.id, workerId: "worker-2", claimToken: second!.claimToken!, attempt: second!.currentAttempt })).resolves.toMatchObject({ applied: true })
    })
  })
}

export interface ScheduleConcurrencyContractOptions {
  createStore: () => ScheduleStore
  now?: Date
}

export function runScheduleConcurrencyContractTests(label: string, options: ScheduleConcurrencyContractOptions): void {
  describe.sequential(`Schedule-store concurrency contract: ${label}`, () => {
    it("fences stale claim tokens from renewal and mutation", async () => {
      const store = options.createStore()
      const now = options.now ?? new Date("2026-08-10T12:00:00.000Z")
      const first = (await store.claimDueSchedules({ workerId: "worker-1", limit: 1, leaseDurationMs: 1_000, now }))[0]
      expect(first?.claimToken).toEqual(expect.any(String))
      const second = (await store.claimDueSchedules({ workerId: "worker-2", limit: 1, leaseDurationMs: 1_000, now: new Date(now.getTime() + 1_001) }))[0]
      expect(second?.claimToken).toEqual(expect.any(String))
      expect(second?.claimToken).not.toBe(first?.claimToken)

      if (!store.renewScheduleLease) throw new Error("Schedule store must implement fenced lease renewal")
      await expect(store.renewScheduleLease({ scheduleId: first!.scheduleId, workerId: "worker-1", claimToken: first!.claimToken, now: new Date(now.getTime() + 1_001), extendByMs: 9_000 })).resolves.toBe(false)
      await expect(store.advanceSchedule({ scheduleId: first!.scheduleId, workerId: "worker-1", claimToken: first!.claimToken, nextRunAt: new Date(now.getTime() + 60_000), lastRunAt: now, lastStatus: "succeeded" })).resolves.toBe(false)
      await expect(store.releaseSchedule({ scheduleId: second!.scheduleId, workerId: "worker-2", claimToken: second!.claimToken })).resolves.toBe(true)
    })
  })
}

export interface OutboxConcurrencyContractOptions {
  createSink: () => OutboxSink
  record: OutboxRecord
  conflictingRecord: OutboxRecord
}

export function runOutboxConcurrencyContractTests(label: string, options: OutboxConcurrencyContractOptions): void {
  describe.sequential(`Outbox concurrency contract: ${label}`, () => {
    it("accepts same-key replays but rejects fingerprint conflicts", async () => {
      const sink = options.createSink()
      await sink.append(options.record)
      await expect(sink.append({ ...options.record, payload: { ...options.record.payload } })).resolves.toBeUndefined()
      await expect(sink.append(options.conflictingRecord)).rejects.toThrow()
    })
  })
}
