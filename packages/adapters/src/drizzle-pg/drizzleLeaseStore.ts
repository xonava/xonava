import { FencedLeaseStore, type AtomicLeaseBackend } from "../drizzle-shared/fencedLeaseStore"
export const createDrizzlePgLeaseStore = (backend: AtomicLeaseBackend) => new FencedLeaseStore(backend)
