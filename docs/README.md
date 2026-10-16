# Canonical documentation

This directory is the single active documentation set.

| Area | Status | Responsibility |
|---|---|---|
| [`spec/`](spec/README.md) | Normative | Language-neutral observable semantics and conformance requirements |
| [`architecture.md`](architecture.md) | Non-normative authority | Current package/dependency/execution architecture |
| [`typescript/`](typescript/README.md) | Reference profile | Exact TypeScript API and implementation mapping |
| [`guides/`](guides/getting-started.md) | Guidance | Task-oriented usage and adapter authoring |
| [`reference/`](reference/package-exports.md) | Current reference | Public exports, capability catalog, errors, release certification state |
| [`governance.md`](governance.md) | Policy | Compatibility, versioning, evidence retention, approvals |

When prose disagrees with executable behavior, treat it as a defect to reconcile. Normative semantics live only in `docs/spec`; TypeScript syntax does not define the language-neutral contract.

## Project documents

- [Known limitations](KNOWN-LIMITATIONS.md): gaps in the current release candidate
- [Plan](../TODO.md): what is left to do before `2.0.0`
- [Changelog](../CHANGELOG.md): notable changes by release
- [Contributing](../CONTRIBUTING.md): setup, build, test, and verification commands
- [Contributor architecture rules](architecture.md#contributor-rules): where code belongs and what it must not import
- [Security policy](../SECURITY.md): how to report a vulnerability privately
