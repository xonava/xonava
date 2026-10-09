import { expect } from "vitest"
import { BusinessRuleError, encodeExecutionScopeId } from "core/domain"
import type { AuditSinkFactory, OutboxRecord, OutboxSinkFactory } from "core/events"
import { createOperationContext, runOperation, type StandardMutationOperationDefinition } from "core/operation"
import type { PersistenceProvider, UnversionedEntityDescriptor } from "core/persistence"

export interface NestedItem { id: string; name: string }
export const nestedItemEntity: UnversionedEntityDescriptor<NestedItem> = { name: "nestedItem", primaryKey: "id", fields: { id: { type: "string" }, name: { type: "string" } } }

/** Maps the framework outbox record onto the business columns of the test outbox table. */
export const mapNestedOutboxRecord = (record: OutboxRecord): Record<string, unknown> => ({ eventType: record.type, eventVersion: record.version, aggregateType: record.aggregateType, aggregateId: record.aggregateId, payload: record.payload, occurredAt: record.occurredAt })

export interface NestedDurableEffectsHarness {
  readonly persistence: PersistenceProvider
  readonly auditSinkFactory: AuditSinkFactory
  readonly outboxSinkFactory: OutboxSinkFactory
  /** Rows for `id` in the business table, the audit table (resource id) and the outbox (aggregate id). */
  counts(id: string): Promise<{ items: number; audit: number; outbox: number }>
}

const scope = { kind: "platform", platformKey: "nested" } as const
const actor = { id: "nested-user", kind: "human", authentication: { kind: "authenticated", method: "session", authenticatedAt: "2026-09-10T00:00:00.000Z" } }
const allow = { authorize: async () => ({ allowed: true }) }

/**
 * A joined child writes a row, registers a durable outbox effect and has
 * atomic audit, so the real adapter sinks run on the parent's transaction:
 * all three commit with the parent, and none survive a parent rollback.
 */
export async function assertNestedDurableEffects(harness: NestedDurableEffectsHarness, prefix: string): Promise<void> {
  const { environment, parent } = nestedOperations(harness, prefix)

  const committed = `${prefix}-committed`
  await expect(runOperation({ operation: environment(), definition: parent(committed, false), input: {} })).resolves.toBe(committed)
  expect(await harness.counts(committed)).toEqual({ items: 1, audit: 1, outbox: 1 })

  const rolledBack = `${prefix}-rolled-back`
  await expect(runOperation({ operation: environment(), definition: parent(rolledBack, true), input: {} })).rejects.toThrow(BusinessRuleError)
  expect(await harness.counts(rolledBack)).toEqual({ items: 0, audit: 0, outbox: 0 })
}

/**
 * Without interactive transactions (D1) a child cannot join its parent's
 * transaction: the composition is refused before anything is written.
 */
export async function assertNestedDurableEffectsRefusedWithoutTransactions(harness: NestedDurableEffectsHarness, prefix: string): Promise<void> {
  const { environment, parent } = nestedOperations(harness, prefix)
  const id = `${prefix}-refused`
  await expect(runOperation({ operation: environment(), definition: parent(id, false), input: {} })).rejects.toThrow("requires interactive transactions")
  expect(await harness.counts(id)).toEqual({ items: 0, audit: 0, outbox: 0 })
}

function nestedOperations(harness: NestedDurableEffectsHarness, prefix: string) {
  const environment = () => ({
    ...createOperationContext({ persistence: harness.persistence, runtimeCapabilities: { deferredExecution: false, cache: false }, auditSinkFactory: harness.auditSinkFactory, outboxSinkFactory: harness.outboxSinkFactory }),
    request: { requestId: `${prefix}-request`, correlationId: `${prefix}-correlation`, identity: { actor, subject: actor }, scope, scopeId: encodeExecutionScopeId(scope) } as never,
  })
  const child: StandardMutationOperationDefinition<string, string> = {
    key: "nested-child", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
    audit: { action: "nested.child.create", resourceType: "nestedItem", auditGuarantee: "atomic", resolveResourceId: ({ input }) => input },
    execute: async ({ operation, input }) => {
      await operation.persistence.repository(nestedItemEntity).insert({ id: input, name: "child" })
      operation.addDurableEffect({ name: "child-created", outbox: { type: "nested.child.created", version: 1, tenantId: null, scope, scopeId: encodeExecutionScopeId(scope), aggregateType: "nestedItem", aggregateId: input, payload: { id: input }, idempotencyKey: `nested-${input}` } })
      return input
    },
  }
  const parent = (id: string, fail: boolean): StandardMutationOperationDefinition<Record<string, never>, string> => ({
    key: "nested-parent", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
    execute: async ({ operation }) => {
      const result = await operation.invoke(child, id)
      // A framework error: drizzle adapters report any other error escaping
      // the transaction as a sanitized PersistenceError.
      if (fail) throw new BusinessRuleError("parent failed after the child")
      return result
    },
  })
  return { environment, parent }
}
