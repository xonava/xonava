import { expect, it } from "vitest"
import { createJobRegistry, dispatchDueJobs, type JobDefinition } from "@xonava/core/execution"
import { createRng, forAllAsync, type Rng } from "../../../core/src/__tests__/differential/harness.js"
import {
  HOUR, LifecycleRunner, PROPERTY_TIMEOUT_MS, T0, coverage, type JobStoreDifferentialDriver, type RawJobRow,
} from "./jobStoreDifferential.js"
import {
  RefStore, executionScopeOf, generateOps, requesterOf, shrinkOps, describeOps,
  type FailStatus, type Op, type ViewReq,
} from "./jobStoreDifferentialModel.js"

/**
 * Concurrency properties against a real store. Unlike the sequential differential these never assert exact equality
 * with a one-at-a-time reference, only what must hold for every interleaving:
 *
 *  - linearizability of fenced transitions: the outcomes and the final table of a set of concurrent operations must be
 *    explained by SOME serial order of the same operations on the reference store;
 *  - claim races: no job is handed to two workers, partitions stay serialized, attempts stay within budget;
 *  - stale tokens never apply and terminal states are sticky under a storm of claims and transitions;
 *  - no job is lost: after the storm a sequential drain completes every job.
 */

// ---------------------------------------------------------------------------------------------------------------
// 1. Linearizability of concurrent operations

type ConcreteOp =
  | { k: "succeed"; slot: number; worker: string; token: string; attempt: number; result?: Record<string, unknown> }
  | { k: "retry"; slot: number; worker: string; token: string; attempt: number; delta: number; error: string }
  | { k: "fail"; slot: number; worker: string; token: string; attempt: number; status: FailStatus; error: string }
  | { k: "release"; slot: number; worker: string; token: string; delta: number; reason: string }
  | { k: "renew"; slot: number; worker: string; token: string; extendMs: number }
  | { k: "cancel"; slot: number; view: ViewReq; reason?: string }
  | { k: "claim"; worker: string; view: ViewReq; limit: number }

interface LinearizabilityCase { prefix: Op[]; batchSeed: number; rounds: number }

function viewOfSlot(model: RefStore, slot: number): ViewReq {
  const job = model.jobs[slot]!
  return job.scope === "tenant" ? (job.tenantId === "t1" ? "t1" : "t2") : job.scope === "platform" ? "plat" : "sys"
}

function generateBatch(rng: Rng, model: RefStore): ConcreteOp[] {
  const running = model.jobs.filter((job) => job.status === "running")
  const pool = running.length > 0 ? running : model.jobs
  if (pool.length === 0) return []
  const targets = rng.shuffle(pool).slice(0, 1 + rng.int(3))
  const count = 2 + rng.int(4)
  const ops: ConcreteOp[] = []
  let claims = 0
  for (let index = 0; index < count; index++) {
    const job = rng.pick(targets)
    const holder = job.leaseOwner ?? job.lastOwner ?? "w1"
    const live = job.token ?? job.tokenHistory[job.tokenHistory.length - 1] ?? "bogus-token"
    const stale = rng.bool(0.2)
    const other = rng.bool(0.15)
    const worker = other ? (holder === "w1" ? "w2" : "w1") : holder
    const token = stale ? (job.tokenHistory.find((candidate) => candidate !== job.token) ?? "bogus-token") : live
    const attempt = rng.bool(0.9) ? job.attempts : job.attempts + 1
    const roll = rng.int(100)
    if (roll < 22) ops.push({ k: "succeed", slot: job.slot, worker, token, attempt, ...(rng.bool() ? { result: { r: index } } : {}) })
    else if (roll < 42) ops.push({ k: "retry", slot: job.slot, worker, token, attempt, delta: rng.pick([-1000, 0, 4000]), error: `retry ${index}` })
    else if (roll < 56) ops.push({ k: "fail", slot: job.slot, worker, token, attempt, status: rng.pick(["failed", "dead_letter", "cancelled"] as const), error: `fail ${index}` })
    else if (roll < 68) ops.push({ k: "release", slot: job.slot, worker, token, delta: rng.pick([-1000, 4000]), reason: `release ${index}` })
    else if (roll < 78) ops.push({ k: "renew", slot: job.slot, worker, token, extendMs: rng.pick([HOUR, 60_000]) })
    else if (roll < 92) ops.push({ k: "cancel", slot: job.slot, view: viewOfSlot(model, job.slot), ...(rng.bool() ? { reason: `cancel ${index}` } : {}) })
    else if (claims === 0) { claims++; ops.push({ k: "claim", worker: rng.pick(["w1", "w2", "w3"]), view: viewOfSlot(model, job.slot), limit: 1 + rng.int(3) }) }
  }
  return ops
}

