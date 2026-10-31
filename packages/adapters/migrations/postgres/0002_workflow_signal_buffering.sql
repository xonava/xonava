-- Buffered workflow signals (docs/spec/workflow.md, "Signals").
-- workflow_signals gains a monotonic delivery order (seq) and consumption bookkeeping; workflows records the receipt that
-- resumed the current step. Receipts stored before this migration were already acted on (or ignored) by the old
-- store, so they are backfilled as consumed at their delivery time, in delivery order; otherwise they would become
-- pending and wake future waits. The guard makes the file safe to re-run: it only changes a table that lacks seq.
ALTER TABLE framework_test.workflows ADD COLUMN IF NOT EXISTS resume_signal_id text;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'framework_test' AND table_name = 'workflow_signals' AND column_name = 'seq') THEN
    ALTER TABLE framework_test.workflow_signals ADD COLUMN seq bigint, ADD COLUMN consumed_at timestamptz, ADD COLUMN consumed_revision bigint;
    UPDATE framework_test.workflow_signals AS s SET seq = o.n, consumed_at = s.delivered_at
      FROM (SELECT id, row_number() OVER (ORDER BY delivered_at, id) AS n FROM framework_test.workflow_signals) AS o WHERE o.id = s.id;
    ALTER TABLE framework_test.workflow_signals ALTER COLUMN seq SET NOT NULL;
    ALTER TABLE framework_test.workflow_signals ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE framework_test.workflow_signals ADD CONSTRAINT workflow_signals_seq_uq UNIQUE (seq);
    PERFORM setval(pg_get_serial_sequence('framework_test.workflow_signals', 'seq'), COALESCE((SELECT max(seq) FROM framework_test.workflow_signals), 1), (SELECT count(*) > 0 FROM framework_test.workflow_signals));
  END IF;
END
$migration$;
CREATE INDEX IF NOT EXISTS workflow_signals_pending_idx ON framework_test.workflow_signals (instance_id, name, seq) WHERE consumed_at IS NULL;
