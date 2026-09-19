import { FencedInboxStore, FencedOutboxStore, type AtomicRecordBackend } from "../drizzle-shared/fencedDeliveryStateMachine"
import type { InboxKey, InboxRecord, OutboxDeliveryKey, OutboxDeliveryRecord } from "core/events"
export const createDrizzlePgInboxStore = (backend: AtomicRecordBackend<InboxKey, InboxRecord>) => new FencedInboxStore(backend)
export const createDrizzlePgOutboxStore = (backend: AtomicRecordBackend<OutboxDeliveryKey, OutboxDeliveryRecord>) => new FencedOutboxStore(backend)
