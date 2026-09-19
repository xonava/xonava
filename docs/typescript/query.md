# Query API

`core/query` exports `QueryPlan`, budgets, projections, read consistency, pagination, cursors/codecs, and search contracts. Validate plans with `validateQueryPlan`; use `DEFAULT_QUERY_BUDGET` only when its limits fit the route. `resolveProjection` intersects requested/route/queryable/readable fields. Cursor encoding/decoding requires an integrity port; always validate binding and stable sort before provider execution. Provider adapters compile the neutral plan—callers never inject SQL.
