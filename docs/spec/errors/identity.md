# Error identity profile

Canonical error identity consists of stable internal identity, category, retryability, safe message, immutable safe metadata, and the safe public code defined in the parent [error specification](../errors.md). Internal causes, SQL, schema names, credentials, unrestricted messages, and provider diagnostics never cross an untrusted boundary.

Transport-specific status, headers, exit values, or delivery dispositions belong exclusively to the applicable transport profile. Persistence adapters normalize using structured backend machine codes, not localized message text. Unknown persistence failures become sanitized non-retryable persistence errors unless a structured code proves a retryable condition.
