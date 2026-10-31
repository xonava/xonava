-- Buffered workflow signals (docs/spec/workflow.md, "Signals").
-- workflow_signals gains a monotonic delivery order (seq, assigned at insert) and consumption bookkeeping; workflows
-- records the receipt that resumed the current step. Receipts stored before this migration were already acted on (or
-- ignored) by the old store, so they are backfilled as consumed at their delivery time, in delivery order; otherwise
-- they would become pending and wake future waits. Apply exactly once (MySQL has no ADD COLUMN IF NOT EXISTS).
ALTER TABLE workflows ADD COLUMN resume_signal_id VARCHAR(100) NULL;
ALTER TABLE workflow_signals ADD COLUMN seq BIGINT NULL, ADD COLUMN consumed_at DATETIME(3) NULL, ADD COLUMN consumed_revision BIGINT NULL;
UPDATE workflow_signals AS s JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY delivered_at, id) AS n FROM workflow_signals) AS o ON o.id = s.id SET s.seq = o.n, s.consumed_at = s.delivered_at;
ALTER TABLE workflow_signals MODIFY seq BIGINT NOT NULL AUTO_INCREMENT, ADD UNIQUE KEY workflow_signals_seq_uq (seq), ADD KEY workflow_signals_pending_idx (instance_id, name, consumed_at, seq);
