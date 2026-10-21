---
"@xonava/core": minor
---

**Breaking:** removes the unimplemented `RootPersistenceProvider`, `ApplicationPersistenceProvider`, `PlatformPersistenceProvider` and `SystemPersistenceProvider` types from `@xonava/core/persistence`. No adapter implemented or consumed them; `ScopedPersistenceProvider` and the tenant-scoped provider types are unchanged.
