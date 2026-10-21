---
"@xonava/core": minor
---

`createAbacBundle` now returns `VerifiedAbacPolicyBundle` (no `assertVerifiedAbacBundle` needed), `InvalidPolicyConfigurationError` carries `missingFields`, and the new `assertAbacPoliciesMatchCatalog` pre-flight reports policy/catalog mismatches (unknown action, condition field, fieldAccess read/write/query field) before any request is served.
