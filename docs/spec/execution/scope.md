# Execution scope

An execution scope is exactly one of `application(applicationKey)`, `tenant(tenantId)`, `platform(platformKey)`, or `system(systemKey)`. The discriminator and identifier are non-empty strings and extra members are forbidden.

The scope identity is `fscope:v1:` followed by unpadded base64url of the UTF-8 canonical JSON bytes. Decoders MUST validate, re-encode, and require byte-for-byte identity. `public` is exposure, never an execution scope. Client input cannot directly grant or widen scope authority.
