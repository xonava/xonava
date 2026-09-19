# Business rules

Import the rule engine from `core/rules`. Compile definitions once during bootstrap and evaluate them with trusted facts and an explicit trusted timestamp.

```ts
import { Predicate } from "core/domain"
import { compileRuleSet, evaluateRuleSet } from "core/rules"

const eligibility = compileRuleSet({
  key: "orders.eligibility",
  version: 1,
  conflictResolution: { kind: "highest-priority", onPriorityTie: "error" },
  rules: [{
    key: "manual-review",
    version: 1,
    priority: 100,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    when: Predicate.gt("total", 10_000),
    actions: [{ type: "start-workflow", workflowKey: "orders.manual-review" }],
  }],
})

const decision = evaluateRuleSet(eligibility, { total: 12_500 }, requestContext.now)
```

`decision.actions` describes what the application may do. Dispatch those descriptions through authorized operations or workflow transitions. The engine does not execute actions, authorize callers, load facts, or read the system clock. Facts must already be authoritative and scoped for the evaluation.

Use multiple versions with the same rule key for scheduled changes. At a given evaluation time, the highest active version wins. Use conflict keys when several rules represent alternatives within one decision category. Choose `onPriorityTie: "error"` when equal priorities indicate faulty configuration; choose `rule-key` only when lexical key order is an intentional stable tie breaker.
