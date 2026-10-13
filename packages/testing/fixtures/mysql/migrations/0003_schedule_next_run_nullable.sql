-- schedules.next_run_at becomes nullable (docs/spec/execution.md: advancing a schedule with no next occurrence retires it).
-- AdvanceScheduleArgs.nextRunAt is `Date | null` (a cron with no future occurrence); with NOT NULL the advance failed with
-- ER_BAD_NULL_ERROR and the dispatcher retried the schedule forever instead of retiring it. A retired schedule keeps next_run_at
-- NULL, so the due predicate (next_run_at<=?) never matches it again. MODIFY restates the column and is safe to re-apply.
ALTER TABLE schedules MODIFY next_run_at DATETIME(3) NULL;
