---
"@xonava/core": minor
"@xonava/adapters": minor
---

**Breaking:** a missing `If-Match` on a versioned update or delete now answers 428 `PRECONDITION_REQUIRED` instead of 409, and a missing required `Idempotency-Key` answers `REQUIRED_HEADER_MISSING` with `details.header`. Adds `PublicBusinessError` for application-authored, caller-safe business error codes, messages and fields, plus `RequiredHeaderMissingError` and `PreconditionRequiredError`.
