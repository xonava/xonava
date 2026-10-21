---
"@xonava/adapters": minor
---

Add `PgAtomicLeaseBackend` / `createPgLeaseStore` and `D1AtomicLeaseBackend` / `createD1LeaseStore`, concrete fenced-lease backends with database-clock lease time and configurable table names (new `lease_records` table, fixture migration `0004_lease_records.sql`).
