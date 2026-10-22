---
"@xonava/core": minor
"@xonava/adapters": patch
---

**Breaking:** job checkpoints whose strings or keys contain U+0000 are now refused with a `ConfigurationError` on every database, because PostgreSQL `jsonb` cannot store them; canonical-JSON refusals such as integers beyond the safe range are reported as `ConfigurationError` too. Fenced lease `acquire` and `renew` now reject their promise on invalid input instead of throwing synchronously.
