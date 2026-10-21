---
"@xonava/adapters": patch
---

Built-in CRUD create and update now read the response row through the operation's own transaction, so PostgreSQL and MySQL return the created or updated row instead of a bare CREATED_OUTSIDE_READ_SCOPE / UPDATED_OUTSIDE_READ_SCOPE acknowledgement.
