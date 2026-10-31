# Getting started

1. Install workspace dependencies with `npm install`.
2. Run `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test`.
3. Select public capability imports from [`../reference/package-exports.md`](../reference/package-exports.md).
4. Supply an adapter for external behavior; do not import private source paths.
5. For database work, configure real provider URLs and run the matching integration/conformance/race/crash gates.

Applications may start with one capability and add orchestration later. No unrelated capability initialization is required.

## Next steps

- [Build a standalone application without tenants](standalone-application.md): platform scope, fixed route scope, ABAC, jobs and workflows
- [Give customers access to only their own records](ownership.md): trusted session, tenant scope, ABAC ownership policy, projection, update and delete
- [Store uploaded files without orphans](durable-uploads.md): reservation, upload, finalize and cleanup across the database and the object store
- [Fill a form with data from another module](supporting-reads.md): a read-only supporting endpoint admitted by the parent action, with a fixed allowlist, a bound and a save that re-checks everything
- [Create an operation](create-an-operation.md)
- [Persistence setup](persistence-setup.md)
- [Understand errors](understanding-errors.md)
