# Scope and security

## Scope and trust boundaries

Trusted scope resolution MUST originate at a trusted boundary. Caller-supplied tenant, principal, or authority claims MUST NOT become authoritative without validation. Authorization MUST evaluate the principal, action, resource, scope, policy facts, and field rules required by the compiled plan.

Principal identity, authority, scope, policy bundle/facts, resource facts, and requested action are distinct inputs. Policy bundles MUST be integrity checked and normalized before use. Missing/invalid required facts fail closed.

## Enforcement requirements

Persistence operations MUST carry mandatory scope predicates. Authorization facts used by a conditional mutation MUST be revalidated atomically when TOCTOU could change the decision. Authority delegation MUST attenuate rather than amplify authority. Safe diagnostics MUST redact sensitive facts.

Client/UI authorization is never authoritative security. Secrets MUST remain opaque and MUST NOT be included in unsafe telemetry or errors.

Row authorization precedes field projection/mutation checks. Obligations emitted by policy MUST be enforced or execution denied. Nested operations receive no more authority/budget/services than the parent explicitly delegates.

Business actions (`approve`, `reject`, and similar domain verbs) are authorized by their own ABAC grant and module action entry, never through `update`; `manage` in a module's `enabledModuleActions` still allows every action. See [Business actions](operations.md#business-actions-normative).

## Errors and conformance

Unauthenticated and unauthorized outcomes remain distinguishable internally but MUST avoid protected existence disclosure. Invalid policy is configuration failure, not an allow decision. Conformance includes hostile caller scopes, tenant crossing, policy tampering, missing facts, ABAC normalization/evaluation, field visibility/writes, obligations, delegation attenuation, TOCTOU races, and redaction.

Traceability: `@xonava/core/domain`, `@xonava/core/security`, scoped persistence, adversarial/TOCTOU suites, S1 and V1 evidence.
