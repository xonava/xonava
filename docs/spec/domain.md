# Domain primitives

## Scope and requirements

Domain defines principal, authority, execution scope, predicates, data classification, field access, ABAC policy/decisions, and canonical errors. Principal/scope facts MUST originate from trusted resolution. Predicates and policy values MUST be normalized/validated before evaluation. Decision combination MUST be deterministic, fail closed on invalid policy, and preserve denial reasons only at safe diagnostic boundaries.

## ABAC decision rules

Policies resolve by priority tier: the highest tier containing a policy whose condition is not FALSE for the record decides; any such deny denies, otherwise a TRUE allow allows, and a tier holding only UNKNOWN allows denies without falling through. Record decisions MUST agree with the compiled query scope under three-valued logic.

A global (record-less) capability decision MUST NOT be looser than the record decision for any record. It is therefore evaluated as if every record attribute were UNKNOWN: a deny that is not statically FALSE matches, only an unconditional allow grants, and a conditional allow claims its tier without granting, so it blocks lower-tier grants exactly as it would for a record whose attribute is NULL.

A field query grant (`fieldAccess.query`) is a record-less decision: queries are not evaluated per row. It therefore MUST be honoured only when it comes from an allow policy whose condition is unconditional; a grant from a conditional allow policy MUST NOT lift a query denial, because it would expose values of rows the record decision hides.

Policy literals for `date` fields are calendar dates (`YYYY-MM-DD`), never instants, so they match records hydrated either as `YYYY-MM-DD` strings or as UTC-midnight instants. Writes MUST supply `date` fields as `YYYY-MM-DD` strings or instants; any other string spelling is rejected (it would compare as a different value while storage casts it to the same date). Persistence MUST hydrate `date` columns as `YYYY-MM-DD` strings or instants; a full date-time string would not equal a calendar-date literal in record-level checks.

Framework-built mandatory scopes (structural and ABAC scopes) narrow a query but are not caller input: they MUST NOT consume the caller's query budget, and are bounded separately by hard evaluation limits, failing as configuration errors.

## Security and conformance

Authority attenuation MUST never add capabilities. Field access MUST be evaluated after row authorization. Classification MUST constrain disclosure/telemetry. Conformance covers hostile values, normalization, predicate evaluation, bundle integrity, tier decisions, attenuation, and redaction. Traceability: `@xonava/core/domain`; S1/V1.
