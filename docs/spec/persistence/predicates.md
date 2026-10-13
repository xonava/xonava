# Predicates

Predicates are data, not executable source. Nodes use an explicit operator and operands. Implementations MUST validate field allowlists, value types, nesting depth, node count, disjunction count, and membership-list size before execution.

Mandatory scope and authorization predicates are combined with caller filters using logical AND and cannot be removed, weakened, or replaced by caller input. Empty destructive predicates and always-true destructive predicates are rejected unless an explicitly authorized all-row operation exists.

## Evaluation semantics

Every implementation — the in-memory evaluator, every SQL compiler, and every language port — MUST produce identical results. The conformance suite `predicate-semantics` (`packages/testing/conformance/vectors/predicate-semantics.json`) is normative; SQL compilers MUST additionally pass a differential test against the in-memory evaluator.

### Three-valued logic

A condition evaluates to TRUE, FALSE, or UNKNOWN. `and`, `or`, and `not` follow the Kleene truth tables (FALSE dominates `and`, TRUE dominates `or`, `not UNKNOWN` is UNKNOWN). An empty `and` is TRUE and an empty `or` is FALSE. Only the root of a predicate collapses UNKNOWN to "no match", exactly like a SQL `WHERE` clause. Implementations MUST NOT collapse UNKNOWN at leaves or inner nodes; doing so makes `not` admit rows whose values are unknown.

A field absent from a record is NULL. Implementations MUST read only the record's own fields (never inherited or prototype properties).

### Comparison

A comparison operator (`eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `between`, `in`, `isTrue`, `isFalse`) yields UNKNOWN when either operand is NULL or when the operands are not comparable. Operands are comparable only when they are of the same kind:

| Kind | Order |
|---|---|
| number | numeric; NaN is not comparable |
| string | case-sensitive Unicode code-point order (identical to UTF-8 byte order); never locale collation |
| boolean | `false < true` |
| instant | by time; an instant is also comparable with a strict RFC 3339 `full-date` (UTC midnight) or `date-time` string. Lenient host date parsing MUST NOT be used. |

Any other pair is not comparable: in particular the string `"100"` and the number `100` are different values (this prevents identifier type confusion), and structured values, arrays, and NaN are never comparable. Incomparable values MUST NOT compare as equal. Adapters MUST hydrate typed columns (for example SQL DECIMAL/NUMERIC, which many drivers return as strings) into the value kind the entity declares before in-memory evaluation.

### Temporal columns

Entities hydrate `date` fields as `YYYY-MM-DD` strings or as `Date` values at UTC midnight, and `datetime` fields as `Date` values. A SQL temporal column (date, timestamp/datetime, time) compares natively as a temporal value whenever the literal is a strict RFC 3339 `full-date` or `date-time`, or a `Date`. That matches the in-memory rule for those representations, and the column's index stays usable. Implementations MUST bind such literals in a time-zone-free form, never through a driver's local-time serialization. The engine's own text form of the column's type (what a string-mode column hydrates, and so what cursor values carry) also compares natively. Any other string compares with the column's text form when rows hydrate as strings, and is not comparable (UNKNOWN) when rows hydrate as `Date`. A `date` field compares as a calendar date: portable predicates compare it with `full-date` literals. A `date-time` literal against a date column is cast by the engine and is not portable. Engine-native enums (PostgreSQL) compare natively only for equality and membership, so indexes stay usable; a literal that is not a member equals no row. Ordering comparisons and sort keys use the label text by code point, exactly as in memory: declaration order would make an authorization scope such as `lessThan` disagree with the record decision. Temporal literals outside an engine's input range never reach it. PostgreSQL receives its own input form, including BC and five-digit years; an instant before its lower limit (4714-11-24 BC) compares against `-infinity` rather than as a constant, because PostgreSQL date/timestamp columns may hold `-infinity`/`infinity`, which are not above/below such an instant the way every finite value is (`gt`/`gte` select all rows except `-infinity`, `lt`/`lte` select only `-infinity`, `eq` nothing, `neq` every non-NULL row; NULL stays UNKNOWN under `not`). MySQL stores DATE/DATETIME years 0000-9999 (it documents only 1000-9999); an instant outside 0000-9999 compares as a constant, since every stored value lies inside it. Driver-text literals (the engine's own text form of the column, which string-mode rows hydrate and cursor values carry) are passed through only when the engine accepts them: on PostgreSQL its date/timestamp output form, including the ` BC` suffix and five-digit years, with offsets up to ±15:59 (one before the lower limit is the out-of-range comparison above); on MySQL years 0000-9999 and no offset. Otherwise they compare as text. A MySQL TIMESTAMP column compares in the connection's `time_zone` while literals are bound as UTC, so a MySQL deployment with TIMESTAMP columns MUST run its sessions in UTC (server `default-time-zone='+00:00'`, or `SET time_zone='+00:00'` on every new connection); in any other zone every instant is shifted and equality on a stored instant finds nothing. The adapter does not own the connection pool, so `assertMySqlUtcSession(db)` (from the MySQL adapter) verifies the session at startup. DATE/DATETIME columns are unaffected.

### Null tests

`isNull`, `isNotNull`, `isEmpty`, `isNotEmpty`, `eq(field, null)` and `neq(field, null)` are two-valued, like SQL `IS NULL` / `IS NOT NULL`. `isEmpty` is TRUE for NULL and the empty string.

### Text matching

`contains`, `startsWith`, and `endsWith` are case-sensitive and match literally (no wildcard characters). They yield UNKNOWN for a NULL or non-string field. An empty needle matches every non-null string. SQL compilers MUST NOT rely on case-insensitive `LIKE` (SQLite, and MySQL under a `_ci` collation); they must use an exact construct such as `instr`/`substr` or a binary collation.

### Membership

`in` is `field = ANY(list)` under three-valued logic. NULL members of the list are ignored. An empty list (after removing NULLs) is FALSE, even for a NULL field. A NULL field with a non-empty list is UNKNOWN. An array-valued field is not comparable with a scalar list.

### Resource limits

Evaluators MUST reject predicates nested more deeply than 256 levels with a validation error rather than exhausting the stack.
