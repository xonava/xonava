import type { WorkflowFailure } from "@xonava/core/workflow"

/** Durable JSON form of a workflow failure record, shared by every SQL workflow store. */
export function encodeWorkflowFailure(failure: WorkflowFailure | null | undefined): string | null {
  if (!failure) return null
  return JSON.stringify({ code: failure.code, message: failure.message, step: failure.step, phase: failure.phase, attempt: failure.attempt, at: failure.at.toISOString() })
}

/** Defensive decode: malformed stored values yield null rather than breaking the dispatcher. */
export function decodeWorkflowFailure(value: unknown): WorkflowFailure | null {
  if (value == null) return null
  let parsed: unknown = value
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) } catch { return null }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const at = typeof record.at === "string" ? new Date(record.at) : null
  if (typeof record.code !== "string" || typeof record.message !== "string" || typeof record.step !== "string" ||
    (record.phase !== "execute" && record.phase !== "compensate") || typeof record.attempt !== "number" ||
    !Number.isSafeInteger(record.attempt) || at === null || Number.isNaN(at.getTime())) return null
  return Object.freeze({ code: record.code, message: record.message, step: record.step, phase: record.phase, attempt: record.attempt, at })
}
