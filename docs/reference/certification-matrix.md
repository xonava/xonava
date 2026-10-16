# Current certification matrix

This page is release state, not normative specification. Source-bound evidence is under `artifacts/framework-conformance`.

| Profile | Current state | Evidence |
|---|---|---|
| Core/API/architecture | Proven for `2.0.0-rc.2` | API, purity, ownership, fresh-core, generated-surface gates |
| PostgreSQL | Integration, conformance, race, crash/replay proven | `verify:framework:cert` run: `<run-id>/release/pg-guarantees.json`, `pg-crash-replay.json` |
| D1 | Pinned local Miniflare integration, conformance, race, crash/replay proven | `verify:framework:cert` run: `<run-id>/release/d1-guarantees.json`, `d1-crash-replay.json` |
| MySQL | Full provider and 120-run crash certification proven | `verify:framework:cert` run: `<run-id>/release/mysql-guarantees.json`, `mysql-crash-replay.json` |
| Aggregate | Proven | `verify:framework:cert` run: `<run-id>/release/framework-release-manifest.json` |
| Differential/property (DF1) | Required in every release run; evidence is per run with a run-specific seed | `<run-id>/df1/differential-conformance.json` |

Evidence is written by running the named verify scripts under `artifacts/framework-conformance/<run-id>/`. Only the latest certified release run is kept in the repository; see the [artifact retention policy](../governance.md#certification-artifact-retention).

The D1 claim does not imply untested remote staging behavior. Application policy and custom adapters are outside this certification unless separately tested.

H1 proves the core feature-fact structure and validation contract. It does not, by itself, certify a provider's trusted-clock freshness, reevaluation, or failure semantics; those require provider-level conformance evidence.
