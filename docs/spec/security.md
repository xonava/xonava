# Scope and security

## Scope and trust boundaries

Trusted scope resolution MUST originate at a trusted boundary. Caller-supplied tenant, principal, or authority claims MUST NOT become authoritative without validation. Authorization MUST evaluate the principal, action, resource, scope, policy facts, and field rules required by the compiled plan.

Principal identity, authority, scope, policy bundle/facts, resource facts, and requested action are distinct inputs. Policy bundles MUST be integrity checked and normalized before use. Missing/invalid required facts fail closed.

A request without a trusted session (the session resolver returned no identity) on a route whose compiled binding is authenticated and allows no anonymous principal MUST fail as an authentication failure (`UnauthorizedError`, 401) before scope resolution, admission or any handler work; routes that allow an anonymous principal keep their binding's behaviour, and a binding that is itself inconsistent (for example a public route with no compiled anonymous principal) remains a configuration failure.

## Enforcement requirements

Persistence operations MUST carry mandatory scope predicates. Authorization facts used by a conditional mutation MUST be revalidated atomically when TOCTOU could change the decision. Authority delegation MUST attenuate rather than amplify authority. Safe diagnostics MUST redact sensitive facts.

Client/UI authorization is never authoritative security. Secrets MUST remain opaque and MUST NOT be included in unsafe telemetry or errors.

Row authorization precedes field projection/mutation checks. Obligations emitted by policy MUST be enforced or execution denied. Nested operations receive no more authority/budget/services than the parent explicitly delegates.

Business actions (`approve`, `reject`, and similar domain verbs) are authorized by their own ABAC grant and module action entry, never through `update`; `manage` in a module's `enabledModuleActions` still allows every action. See [Business actions](operations.md#business-actions-normative).

## Errors and conformance

Unauthenticated and unauthorized outcomes remain distinguishable internally but MUST avoid protected existence disclosure. Invalid policy is configuration failure, not an allow decision. A policy that names an action, capability, condition field or fieldAccess field absent from its module catalog is such a configuration error (`INVALID_POLICY_CONFIGURATION`, identifying the module, the policy and the missing names); it is detected when the bundle is constructed or the policies are pre-validated (`assertAbacPoliciesMatchCatalog`), and `createAbacBundle` returns a verified bundle. Conformance includes hostile caller scopes, tenant crossing, policy tampering, missing facts, ABAC normalization/evaluation, field visibility/writes, obligations, delegation attenuation, TOCTOU races, and redaction.

Traceability: `@xonava/core/domain`, `@xonava/core/security`, scoped persistence, adversarial/TOCTOU suites, S1 and V1 evidence.

## Threat model

This section names what the framework protects, from whom, and through which inputs, and maps every threat to the
requirement that addresses it and the test that proves it. A threat without a test is tracked as a work package in
[TODO.md](../../TODO.md); a residual risk is a threat the framework does not address and leaves to the application or
the platform.

### Assets

| ID | Asset | Why it matters |
| --- | --- | --- |
| A1 | Tenant data: entity rows, temporal history, attachments and object keys | Confidentiality and integrity per tenant |
| A2 | Policy bundles, module catalogs and entitlements | They decide every authorization outcome |
| A3 | Idempotency receipts and stored responses | A forged or crossed receipt replays another caller's response |
| A4 | Audit records and the outbox | Evidence of what happened, and the effects other systems act on |
| A5 | Durable execution state: jobs, schedules, workflows, leases, sequences | Duplicated or lost execution, fencing violations |
| A6 | Secrets, session material and cursor integrity keys | Their compromise defeats the controls above |

### Adversaries

| ID | Adversary | Capabilities assumed |
| --- | --- | --- |
| T1 | Unauthenticated client | Sends arbitrary HTTP requests: methods, headers, bodies, query strings, cursors, idempotency keys |
| T2 | Authenticated user of another tenant | T1 plus a valid session in its own tenant |
| T3 | Malicious tenant administrator | T2 plus authoring rights over its own tenant's policies, module settings and job payloads |
| T4 | Compromised worker | Runs framework code with database credentials; can stall, crash or replay at any point |
| T5 | Operator with database access | Reads and writes tables directly, outside the framework |

