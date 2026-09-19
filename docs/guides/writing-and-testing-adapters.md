# Writing and testing an adapter

1. Select the neutral contract and read its normative specification.
2. Import only its public `core/<capability>` entry point.
3. Map provider operations and errors without weakening semantics.
4. Declare only capabilities the implementation actually guarantees.
5. Add provider-local unit/integration tests.
6. Run shared conformance suites.
7. Add race and crash/replay tests for concurrency/durability.
8. Produce source-bound certification evidence.

For HTTP, translate request data to canonical operation input and map canonical output/errors back to HTTP. Do not place request/response objects in core operations.
