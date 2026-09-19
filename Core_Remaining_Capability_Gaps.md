# Core — Remaining Capability Gaps (Repo-Verified)

## Purpose

The original *Enterprise Core Capability Gap Analysis* described a core that
had only Entity, Operation, basic Policy, basic Audit, and Adapter
foundations, and recommended eight additions on top of that.

A direct inspection of `Core.zip` (`docs/reference/capabilities.md` and
`packages/core/src`) shows the core is already substantially further along
than that description. Six of the eight originally proposed capabilities
are already built and certified:

| Originally proposed | Actual status in repo |
|---|---|
| Workflow Engine | Built — `core/workflow` (state machine, timers, fenced compensation), certified W1 |
| Event Lifecycle Management | Built — `core/events` + `durability/` (outbox/inbox, idempotency, versioning), certified EV1 |
| Enhanced Operation / Command Model | Built — `core/operation` (pipeline, atomic batch, authorization-plan enforcement), certified OP1 |
| Advanced Policy Engine | Built, and further along — full ABAC in `core/domain` + `core/security` (conditions, decisions, delegation, scope resolution) |
| Audit and Compliance Model | Built — `events/durability/audit.ts`, atomic with its transaction |
| (not listed) | Also already present: persistence/OCC, query, read-model, object-store/attachments, rate-limit/quota/resilience, telemetry, secrets, feature-flags, health, business-calendar, serialization, jobs/schedules, entity lifecycle (soft-delete/append-only), data classification, delegation of authority, artifact-retention governance |

This document supersedes those six sections. It only specifies the
capabilities that a full repo review confirms are genuinely **not**
present anywhere in `packages/core/src`.

------------------------------------------------------------------------

# Genuine Remaining Gaps

------------------------------------------------------------------------

# 1. Business Rule Engine — Implemented (`core/rules`, RL1)

## Delivered capability

The core can authorize an action (`core/domain` ABAC) and it can execute
an action (`core/operation`). Neither answers a third, distinct question:

"Given these conditions, what should automatically happen?"

`core/rules` now compiles versioned, effective-dated declarative rules,
evaluates them against trusted facts using the shared predicate language,
resolves conflicts deterministically, and returns immutable declarative
actions plus a complete decision trace. Effects remain the responsibility
of authorized operations or workflow transitions.

------------------------------------------------------------------------

## Why It Belongs in Core

Rule evaluation is a generic, cross-domain execution primitive, not
business logic itself — exactly the same relationship the core already
has with entities, operations, and workflows:

-   Eligibility determination
-   Approval thresholds
-   Derived/calculated fields
-   Conditional automated actions
-   Validation decisions that depend on more than one field

------------------------------------------------------------------------

## Core Responsibility

Provide:

-   A rule definition model (conditions + resulting actions)
-   An expression/condition evaluator (reusing the existing predicate
    infrastructure in `core/domain/predicate.ts` where possible, rather
    than inventing a second condition language)
-   Rule priority and conflict resolution
-   Rule versioning
-   Effective-dating (a rule is active only within a date range)
-   A deterministic, side-effect-free evaluation contract, consistent with
    how `operation` and `workflow` already separate pure decision-making
    from effectful execution

------------------------------------------------------------------------

## Outside Core

Adapters/domains define:

