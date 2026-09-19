# Predicates

Predicates are data, not executable source. Nodes use an explicit operator and operands. Implementations MUST validate field allowlists, value types, nesting depth, node count, disjunction count, and membership-list size before execution.

Mandatory scope and authorization predicates are combined with caller filters using logical AND and cannot be removed, weakened, or replaced by caller input. Empty destructive predicates and always-true destructive predicates are rejected unless an explicitly authorized all-row operation exists.
