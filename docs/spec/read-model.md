# Read models

## Scope and requirements

A read model is an independently authorized bounded read, potentially across sources. It MUST declare input/output contracts, required sources/capabilities, consistency, failure behavior, and authorization. Partial-source behavior MUST be explicit; silent omission MUST NOT masquerade as a complete result.

Definitions have stable identity and validated input/output. Execution authorizes each source/resource independently, applies projection/classification rules to the combined result, and enforces one overall budget/deadline. The execution signal and absolute deadline MUST be propagated to every source. Caller cancellation or deadline expiry terminates the whole read regardless of partial-source policy; late provider failures remain observed. Source order MUST NOT change logical output when the definition declares deterministic results. In-memory joins MUST enforce absolute source, output, and indexed-work ceilings and avoid quadratic scans.

## Errors and conformance

Invalid input/definition is validation; source denial authorization without existence leakage; unavailable required source dependency failure; explicitly optional source may produce declared partial result/warning. Conformance covers multi-source authorization, consistency selection, partial/required failure, timeout, deterministic composition, projection, and safe errors.

Traceability: `packages/core/src/read-model`; read-model tests; R1 certification.
