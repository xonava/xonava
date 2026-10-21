---
"@xonava/core": minor
"@xonava/adapters": minor
"@xonava/testing": minor
---

Add `R2ObjectStore` (Cloudflare R2 binding) to `@xonava/adapters/storage`, make `InMemoryObjectStore` verify sha256 checksums and honour versions and custom metadata, and add the `@xonava/testing/contracts/object-store` contract suite. `ObjectMetadata` gains an optional `metadata` field.