/**
 * `sweep: false` models a claim whose dead-letter sweep skipped rows that a concurrent transaction held locked
 * (the sweeps of MySQL use SKIP LOCKED): the expired final attempt is then dead-lettered by the next claim instead.
 * `subset` models a claim that raced with other operations and delivered fewer jobs than were claimable.
 */
function applyToModel(model: RefStore, op: ConcreteOp, variant: { sweep: boolean; subset: boolean }, returned: readonly number[]): { signature: string; claimed?: number[] } {
  const transition = (outcome: { applied: boolean; reason?: string }): string => (outcome.applied ? "applied" : outcome.reason ?? "rejected")
  switch (op.k) {
    case "succeed": return { signature: transition(model.succeed(op.slot, op.worker, op.token, op.attempt, op.result)) }
    case "retry": return { signature: transition(model.retry(op.slot, op.worker, op.token, op.attempt, model.vnow + op.delta, op.error)) }
    case "fail": return { signature: transition(model.fail(op.slot, op.worker, op.token, op.attempt, op.status, op.error)) }
    case "release": return { signature: transition(model.release(op.slot, op.worker, op.token, model.vnow + op.delta, op.reason)) }
    case "renew": return { signature: String(model.renew(op.slot, op.worker, op.token, op.extendMs)) }
    case "cancel": return { signature: transition(model.cancel(op.slot, op.view, op.reason)) }
    case "claim": {
      if (variant.subset) {
        if (!model.claimSubset(op.view, op.worker, op.limit, model.vnow, returned, variant.sweep)) return { signature: "illegal-claim" }
        return { signature: `claimed[${[...returned].sort((a, b) => a - b).join(",")}]`, claimed: [...returned] }
      }
      const claimed = model.claim(op.view, op.worker, op.limit, model.vnow, variant.sweep)
      return { signature: `claimed[${[...claimed].sort((a, b) => a - b).join(",")}]`, claimed }
    }
  }
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]))
}

