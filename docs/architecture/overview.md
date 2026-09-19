# Architecture overview

The framework separates specification, implementation, integration, and proof:

```text
                 LANGUAGE-NEUTRAL SPECIFICATION
                              │
                     TypeScript profile
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
            core           adapters         testing
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                     certified behavior
```

Core defines contracts, semantics, domain primitives, and neutral orchestration. Adapters connect those contracts to databases, HTTP, storage, caches, and runtimes. Testing provides reusable contract suites, real-provider integration/race/crash suites, and certification evidence.

An application normally follows `application → public capability → contract → adapter → provider/runtime`. Provider technology never becomes core semantics.
