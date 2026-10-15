# Testing profile

- Unit tests prove a local algorithm or state machine.
- Integration tests prove behavior against a real runtime/provider.
- Contract tests prove a reusable contract boundary.
- Conformance tests compare providers against the same semantics.
- Race tests exercise concurrent decisions.
- Crash/replay tests prove durable outcomes across termination/restart.
- Certification binds evidence and source to a named guarantee set.
- Architecture tests prove dependency direction, exports, cycles, ownership, and tree shaking.

Use the `@xonava/testing` workspace and provider-specific commands documented in the certification guide. A skipped mandatory provider suite is not certification.
