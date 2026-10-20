---
"@xonava/adapters": patch
---

CRUD list handlers accept an opt-in `cursorTtlMs`; their cursors then carry an integrity-protected expiry and an expired cursor is refused with the stale-cursor 400.
