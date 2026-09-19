# Compatibility and versioning policy

The canonical release intentionally retains no obsolete pre-release compatibility surfaces. Future compatibility requires an explicit version decision, documented lifetime, tests, and removal policy; aliases or silent fallback MUST NOT be added ad hoc.

Distinct versions:

- Specification version identifies normative semantics.
- Reference implementation/package version identifies TypeScript release artifacts.
- Durable format version identifies persisted/wire representation.
- Adapter certification version identifies the guarantee suite and source/runtime evidence.

These versions may evolve independently but compatibility claims MUST state which dimensions they cover. Durable writers MUST follow reader-before-writer deployment rules. Public export changes follow the maintained API manifest and package-version policy.
