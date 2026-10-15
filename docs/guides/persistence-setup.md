# Persistence setup

Choose `@xonava/adapters/drizzle-pg`, `@xonava/adapters/drizzle-mysql`, or `@xonava/adapters/drizzle-d1`, create provider-specific schema/fixtures, and configure a trusted datasource route. Use dedicated databases for certification.

Do not claim capabilities from driver presence alone. Verify interactive transaction or atomic-batch behavior, conditional OCC, authorized predicates, atomic idempotency/audit/outbox/cache generation, race behavior, and process-crash recovery as applicable. Provider operational tuning, migrations, credentials, pooling, and availability remain adapter/operator responsibilities.
