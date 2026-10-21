---
"@xonava/adapters": patch
---

A request with no trusted session (`resolveTrustedSession` returned `undefined`) on an authenticated route without an anonymous principal now answers 401 UNAUTHORIZED instead of 500.
