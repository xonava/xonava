---
"@xonava/adapters": minor
---

Job and schedule stores now round-trip the exact `platformKey` / `systemKey` of platform and system execution scopes instead of returning `default` / `framework`. A migration is needed: apply `0005_job_scope_key.sql` (adds a nullable `scope_key` column to `jobs` and `schedules`; MySQL also redefines the active-partition generated column), and map `scopeKey` in the PostgreSQL and D1 column maps. Jobs of different keys no longer share a partition head, and rows without a key still decode to the defaults.
