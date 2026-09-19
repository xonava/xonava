# Getting started

1. Install workspace dependencies with `npm install`.
2. Run `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test`.
3. Select public capability imports from [`../reference/package-exports.md`](../reference/package-exports.md).
4. Supply an adapter for external behavior; do not import private source paths.
5. For database work, configure real provider URLs and run the matching integration/conformance/race/crash gates.

Applications may start with one capability and add orchestration later. No unrelated capability initialization is required.
