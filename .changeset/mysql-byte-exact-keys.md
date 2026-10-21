---
"@xonava/adapters": patch
---

MySQL sequence and temporal stores now compare scope ids byte-for-byte (utf8mb4_0900_bin plus a SHA-256 `scope_hash` key); apply `0006_byte_exact_identifiers.sql` before upgrading.
