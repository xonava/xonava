---
"@xonava/core": patch
---

`applyAuthorizationPlanToResult` keeps a list result's `rowCount` as the operation returned it instead of replacing it with the number of rows on the page. Field projection masks or omits fields but never drops rows, and `pageInfo` (including an offset page's `rowCount`) already passed through unchanged, so a requested total now reaches the caller consistently.
