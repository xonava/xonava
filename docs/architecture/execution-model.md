# Execution model

An operation definition describes trusted input/output behavior, authorization, budgets, hooks, and required capabilities. An execution context carries an attenuated principal/scope, deadline, cancellation, services, telemetry, and effects. The operation produces a canonical result or structured error; transport adapters translate at the boundary.

```text
transport input → adapter validation → canonical operation input
  → authorization plan → scoped execution → result/effects
  → adapter response
```

Jobs, schedules, and workflows add durable identity, retry, progress, leases/fencing, and versioned state. Their state machines remain distinct even where they share lease primitives.
