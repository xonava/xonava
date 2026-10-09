# Current certification matrix

This page is release state, not normative specification. Source-bound evidence is under `artifacts/framework-conformance`.

| Profile | Current state | Evidence |
|---|---|---|
| Core/API/architecture | Proven for `2.0.0-rc.2` | API, purity, ownership, fresh-core, generated-surface gates |
| PostgreSQL | Integration, conformance, race, crash/replay proven | `canonical-20260916/v1` and final release gate |
| D1 | Pinned local Miniflare integration, conformance, race, crash/replay proven | `canonical-20260916/v1` |
| MySQL | Full provider and 120-run crash certification proven | `canonical-20260916/mysql1` |
| Aggregate | Proven | `canonical-20260916/cert` |
| Differential/property (DF1) | Required in every release run; evidence is per run with a run-specific seed | `<run-id>/df1/differential-conformance.json` |

The D1 claim does not imply untested remote staging behavior. Application policy and custom adapters are outside this certification unless separately tested.

H1 proves the core feature-fact structure and validation contract. It does not, by itself, certify a provider's trusted-clock freshness, reevaluation, or failure semantics; those require provider-level conformance evidence.
