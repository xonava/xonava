# Business rules

## Definition and compilation

A rule set has a stable non-empty key, positive integer version, explicit conflict-resolution policy, and a bounded collection of rules. Each rule has a stable key, positive integer version, integer priority, predicate condition, one or more declarative data-only actions, OPTIONAL conflict key, OPTIONAL description, and OPTIONAL effective window. Effective timestamps MUST be canonical ISO-8601 instants. `effectiveFrom` is inclusive and `effectiveUntil` is exclusive. A finite window MUST be increasing.

Compilation MUST reject malformed predicates, duplicate `(rule key, rule version)` identities, executable or accessor-backed action data, non-plain data, invalid dates, non-finite numbers, and structures outside documented bounds. Compilation MUST defensively snapshot and freeze framework-owned definition data. Only values returned by `compileRuleSet` are accepted for evaluation.

## Evaluation

Evaluation is deterministic and side-effect-free. The caller MUST provide a trusted valid evaluation timestamp; the engine MUST NOT consult the ambient clock. Facts MUST be defensively snapshotted before predicate evaluation and MUST contain data only. Predicate evaluation uses the canonical `core/domain` predicate semantics, including UNKNOWN collapsing to no match.

For each rule key, the highest active version is current. Inactive versions are ignored; lower active versions are superseded. Current matching rules are ordered by descending priority, then lexical rule key, then descending version.

Conflict resolution is explicit:

- `all-matches` selects every match in deterministic order.
- `highest-priority` selects one match globally.
- `highest-priority-per-key` selects one match for each conflict key; a rule without a conflict key forms its own independent group.

Single-winner policies MUST declare whether equal priority is resolved by lexical rule key or rejected as an ambiguity. The engine returns actions as descriptions only. An operation or workflow MAY interpret them, but rule evaluation MUST NOT execute effects.

## Result and trace

The immutable result identifies the rule-set key/version and evaluation time and contains selected matches, flattened actions, and one trace entry for every declared rule in declaration order. Trace dispositions are exactly inactive, superseded, not-matched, selected, or conflict-discarded. Returned definition, action, match, and trace objects MUST be defensive immutable snapshots.

## Limits and certification

A rule set contains at most 10,000 rules. A rule contains between 1 and 100 actions. Predicate trees contain at most 1,000 nodes and depth 32. Rule data snapshots contain at most 10,000 nodes and depth 64. Keys contain at most 200 restricted identifier characters; descriptions contain at most 500 characters.

RL1 certifies version/effective-window selection, deterministic ordering, all conflict modes and tie behavior, predicate reuse, decision/effect separation, immutable defensive snapshots, malformed-input rejection, and complete traces. Traceability: `core/rules`; RL1.
