# Contributor architecture guide

Place a fundamental invariant with no higher dependency in `core/kernel`; neutral capability contracts/behavior in the corresponding core capability; provider/runtime-specific code in `adapters`; and conformance/certification infrastructure in `testing` or `scripts/verification`.

- No compatibility aliases without an explicit versioning decision.
- No framework/provider imports in core.
- No adapter deep-imports into private core files.
- No unjustified broad barrels, dead migration files, or duplicate canonical concepts.
- Public behavior requires tests and applicable conformance coverage.
- Normative behavior cannot exist only in an implementation comment.
- React/HTTP-framework bindings belong outside core.
