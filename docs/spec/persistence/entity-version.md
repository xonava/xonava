# Entity version

An entity version is a positive safe integer. A versioned mutation supplies the expected version and changes a row only when scope, authorization predicate, row identity, and expected version all match in the same backend condition.

A successful mutation increments exactly once. Zero matches is a conflict or not-found result according to the authorized observation policy. Bulk versioned mutations carry an expected version per row; atomic mode never reports a mixture of applied and rejected items.
