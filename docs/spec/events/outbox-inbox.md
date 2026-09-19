# Outbox and inbox

An outbox record is written atomically with its originating state change. Claim ownership uses a lease and fencing token; only the current unexpired claimant can acknowledge delivery or reschedule. Redelivery is at-least-once and consumers must tolerate duplicates.

An inbox key binds consumer, message and execution scope. Claim, completion, retry and dead-letter transitions are conditional on current claim identity. Replaying an identical message is harmless; conflicting identity or fingerprint data is rejected.
