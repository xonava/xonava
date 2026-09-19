# Kernel

## Validation contract

A validation schema exposes synchronous and asynchronous parsing of unknown input into a validated result or explicit failure. Parsing MUST NOT silently weaken security-sensitive values. Callers choose the synchronous operation only when the schema can complete synchronously.

## Definition cloning and integrity

Definition cloning MUST return a distinct graph for framework-owned arrays and plain objects, preserve property descriptors and symbol keys, preserve shared references/cycles within the clone, and leave the source unmodified. Every cloned framework-owned object/array MUST be deeply frozen. Non-plain/class instances are retained by reference in ordinary mode and are not claimed frozen.

Data-only mode MUST accept only primitives, arrays, and plain/null-prototype objects. It MUST reject accessors and non-plain objects so a security snapshot cannot execute getters or retain mutable class instances. Both modes MUST reject graphs deeper than 64 levels or exceeding 10,000 cloned framework-owned nodes. Cycles are supported through reference preservation, not recursively re-expanded.

## Errors and conformance

Invalid data-only values/accessors are type failures; resource ceilings are range failures; validation schemas return their declared validation failure. Conformance covers clone/source separation, deep freezing, descriptors/symbols, null prototypes, shared references, cycles, ordinary non-plain retention, data-only rejection, accessors, depth 64 boundary, and 10,000-node boundary.

Kernel semantics remain provider/transport/orchestration independent. Traceability: `packages/core/src/kernel`; kernel/compiler tests; fresh-core verification.
