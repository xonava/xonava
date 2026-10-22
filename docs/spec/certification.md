# Conformance and certification

Interface compatibility proves only shape. Conformance proves observable contract behavior. Certification binds named source, versions, runtime topology, tests, and evidence to a guarantee set.

A certification claim MUST identify the adapter/provider, guarantee identifiers, source manifest, runtime versions, and result. Transaction/crash claims MUST use real provider behavior, independent connections/processes, forced termination where specified, fresh recovery processes, and the required repetition count. Failed or skipped mandatory evidence MUST NOT be reported as proven.

## Differential certification (DF1)

Every release certification run MUST include DF1. DF1 runs the property/differential suites — the core suites under `packages/core/src/__tests__/differential` (predicate semantics, ABAC authorization and field access, encodings and serialization) the HTTP fuzz suites over the CRUD and write handlers (`packages/adapters/src/http/__tests__/fuzz`), and the PostgreSQL, MySQL, and D1 real-database parity suites, which compare each SQL compiler, repository ordering, and keyset pagination against the core evaluator — at elevated volume with a seed that is new for each run and recorded in the evidence.

DF1 is proven only when every property declared by a `forAll`/`forAllAsync` call site in those suites reported success with the recorded seed and scale, every call site is covered by its own properties (a property satisfies exactly one call site), every property ran at least its scaled case count, no property ran in single-case replay mode, no call site in the checked-in property baseline was removed or expands to fewer properties than recorded, the seed of a release run is the one derived from its run ID rather than a fixed seed, and the source manifest of the suites, the harness, the core and adapter sources they exercise, and their specifications matches the certified sources. Missing, foreign-run, stale, under-volume, or incomplete differential evidence MUST NOT be reported as proven, and the aggregate release manifest MUST NOT be emitted without it.

DF1 is randomized testing: a pass is evidence that the explored cases agree, not a proof over all inputs. Because each run explores different cases, a failure in a later run does not invalidate earlier evidence; it is a defect to fix and replay from the recorded seed.

Certification does not prove application-specific policy correctness, provider operations outside the tested topology, or future versions. Current release status is non-normative and lives in [`../reference/certification-matrix.md`](../reference/certification-matrix.md).

Traceability: `packages/testing`, `scripts/verification`, and `artifacts/framework-conformance`.
