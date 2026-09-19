# Operation API

The root `core` and `core/operation` expose `createOperation`, `runOperation`, detailed outcomes, contexts, services, deadlines, budgets, resources, and invocation. Define validation/authorization/capabilities before the handler. Build services with `createOperationServices`, create only the phase-specific context exposed to hooks, and inspect detailed outcomes when post-commit warnings matter. `OperationCommittedEffectError` means primary state committed while a non-atomic effect failed; do not retry it as though no mutation occurred.
