---
"@xonava/adapters": patch
---

A valid session for another scope on a route with a fixed scope (for example a tenant user calling a platform route) is now refused with 403 `ForbiddenError` instead of a 500 configuration error, so callers can no longer trigger server errors on such routes.
