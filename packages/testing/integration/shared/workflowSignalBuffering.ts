import { expect, it } from "vitest"
import { applyWorkflowStep, cancelWorkflow, scheduleWorkflowRetry, type WorkflowInstance, type WorkflowStore } from "core/workflow"
import { createRng, hashSeed, scaledRuns } from "../../../core/src/__tests__/differential/harness.js"
import { signalLedgerViolations } from "../../../core/src/__tests__/differential/workflowFixtures.js"

/**
 * Buffered workflow signals on a real database (docs/spec/workflow.md, "Signals"): a receipt delivered before the
 * instance reaches its wait is kept and consumed, oldest first, by the next wait for that name, atomically with the
 * wait's fenced commit; each receipt is consumed at most once; terminal instances store nothing. The race tests issue a
 * delivery and the fenced commit of a wait on separate connections and check the ledger invariants from the rows.
 */

export interface DbReceipt {
  readonly id: string
  readonly instanceId: string
  readonly name: string
  readonly seq: number
  readonly consumed: boolean
  readonly consumedRevision: number | null
}

export interface SignalBufferingHarness {
  readonly store: WorkflowStore
  /** Race iterations at scale 1 (default 60). */
  readonly raceRuns?: number
  /** The receipts of these instances in delivery (seq) order, read straight from the database. */
  receipts(instanceIds: readonly string[]): Promise<DbReceipt[]>
}

const scope = { kind: "tenant", tenantId: "t1" } as const

export async function startInstance(store: WorkflowStore, id: string): Promise<void> {
  await store.start({ id, workflowType: "signals", workflowVersion: 1, executionScope: scope, initialStep: "approve", variables: {} })
}

/** Claims the instance (and, harmlessly, any other due ones) and returns its claim with the fence for it. */
export async function claim(store: WorkflowStore, id: string, workerId = "signals") {
  const claims = await store.claimDue({ workerId, limit: 1000, leaseDurationMs: 60_000 })
  const found = claims.find((entry) => entry.instance.id === id)
  expect(found, `claim ${id}`).toBeDefined()
  return { claim: found!, fence: { instanceId: id, workerId, claimToken: found!.claimToken, revision: found!.instance.revision } }
}

const waitFor = (instance: WorkflowInstance, signal: string): WorkflowInstance => applyWorkflowStep(instance, { kind: "wait", signal }, new Date())
let counter = 0
const signalId = (prefix: string, label: string): string => `${prefix}-${label}-${++counter}`

export async function ledgerViolations(harness: SignalBufferingHarness, instanceIds: readonly string[]): Promise<string[]> {
  const receipts = await harness.receipts(instanceIds)
  const rows: WorkflowInstance[] = []
  for (const id of instanceIds) { const row = await harness.store.get(id); if (row) rows.push(row) }
  return signalLedgerViolations({ receipts, consumed: new Set(receipts.filter((receipt) => receipt.consumed).map((receipt) => receipt.id)), rows })
}

