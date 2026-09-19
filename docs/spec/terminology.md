# Terminology

- **Core:** neutral contracts and semantics.
- **Capability:** a cohesive independently consumable behavior family.
- **Contract/port:** a boundary an implementation satisfies; “port” does not imply a global import namespace.
- **Adapter:** technology-specific implementation or translation of a contract.
- **Reference adapter:** maintained proof/example implementation.
- **Provider:** external runtime or service behind an adapter.
- **Operation:** authorized, bounded unit of application behavior.
- **Execution:** one invocation with context, scope, budget, services, and effects.
- **Principal:** authenticated actor identity and trusted attributes.
- **Scope:** authority boundary, including tenant/application constraints.
- **Resource:** protected domain object or capability target.
- **Query:** bounded declarative read request.
- **Conformance:** behavioral satisfaction of a contract suite.
- **Certification:** evidence that a named implementation/configuration satisfies a guarantee set.
- **Normative specification:** required observable semantics.
- **Reference implementation:** current TypeScript realization of this specification.
- **Language profile:** mapping of neutral concepts to one language/API.
