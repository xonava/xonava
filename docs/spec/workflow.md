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
| deadline exceeded after the step started, step stopped within the grace period | retry only if `idempotent: true`, else fail (`TIMEOUT`) | retry under policy |
| deadline exceeded before the step was started (slow lease renewal or signal read) | retry under policy (the step cannot have had an external effect, so `idempotent` is irrelevant) | same |
| deadline exceeded, step ignored cancellation | nothing is committed (`stalled`); the lease lapses and the next claim counts the attempt | same |
| attempt counter already above `maxAttempts` at claim | fail without running (`ATTEMPTS_EXHAUSTED`) | `compensation_failed` |
| definition version unknown to this worker | hand back without consuming an attempt (`deferred`) | same |

A `next` result's `compensation` of `null`, `undefined`, or `""` means no compensation step; any other non-string value is malformed (`INVALID_STEP_RESULT`).

A failed execution step enters `compensating` when the compensation stack is non-empty, otherwise `failed`. Compensation runs the stack in reverse order; a compensation step that exhausts its policy stops the instance in the terminal state `compensation_failed`, keeping the remaining stack for manual intervention. A dispatcher MUST NOT record a failure (and so start compensation) while a timed-out step may still be running.

**Failure record.** The instance carries `failure: { code, message, step, phase, attempt, at }` for the most recent terminal or compensating failure. Messages are sanitized (contact details and dates redacted), limited to 512 characters, and never include stack traces. The record is diagnostic state of the current outcome, not history: a forward step result (`next`, `wait`, `sleep`, `complete`) is a successful attempt and clears it (`failure` becomes null), including the `TIMEOUT` record of an earlier stalled attempt once the resumed step succeeds. A `retry` result, a retry timer, and compensation transitions keep it; `failed`, `cancelled`, and `compensation_failed` instances keep their terminal record. Cancellation records code `CANCELLED`; a cancelled instance that finishes compensation ends `cancelled`, not `failed`.

**Concurrency.** A dispatcher MAY run up to `concurrency` claims of one batch at a time (default 1, at most the claim limit). Each claim keeps its own lease lifecycle.

## Signals (normative)

**Receipts.** A signal receipt (`id`, `instanceId`, `name`, `payload`, `deliveredAt`) is durable. It is *pending* until it is *consumed*, and a receipt is consumed AT MOST ONCE. The store assigns every stored receipt a monotonic delivery order (a sequence number, not a timestamp: two receipts never tie); "oldest" always means smallest delivery order. Receipts are never deleted by consumption, so the history stays auditable.

**Delivery.** `deliverSignal(signal)` is atomic and:

1. is idempotent by signal id: an id that is already stored (for any instance) returns `{ delivered: false, duplicate: true }` and has no effect;
2. for an unknown instance, or one in a terminal state (`succeeded`, `failed`, `cancelled`, `compensation_failed`), returns `{ delivered: false, duplicate: false }` and stores nothing;
3. otherwise stores the receipt as pending and returns `{ delivered: true, duplicate: false }`. If the instance is waiting for that name (status `waiting`, no `wakeAt`, `waitingSignal` equal to the name; a sleep or a retry backoff is not a signal wait), the same transaction consumes the OLDEST pending receipt of that name, makes the instance `pending` with `stepAttempt` 0 and `revision + 1` (`deliverWorkflowSignal`), keeps `waitingSignal` and records the consumed receipt in `resumeSignalId`. In every other state (including `compensating`, or a step that is currently running) the receipt only stays pending: nothing else about the instance changes, not even its revision, so a running claim is not invalidated.

**Buffering at `wait`.** When a step returns `wait(name)`, the commit of that transition is a *signal wait* (`isWorkflowSignalWait`: status `waiting`, `wakeAt` null, `waitingSignal` set). If a pending receipt with that name exists, the same atomic commit consumes the OLDEST one and stores the resumed instance instead (`resumeWorkflowFromBufferedSignal`: `pending`, `stepAttempt` 0, `waitingSignal` kept, `resumeSignalId` set, lease released) with the usual single `revision + 1` of a commit. Otherwise it stores the waiting instance. This commit is fenced like every transition (worker, token, revision, unexpired lease); a commit rejected by the fence consumes nothing. (Stores that check the lease separately per statement, such as the D1 batch, which reads the clock once per statement, must undo a consumption whose commit the fence then rejected.) Because delivery and commit both serialize on the instance row, a delivery that races the commit is either stored first (and consumed by the commit) or second (and consumed by the delivery, which then sees the waiting instance): a signal is never lost and never consumed twice. Invariant: an instance that is waiting for a signal name has no pending receipt with that name.

**Order.** Receipts of one name are consumed in delivery order across successive waits; consumed receipts of one (instance, name) are always a prefix of that name's delivery order. Receipts of other names stay pending until some wait for that name consumes them. An early signal satisfies exactly one later `wait`; a second wait for the same name needs a second signal.

**Resumed step.** `resumeSignalId` is set by consumption and cleared by the next forward (`next`, `wait`, `sleep`, `complete`), failure, or cancellation transition; `retry`, retry timers, stalled attempts, handed-back (released or deferred) claims keep it, so every attempt of the resumed step receives the same receipt. The dispatcher passes exactly the receipt named by `resumeSignalId` (payload deep-frozen) to the step as `context.signal`, read through `getSignalById`. It never substitutes a later receipt of the same name. A store without `getSignalById`, or an instance without `resumeSignalId` (resumed before the field existed), falls back to `getSignal(instanceId, name)`, the latest receipt by name regardless of consumption; such a store does not provide the exactness guarantee. A lookup that returns a receipt with a different id, instance, or name is ignored.

**Terminal and cancelled instances.** Pending receipts of an instance that becomes terminal or is cancelled are retained and never consumed. Receipts delivered while an instance is `compensating` are buffered like any other and are likewise never consumed, because compensation never waits.

**Crash and lease loss.** Consumption is part of a durable transition, so a crash leaves either the unconsumed receipt (pending) or the consumed receipt with the resumed instance, never one without the other. A worker that lost its lease between a delivery and its commit cannot commit and so consumes nothing; whoever re-runs the step and commits its `wait` consumes the buffered receipt then.

**Store surface.** `WorkflowInstance.resumeSignalId?: string | null` (stores without the column omit it); `WorkflowStore.getSignalById?(instanceId, signalId)`; `WorkflowStore.getSignal?(instanceId, name)` is retained for compatibility and returns the latest receipt by name, pending or consumed. Pure state helpers in core that stores mirror: `deliverWorkflowSignal`, `resumeWorkflowFromBufferedSignal`, `isWorkflowSignalWait`, `isWaitingForWorkflowSignal`, `oldestPendingWorkflowSignal`.
