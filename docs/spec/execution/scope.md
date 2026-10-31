# Execution scope

An execution scope is exactly one of `application(applicationKey)`, `tenant(tenantId)`, `platform(platformKey)`, or `system(systemKey)`. The discriminator and identifier are non-empty strings and extra members are forbidden.

The scope identity is `fscope:v1:` followed by unpadded base64url of the UTF-8 canonical JSON bytes. Decoders MUST validate, re-encode, and require byte-for-byte identity. `public` is exposure, never an execution scope. Client input cannot directly grant or widen scope authority.

## Enqueue requester matrix

An enqueue names a requester whose scope is `system`, `platform`, or `tenant`, and a job whose execution scope is `tenant`, `platform`, or `system`. Every job store MUST apply the shared core check (`assertRequesterCanEnqueueScope`) before writing, and a violation MUST fail with `TenantScopeViolationError` without writing. The allowed combinations are:

| Requester | May enqueue |
|---|---|
| `tenant(T)` | `tenant` jobs of tenant `T` only |
| `platform` | `platform` jobs; without the `enqueue:system` capability nothing else, with it jobs of any scope |
| `system` | jobs of any scope (the system requester is the trusted framework actor and acts explicitly for others) |

Scope and tenant identity of a job are fixed by its execution scope and are never taken from the requester.
