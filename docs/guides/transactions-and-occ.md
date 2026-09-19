# Use transactions and OCC

Choose a provider whose declared capabilities meet the compiled operation. Supply the caller's expected version from the last authorized read. Execute the row predicate, scope predicate, authorization facts, version condition, mutation, idempotency receipt, audit, outbox, and cache generation in one transaction/batch when the plan requires it. Treat zero affected rows through the framework conflict/absence semantics; never retry blindly. On conflict, reread, reauthorize, and obtain a new expected version. Certify with real-provider race and crash tests.
