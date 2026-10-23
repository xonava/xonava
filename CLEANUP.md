# Repository clean-up (0.3.0)

This is planned for the minor release after 0.2.0. Its goal is a fresh repository: the published packages, their
tests, the user documentation and the tooling a contributor needs. Nothing else stays: no work tracking, no
evidence from past runs, no certification gates named after work items, and no comments pointing back to
how the work was done.

This file is part of that work and is deleted by the same change.

## Order

1. Release 0.2.0 from the current state. Finish the mutation work for `drizzle-shared` and `events` first.
2. Make the clean-up on one branch from `dev`, in the steps below, with one commit per step.
3. Run the remaining release check, merge into `dev`, and release as 0.3.0 with one changeset that describes the
   user-visible removals.

## What goes

### Work tracking and plans

- `TODO.md`.
- `CLEANUP.md` (this file).
- Plan sections, "status", "gap" and "wave" wording in `CONTRIBUTING.md`, `docs/README.md`,
  `docs/architecture.md` and `docs/governance.md`.
- `docs/KNOWN-LIMITATIONS.md` should describe only current limits, not what is planned or was fixed.

### Evidence from past runs

- `artifacts/` (the committed 0.1.0 conformance evidence, `framework-conformance/release-*`).
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
- `differentialCertification.mjs` and `differentialBaseline.json` become a plain differential test runner
  without certification naming. Keep the test seeds that matter as regular test data.
- `package.json` scripts: drop every `certify:*` or ID-named script. The remaining set should be small and
  obvious: `build`, `lint`, `typecheck`, `test`, `test:integration:*`, `test:mutation`, `bench`, `soak`,
  `verify` (one aggregate), `release:version`, `release:publish`.
- `docs/spec/certification.md` and `docs/guides/certification.md`: remove them, or rewrite them as a plain
  "how releases are checked" page with no work IDs.

### Old version gates and compatibility code

- The compatibility fingerprints kept for 0.1.0 data, and the "legacy" paths in `packages/*/src`. About 16
  source files mention "legacy", including the legacy idempotency fingerprint retry in
  `createFrameworkWriteHandler.ts`. Removing them is a breaking change, so it goes in the 0.3.0 changeset with
  upgrade notes.
- The upgrade test aliases for the previous version (`xonava-core-prev`, `xonava-adapters-prev`) and the
  `packages/testing/integration/upgrade/` setup that targets 0.1.0. Keep the upgrade test itself, pointed at
  0.2.0, or remove it.
- Dead code found during the mutation work: `getCookieValue` and `resolveSessionRequired` in
  `packages/adapters/src/http/createFrameworkWriteHandler.ts`.
- `.changeset/*.md` entries are consumed by the 0.2.0 and 0.3.0 releases. None may be left over.

### References to how the work was done

- Work-item IDs in code, tests, configs and docs (G1…G14, F1…F9, Q1…Q6, A1…A8, B7, B8, C3…C9, W0-x, DF1, AG1,
  HT1, RL1, TH1, N1, TM/R labels used only as plan references, and "wave N"). About 43 files in `packages/` and
  `scripts/` contain them today. Rename tests and `describe` blocks by behaviour, not by ID.
- Test file names that describe how they were written rather than what they test. `*MutationKills.test.ts`
  becomes `<unit>.<behaviour>.test.ts`, or the tests merge into the existing test file for that unit.
- Comments that explain history ("added for", "was", "previously", "fix for review finding") instead of the
  current behaviour.
- The threat model in `docs/spec/security.md` stays, but without plan cross-references.
- `CHANGELOG.md` stays: it is the users' record of what changed between versions. It should mention no
  internal IDs from 0.2.0 onward.

## What stays

- `packages/core`, `packages/adapters` and `packages/testing`: sources, tests (renamed as above), published
  migrations, READMEs and Stryker configs (renamed comments only).
- `docs/` user documentation: specs, guides, reference and TypeScript docs, without plan wording.
- `spec/conformance-vectors`, if the tests use them.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `LICENSE`, `CHANGELOG.md`, `.github/`
  templates, editor, lint and TypeScript configs, `.nvmrc`, `package-lock.json`.

## Done when

- `git ls-files` shows no file whose name or purpose is work tracking, evidence or certification by ID.
- `git grep -nE '\b(G[0-9]{1,2}[ab]?|F[0-9]|Q[0-9]|W[0-9]-[0-9]|DF1|AG1|HT1|RL1|TH1)\b|\bwave [0-9]|TODO\.md|stryker-equivalent'`
  finds nothing outside `CHANGELOG.md` entries for 0.1.0 and 0.2.0.
- `git grep -il legacy -- packages/*/src` finds nothing.
- `build`, `lint`, `typecheck`, `test`, the PostgreSQL, MySQL and D1 integration suites and the aggregate `verify`
  all pass.
- The 0.3.0 changeset lists every user-visible removal: compatibility fingerprints, upgrade from 0.1.0 data,
  and removed scripts.

## Not covered

Git history still contains everything above. A repository with a fresh history (a new repository, or a single
squashed root commit) is a separate decision. It cannot be done with a normal merge, and it changes every
existing clone.
