# Capability catalog and traceability

The codes in the table name certification suites, each run by `npm run verify:framework:<code in lowercase>` (for example `verify:framework:tx1`; Q1/Q2 is `verify:framework:q1-q2`), except V1, which has no standalone script; see the [certification guide](../guides/certification.md).

| Capability | Normative specification | TypeScript implementation | Conformance/certification | Status |
|---|---|---|---|---|
| Kernel/bootstrap | `kernel.md`, `bootstrap.md` | `@xonava/core/kernel`, `@xonava/core/bootstrap` | compiler/architecture/API gates | Current |
| Domain/entity/security | `domain.md`, `entity.md`, `security.md` | `@xonava/core/domain`, `@xonava/core/entity`, `@xonava/core/security` | E1/S1/V1 adversarial | Current |
| Cache | `cache.md` | `@xonava/core/cache`; `@xonava/adapters/cache` | C1/G1/V1 | Current |
| Rate limit/quota/resilience | respective spec pages | corresponding core folders | G1/B1 | Current |
| Telemetry | `telemetry.md` | `@xonava/core/telemetry` | T1 | Current |
| Object store/attachments | `object-store.md`, `attachments.md` | `@xonava/core/object-store`, `@xonava/core/storage` | O1 | Current |
| Health/secrets/flags/calendar | `health.md`, `secrets.md`, `feature-flags.md`, `business-calendar.md` | corresponding core folders | H1 | Current |
| Persistence/transactions/OCC | persistence and transaction pages | `@xonava/core/persistence`; three database adapters | TX1/V1/MYSQL1/backend suites | Current |
| Query | `query.md` | `@xonava/core/query`; adapter pagination | Q1/Q2 | Current |
| Read model | `read-model.md` | `@xonava/core/read-model` | R1 | Current |
| Events/durability | `events.md` | `@xonava/core/events`; provider stores | EV1/C1/V1 | Current |
| Operations | `operations.md` | `@xonava/core/operation` | OP1/S1/T1 | Current |
| Jobs/schedules | `execution.md` | `@xonava/core/execution`; provider stores | L1/J1 | Current |
| Workflow | `workflow.md` | `@xonava/core/workflow`; provider stores | W1 | Current |
| Business rules | `rules.md` | `@xonava/core/rules` | RL1 | Current |
| Aggregate consistency | `aggregate.md` | `@xonava/core/aggregate`; existing transaction/atomic-batch providers | AG1 | Current |
| Temporal history | `temporal.md` | `@xonava/core/temporal`; PostgreSQL, MySQL, and D1 stores | TH1/provider suites | Current |
| Scoped numbering | `sequence.md` | `@xonava/core/sequence`; PostgreSQL, MySQL, and D1 stores | N1/provider suites | Current |
| Serialization/formats | serialization page | `@xonava/core/serialization` | F1 | Current |

Document filenames are relative to `docs/spec`.
