import type { Rng } from "./harness"
import type { Behavior, ErrKind, JobScenario, JobSpec, JobTypeName, PayloadKind, SimOp, WorkerSpec } from "./jobModel"

/**
 * Generators for the job dispatcher model. Durations are expressed relative to the lease so that the
 * interesting boundaries (heartbeat, lease expiry, timeout, cancellation grace) are hit constantly.
 */

const ERR_KINDS: readonly ErrKind[] = [
  "error", "retryable", "permanent", "cancelled", "string", "null", "undefined", "number", "kindPermanent", "kindCancelled", "kindBogus", "noError",
]

function duration(rng: Rng, lease: number): number {
  return rng.pick([0, 0, 0, Math.floor(lease / 10), Math.floor(lease / 10), Math.floor(lease / 2), Math.floor(lease * 0.9), lease, Math.floor(lease * 1.5), lease * 3, lease * 12])
}

function behavior(rng: Rng, lease: number): Behavior {
  const roll = rng.int(100)
  if (roll < 52) return rng.bool(0.06) ? { k: "ok", ms: duration(rng, lease), data: rng.pick(["bigint", "circular"] as const) } : { k: "ok", ms: duration(rng, lease) }
  if (roll < 78) {
    const err = rng.pick(ERR_KINDS)
    const via = err === "noError" || rng.bool() ? "result" : "throw"
    return { k: "fail", ms: duration(rng, lease), via, err, ...(rng.bool(0.1) && (err === "error" || err === "retryable" || err === "permanent") ? { huge: true } : {}) }
  }
  if (roll < 83) return rng.bool() ? { k: "syncThrow", err: rng.pick(ERR_KINDS) } : { k: "badResult", shape: rng.pick(["undefined", "empty", "null"] as const) }
  if (roll < 88) {
    const err = rng.pick(ERR_KINDS)
    return { k: "coop", cleanupMs: rng.pick([0, 1, Math.floor(lease / 4), lease * 3]), via: err === "noError" || rng.bool() ? "result" : "throw", err }
  }
  return { k: "effect", pre: duration(rng, lease), post: duration(rng, lease) }
}