/** Registers the tests; `open` is called once per test file, lazily. */
export function registerWorkflowSignalBufferingTests(getHarness: () => SignalBufferingHarness, prefix: string): void {
  it("consumes a signal delivered before the wait at the wait's commit and records it as the resume receipt", async () => {
    const { store } = getHarness()
    const id = `${prefix}-early`
    await startInstance(store, id)
    const { claim: running, fence } = await claim(store, id)
    // The signal arrives while the step is still running: stored pending, nothing else changes (the running claim stays valid).
    expect(await store.deliverSignal({ id: `${id}-sig`, instanceId: id, name: "go", payload: { n: 1 } })).toEqual({ delivered: true, duplicate: false })
    const during = await store.get(id)
    expect(during).toMatchObject({ status: "pending", revision: running.instance.revision, leaseOwner: "signals", claimToken: fence.claimToken })
    expect(await store.assertLease(fence)).toBe(true)

    expect(await store.commit(fence, waitFor(running.instance, "go"))).toBe(true)
    const resumed = await store.get(id)
    expect(resumed).toMatchObject({ status: "pending", waitingSignal: "go", resumeSignalId: `${id}-sig`, stepAttempt: 0, wakeAt: null, leaseOwner: null, claimToken: null, leaseExpiresAt: null, revision: fence.revision + 1 })
    expect(await store.getSignalById!(id, `${id}-sig`)).toMatchObject({ id: `${id}-sig`, instanceId: id, name: "go", payload: { n: 1 } })
    expect(await getHarness().receipts([id])).toMatchObject([{ id: `${id}-sig`, consumed: true, consumedRevision: fence.revision + 1 }])

    // The resumed step is claimed with the same receipt id; its attempt counter starts at the claim.
    const again = await claim(store, id, "signals-2")
    expect(again.claim.instance).toMatchObject({ resumeSignalId: `${id}-sig`, stepAttempt: 1 })
    expect(await ledgerViolations(getHarness(), [id])).toEqual([])
  })

  it("consumes several early signals first-in-first-out across successive waits and keeps later ones pending", async () => {
    const harness = getHarness()
    const { store } = harness
    const id = `${prefix}-fifo`
    await startInstance(store, id)
    let current = await claim(store, id)
    for (const n of [1, 2, 3]) expect(await store.deliverSignal({ id: `${id}-s${n}`, instanceId: id, name: "go", payload: { n } })).toEqual({ delivered: true, duplicate: false })
    for (const n of [1, 2, 3]) {
      expect(await store.commit(current.fence, waitFor(current.claim.instance, "go"))).toBe(true)
      expect(await store.get(id)).toMatchObject({ status: "pending", resumeSignalId: `${id}-s${n}` })
      expect((await harness.receipts([id])).filter((receipt) => receipt.consumed).map((receipt) => receipt.id)).toEqual([1, 2, 3].slice(0, n).map((k) => `${id}-s${k}`))
      current = await claim(store, id, `signals-${n}`)
    }
    // All three are consumed: the fourth wait parks the instance, and the latest-by-name lookup still sees the newest receipt.
    expect(await store.commit(current.fence, waitFor(current.claim.instance, "go"))).toBe(true)
    expect(await store.get(id)).toMatchObject({ status: "waiting", waitingSignal: "go", resumeSignalId: null })
    expect(await store.getSignal!(id, "go")).toMatchObject({ id: `${id}-s3`, payload: { n: 3 } })
    // A delivery to the parked instance wakes it with exactly that receipt.
    expect(await store.deliverSignal({ id: `${id}-s4`, instanceId: id, name: "go", payload: { n: 4 } })).toEqual({ delivered: true, duplicate: false })
    expect(await store.get(id)).toMatchObject({ status: "pending", resumeSignalId: `${id}-s4`, stepAttempt: 0 })
    expect(await store.getSignalById!(id, `${id}-s4`)).toMatchObject({ payload: { n: 4 } })
    expect(await ledgerViolations(harness, [id])).toEqual([])
  })

  it("answers duplicate ids idempotently, also across instances and after consumption, without a second consumption", async () => {
    const harness = getHarness()
    const { store } = harness
    const a = `${prefix}-dup-a`
    const b = `${prefix}-dup-b`
    await startInstance(store, a)
    await startInstance(store, b)
    const { claim: running, fence } = await claim(store, a)
    const bBefore = await store.get(b)
    expect(await store.deliverSignal({ id: `${a}-sig`, instanceId: a, name: "go", payload: {} })).toEqual({ delivered: true, duplicate: false })
    expect(await store.deliverSignal({ id: `${a}-sig`, instanceId: a, name: "go", payload: {} })).toEqual({ delivered: false, duplicate: true })
    expect(await store.deliverSignal({ id: `${a}-sig`, instanceId: b, name: "go", payload: {} })).toEqual({ delivered: false, duplicate: true })
    expect(await store.commit(fence, waitFor(running.instance, "go"))).toBe(true)
    const consumed = await store.get(a)
    expect(await store.deliverSignal({ id: `${a}-sig`, instanceId: a, name: "go", payload: {} })).toEqual({ delivered: false, duplicate: true })
    expect(await store.get(a)).toEqual(consumed)
    expect(await store.get(b)).toEqual(bBefore)
    expect((await harness.receipts([a, b])).map((receipt) => [receipt.id, receipt.consumed])).toEqual([[`${a}-sig`, true]])
    // Two concurrent deliveries of one id: exactly one stores it.
    const results = await Promise.all([store.deliverSignal({ id: `${b}-sig`, instanceId: b, name: "go", payload: {} }), store.deliverSignal({ id: `${b}-sig`, instanceId: b, name: "go", payload: {} })])
    expect(results.filter((result) => result.delivered)).toEqual([{ delivered: true, duplicate: false }])
    expect(results.filter((result) => !result.delivered)).toEqual([{ delivered: false, duplicate: true }])
    expect(await ledgerViolations(harness, [a, b])).toEqual([])
  })

  it("keeps receipts of other names pending until a wait for that name, and does not wake a sleep or a retry backoff", async () => {
    const harness = getHarness()
    const { store } = harness
    const id = `${prefix}-names`
    await startInstance(store, id)
    const first = await claim(store, id)
    expect(await store.deliverSignal({ id: `${id}-other`, instanceId: id, name: "other", payload: {} })).toMatchObject({ delivered: true })
    expect(await store.commit(first.fence, waitFor(first.claim.instance, "go"))).toBe(true)
    expect(await store.get(id)).toMatchObject({ status: "waiting", waitingSignal: "go", resumeSignalId: null })
    expect((await harness.receipts([id]))[0]).toMatchObject({ id: `${id}-other`, consumed: false })
    // A different name delivered to the waiting instance neither wakes it nor changes its revision.
    const parked = await store.get(id)
    expect(await store.deliverSignal({ id: `${id}-other-2`, instanceId: id, name: "other", payload: {} })).toMatchObject({ delivered: true })
    expect(await store.get(id)).toEqual(parked)
    // Waking by "go" and then waiting for "other" consumes the oldest "other" receipt, not the newest.
    expect(await store.deliverSignal({ id: `${id}-go`, instanceId: id, name: "go", payload: {} })).toMatchObject({ delivered: true })
    const second = await claim(store, id, "signals-2")
    expect(second.claim.instance.resumeSignalId).toBe(`${id}-go`)
    expect(await store.commit(second.fence, waitFor(second.claim.instance, "other"))).toBe(true)
    expect(await store.get(id)).toMatchObject({ status: "pending", waitingSignal: "other", resumeSignalId: `${id}-other` })
    expect((await harness.receipts([id])).map((receipt) => [receipt.id, receipt.consumed])).toEqual([[`${id}-other`, true], [`${id}-other-2`, false], [`${id}-go`, true]])
    expect(await ledgerViolations(harness, [id])).toEqual([])

    // A signal received during a retry backoff is buffered; the backoff is not cut short.
    const backoff = `${prefix}-backoff`
    await startInstance(store, backoff)
    const running = await claim(store, backoff)
    const wakeAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000)
    expect(await store.commit(running.fence, scheduleWorkflowRetry(running.claim.instance, wakeAt, new Date()))).toBe(true)
    const backingOff = await store.get(backoff)
    expect(await store.deliverSignal({ id: `${backoff}-sig`, instanceId: backoff, name: "go", payload: {} })).toMatchObject({ delivered: true })
    expect(await store.get(backoff)).toEqual(backingOff)
    expect((await harness.receipts([backoff]))[0]).toMatchObject({ consumed: false })
  })

  it("stores nothing for an unknown or terminal instance and retains pending receipts of an instance that becomes terminal", async () => {
    const harness = getHarness()
    const { store } = harness
    expect(await store.deliverSignal({ id: `${prefix}-ghost-sig`, instanceId: `${prefix}-ghost`, name: "go", payload: {} })).toEqual({ delivered: false, duplicate: false })
    expect(await harness.receipts([`${prefix}-ghost`])).toEqual([])

    // succeeded
    const done = `${prefix}-done`
    await startInstance(store, done)
    const running = await claim(store, done)
    expect(await store.commit(running.fence, applyWorkflowStep(running.claim.instance, { kind: "complete" }, new Date()))).toBe(true)
    expect(await store.get(done)).toMatchObject({ status: "succeeded" })
    expect(await store.deliverSignal({ id: `${done}-sig`, instanceId: done, name: "go", payload: {} })).toEqual({ delivered: false, duplicate: false })
    expect(await harness.receipts([done])).toEqual([])

    // cancelled: the receipt delivered earlier is retained, never consumed, and later deliveries store nothing
    const cancelled = `${prefix}-cancelled`
    await startInstance(store, cancelled)
    expect(await store.deliverSignal({ id: `${cancelled}-early`, instanceId: cancelled, name: "go", payload: {} })).toEqual({ delivered: true, duplicate: false })
    expect(await store.cancel(cancelled)).toBe(true)
    expect(await store.get(cancelled)).toMatchObject({ status: "cancelled", resumeSignalId: null })
    expect(await store.deliverSignal({ id: `${cancelled}-late`, instanceId: cancelled, name: "go", payload: {} })).toEqual({ delivered: false, duplicate: false })
    expect(await store.deliverSignal({ id: `${cancelled}-early`, instanceId: cancelled, name: "go", payload: {} })).toEqual({ delivered: false, duplicate: true })
    expect((await harness.receipts([cancelled])).map((receipt) => [receipt.id, receipt.consumed])).toEqual([[`${cancelled}-early`, false]])
    expect(await ledgerViolations(harness, [done, cancelled])).toEqual([])
  })

  it("cancel clears the resume receipt but leaves receipts untouched, and receipts delivered while compensating are buffered", async () => {
    const harness = getHarness()
    const { store } = harness
    const id = `${prefix}-cancel`
    await startInstance(store, id)
    const { claim: running, fence } = await claim(store, id)
    await store.deliverSignal({ id: `${id}-s1`, instanceId: id, name: "go", payload: {} })
    await store.deliverSignal({ id: `${id}-s2`, instanceId: id, name: "go", payload: {} })
    expect(await store.commit(fence, waitFor(running.instance, "go"))).toBe(true)
    expect(await store.get(id)).toMatchObject({ status: "pending", resumeSignalId: `${id}-s1` })
    expect(await store.cancel(id)).toBe(true)
    expect(await store.get(id)).toMatchObject({ status: "cancelled", resumeSignalId: null, waitingSignal: null })
    expect((await harness.receipts([id])).map((receipt) => [receipt.id, receipt.consumed])).toEqual([[`${id}-s1`, true], [`${id}-s2`, false]])
    expect(await store.getSignalById!(id, `${id}-s1`)).toMatchObject({ id: `${id}-s1` })

    // compensating: a cancelled instance with a compensation stack keeps running its compensations; signals are only buffered.
    const comp = `${prefix}-comp`
    await startInstance(store, comp)
    const first = await claim(store, comp)
    expect(await store.commit(first.fence, applyWorkflowStep(first.claim.instance, { kind: "next", step: "charge", compensation: "release" }, new Date()))).toBe(true)
    const second = await claim(store, comp, "signals-2")
    expect(await store.commit(second.fence, cancelWorkflow(second.claim.instance, new Date()))).toBe(true)
    const compensating = await store.get(comp)
    expect(compensating?.status).toBe("compensating")
    expect(await store.deliverSignal({ id: `${comp}-sig`, instanceId: comp, name: "go", payload: {} })).toEqual({ delivered: true, duplicate: false })
    expect(await store.get(comp)).toEqual(compensating)
    expect((await harness.receipts([comp]))[0]).toMatchObject({ id: `${comp}-sig`, consumed: false })
    expect(await ledgerViolations(harness, [id, comp])).toEqual([])
  })

  it("consumes nothing when the fenced commit of a wait is rejected", async () => {
    const harness = getHarness()
    const { store } = harness
    const id = `${prefix}-stale`
    await startInstance(store, id)
    const { claim: running, fence } = await claim(store, id)
    await store.deliverSignal({ id: `${id}-sig`, instanceId: id, name: "go", payload: {} })
    const before = await store.get(id)
    expect(await store.commit({ ...fence, claimToken: "someone-else" }, waitFor(running.instance, "go"))).toBe(false)
    expect(await store.commit({ ...fence, revision: fence.revision - 1 }, waitFor(running.instance, "go"))).toBe(false)
    expect(await store.get(id)).toEqual(before)
    expect((await harness.receipts([id]))[0]).toMatchObject({ consumed: false, consumedRevision: null })
    // The right fence still works afterwards.
    expect(await store.commit(fence, waitFor(running.instance, "go"))).toBe(true)
    expect(await store.get(id)).toMatchObject({ status: "pending", resumeSignalId: `${id}-sig` })
  })

  it("never loses a wake nor consumes a receipt twice when deliveries race the fenced commit of a wait on separate connections", async () => {
    const harness = getHarness()
    const { store } = harness
    const iterations = scaledRuns(harness.raceRuns ?? 60)
    const rng = createRng(hashSeed(`${prefix}-race`))
    // 0 ms means "issue immediately"; a small random head start for either side varies which statement reaches the database first.
    const after = (ms: number): Promise<void> => (ms === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)))
    const ids: string[] = []
    for (let index = 0; index < iterations; index++) {
      const id = `${prefix}-race-${index}`
      ids.push(id)
      await startInstance(store, id)
      const { claim: running, fence } = await claim(store, id)
      const deliveries = index % 3 === 2 ? [`${id}-a`, `${id}-b`] : [`${id}-a`]
      const [commit, ...delivered] = await Promise.all([
        after(rng.int(4)).then(() => store.commit(fence, waitFor(running.instance, "go"))),
        ...deliveries.map((signal) => after(rng.int(4)).then(() => store.deliverSignal({ id: signal, instanceId: id, name: "go", payload: { signal } }))),
      ])
      expect(commit, `commit ${id}`).toBe(true)
      for (const result of delivered) expect(result, `delivery ${id}`).toEqual({ delivered: true, duplicate: false })
      const final = await store.get(id)
      const receipts = await harness.receipts([id])
      expect(receipts.length, id).toBe(deliveries.length)
      // No lost wake: the instance is resumed (pending), never parked on "go" while a "go" receipt is pending.
      expect(final, id).toMatchObject({ status: "pending", waitingSignal: "go", stepAttempt: 0, leaseOwner: null })
      expect(await ledgerViolations(harness, [id]), id).toEqual([])
      // Exactly one receipt consumed (the oldest by delivery order), by the transition that produced the final revision.
      expect(receipts.filter((receipt) => receipt.consumed).map((receipt) => receipt.id), id).toEqual([receipts[0]!.id])
      expect(final!.resumeSignalId, id).toBe(receipts[0]!.id)
      expect(receipts[0]!.consumedRevision, id).toBe(final!.revision)
      await store.cancel(id)
    }
    expect(await ledgerViolations(harness, ids)).toEqual([])
  }, 120_000)
}
