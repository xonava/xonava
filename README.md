# Framework reference implementation

This repository contains a language-neutral server-framework specification and its TypeScript reference implementation.

```text
specification → TypeScript profile → core / adapters / testing → certified behavior
```

The workspace contains `core` (semantics and contracts), `adapters` (technology integrations), and `testing` (conformance and certification). Core has no runtime dependencies and exposes capability subpaths so applications can consume only what they need.

Start at [Documentation](docs/README.md). Build with `npm run build`, run ordinary tests with `npm test`, and run the complete configured backend gate with `npm run verify:framework-release`.

Current package names are `core`, `adapters`, and `testing`. This repository uses native ESM.
