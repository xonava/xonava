-- Buffered workflow signals (docs/spec/workflow.md, "Signals"). One statement per line (D1 exec). Apply exactly once.
-- seq is the monotonic delivery order, assigned by the store at insert as MAX(seq)+1 inside the delivery batch. Receipts stored before this migration were already acted on (or ignored) by the old store, so they are backfilled as consumed at their delivery time, in delivery order (delivered_at_ms, rowid); otherwise they would become pending and wake future waits.
ALTER TABLE framework_workflows ADD COLUMN resume_signal_id TEXT;
ALTER TABLE framework_workflow_signals ADD COLUMN seq INTEGER;
ALTER TABLE framework_workflow_signals ADD COLUMN consumed_at_ms INTEGER;
ALTER TABLE framework_workflow_signals ADD COLUMN consumed_revision INTEGER;
UPDATE framework_workflow_signals SET seq = o.n, consumed_at_ms = framework_workflow_signals.delivered_at_ms FROM (SELECT rowid AS r, ROW_NUMBER() OVER (ORDER BY delivered_at_ms, rowid) AS n FROM framework_workflow_signals) AS o WHERE framework_workflow_signals.rowid = o.r;
CREATE UNIQUE INDEX IF NOT EXISTS framework_workflow_signals_seq_uq ON framework_workflow_signals (seq);
CREATE INDEX IF NOT EXISTS framework_workflow_signals_pending_idx ON framework_workflow_signals (instance_id, name, seq) WHERE consumed_at_ms IS NULL;