function jobSpec(rng: Rng, lease: number): JobSpec {
  const type = rng.pick<JobTypeName>(["A", "A", "A", "A", "B", "C", "C", "T", "W", "W", "G"])
  const version = type === "W" ? rng.pick([1, 2]) : type === "G" ? rng.pick([1, 3]) : 1
  const scope = type === "T" ? (rng.bool(0.9) ? "tenant" : "system") : rng.bool(0.96) ? "system" : "tenant"
  const payload = rng.pick<PayloadKind>(["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "notJson", "array", "reject"])
  const script = Array.from({ length: 1 + rng.int(4) }, () => behavior(rng, lease))
  const spec: JobSpec = { type, version, scope, runAfterMs: rng.bool(0.6) ? 0 : rng.pick([1, Math.floor(lease / 2), lease * 2]), priority: rng.int(3), payload, script }
  if (rng.bool(0.4)) spec.maxAttempts = 1 + rng.int(4)
  return spec
}

function workerSpec(rng: Rng, lease: number, full: boolean): WorkerSpec {
  const has = full
    ? { A: true, B: true, C: true, T: true }
    : { A: rng.bool(0.8), B: rng.bool(0.8), C: rng.bool(0.8), T: rng.bool(0.8) }
  const skewed = rng.bool(0.3)
  return {
    has,
    w: full ? "both" : rng.pick(["none", "v1", "v2", "both", "both"] as const),
    upcaster: full || rng.bool(),
    skew: skewed ? rng.int(Math.floor((2 * lease) / 3) + 1) - Math.floor(lease / 3) : 0,
  }
}

export function generateJobScenario(rng: Rng): JobScenario {
  const lease = rng.pick([60, 100, 150, 300])
  const workerCount = 1 + rng.int(3)
  const workers = Array.from({ length: workerCount }, (_, index) => workerSpec(rng, lease, index === 0 && rng.bool(0.4)))
  const jobs = Array.from({ length: 1 + rng.int(6) }, () => jobSpec(rng, lease))
  const ops: SimOp[] = []
  const length = 10 + rng.int(28)
  for (let index = 0; index < length; index++) {
    const roll = rng.int(100)
    if (roll < 42) ops.push({ k: "tick", w: rng.int(workerCount) })
    else if (roll < 80) ops.push({ k: "advance", ms: rng.pick([1, Math.floor(lease / 10), Math.floor(lease / 3), Math.floor(lease / 2), lease, lease * 2, lease * 3]) })
    else if (roll < 84) ops.push({ k: "jump", ms: rng.pick([lease * 2, lease * 5, lease * 50]) })
    else if (roll < 89) ops.push({ k: "crash", w: rng.int(workerCount) })
    else if (roll < 95) ops.push({ k: "skew", w: rng.int(workerCount), skew: rng.int(Math.floor((2 * lease) / 3) + 1) - Math.floor(lease / 3) })
    else if (roll < 97) ops.push({ k: "cancel", job: rng.int(jobs.length) })
    else ops.push({ k: "tick", w: rng.int(workerCount) })
  }
  jobs.forEach((_, job) => {
    // Enqueue early enough that most jobs see several dispatch rounds.
    ops.splice(rng.int(Math.max(1, Math.floor((ops.length * 2) / 3)) + 1), 0, { k: "enqueue", job })
  })
  const timeoutPolicy = rng.bool(0.25)
    ? { graceMs: rng.pick([0, Math.floor(lease / 4), lease, lease * 2]), ...(rng.bool() ? { timeoutMs: rng.pick([Math.floor(lease / 4), lease, lease * 2]) } : {}) }
    : null
  return {
    seed: rng.next(), leaseMs: lease, claimLimit: 1 + rng.int(4), capMs: rng.pick([0, lease, lease * 3, lease * 10]),
    hasRelease: rng.bool(0.9), timeoutPolicy, maxLatencyMs: rng.pick([0, 0, 2, Math.floor(lease / 20), Math.floor(lease * 0.6)]),
    faultPerMille: rng.pick([0, 0, 0, 30, 100]), workers, jobs, ops,
  }
}

/** A scenario without fault injection and with a single, healthy, fully-equipped worker. */
export function generateCalmJobScenario(rng: Rng): JobScenario {
  const base = generateJobScenario(rng)
  return {
    ...base, faultPerMille: 0, maxLatencyMs: 0, hasRelease: true,
    workers: [{ has: { A: true, B: true, C: true, T: true }, w: "both", upcaster: true, skew: 0 }],
    ops: base.ops.filter((op) => op.k !== "crash" && op.k !== "skew" && op.k !== "jump"),
  }
}

export function* shrinkJobScenario(value: JobScenario): Generator<JobScenario> {
  if (value.faultPerMille > 0) yield { ...value, faultPerMille: 0 }
  if (value.maxLatencyMs > 0) yield { ...value, maxLatencyMs: 0 }
  if (value.timeoutPolicy) yield { ...value, timeoutPolicy: null }
  if (value.workers.some((worker) => worker.skew !== 0)) yield { ...value, workers: value.workers.map((worker) => ({ ...worker, skew: 0 })) }
  if (value.ops.length > 2) {
    yield { ...value, ops: value.ops.slice(0, Math.ceil(value.ops.length / 2)) }
    yield { ...value, ops: value.ops.slice(Math.floor(value.ops.length / 2)) }
  }
  for (let index = 0; index < value.ops.length; index++) yield { ...value, ops: value.ops.filter((_, position) => position !== index) }
  if (value.workers.length > 1) yield { ...value, workers: value.workers.slice(0, -1) }
  for (let index = 0; index < value.jobs.length; index++) {
    const job = value.jobs[index]!
    if (job.script.length > 1) yield { ...value, jobs: value.jobs.map((candidate, position) => (position === index ? { ...candidate, script: [candidate.script[0]!] } : candidate)) }
  }
}

export function describeJobScenario(value: JobScenario): string {
  return JSON.stringify(value)
}
