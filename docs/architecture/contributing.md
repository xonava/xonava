# Contributor architecture guide

For setup, verification commands, and database test requirements, see [CONTRIBUTING.md](../../CONTRIBUTING.md). This page states where code belongs and the rules every change must follow.

## Placement

Place a fundamental invariant with no higher dependency in `@xonava/core/kernel`. Put neutral capability contracts and behavior in the corresponding core capability. Put provider- and runtime-specific code in `@xonava/adapters`. Put conformance and certification infrastructure in `@xonava/testing` or `scripts/verification`.

## Rules

- No compatibility aliases without an explicit versioning decision.
- No framework or provider imports in core.
- No adapter deep-imports into private core files.
- No unjustified broad barrels, dead migration files, or duplicate canonical concepts.
- Public behavior requires tests and applicable conformance coverage.
- Normative behavior cannot exist only in an implementation comment.
- React and HTTP-framework bindings belong outside core.
