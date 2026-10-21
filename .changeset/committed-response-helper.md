---
"@xonava/adapters": minor
---

Add `readCommittedRecord()` to `@xonava/adapters/http`: re-reads a row a custom write handler just committed under the caller's read scope, field-read overrides and projection, and reports `record`, `outside-read-scope`, `revision-unavailable` or `deleted`. Built-in create and update (and their idempotent recovery) now use the same code path.
