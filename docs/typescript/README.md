# TypeScript reference profile

The repository targets native ESM and maps the neutral specification to TypeScript contracts. This profile explains representation and usage; it does not redefine normative behavior.

Use package capability subpaths for specialized APIs. Type-only imports should use `import type`. Importing private `src` or `dist` paths is unsupported.

See [type mappings](type-mappings.md), [public API](public-api.md), [core usage](core-usage.md), [adapter authoring](adapter-authoring.md), and [testing](testing.md).
