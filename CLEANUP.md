# Repository clean-up (0.2.1 and 0.3.0)

The goal is a fresh repository: the published packages, their tests, the user documentation and the tooling a
contributor needs. Nothing else stays: no work tracking, no evidence from past runs, no certification gates named
after work items, and no comments pointing back to how the work was done.

The work is split by what it does to users:

- **0.2.1, repository-only (patch):** everything that does not change the published behaviour. Files, scripts,
  test names, comments and internal dead code. Packages are released as a patch only if a published file changes.
- **0.3.0, breaking (minor):** removing the compatibility code for 0.1.0 data. It ships with the other breaking
  0.3.0 work (the list row-count change in `TODO.md`).

This file and `TODO.md` stay until the last 0.3.0 change, which deletes both.

## Order

1. 0.2.0 is versioned and certified on `dev` (not published; `main` and npm follow after 0.3.0).
2. CI (Q1 in `TODO.md`) lands on `dev` first, with no version bump, so every clean-up pull request is checked.
3. 0.2.1: the steps under "0.2.1: what goes", one branch from `dev`, one commit per step. Add a patch changeset
   only for the published changes (the dead code); then `release:version` and the release certification.
4. 0.3.0: the steps under "0.3.0: what goes" together with the list row-count change. Add one minor changeset
   with upgrade notes. Because 0.2.0 and 0.2.1 are never published, the 0.3.0 upgrade notes cover everything
   since 0.1.0, including the 0.2.0 breaking changes and migrations `0005_job_scope_key` and MySQL
   `0006_byte_exact_identifiers`. Run `release:version`, the release certification (with soak enabled), then
   merge `dev` into `main` and publish.

## 0.2.1: what goes

### Work tracking and plans

- Plan sections, "status", "gap" and "wave" wording in `CONTRIBUTING.md`, `docs/README.md`,
  `docs/architecture.md` and `docs/governance.md`.
- `docs/KNOWN-LIMITATIONS.md` should describe only current limits, not what is planned or was fixed.

### Evidence from past runs

- `artifacts/` (the committed conformance evidence, `framework-conformance/release-*`). Release evidence is no
  longer committed: `docs/governance.md` changes to say the release check's output is kept with the release
  (CI artifact or release attachment), not in the repository.
- `ci-artifacts/` (`framework-release-verification.json`).
- `packages/core/stryker-equivalent.md` and `packages/adapters/stryker-equivalent.md`. Each mutant they justify
  either gets a short comment in the source or is not mentioned at all.
- `benchmarks/baseline.json`, if benchmarks are kept: replace it with a freshly generated baseline. If they are
  dropped, delete it.

### Certification gates named after work items

- `scripts/verification/verify<ID>Certification.mjs`, one per old work item (AG1, B1, C1, D1, DF1, E1, ER1,
  EV1, F1, G1, H1, HT1, J1, L1, MYSQL1, N1, O1, OP1, Q1Q2, R1, RL1, S1, T1, TH1, TX1, W1), plus
  `verifyFinalCertification.mjs`, `verifyFreshCoreArchitecture.mjs`, `runFrameworkReleaseCertification.mjs` and
  `certificationSupport.mjs`.
- For each one, keep any check that still protects users and that no test already covers. Move it into a
  plain, purpose-named check: architecture, exports, docs, fixtures, versions, benchmarks or differentials.
  Delete the rest.
- The release check itself stays, renamed: `verify:framework-release` and its runner become one plain
  `verify:release` command that still runs all three databases, the differential suites at release volume and
  the crash failpoints, and still fails closed. The 0.3.0 release is checked with it.
- `differentialCertification.mjs` and `differentialBaseline.json` become a plain differential test runner
  without certification naming. Keep the test seeds that matter as regular test data.
- `package.json` scripts: drop every `certify:*` or ID-named script. The remaining set should be small and
  obvious: `build`, `lint`, `typecheck`, `test`, `test:integration:*`, `test:mutation`, `bench`, `soak`,
  `verify` (one aggregate), `verify:release`, `release:version`, `release:publish`.
- `docs/spec/certification.md` and `docs/guides/certification.md`: remove them, or rewrite them as a plain
  "how releases are checked" page with no work IDs.

### Dead code (internal, not exported)

