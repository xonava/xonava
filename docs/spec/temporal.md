# Temporal history

Temporal revision is separate from an entity's OCC version. A resource is identified by trusted scope ID, entity type, and entity ID. Each monotonically increasing temporal revision records an authoritative full state after the change, its occurrence time, lifecycle kind (`created`, `updated`, `deleted`, or `restored`), and OPTIONAL OCC version, event ID, and audit ID. Deleted revisions have null state; all other kinds have state.

Stores append revisions transactionally with the business write, save acceleration snapshots, find the latest snapshot no later than a requested instant, and return bounded revision pages ordered after a revision. Implementations MUST enforce unique resource/revision identity and chronological, contiguous histories.

PostgreSQL and MySQL callers bind the store to the current transaction. D1 callers use `appendWithStatements` so business participant statements and the revision append run in one atomic D1 batch.

Point-in-time reconstruction uses the latest eligible snapshot and replays contiguous revisions through the inclusive requested instant. It rejects foreign/future records, gaps, malformed pages (including a page with more revisions than the requested limit), and replay beyond configured bounds. Validated revisions, snapshots, reconstructed state, and their timestamps MUST be defensive immutable snapshots; mutation through retained input references or returned `Date` values MUST NOT alter authoritative history. Deletion remains historical state and restoration creates a later non-null state. Snapshots are acceleration artifacts and MUST NOT change reconstruction results.

Provider conformance must prove transactional append, concurrent revision allocation, rollback, exact time boundaries, snapshot equivalence, pagination, tenant isolation, deletion/restoration, and crash recovery.