### Entry points

| ID | Entry point | Where |
| --- | --- | --- |
| E1 | HTTP scope resolution and session | `resolveEndpointRequestContext`, session resolvers, framework adapters |
| E2 | Request bodies, query strings and headers | CRUD and write handlers, `requestBody.ts`, method and body matrix |
| E3 | List cursors | `query/cursorCodec.ts` |
| E4 | Idempotency keys | `http/idempotency.ts`, idempotency stores |
| E5 | Policy and catalog authoring | `createAbacBundle`, `assertAbacPoliciesMatchCatalog` |
| E6 | Job, schedule and workflow payloads and signals | dispatchers, durable stores |
| E7 | Object keys and uploads | `storage/`, object-store contract |
| E8 | Direct database access | every durable table |

### Threats

The *Requirement* column names the normative sentence (in this file or another spec file) that addresses the threat; the
*Test* column names the suite that proves it. `TBD` marks a cell not yet mapped.

| ID | Threat | Adversary | Entry | Requirement | Test |
| --- | --- | --- | --- | --- | --- |
| TM1 | Forge or override tenant, principal or authority claims through headers, body or path | T1, T2 | E1, E2 | TBD | TBD |
| TM2 | Read or write another tenant's rows by omitting or altering scope predicates | T2 | E1, E2, E3 | TBD | TBD |
| TM3 | Learn that a protected resource exists from status codes, error text or timing of not-found against forbidden | T1, T2 | E2 | TBD | TBD |
| TM4 | Forge, replay across routes or scopes, or extend the lifetime of a list cursor | T1, T2 | E3 | TBD | TBD |
| TM5 | Replay another caller's stored response, or collide fingerprints, through idempotency keys | T1, T2 | E4 | TBD | TBD |
| TM6 | Exhaust resources with oversized bodies, deep nesting, huge predicates or unbounded queries | T1, T2 | E2, E3 | TBD | TBD |
| TM7 | Prototype pollution or type confusion through JSON bodies and filter parameters | T1, T2 | E2 | TBD | TBD |
| TM8 | Cross-site request forgery on cookie-authenticated write routes | T1 | E1, E2 | TBD | TBD |
| TM9 | Write a field the caller may not write, or read a field it may not see | T2 | E2 | TBD | TBD |
| TM10 | Win a TOCTOU race between the authorization decision and a conditional mutation | T2 | E2 | TBD | TBD |
| TM11 | Author a policy that grants more than intended: unknown actions, capabilities or fields, or a tampered bundle | T3 | E5 | TBD | TBD |
| TM12 | Amplify authority through delegation or nested operations | T2, T3 | E2, E6 | TBD | TBD |
| TM13 | Reach a platform-scope route with tenant credentials; platform routes do not consult module entitlements | T2, T3 | E1 | TBD | TBD |
| TM14 | Inject a job, schedule or workflow signal into another tenant's scope, or replay a consumed signal | T3, T4 | E6 | TBD | TBD |
| TM15 | Double-execute work or act after losing a lease (stale fencing token) | T4 | E6 | TBD | TBD |
| TM16 | Escape a tenant's object-key prefix or overwrite another tenant's object | T2 | E7 | TBD | TBD |
| TM17 | Leak secrets, session material or protected facts through errors, logs or telemetry | T1, T2 | E1, E2 | TBD | TBD |
| TM18 | Tamper with audit or outbox records so that evidence or downstream effects are wrong | T4, T5 | E8 | TBD | TBD |
| TM19 | Edit durable state directly (status, fencing tokens, idempotency rows) to bypass framework checks | T5 | E8 | TBD | TBD |

### Residual risks

TBD: threats the framework does not address, each with the reason and where the application or platform must address
it. Known inputs: write handlers parse the request body (bounded at 1 MiB by default) before CSRF, session and
authorization checks ([HTTP adapters](../typescript/http-adapters.md), method and body matrix); an operator with
database access (T5) is outside the framework's control except where integrity checks detect tampering.
