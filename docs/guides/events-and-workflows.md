# Use events, jobs, and workflows

Define stable event/job/workflow names and versions, register them before readiness, and persist durable payloads only through registered codecs. Append outbox events in the business transaction. Consumers use inbox identity and fenced claims. Jobs use bounded retry and fenced progress. Workflows use versioned definitions, durable timers/signals, idempotent signal receipts, and explicit compensation. Test duplicate delivery, claim races, lease expiry, crash/restart, and version migration; do not assume exactly-once external side effects.
