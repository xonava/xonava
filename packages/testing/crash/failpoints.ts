export const DURABLE_FAILPOINTS = [
  "before-transaction",
  "after-business-before-commit",
  "after-participants-before-commit",
  "after-commit-before-response",
  "after-commit-before-finalization",
  "during-replay-before-response",
] as const
export type DurableFailpoint = typeof DURABLE_FAILPOINTS[number]
export function isPreCommitFailpoint(value: DurableFailpoint): boolean {
  return value === "before-transaction" || value === "after-business-before-commit" || value === "after-participants-before-commit"
}
