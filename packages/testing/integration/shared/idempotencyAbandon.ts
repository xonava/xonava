import { expect } from "vitest"
import type { IdempotencyPort, IdempotencyRequest } from "core/events"

/**
 * Contract for IdempotencyPort.abandon: it releases only an uncommitted
 * reservation owned by the caller, so a retry can run at once, and never
 * touches a business-committed receipt or another owner's reservation.
 */
export async function assertIdempotencyAbandonContract(store: IdempotencyPort<unknown> & { abandon(lease: IdempotencyRequest & { token: string }): Promise<void> }, markCommitted: (lease: IdempotencyRequest & { token: string }) => Promise<void>, prefix: string): Promise<void> {
  const request = { scope: `tenant:t1:${prefix}`, key: `${prefix}-k1`, fingerprint: "fp", leaseDurationMs: 60_000 }
  const first = await store.acquire(request)
  expect(first.outcome).toBe("acquired")
  const token = (first as { token: string }).token
  expect((await store.acquire(request)).outcome).toBe("in-progress")
  await store.abandon({ ...request, token: "someone-else" })
  expect((await store.acquire(request)).outcome).toBe("in-progress")
  await store.abandon({ ...request, token })
  const retried = await store.acquire(request)
  expect(retried.outcome).toBe("acquired")

  const committedRequest = { ...request, key: `${prefix}-k2` }
  const owned = await store.acquire(committedRequest)
  const committedToken = (owned as { token: string }).token
  await markCommitted({ ...committedRequest, token: committedToken })
  await store.abandon({ ...committedRequest, token: committedToken })
  expect(await store.acquire(committedRequest)).toMatchObject({ outcome: "business-committed", token: committedToken })
}
