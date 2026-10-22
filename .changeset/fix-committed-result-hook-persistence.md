---
"@xonava/adapters": patch
---

`projectCommittedResult` hooks now read through the writing transaction, so they see the row just written on PostgreSQL and MySQL.