-   The actual business rules
-   Domain-specific calculations
-   What a "triggered action" concretely does (that's an operation or
    workflow transition, not the rule engine's concern)

------------------------------------------------------------------------

# 2. Temporal Data and Point-in-Time Query — Implemented (`core/temporal`, TH1)

## Delivered capability

`core/temporal` separates historical revision numbers from optimistic-
concurrency versions, records full lifecycle states, supports bounded
snapshot-assisted reconstruction at an exact instant, and detects gaps or
foreign history. PostgreSQL, MySQL, and D1 stores allocate revisions
atomically and expose transaction-bound writes for business coupling.

------------------------------------------------------------------------

## Why It Belongs in Core

Point-in-time reconstruction is a generic system capability, independent
of any specific industry or entity type — the same argument already
applied to OCC, audit, and event durability.

------------------------------------------------------------------------

## Core Responsibility

Provide:

-   A defined relationship between entity versions, audit records, and the
    event log sufficient to answer "state as of time T"
-   Snapshotting strategy (so reconstruction doesn't require replaying an
    unbounded event history)
-   A revision/history read API, distinct from the OCC version used for
    write conflict detection
-   Explicit interaction rules with the existing lifecycle policies
    (`soft-delete`, `append-only`) so history remains correct under
    deletion/restoration

------------------------------------------------------------------------

## Outside Core

Adapters define:

-   Which fields/entities require history retention
-   Retention duration and archival rules
-   Domain-specific interpretation of a historical snapshot

------------------------------------------------------------------------

# 3. Aggregate / Consistency Boundary Model — Implemented (`core/aggregate`, AG1)

## Delivered capability

The core already has the *mechanics* for cross-entity consistency:
`atomicBatchOperationPipeline` (atomic multi-effect operations) and
workflow compensation (explicit, ordered rollback of already-committed
steps). What's missing is the *modeling* layer above those mechanics: a
named way to declare which entities form one consistency boundary and
what invariants must hold across them as a group.

`core/aggregate` now declares named, versioned member boundaries and
phase-specific cross-entity invariants. It validates proposed atomic-batch
transitions and can run authoritative before/after checks inside an existing
serializable provider transaction, with failures thrown before commit.

------------------------------------------------------------------------

## Why It Belongs in Core

Without a declared boundary, nothing stops two different operations from
independently violating an invariant that spans multiple entities, since
there's no single place that owns "this group must stay consistent."

------------------------------------------------------------------------

## Core Responsibility

Provide:

-   An aggregate boundary declaration (which entities compose one
    consistency unit)
-   Cross-entity invariant checks evaluated as part of the existing atomic
    batch / transaction machinery, rather than a new commit mechanism
-   A defined failure/recovery contract when an aggregate-level invariant
    fails mid-transaction, consistent with the compensation model
    workflow already uses

------------------------------------------------------------------------

## Outside Core

Adapters/domains define:

-   Which entities actually belong to a given aggregate
-   The specific invariants that must hold
-   Domain-specific compensation logic when a step fails

------------------------------------------------------------------------

# 4. Sequence / Numbering Service — Implemented (`core/sequence`, N1)

## Delivered capability

`core/sequence` provides tenant-scoped, named counters with UTC reset
periods, optional prefixes and padding, and transaction-bound provider
allocation. PostgreSQL, MySQL, and D1 implementations serialize competing
allocations per scope and period; rollback tests prove that an uncommitted
number is reusable where the provider exposes interactive transactions.

------------------------------------------------------------------------

## Why It Belongs in Core

Every domain eventually needs human-readable sequential numbers, and
getting this right under concurrency (no duplicates, no silently skipped
numbers when a transaction rolls back) is exactly the kind of
infrastructure-grade problem the core already solves for OCC and
transactions — it shouldn't be re-solved per adapter.

------------------------------------------------------------------------

## Core Responsibility

Provide:

-   A scoped sequence/counter primitive with defined behavior under
    concurrent access and rollback
-   Optional formatting (prefix, padding, reset period) as configuration,
    not policy baked into the core

------------------------------------------------------------------------

## Outside Core

Adapters/domains define:

-   What the numbers are used for
-   Format/prefix conventions specific to a document type

------------------------------------------------------------------------

# Updated Recommended Core Scope

    Core Engine  (existing + certified)
    |
    +-- Entity Model, Operation Model, Workflow Engine
    +-- Event Lifecycle, Persistence/Transactions/OCC
    +-- ABAC Policy Engine, Delegation of Authority, Audit
    +-- Query, Read Model, Object Store/Attachments
    +-- Rate Limit/Quota/Resilience, Telemetry, Secrets
    +-- Feature Flags, Health, Business Calendar, Serialization
    +-- Adapter Contracts
    |
    +-- [NEW] Business Rule Engine
    +-- [NEW] Temporal Data / Point-in-Time Query
    +-- [NEW] Aggregate / Consistency Boundary Model
    +-- [NEW, optional] Sequence / Numbering Service

------------------------------------------------------------------------

# Final Principle (unchanged)

The core should answer "how does a business system execute safely?" while
the adapters and applications answer "what business does the system
perform?" Nothing above changes that boundary — it only corrects which
generic execution capabilities are still missing versus already delivered.
