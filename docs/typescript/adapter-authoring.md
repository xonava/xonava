# Adapter authoring profile

Import only public core subpaths. Implement the relevant contract, declare capabilities conservatively, validate configuration at construction, normalize vendor failures into canonical errors, preserve cancellation/deadlines, and expose bounded health information.

Persistence adapters additionally implement trusted scope predicates, transaction/rollback behavior, OCC, concurrency/fencing, and atomic effects exactly as claimed. Optional capabilities MUST be absent or reported unsupported—not emulated with weaker semantics.

Run unit tests, shared contract/conformance suites, real-provider integration and race tests, and crash/replay certification for durability claims. A reference adapter is not certified merely because it typechecks.