async function executeConcurrently(runner: LifecycleRunner, ops: ConcreteOp[]): Promise<{ signature: string; claimed?: { slot: number; token: string }[] }[]> {
  const { driver } = runner
  const { store } = driver
  const model = runner.model
  const transitionSig = (result: { applied: boolean; reason?: string; historyError?: string }): string => {
    if (result.historyError !== undefined) return `historyError:${result.historyError}`
    return result.applied ? "applied" : result.reason ?? "rejected"
  }
  return Promise.all(ops.map(async (op) => {
    const jobId = op.k === "claim" ? "" : runner.realId(op.slot)
    switch (op.k) {
      case "succeed": return { signature: transitionSig(await store.markSucceeded({ jobId, workerId: op.worker, claimToken: runner.realToken(op.token), attempt: op.attempt, ...(op.result ? { result: op.result } : {}) })) }
      case "retry": return { signature: transitionSig(await store.markRetrying({ jobId, workerId: op.worker, claimToken: runner.realToken(op.token), attempt: op.attempt, nextAttemptAt: new Date(model.vnow + op.delta), error: op.error })) }
      case "fail": return { signature: transitionSig(await store.markFailed({ jobId, workerId: op.worker, claimToken: runner.realToken(op.token), attempt: op.attempt, error: op.error, status: op.status })) }
      case "release": return { signature: transitionSig(await store.release!({ jobId, workerId: op.worker, claimToken: runner.realToken(op.token), nextAttemptAt: new Date(model.vnow + op.delta), reason: op.reason })) }
      case "renew": return { signature: String(await store.renewLease({ jobId, workerId: op.worker, claimToken: runner.realToken(op.token), extendByMs: op.extendMs })) }
      case "cancel": return { signature: transitionSig(await store.cancel({ jobId, requester: requesterOf(op.view), ...(op.reason !== undefined ? { reason: op.reason } : {}) })) }
      case "claim": {
        const jobs = await store.claimDue({ limit: op.limit, workerId: op.worker, leaseDurationMs: HOUR, requester: requesterOf(op.view), now: new Date(model.vnow) })
        const claimed = jobs.map((job) => ({ slot: runner.slotByRealId.get(job.id) ?? -1, token: job.claimToken ?? "" }))
        return { signature: `claimed[${claimed.map((entry) => entry.slot).sort((a, b) => a - b).join(",")}]`, claimed }
      }
    }
  }))
}

async function runLinearizabilityCase(driver: JobStoreDifferentialDriver, input: LinearizabilityCase): Promise<void> {
  await driver.reset()
  const runner = new LifecycleRunner(driver)
  for (let index = 0; index < input.prefix.length; index++) await runner.step(index, input.prefix[index]!)
  const rng = createRng(input.batchSeed)
  for (let round = 0; round < input.rounds; round++) {
    const ops = generateBatch(rng, runner.model)
    if (ops.length === 0) return
    const actual = await executeConcurrently(runner, ops)
    const perSlot = new Map<number, string[]>()
    ops.forEach((op, index) => { if (op.k !== "claim") perSlot.set(op.slot, [...(perSlot.get(op.slot) ?? []), actual[index]!.signature]) })
    for (const signatures of perSlot.values()) {
      if (signatures.length > 1) coverage(`concurrent:contended-job:${signatures.filter((signature) => signature === "applied" || signature === "true").length}-applied-of-${signatures.length}`)
    }
    if (ops.some((op) => op.k === "claim")) coverage("concurrent:with-claim")
    // Register the real tokens handed out by a claim so that the table comparison can map symbolic tokens.
    const failures: string[] = []
    let accepted: RefStore | undefined
    const hasClaim = ops.some((op) => op.k === "claim")
    const variants = hasClaim
      ? [{ sweep: true, subset: false }, { sweep: false, subset: false }, { sweep: true, subset: true }, { sweep: false, subset: true }]
      : [{ sweep: true, subset: false }]
    for (const [order, variant] of permutations(ops.map((_, index) => index)).flatMap((order) => variants.map((variant) => [order, variant] as const))) {
      const candidate = runner.model.clone()
      const outcomes: string[] = []
      const claimedByOp = new Map<number, number[]>()
      for (const index of order) {
        const returned = (actual[index]!.claimed ?? []).map((entry) => entry.slot)
        const result = applyToModel(candidate, ops[index]!, variant, returned)
        outcomes[index] = result.signature
        if (result.claimed) claimedByOp.set(index, result.claimed)
      }
      let explained = true
      for (const [index, signature] of outcomes.entries()) {
        if (signature === actual[index]!.signature) continue
        const modelClaimed = claimedByOp.get(index)
        const returned = (actual[index]!.claimed ?? []).map((entry) => entry.slot)
        const lostToCancel = driver.claimReadbackMayLoseToCancel === true && modelClaimed !== undefined && returned.every((slot) => modelClaimed.includes(slot))
          && modelClaimed.filter((slot) => !returned.includes(slot)).every((slot) => candidate.jobs[slot]?.status === "cancelled")
        if (!lostToCancel) explained = false
      }
      if (!explained) continue
      for (const index of claimedByOp.keys()) {
        for (const entry of actual[index]!.claimed ?? []) {
          const token = candidate.jobs[entry.slot]?.token
          if (token) { runner.realTokenBySym.set(token, entry.token); runner.symByRealToken.set(entry.token, token) }
        }
      }
      const problems = await runner.dumpProblems(candidate)
      if (problems.length === 0) { accepted = candidate; break }
      failures.push(`order [${order.join(",")}] explains the outcomes but not the table:\n    ${problems.slice(0, 4).join("\n    ")}`)
    }
    if (!accepted) {
      const described = ops.map((op, index) => `  #${index} ${JSON.stringify(op)} -> ${actual[index]!.signature}`).join("\n")
      throw new Error(`round ${round}: no serial order of the concurrent operations explains the observed outcomes and table\n${described}\n${failures.length > 0 ? failures.join("\n") : "  (no permutation reproduces the outcome signatures)"}`)
    }
    runner.model = accepted
  }
}

