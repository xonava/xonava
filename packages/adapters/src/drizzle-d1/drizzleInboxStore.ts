import { ConflictError } from "@xonava/core/domain"
import { FencedInboxStore, FencedOutboxStore, type AtomicRecordBackend } from "../drizzle-shared/fencedDeliveryStateMachine"
import { acknowledgeInboxRecord, type InboxKey, type InboxRecord, type OutboxDeliveryKey, type OutboxDeliveryRecord } from "@xonava/core/events"
import { D1AtomicRecordBackend, type D1Statement } from "./d1AtomicRecordBackend"

export class DrizzleD1InboxStore extends FencedInboxStore {
  constructor(private readonly atomicBackend: D1AtomicRecordBackend<InboxKey, InboxRecord>) { super(atomicBackend) }
  acknowledgeBatch<T>(key: InboxKey, token: string, businessStatements: readonly D1Statement[], result: T): Promise<{ record: InboxRecord; result: T }> {
    if (businessStatements.length === 0) throw new Error("D1 atomic acknowledgement requires at least one business statement")
    return this.atomicBackend.transactBatch(key, businessStatements, (current, now) => {
      if (!current) throw new ConflictError()
      const next = acknowledgeInboxRecord(current, token, now)
      return { record: next, result: { record: next, result } }
    })
  }
}

export const createDrizzleD1InboxStore = (backend: AtomicRecordBackend<InboxKey, InboxRecord>) => backend instanceof D1AtomicRecordBackend ? new DrizzleD1InboxStore(backend) : new FencedInboxStore(backend)
export const createDrizzleD1OutboxStore = (backend: AtomicRecordBackend<OutboxDeliveryKey, OutboxDeliveryRecord>) => new FencedOutboxStore(backend)
