# Conformance and certification

Interface compatibility proves only shape. Conformance proves observable contract behavior. Certification binds named source, versions, runtime topology, tests, and evidence to a guarantee set.

A certification claim MUST identify the adapter/provider, guarantee identifiers, source manifest, runtime versions, and result. Transaction/crash claims MUST use real provider behavior, independent connections/processes, forced termination where specified, fresh recovery processes, and the required repetition count. Failed or skipped mandatory evidence MUST NOT be reported as proven.

Certification does not prove application-specific policy correctness, provider operations outside the tested topology, or future versions. Current release status is non-normative and lives in [`../reference/certification-matrix.md`](../reference/certification-matrix.md).

Traceability: `packages/testing`, `scripts/verification`, and `artifacts/framework-conformance`.
