# Capability catalog and traceability

The last column names what covers each capability. The conformance suites that cover them run with `npm run test:conformance:<pg|mysql|d1>`; see [how releases are checked](../guides/release-checks.md).

| Capability | Normative specification | TypeScript implementation | Covered by | Status |
|---|---|---|---|---|
| Kernel/bootstrap | `kernel.md`, `bootstrap.md` | `@xonava/core/kernel`, `@xonava/core/bootstrap` | compiler/architecture/API gates | Current |
| Domain/entity/security | `domain.md`, `entity.md`, `security.md` | `@xonava/core/domain`, `@xonava/core/entity`, `@xonava/core/security` | entity, security and adversarial suites | Current |
| Cache | `cache.md` | `@xonava/core/cache`; `@xonava/adapters/cache` | cache and adversarial suites | Current |
| Rate limit/quota/resilience | respective spec pages | corresponding core folders | rate-limit, quota and resilience suites | Current |
| Telemetry | `telemetry.md` | `@xonava/core/telemetry` | telemetry suites | Current |
| Object store/attachments | `object-store.md`, `attachments.md` | `@xonava/core/object-store`, `@xonava/core/storage` | object-store and attachment suites | Current |
| Health/secrets/flags/calendar | `health.md`, `secrets.md`, `feature-flags.md`, `business-calendar.md` | corresponding core folders | health, secrets, flags and calendar suites | Current |
| Persistence/transactions/OCC | persistence and transaction pages | `@xonava/core/persistence`; three database adapters | transaction, OCC and backend suites | Current |
| Query | `query.md` | `@xonava/core/query`; adapter pagination | query and cursor suites | Current |
| Read model | `read-model.md` | `@xonava/core/read-model` | read-model suites | Current |
| Events/durability | `events.md` | `@xonava/core/events`; provider stores | event, delivery and adversarial suites | Current |
| Operations | `operations.md` | `@xonava/core/operation` | operation, security and telemetry suites | Current |
| Jobs/schedules | `execution.md` | `@xonava/core/execution`; provider stores | job and schedule suites | Current |
| Workflow | `workflow.md` | `@xonava/core/workflow`; provider stores | workflow suites | Current |
| Business rules | `rules.md` | `@xonava/core/rules` | rule-engine suites | Current |
| Aggregate consistency | `aggregate.md` | `@xonava/core/aggregate`; existing transaction/atomic-batch providers | aggregate suites | Current |
| Temporal history | `temporal.md` | `@xonava/core/temporal`; PostgreSQL, MySQL, and D1 stores | temporal and provider suites | Current |
| Scoped numbering | `sequence.md` | `@xonava/core/sequence`; PostgreSQL, MySQL, and D1 stores | sequence and provider suites | Current |
| Serialization/formats | serialization page | `@xonava/core/serialization` | serialization suites | Current |

Document filenames are relative to `docs/spec`.