- Dead code found during the mutation work: `getCookieValue` and `resolveSessionRequired` in
  `packages/adapters/src/http/createFrameworkWriteHandler.ts`, and the write-only `revisions` map in
  `packages/adapters/src/cache/inMemoryCacheAdapter.ts` (nothing reads it).

### References to how the work was done

- Work-item IDs in code, tests, configs and docs (G1…G14, F1…F9, Q1…Q6, A1…A8, B7, B8, C3…C9, W0-x, DF1, AG1,
  HT1, RL1, TH1, N1, TM/R labels used only as plan references, and "wave N"). About 43 files in `packages/` and
  `scripts/` contain them today. Rename tests and `describe` blocks by behaviour, not by ID.
- Test file names that describe how they were written rather than what they test. `*MutationKills.test.ts`
  becomes `<unit>.<behaviour>.test.ts`, or the tests merge into the existing test file for that unit.
- Decide on `packages/adapters/src/drizzle-shared/__tests__/predicateCompilerMutationKills.test.ts` (168 KB) and
  its snapshot (`__snapshots__/…snap`, 545 KB, exact SQL and parameters for about 3,200 predicates). These are
  the largest files in the repository. A snapshot records current output and does not prove it is correct.
  The option is to replace both with a hand-written table of about 100–200 representative cases with explicit
  expected SQL per dialect, then re-measure that the mutation score stays close to 96.8 %.
- Comments that explain history ("added for", "was", "previously", "fix for review finding") instead of the
  current behaviour.
- The threat model in `docs/spec/security.md` stays, but without plan cross-references.
- `CHANGELOG.md` stays: it is the users' record of what changed between versions. It should mention no
  internal IDs from 0.2.0 onward.

## 0.3.0: what goes

- The compatibility fingerprints kept for 0.1.0 data, and the "legacy" paths in `packages/*/src`. About 16
  source files mention "legacy", including the legacy idempotency fingerprint retry in
  `createFrameworkWriteHandler.ts`. Removing them is a breaking change, so it goes in the 0.3.0 changeset with
  upgrade notes.
- The upgrade test aliases for the previous version (`xonava-core-prev`, `xonava-adapters-prev`) and the
  `packages/testing/integration/upgrade/` setup that targets 0.1.0. Keep the upgrade test itself, pointed at
  0.2.0, or remove it.
- `TODO.md` and `CLEANUP.md` (this file), in the last 0.3.0 change, after their remaining items are done.
- `.changeset/*.md` entries are consumed by the 0.2.1 and 0.3.0 releases. None may be left over.

## What stays

- `packages/core`, `packages/adapters` and `packages/testing`: sources, tests (renamed as above), published
  migrations, READMEs and Stryker configs (renamed comments only).
- `docs/` user documentation: specs, guides, reference and TypeScript docs, without plan wording.
- `spec/conformance-vectors`, if the tests use them.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `LICENSE`, `CHANGELOG.md`, `.github/`
  templates, editor, lint and TypeScript configs, `.nvmrc`, `package-lock.json`.

## Done when

After 0.2.1 (everything except the 0.3.0 section):

- `git ls-files` shows no file other than `TODO.md` and `CLEANUP.md` whose name or purpose is work tracking, evidence or certification by ID.
- `git grep -nE '\b(G[0-9]{1,2}[ab]?|F[0-9]|Q[0-9]|W[0-9]-[0-9]|DF1|AG1|HT1|RL1|TH1)\b|\bwave [0-9]|TODO\.md|stryker-equivalent'`
  finds nothing outside `CHANGELOG.md`, `TODO.md` and `CLEANUP.md`.
After 0.3.0:

- `TODO.md` and `CLEANUP.md` are gone, and the ID grep above finds nothing at all outside `CHANGELOG.md`.
- `git grep -il legacy -- packages/*/src` finds nothing.
- `build`, `lint`, `typecheck`, `test`, the PostgreSQL, MySQL and D1 integration suites, the aggregate `verify`
  and `verify:release` all pass.
- The 0.3.0 changeset lists every user-visible removal: compatibility fingerprints, upgrade from 0.1.0 data,
  and removed scripts.

## Not covered

Git history still contains everything above. A repository with a fresh history (a new repository, or a single
squashed root commit) is a separate decision. It cannot be done with a normal merge, and it changes every
existing clone.
