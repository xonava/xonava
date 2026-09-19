# Rate-limit API

Import `checkRateLimit` for decisions, `enforceRateLimit` for exception-based enforcement, and store contracts from `core/rate-limit`. Atomic behavior is default and requires `AtomicRateLimitStore`; explicitly select best-effort before fail-open is permitted. Time values are epoch/duration milliseconds. Unsupported algorithm/cost capabilities raise `RuntimeCapabilityError`; invalid inputs raise `ValidationError`; blocked enforcement raises `RateLimitError` with `retryAfterMs`. See [normative semantics](../spec/rate-limit.md).
