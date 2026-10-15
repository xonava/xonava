# Understand errors

Catch `FrameworkCoreError` at a trusted integration boundary and inspect stable code/category/retryability/safe metadata. Do not serialize `details`, internal cause, stack, or provider text to an untrusted client. Authorization/not-found mapping must avoid existence leaks. Retry only when the canonical error says retryable and the operation is idempotent or safely replayable. HTTP mapping belongs to `@xonava/adapters/http`; other transports map the same canonical identity independently.
