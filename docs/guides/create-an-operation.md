# Create a minimal operation

1. Define/compile the entity or input contract.
2. Declare operation kind, validation, authorization, atomicity, services, budget, and handler through `createOperation`.
3. Resolve principal/scope at the trusted transport boundary.
4. Supply operation services and run through `runOperation` or `runOperationDetailed`.
5. Translate the canonical result/error in the transport adapter.

Do not pass HTTP request/response objects into the operation. Use detailed outcomes when callers must distinguish committed primary state from post-commit effect warnings. Add unit tests for handler logic and integration/conformance coverage for provider effects.
