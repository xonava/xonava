---
"@xonava/adapters": patch
---

MySQL cache tag generations: the reference `cache_generations.scope` column is now `VARCHAR(256)` (it was `VARCHAR(100)`), so tags of up to the 256-byte maximum no longer fail every advance with "Data too long". Existing tables get the new width from `0006_byte_exact_identifiers.sql`.
