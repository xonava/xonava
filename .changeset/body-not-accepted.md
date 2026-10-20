---
"@xonava/adapters": patch
---

A request body sent to an operation that accepts none is refused with 415 `BODY_NOT_ACCEPTED` ("This operation does not accept a request body") instead of a misleading `UNSUPPORTED_MEDIA_TYPE`.
