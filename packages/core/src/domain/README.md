# Domain Layer

The domain layer owns framework decisions that must remain independent of HTTP, databases, queues, and Cloudflare runtime APIs.

It contains predicates, ABAC policy evaluation, structured errors, and domain value normalization. Domain code may depend on other core domain modules and core ports as types, but must not import adapter implementations or application modules.

Keep I/O behind ports. If a rule needs a database, cache, audit sink, or request object, expose the required capability through a port and keep the decision itself in this layer.
