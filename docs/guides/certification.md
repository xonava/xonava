# Running certification

Run `npm run verify:framework-release:local` for the fast local development profile. Its crash checks use one repetition and do not produce release certification.

For release certification, configure `FRAMEWORK_TEST_PG_URL` and `FRAMEWORK_TEST_MYSQL_URL`, then run `npm run verify:framework-release`. The command creates a unique run ID unless `FRAMEWORK_CONFORMANCE_RUN_ID` is supplied, executes all three database providers, repeats every crash failpoint 20 times for every provider, and fails unless the same run produces valid guarantee and crash evidence. It then emits a source-bound aggregate manifest in `artifacts/framework-conformance/<run-id>/release/`.

`npm run verify:framework-release:baseline` is the underlying one-repetition diagnostic gate. A passing baseline is not a release certification. The internal `verify:framework:cert` step requires the explicit run ID, start timestamp, and initial source digest supplied by the release runner; it validates only that new run and never searches historical evidence. A requested run ID whose artifact directory already exists is rejected. Named V1/MYSQL1 runs use `FRAMEWORK_CONFORMANCE_RUN_ID` and the corresponding certification commands.

Evidence under `artifacts/framework-conformance/<run-id>/` records guarantee results, source manifests, runtime topology, crash repetitions, and aggregate digests. The aggregate manifest explicitly records that local multi-backend certification does not certify production topology, custom adapters, or offline-unavailable external advisories. Preserve named release evidence according to the [retention policy](../governance/artifact-retention.md). A green interface/unit suite is not provider certification.
