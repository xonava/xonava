# Entity model

## Data model

An entity definition declares stable name/identity, fields/scalars, scope, lifecycle, classification, capabilities, versioning, persistence/read-model metadata, and policy hooks. Compilation MUST validate identifiers, field collisions, scopes, transitions, dependencies, and runtime requirements, then produce an immutable plan.

## Requirements and errors

Default cache key prefixes and tags are namespaced by module and persistence namespace; an explicit cache key prefix MUST be unique across the application (see bootstrap), and a duplicate is a configuration failure naming both entities. Runtime MUST execute the compiled plan rather than reinterpret untrusted metadata. Create/update/read projection MUST enforce field rules and scope. Invalid definitions fail before readiness; invalid lifecycle transitions and values fail without partial mutation.

## Evolution and conformance

Definition changes that alter durable formats, identity, or policy require explicit migration/version decisions. Conformance covers valid/invalid definitions, immutability, lifecycle, scope, classification, fields, capability requirements, and read-model binding. Traceability: `core/entity`; E1/S1.
