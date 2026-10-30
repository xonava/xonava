---
"@xonava/adapters": patch
---

Fix MySQL scope parity for negated equality. With `mysqlBinaryCollation: true`, MySQL could return rows an ABAC read scope should exclude, for scopes combining negations and case-differing equality (for example `NOT owner = 'U1' OR (owner = 'U1' AND NOT owner <> 'u1')`), because its equality propagation compared the literals case-insensitively under the connection collation; text literals now carry `utf8mb4_0900_bin` explicitly.
