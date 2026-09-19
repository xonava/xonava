# Leases

A lease identifies its resource, owner, opaque claim token, monotonically increasing fencing token and expiry. Acquisition succeeds only when no live lease exists. Renewal and release require the current owner and claim token.

Every protected write checks current claim identity and unexpired ownership in the same backend condition. A stale owner cannot write after expiry or replacement, even if its process resumes later.
