# Domain primitives

## Scope and requirements

Domain defines principal, authority, execution scope, predicates, data classification, field access, ABAC policy/decisions, and canonical errors. Principal/scope facts MUST originate from trusted resolution. Predicates and policy values MUST be normalized/validated before evaluation. Decision combination MUST be deterministic, fail closed on invalid policy, and preserve denial reasons only at safe diagnostic boundaries.

## Security and conformance

Authority attenuation MUST never add capabilities. Field access MUST be evaluated after row authorization. Classification MUST constrain disclosure/telemetry. Conformance covers hostile values, normalization, predicate evaluation, bundle integrity, tier decisions, attenuation, and redaction. Traceability: `core/domain`; S1/V1.
