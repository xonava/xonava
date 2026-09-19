# Framework Release Verification

**Framework 2.0 profile:** F0-F3 implementation is framework-owned and independent of consumer
applications. Conformance evidence is written below
`artifacts/framework-conformance/<run-id>/`.

Run `npm run verify:framework-release` for the framework-only release profile.

The full profile covers framework builds, package static/export checks, framework-owned migration
consistency, core/adapter/testing typechecks, lint, unit tests, race tests, separate-process crash
recovery, and real D1/PostgreSQL integration and conformance tests. PostgreSQL certification fails
closed unless `FRAMEWORK_TEST_PG_URL` or `DATABASE_URL` identifies a real PostgreSQL server.
The gate also regenerates and validates RL1 business-rule, AG1 aggregate, TH1 temporal-history,
N1 sequence-numbering, and HT1 HTTP-adapter evidence from the same source snapshot and run identifier.

The `verify:framework:core-purity` gate enforces the dependency-free core contract against both
production TypeScript and built JavaScript. It rejects runtime package/Node imports, Node runtime
globals, and non-empty `dependencies`, `peerDependencies`, or `optionalDependencies`. F1 SHA-256
digest logic is an internal synchronous ECMAScript implementation and does not depend on
`node:crypto`, Web Crypto, or any third-party package.

`npm run verify:framework-release:local` executes the complete framework-only profile available
without an external PostgreSQL service, including the real SQLite execution model used for D1.
`npm run verify:framework-release` adds mandatory PostgreSQL integration, conformance, race, and
crash suites. Neither command imports application migrations or application lifecycle code.

The version-policy verifier records package versions, source revision, lockfile digest and public
API digest in `ci-artifacts/framework-release-verification.json`. Adapter proof artifacts remain
separate under `artifacts/framework-conformance/<run-id>/`; absence of PostgreSQL evidence is never
treated as proof.
