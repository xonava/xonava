# Canonical documentation

This directory is the single active documentation set.

| Area | Status | Responsibility |
|---|---|---|
| [`spec/`](spec/README.md) | Normative | Language-neutral observable semantics and conformance requirements |
| [`architecture/`](architecture/overview.md) | Non-normative authority | Current package/dependency/execution architecture |
| [`typescript/`](typescript/README.md) | Reference profile | Exact TypeScript API and implementation mapping |
| [`guides/`](guides/getting-started.md) | Guidance | Task-oriented usage and adapter authoring |
| [`reference/`](reference/package-exports.md) | Current reference | Public exports, capability catalog, errors, release certification state |
| [`governance/`](governance/compatibility-and-versioning.md) | Policy | Compatibility, versioning, evidence retention, approvals |

When prose disagrees with executable behavior, treat it as a defect to reconcile. Normative semantics live only in `docs/spec`; TypeScript syntax does not define the language-neutral contract.
