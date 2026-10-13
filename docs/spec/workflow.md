# Workflows

## Scope and data model

A workflow declares a versioned state machine, inputs, transitions, activities, timers, signals, compensation, and store requirements. Only valid transitions MAY commit. Durable transitions MUST be atomic with their declared state/effects.

Instance identity, definition/version, current state, revision, scoped data, pending timers/activities, signal receipts, and claim/fencing state are durable. Each transition conditions on current revision/claim so concurrent stale workers cannot overwrite state.

## Runtime requirements

Claims MUST be fenced. A worker MUST renew its claim immediately before invoking activity or compensation code, renew it periodically while work is active, and re-fence before commit. Renewals for one claim MUST be serialized and monotonically extend expiry. Every durable transition MUST condition on the same worker/token/revision fence and an unexpired lease. The dispatcher MUST bound step execution, propagate cooperative cancellation and an absolute deadline, stop and await its renewal lifecycle, and reject oversized claim batches. Signals MUST be idempotent where retry is possible. Timers MUST survive process restart. Compensation order/outcomes MUST be explicit. Version migration MUST be deterministic and reject unsupported state versions.

Activities may be retried only under declared idempotency/retry semantics. A workflow cannot assume exactly-once external side effects: activity implementations remain responsible for idempotency or a transactionally coupled effect mechanism. Steps MUST observe cancellation and revalidate the current lease immediately before external activity. Lease fencing does not turn an external side effect into an exactly-once operation, and a runtime cannot forcibly stop a step that ignores cooperative cancellation. Compensation is a durable transition sequence, not rollback of already committed external work. Migration runs before new-version transition logic and preserves auditability.

## Errors and conformance

Invalid transition/input/signal is validation or conflict as defined; stale claim/revision conflict; unsupported version configuration; activity failure follows retry/compensation policy. Conformance covers transition tables, concurrent signals, duplicate signal receipts, timer recovery, stale fencing, activity retry, compensation ordering/failure, migration, and crash at every durable boundary.

Traceability: `packages/core/src/workflow`; workflow unit and provider integration suites; W1 certification.

## Attempts, retry, and failure (normative)

**Attempt counting.** `stepAttempt` is the number of attempts started for the current step or compensation step. A store MUST increment it atomically when it claims an instance, so crashed, hung, and timed-out attempts are counted. Moving to a new step, entering compensation, finishing a compensation step, and cancellation reset it to 0.

**Retry policy.** Each step MAY declare `retry` and `compensationRetry` using the shared serializable backoff policy (`maxAttempts`, `initialDelayMs`, `backoffMultiplier`, `maxDelayMs`, `jitter: "none" | "equal"`; see resilience). The default is 3 attempts, 1 s initial delay, ×2, capped at 60 s, equal jitter. A retry is a durable timer (`wakeAt`); workers are never held while waiting.

**Classification.**

| Event | Execution step | Compensation step |
|---|---|---|
| `retry` result | retry under policy, then `RETRY_EXHAUSTED` | n/a |
| `fail` result | fail immediately (`STEP_FAILED`) | `compensation_failed` |
| error with `retryable: true` or `kind: "retryable"` | retry under policy | retry under policy |
| any other error | fail immediately (error code) | retry under policy |
| deadline exceeded, step stopped within the grace period | retry only if `idempotent: true`, else fail (`TIMEOUT`) | retry under policy |
| deadline exceeded, step ignored cancellation | nothing is committed (`stalled`); the lease lapses and the next claim counts the attempt | same |
| attempt counter already above `maxAttempts` at claim | fail without running (`ATTEMPTS_EXHAUSTED`) | `compensation_failed` |
| definition version unknown to this worker | hand back without consuming an attempt (`deferred`) | same |

A failed execution step enters `compensating` when the compensation stack is non-empty, otherwise `failed`. Compensation runs the stack in reverse order; a compensation step that exhausts its policy stops the instance in the terminal state `compensation_failed`, keeping the remaining stack for manual intervention. A dispatcher MUST NOT record a failure (and so start compensation) while a timed-out step may still be running.

**Failure record.** The instance carries `failure: { code, message, step, phase, attempt, at }` for the most recent terminal or compensating failure. Messages are sanitized (contact details and dates redacted), limited to 512 characters, and never include stack traces. The record is diagnostic state of the current outcome, not history: a forward step result (`next`, `wait`, `sleep`, `complete`) is a successful attempt and clears it (`failure` becomes null), including the `TIMEOUT` record of an earlier stalled attempt once the resumed step succeeds. A `retry` result, a retry timer, and compensation transitions keep it; `failed`, `cancelled`, and `compensation_failed` instances keep their terminal record. Cancellation records code `CANCELLED`; a cancelled instance that finishes compensation ends `cancelled`, not `failed`.

**Signals.** Delivering a signal moves the instance from `waiting` to `pending` and keeps the signal name recorded until the step's next transition. Stores that implement `getSignal` let the dispatcher pass the delivered signal (payload deep-frozen) to the resumed step as `context.signal`.

**Concurrency.** A dispatcher MAY run up to `concurrency` claims of one batch at a time (default 1, at most the claim limit). Each claim keeps its own lease lifecycle.
