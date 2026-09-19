# Architecture principles

- Core defines observable semantics and has zero runtime dependencies.
- Adapters depend only on intentional public core APIs; core never depends on adapters or testing.
- Capabilities are independently consumable and do not require global initialization.
- Security and durability boundaries remain explicit.
- Reference adapters prove implementability; certification proves behavioral conformance.
- Provider-specific mechanics stay outside the neutral specification.
- No import-time registration is required.
- A port is a contract boundary, not a global consumer-facing directory.
- Current code is the source of truth when historical prose conflicts.
