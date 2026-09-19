import { FencedLeaseStore, type AtomicLeaseBackend } from "../drizzle-shared/fencedLeaseStore"
export const createDrizzleD1LeaseStore = (backend: AtomicLeaseBackend) => new FencedLeaseStore(backend)
