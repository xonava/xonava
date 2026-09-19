# Capability catalog and traceability

| Capability | Normative specification | TypeScript implementation | Conformance/certification | Status |
|---|---|---|---|---|
| Kernel/bootstrap | `kernel.md`, `bootstrap.md` | `core/kernel`, `core/bootstrap` | compiler/architecture/API gates | Current |
| Domain/entity/security | `domain.md`, `entity.md`, `security.md` | `core/domain`, `core/entity`, `core/security` | E1/S1/V1 adversarial | Current |
| Cache | `cache.md` | `core/cache`; `adapters/cache` | C1/G1/V1 | Current |
| Rate limit/quota/resilience | respective spec pages | corresponding core folders | G1/B1 | Current |
| Telemetry | `telemetry.md` | `core/telemetry` | T1 | Current |
| Object store/attachments | `object-store.md`, `attachments.md` | `core/object-store`, `core/storage` | O1 | Current |
| Health/secrets/flags/calendar | `health.md`, `secrets.md`, `feature-flags.md`, `business-calendar.md` | corresponding core folders | H1 | Current |
| Persistence/transactions/OCC | persistence and transaction pages | `core/persistence`; three database adapters | TX1/V1/MYSQL1/backend suites | Current |
| Query | `query.md` | `core/query`; adapter pagination | Q1/Q2 | Current |
| Read model | `read-model.md` | `core/read-model` | R1 | Current |
| Events/durability | `events.md` | `core/events`; provider stores | EV1/C1/V1 | Current |
| Operations | `operations.md` | `core/operation` | OP1/S1/T1 | Current |
| Jobs/schedules | `execution.md` | `core/execution`; provider stores | L1/J1 | Current |
| Workflow | `workflow.md` | `core/workflow`; provider stores | W1 | Current |
| Business rules | `rules.md` | `core/rules` | RL1 | Current |
| Aggregate consistency | `aggregate.md` | `core/aggregate`; existing transaction/atomic-batch providers | AG1 | Current |
| Temporal history | `temporal.md` | `core/temporal`; PostgreSQL, MySQL, and D1 stores | TH1/provider suites | Current |
| Scoped numbering | `sequence.md` | `core/sequence`; PostgreSQL, MySQL, and D1 stores | N1/provider suites | Current |
| Serialization/formats | serialization page | `core/serialization` | F1 | Current |

Document filenames are relative to `docs/spec`.
