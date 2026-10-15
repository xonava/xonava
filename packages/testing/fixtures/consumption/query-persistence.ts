import { validateQueryPlan } from "@xonava/core/query"
import { supportsAtomicBatch } from "@xonava/core/persistence"
export const capabilities = [validateQueryPlan, supportsAtomicBatch]
