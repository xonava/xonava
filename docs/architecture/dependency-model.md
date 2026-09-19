# Dependency model

```text
kernel
  ↑
standalone capabilities
  ↑
domain / entity / query / persistence / events
  ↑
operation / execution / workflow
  ↑
bootstrap
```

Lower-level capabilities MUST NOT acquire dependencies on higher orchestration merely for convenience.

```text
adapters → public core APIs
testing  → core; adapters when implementations are under test
core     ✕ adapters
core     ✕ testing
```

Architecture verification rejects runtime cycles, obsolete package identities, private compatibility surfaces, and tree-shaking regressions.
