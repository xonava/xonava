---
"@xonava/adapters": patch
---

The MySQL repository now refuses every predicate that matches all rows in `deleteWhere`, `updateManyWhere`, `updateOneWhere` and `findOneWhere`, as the PostgreSQL and D1 repositories already did. It previously recognised only a literal `true` predicate, so `Predicate.alwaysTrue()` (an empty `and`), `Predicate.not(Predicate.alwaysFalse())` or an `or` containing an always-true branch ran as `WHERE (1 = 1)` and updated or deleted every row.
