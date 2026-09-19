import { StaleClaimError } from "core/domain"
import { FencedInboxStore, FencedOutboxStore, type AtomicRecordBackend } from "../drizzle-shared/fencedDeliveryStateMachine"
import type { InboxKey, InboxRecord, OutboxDeliveryKey, OutboxDeliveryRecord } from "core/events"
import { D1AtomicRecordBackend, type D1Statement } from "./d1AtomicRecordBackend"

export class DrizzleD1InboxStore extends FencedInboxStore {
  constructor(private readonly atomicBackend: D1AtomicRecordBackend<InboxKey, InboxRecord>) { super(atomicBackend) }
  acknowledgeBatch<T>(key: InboxKey, token: string, businessStatements: readonly D1Statement[], result: T): Promise<{ record: InboxRecord; result: T }> {
    if (businessStatements.length === 0) throw new Error("D1 atomic acknowledgement requires at least one business statement")
    return this.atomicBackend.transactBatch(key, businessStatements, (current, now) => {
      if (!current || current.state !== "claimed" || current.claim?.token !== token || now.getTime() >= Date.parse(current.claim.leaseExpiresAt)) throw new StaleClaimError()
      const at = now.toISOString()
      const next: InboxRecord = { ...current, state: "processed", claim: null, processedAt: at, lastObservedAt: at, history: [...current.history, { generation: current.replayGeneration, terminalState: "processed", at }] }
      return { record: next, result: { record: next, result } }
    })
  }
}

export const createDrizzleD1InboxStore = (backend: AtomicRecordBackend<InboxKey, InboxRecord>) => backend instanceof D1AtomicRecordBackend ? new DrizzleD1InboxStore(backend) : new FencedInboxStore(backend)
export const createDrizzleD1OutboxStore = (backend: AtomicRecordBackend<OutboxDeliveryKey, OutboxDeliveryRecord>) => new FencedOutboxStore(backend)
