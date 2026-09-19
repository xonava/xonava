# Quota

## Scope and requirements

A quota contract evaluates consumption against a scoped allowance. Scope, unit, amount, period, and result MUST be explicit. Implementations MUST reject invalid/negative consumption and MUST preserve declared atomicity under concurrency. Enforcement failure behavior MUST be explicit; security-sensitive limits SHOULD fail closed.

The result MUST distinguish allowed, exhausted, remaining amount, and renewal/reset information where periodic. Consumption at exactly the allowance is permitted unless policy explicitly reserves capacity; consumption beyond it is denied. Weighted amount MUST use an exact bounded numeric representation appropriate to the unit.

## Errors and conformance

Invalid scope/unit/amount/period is validation failure; unsupported atomicity capability failure; provider faults follow explicit fail policy. Conformance covers boundary equality, exceedance, concurrent consumption, period rollover, scoped isolation, invalid backend results, and failure mode.

Traceability: `packages/core/src/quota`; capability contract tests.