function generateLinearizabilityCase(light: boolean) {
  return (rng: Rng): LinearizabilityCase => ({ prefix: generateOps(rng, light ? { min: 6, max: 9, dense: true } : { min: 14, max: 30, dense: true }), batchSeed: rng.next(), rounds: light ? 1 : 2 })
}

function* shrinkLinearizabilityCase(value: LinearizabilityCase): Generator<LinearizabilityCase> {
  if (value.rounds > 1) yield { ...value, rounds: 1 }
  for (const prefix of shrinkOps(value.prefix)) yield { ...value, prefix }
}

export function defineConcurrentLinearizability(driver: JobStoreDifferentialDriver): void {
  it(`concurrent fenced transitions are linearizable (${driver.label})`, async () => {
    await forAllAsync(`job store concurrent transitions are linearizable (${driver.label})`, generateLinearizabilityCase(driver.light === true), (input) => runLinearizabilityCase(driver, input), {
      runs: driver.concurrencyRuns ?? 50, shrink: shrinkLinearizabilityCase, maxShrinkSteps: 80,
      describe: (value) => `batchSeed=${value.batchSeed} rounds=${value.rounds}\n${describeOps(value.prefix)}`,
    })
  }, PROPERTY_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Claim / transition storms

interface StormCase { seed: number; jobs: number; workers: number; rounds: number; limit: number; expireChance: number }

function generateStorm(light: boolean) {
  return (rng: Rng): StormCase => ({
    seed: rng.next(), jobs: light ? 3 + rng.int(2) : 4 + rng.int(8), workers: light ? 2 : 2 + rng.int(3), rounds: light ? 2 : 2 + rng.int(3),
    limit: 1 + rng.int(3), expireChance: rng.pick([0, 0.2, 0.5]),
  })
}

function* shrinkStorm(value: StormCase): Generator<StormCase> {
  if (value.rounds > 1) yield { ...value, rounds: value.rounds - 1 }
  if (value.workers > 2) yield { ...value, workers: value.workers - 1 }
  if (value.jobs > 2) yield { ...value, jobs: value.jobs - 1 }
  if (value.expireChance > 0) yield { ...value, expireChance: 0 }
  if (value.limit > 1) yield { ...value, limit: 1 }
}

const SYS = requesterOf("sys")

interface Held { jobId: string; worker: string; token: string; attempt: number }

async function runStorm(driver: JobStoreDifferentialDriver, input: StormCase): Promise<void> {
  await driver.reset()
  const { store } = driver
  const rng = createRng(input.seed)
  const now = new Date(T0 + 1_000)
  const ids: string[] = []
  const budgets = new Map<string, number | undefined>()
  const partitions = new Map<string, string | undefined>()
  for (let index = 0; index < input.jobs; index++) {
    const maxAttempts = rng.bool(0.6) ? 1 + rng.int(3) : undefined
    const partition = rng.bool(0.4) ? rng.pick(["p1", "p2"]) : undefined
    const job = await store.enqueue({
      requester: SYS,
      job: {
        executionScope: executionScopeOf("system"), jobType: "storm", jobVersion: 1, payload: { index }, runAt: new Date(T0 + index), priority: rng.int(3),
        ...(maxAttempts !== undefined ? { maxAttempts } : {}), ...(partition !== undefined ? { partitionKey: partition } : {}),
      },
    })
    ids.push(job.id); budgets.set(job.id, maxAttempts); partitions.set(job.id, partition)
  }
  const workers = Array.from({ length: input.workers }, (_, index) => `w${index + 1}`)
  const everHeld: Held[] = []
  const terminalAtStart = new Map<string, string>()
  const problems: string[] = []
  const complain = (message: string): void => { if (problems.length < 12) problems.push(message) }

  for (let round = 0; round < input.rounds; round++) {
    // Tokens issued in earlier rounds that are already superseded or spent must never apply again.
    const rowsBefore = new Map((await driver.dump()).map((row) => [row.id, row]))
    for (const row of rowsBefore.values()) if (["succeeded", "failed", "dead_letter", "cancelled"].includes(row.status)) terminalAtStart.set(row.id, `${row.status}|${row.lastError}`)
    const staleCandidates = everHeld.filter((held) => rowsBefore.get(held.jobId)?.claimToken !== held.token)

    const claims = await Promise.all(workers.map(async (worker) => ({ worker, jobs: await store.claimDue({ limit: input.limit, workerId: worker, leaseDurationMs: HOUR, requester: SYS, now }) })))
    const seen = new Map<string, string>()
    for (const { worker, jobs } of claims) {
      for (const job of jobs) {
        if (seen.has(job.id)) complain(`round ${round}: job ${job.id} claimed by both ${seen.get(job.id)} and ${worker}`)
        seen.set(job.id, worker)
        if (job.leaseOwner !== worker || !job.claimToken) complain(`round ${round}: claimed job ${job.id} not owned by ${worker}`)
        const budget = budgets.get(job.id)
        if (budget !== undefined && job.currentAttempt > budget) complain(`round ${round}: job ${job.id} claimed as attempt ${job.currentAttempt} beyond maxAttempts ${budget}`)
        if (everHeld.some((held) => held.token === job.claimToken)) complain(`round ${round}: claim token ${job.claimToken} reused`)
        everHeld.push({ jobId: job.id, worker, token: job.claimToken!, attempt: job.currentAttempt })
      }
    }
    // Partition serialization within one batch of concurrent claims.
    const byPartition = new Map<string, string[]>()
    for (const [jobId] of seen) { const partition = partitions.get(jobId); if (partition) byPartition.set(partition, [...(byPartition.get(partition) ?? []), jobId]) }
    for (const [partition, members] of byPartition) if (members.length > 1) complain(`round ${round}: partition ${partition} had ${members.length} jobs claimed concurrently`)

    // Fire a storm of transitions for the freshly claimed jobs, stale-token attempts, cancels and a competing claim.
    const held = claims.flatMap(({ worker, jobs }) => jobs.map((job) => ({ jobId: job.id, worker, token: job.claimToken!, attempt: job.currentAttempt })))
    const staleResults: { held: Held; applied: boolean }[] = []
    const actions: Promise<void>[] = []
    for (const entry of held) {
      const choice = rng.int(7)
      const base = { jobId: entry.jobId, workerId: entry.worker, claimToken: entry.token }
      if (choice === 0) actions.push(store.markSucceeded({ ...base, attempt: entry.attempt }).then(() => undefined))
      else if (choice === 1) actions.push(store.markRetrying({ ...base, attempt: entry.attempt, nextAttemptAt: new Date(T0), error: "storm retry" }).then(() => undefined))
      else if (choice === 2) actions.push(store.markFailed({ ...base, attempt: entry.attempt, error: "storm fail", status: "failed" }).then(() => undefined))
      else if (choice === 3) actions.push(store.release!({ ...base, nextAttemptAt: new Date(T0), reason: "storm release" }).then(() => undefined))
      else if (choice === 4) actions.push(store.cancel({ jobId: entry.jobId, requester: SYS, reason: "storm cancel" }).then(() => undefined))
      else if (choice === 5 && input.expireChance > 0 && rng.bool(input.expireChance)) actions.push(driver.expireLease(entry.jobId))
      // choice 6 / otherwise: the worker "crashes" and keeps its claim until the next round.
      if (rng.bool(0.5)) {
        // a second, racing transition with the same claim: at most one of the two may apply
        actions.push(store.markSucceeded({ ...base, attempt: entry.attempt }).then(() => undefined))
      }
    }
    for (const stale of staleCandidates.slice(0, 6)) {
      actions.push(store.markSucceeded({ jobId: stale.jobId, workerId: stale.worker, claimToken: stale.token, attempt: stale.attempt }).then((result) => { staleResults.push({ held: stale, applied: result.applied }) }))
    }
    actions.push(store.claimDue({ limit: input.limit, workerId: "racer", leaseDurationMs: HOUR, requester: SYS, now }).then((jobs) => {
      for (const job of jobs) {
        if (seen.has(job.id) && rowsBefore.get(job.id)?.status !== "pending") continue
        everHeld.push({ jobId: job.id, worker: "racer", token: job.claimToken!, attempt: job.currentAttempt })
      }
    }))
    await Promise.all(actions)
    for (const result of staleResults) if (result.applied) complain(`round ${round}: stale token ${result.held.token} of job ${result.held.jobId} applied`)

    const rows = await driver.dump()
    const live = new Map<string, number>()
    for (const row of rows) {
      const budget = budgets.get(row.id)
      if (budget !== undefined && row.attempts > budget) complain(`round ${round}: job ${row.id} attempts ${row.attempts} exceed maxAttempts ${budget}`)
      const start = terminalAtStart.get(row.id)
      if (start !== undefined && start !== `${row.status}|${row.lastError}`) complain(`round ${round}: terminal job ${row.id} changed from ${start} to ${row.status}|${row.lastError}`)
      const partition = partitions.get(row.id)
      if (partition && row.status === "running" && row.leaseExpiresAt !== null && row.leaseExpiresAt > Date.now()) live.set(partition, (live.get(partition) ?? 0) + 1)
    }
    for (const [partition, count] of live) if (count > 1) complain(`round ${round}: partition ${partition} has ${count} live running jobs`)
    if (problems.length > 0) throw new Error(problems.join("\n"))
  }

  // No lost jobs: a sequential drain must be able to complete everything that is not terminal.
  for (let step = 0; step < 60; step++) {
    const rows = await driver.dump()
    // Anything still running holds its (one hour) lease; the crashed workers never come back, so expire them.
    for (const row of rows) if (row.status === "running") await driver.expireLease(row.id)
    const claimed = await store.claimDue({ limit: 5, workerId: "drain", leaseDurationMs: HOUR, requester: SYS, now: new Date(T0 + 10 * HOUR) })
    if (claimed.length === 0) break
    for (const job of claimed) {
      const result = await store.markSucceeded({ jobId: job.id, workerId: "drain", claimToken: job.claimToken!, attempt: job.currentAttempt })
      if (!result.applied) complain(`drain: could not complete freshly claimed job ${job.id}`)
    }
  }
  const final = await driver.dump()
  for (const row of final) {
    if (!["succeeded", "failed", "dead_letter", "cancelled"].includes(row.status)) complain(`lost job ${row.id}: stuck ${row.status} after drain (attempts ${row.attempts}/${String(budgets.get(row.id))})`)
  }
  const executions = await driver.executionsFor(ids)
  const terminalRows = new Map<string, number>()
  for (const entry of executions) {
    if (["succeeded", "failed", "dead_letter"].includes(entry.status)) terminalRows.set(entry.jobId, (terminalRows.get(entry.jobId) ?? 0) + 1)
    const budget = budgets.get(entry.jobId)
    if (budget !== undefined && entry.attempt > budget) complain(`history row ${entry.id} records attempt ${entry.attempt} beyond maxAttempts ${budget}`)
  }
  for (const [jobId, count] of terminalRows) if (count > 1) complain(`job ${jobId} has ${count} terminal history rows (a claim resolved more than once)`)
  if (problems.length > 0) throw new Error(problems.join("\n"))
}

export function defineConcurrentStorm(driver: JobStoreDifferentialDriver): void {
  it(`claim and transition storms keep the lifecycle invariants (${driver.label})`, async () => {
    await forAllAsync(`job store concurrent claim and transition storm (${driver.label})`, generateStorm(driver.light === true), (input) => runStorm(driver, input), {
      runs: driver.concurrencyRuns ?? 50, shrink: shrinkStorm, maxShrinkSteps: 40,
    })
  }, PROPERTY_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------------------------------------------
// 3. The real dispatcher against the real store

type Script = "ok" | "retry-then-ok" | "permanent" | "always-retry" | "release-less"
interface DispatchCase { seed: number; jobs: { script: Script; partition?: string; maxAttempts: number }[]; dispatchers: number }

function generateDispatchCase(light: boolean) {
  return (rng: Rng): DispatchCase => ({
    seed: rng.next(), dispatchers: 1 + rng.int(light ? 2 : 3),
    jobs: Array.from({ length: 2 + rng.int(light ? 2 : 6) }, () => ({
      script: rng.pick(["ok", "ok", "retry-then-ok", "permanent", "always-retry"] as const),
      ...(rng.bool(0.35) ? { partition: rng.pick(["pa", "pb"]) } : {}),
      maxAttempts: rng.pick([2, 3]),
    })),
  })
}

function* shrinkDispatchCase(value: DispatchCase): Generator<DispatchCase> {
  if (value.dispatchers > 1) yield { ...value, dispatchers: value.dispatchers - 1 }
  for (let index = 0; index < value.jobs.length && value.jobs.length > 1; index++) yield { ...value, jobs: value.jobs.filter((_, position) => position !== index) }
}

async function runDispatchCase(driver: JobStoreDifferentialDriver, input: DispatchCase): Promise<void> {
  await driver.reset()
  const { store } = driver
  const inFlight = new Set<string>()
  const partitionBusy = new Map<string, string>()
  const attemptsSeen = new Map<string, number[]>()
  const problems: string[] = []
  const complain = (message: string): void => { if (problems.length < 12) problems.push(message) }
  const definition: JobDefinition = {
    type: "scripted", version: 1, scope: "system", maxAttempts: 3, retryDelayMs: 0, retryBackoffMultiplier: 1,
    decodePayload: (input) => input as Record<string, unknown>,
    execute: async (ctx) => {
      const payload = ctx.payload as { script: Script; partition?: string; index: number; maxAttempts: number }
      const key = `${payload.index}`
      if (inFlight.has(key)) complain(`job ${key} executed concurrently with itself`)
      inFlight.add(key)
      if (payload.partition) {
        const other = partitionBusy.get(payload.partition)
        if (other !== undefined) complain(`partition ${payload.partition}: jobs ${other} and ${key} executed at the same time`)
        partitionBusy.set(payload.partition, key)
      }
      attemptsSeen.set(key, [...(attemptsSeen.get(key) ?? []), ctx.attempt])
      await new Promise<void>((resolve) => { setTimeout(resolve, 3 + (payload.index % 3)) })
      inFlight.delete(key)
      if (payload.partition) partitionBusy.delete(payload.partition)
      switch (payload.script) {
        case "ok": return { success: true }
        case "retry-then-ok": return ctx.attempt === 1 ? { success: false, error: Object.assign(new Error("flaky"), { kind: "retryable" as const }) } : { success: true }
        case "permanent": return { success: false, error: Object.assign(new Error("never"), { kind: "permanent" as const }) }
        default: return { success: false, error: Object.assign(new Error("still failing"), { kind: "retryable" as const }) }
      }
    },
  }
  const registry = createJobRegistry()
  registry.register(definition)
  const ids: string[] = []
  for (const [index, spec] of input.jobs.entries()) {
    const job = await store.enqueue({
      requester: SYS,
      job: {
        executionScope: executionScopeOf("system"), jobType: "scripted", jobVersion: 1, runAt: new Date(Date.now() - 5_000 + index), maxAttempts: spec.maxAttempts,
        payload: { script: spec.script, index, maxAttempts: spec.maxAttempts, ...(spec.partition ? { partition: spec.partition } : {}) },
        ...(spec.partition ? { partitionKey: spec.partition } : {}),
      },
    })
    ids.push(job.id)
  }
  const rounds = 12
  for (let round = 0; round < rounds; round++) {
    await Promise.all(Array.from({ length: input.dispatchers }, (_, index) => dispatchDueJobs({ store, registry, workerId: `dispatcher-${index}`, leaseDurationMs: 60_000, claimLimit: 2, requester: SYS })))
    const rows = await driver.dump()
    if (rows.every((row) => ["succeeded", "failed", "dead_letter", "cancelled"].includes(row.status))) break
  }
  const rows = new Map((await driver.dump()).map((row) => [row.id, row]))
  for (const [index, spec] of input.jobs.entries()) {
    const row: RawJobRow | undefined = rows.get(ids[index]!)
    const seen = attemptsSeen.get(`${index}`) ?? []
    if (!row) { complain(`job ${index} vanished`); continue }
    if (seen.some((attempt, position) => attempt !== position + 1)) complain(`job ${index} (${spec.script}) ran attempts ${seen.join(",")}: not consecutive from 1`)
    if (seen.length > spec.maxAttempts) complain(`job ${index} ran ${seen.length} times beyond maxAttempts ${spec.maxAttempts}`)
    const succeeds = spec.script === "ok" || spec.script === "retry-then-ok"
    const acceptable = succeeds ? ["succeeded"] : ["failed", "dead_letter"]
    if (!acceptable.includes(row.status)) complain(`job ${index} (${spec.script}, max ${spec.maxAttempts}) ended ${row.status}, expected ${acceptable.join(" or ")} after attempts ${seen.join(",")}`)
    if (spec.script === "always-retry" && seen.length !== spec.maxAttempts) complain(`job ${index} (always-retry) ran ${seen.length} time(s), expected exactly its budget ${spec.maxAttempts}`)
    if (row.attempts !== seen.length) complain(`job ${index}: stored attempts ${row.attempts} but the handler ran ${seen.length} time(s)`)
  }
  if (problems.length > 0) throw new Error(problems.join("\n"))
  expect(problems).toEqual([])
}

export function defineDispatcherAgainstStore(driver: JobStoreDifferentialDriver): void {
  it(`the core dispatcher keeps its invariants on the real store (${driver.label})`, async () => {
    await forAllAsync(`core job dispatcher against the real job store (${driver.label})`, generateDispatchCase(driver.light === true), (input) => runDispatchCase(driver, input), {
      runs: driver.dispatcherRuns ?? 50, shrink: shrinkDispatchCase, maxShrinkSteps: 40,
    })
  }, PROPERTY_TIMEOUT_MS)
}
