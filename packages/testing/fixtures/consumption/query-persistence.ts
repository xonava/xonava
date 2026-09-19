import { validateQueryPlan } from "core/query"
import { supportsAtomicBatch } from "core/persistence"
export const capabilities = [validateQueryPlan, supportsAtomicBatch]
