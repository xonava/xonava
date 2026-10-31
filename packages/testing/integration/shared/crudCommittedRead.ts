import { describe, expect, it } from "vitest"
import { z } from "zod"
import { defineEntity } from "@xonava/core/entity"
import type { EntityDescriptor, PersistenceProvider, VersionedEntityDescriptor } from "@xonava/core/persistence"
import { CRUD } from "../../../adapters/src/http/crud.js"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "../../../adapters/src/http/__tests__/canonicalRequest.js"

/**
 * Built-in CRUD create/update must answer with the committed row. The initial
 * response is built inside the operation's transaction, so a driver that gives
 * each connection its own transaction visibility (PostgreSQL, MySQL) must
 * still return the row, for tenant-scoped and platform-scoped entities alike.
 */
export type CrudCommittedReadDriver = {
  /** Provider whose registry maps the entities "ccrTenantItem" and "ccrPlatformItem" to tables (id, [tenant_id], name, version). */
  provider(): PersistenceProvider
}

type TenantRow = { id: string; tenantId: string; name: string; version: number }
type PlatformRow = { id: string; name: string; version: number }

const tenantFields = { id: { type: "string" }, tenantId: { type: "string" }, name: { type: "string" }, version: { type: "number" } } as const
const platformFields = { id: { type: "string" }, name: { type: "string" }, version: { type: "number" } } as const
const bodies = {
  createBody: z.object({ name: z.string() }),
  updateBody: z.object({ name: z.string() }),
  idParams: z.object({ id: z.string() }),
}

export const CRUD_COMMITTED_READ_TENANT_ENTITY = "ccrTenantItem"
export const CRUD_COMMITTED_READ_PLATFORM_ENTITY = "ccrPlatformItem"
export const crudCommittedReadTenantDescriptor: EntityDescriptor<TenantRow> = { name: CRUD_COMMITTED_READ_TENANT_ENTITY, primaryKey: "id", tenantField: "tenantId", versionField: "version", fields: tenantFields }
export const crudCommittedReadPlatformDescriptor: EntityDescriptor<PlatformRow> = { name: CRUD_COMMITTED_READ_PLATFORM_ENTITY, primaryKey: "id", versionField: "version", fields: platformFields }

type NamedRow = { id: string; name: string }

/**
 * A `projectCommittedResult` hook that re-reads the written row through its
 * context persistence and returns a field derived from what it read. The field
 * is absent from the response unless the hook saw the just-written row.
 */
const projectHookSawRow = async ({ result, context }: { result: NamedRow; context: { persistence: { repository: (entity: never) => { findById: (id: string) => Promise<NamedRow | null> } } } }, descriptor: unknown) => {
  const reread = await context.persistence.repository(descriptor as never).findById(result.id)
  return { ...result, hookSaw: reread ? `saw:${reread.name}` : "missing" }
}

function handlersFor(driver: CrudCommittedReadDriver, kind: "tenant" | "platform", withHook = false) {
  const session = kind === "tenant" ? trustedSession({ kind: "tenant", tenantId: "tenant-1" }) : trustedSession({ kind: "platform", platformKey: "test" })
  const moduleKey = `ccr.${kind}`
  const runtime = {
    adapterDeps: { assertValidCsrf: () => undefined, resolveModuleAuthorizationFacts: allowAllModuleFacts, resolveAbacBundle: ({ moduleKey: key }: { moduleKey: string }) => allowAllAbacBundle(key) },
    requestNormalization: canonicalRequestNormalization(session, moduleKey),
    scope: { scope: kind, idempotency: { required: false } } as const,
    createPersistence: () => driver.provider(),
    getCacheAdapter: () => Promise.reject(new Error("cache is disabled")),
  }
  return kind === "tenant"
    ? CRUD(defineEntity<TenantRow, { name: string }, { name: string }>({
        moduleKey,
        entity: crudCommittedReadTenantDescriptor,
        entityScope: { kind: "tenant" }, policy: { skipCapabilityCheck: true }, cache: false, audit: false, validation: bodies,
        ...(withHook ? { entity: { ...crudCommittedReadTenantDescriptor, fields: { ...tenantFields, hookSaw: { type: "string" } } } as never, crud: { create: { projectCommittedResult: (args: never) => projectHookSawRow(args, crudCommittedReadTenantDescriptor) }, update: { projectCommittedResult: (args: never) => projectHookSawRow(args, crudCommittedReadTenantDescriptor) } } as never } : {}),
      }), runtime as never)
    : CRUD(defineEntity<PlatformRow, { name: string }, { name: string }>({
        moduleKey,
        entity: crudCommittedReadPlatformDescriptor,
        entityScope: { kind: "platform", acknowledged: true }, policy: { skipCapabilityCheck: true }, cache: false, audit: false, validation: bodies,
        ...(withHook ? { entity: { ...crudCommittedReadPlatformDescriptor, fields: { ...platformFields, hookSaw: { type: "string" } } } as never, crud: { create: { projectCommittedResult: (args: never) => projectHookSawRow(args, crudCommittedReadPlatformDescriptor) }, update: { projectCommittedResult: (args: never) => projectHookSawRow(args, crudCommittedReadPlatformDescriptor) } } as never } : {}),
      }), runtime as never)
}

const json = (method: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://example.test/items", { method, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } })

export function defineCrudCommittedReadSuite(label: string, driver: CrudCommittedReadDriver): void {
  describe(`${label}: built-in CRUD reads the committed row inside the writing transaction`, () => {
    for (const kind of ["tenant", "platform"] as const) {
      it(`create answers the created ${kind}-scoped row`, async () => {
        const handlers = handlersFor(driver, kind)
        const response = await handlers.create(json("POST", { name: "created" }))
        const body = await response.json() as Record<string, unknown>
        expect(body).not.toHaveProperty("error")
        expect(response.status).toBe(201)
        expect(body).not.toHaveProperty("reason")
        expect(body).toMatchObject({ name: "created", version: 1 })
        expect(typeof body.id).toBe("string")
      })

      it(`update answers the updated ${kind}-scoped row`, async () => {
        const handlers = handlersFor(driver, kind)
        // Seed directly so the update test does not depend on create's response.
        const seed = kind === "tenant" ? { id: `seed-${kind}-${crypto.randomUUID()}`, tenantId: "tenant-1", name: "before", version: 1 } : { id: `seed-${kind}-${crypto.randomUUID()}`, name: "before", version: 1 }
        const created = { id: seed.id }
        await driver.provider().repository((kind === "tenant" ? crudCommittedReadTenantDescriptor : crudCommittedReadPlatformDescriptor) as VersionedEntityDescriptor<Record<string, unknown>>).insert(seed as never)
        const response = await handlers.update(json("PATCH", { name: "after" }, { "if-match": '"1"' }), { params: Promise.resolve({ id: created.id }) })
        const body = await response.json() as Record<string, unknown>
        expect(body).not.toHaveProperty("error")
        expect(response.status).toBe(200)
        expect(body).not.toHaveProperty("reason")
        expect(body).toMatchObject({ id: created.id, name: "after", version: 2 })
      })

      it(`create projectCommittedResult hook reads the just-created ${kind}-scoped row through its context persistence`, async () => {
        const handlers = handlersFor(driver, kind, true)
        const response = await handlers.create(json("POST", { name: "hooked" }))
        const body = await response.json() as Record<string, unknown>
        expect(body).not.toHaveProperty("error")
        expect(response.status).toBe(201)
        expect(body).toMatchObject({ name: "hooked", version: 1, hookSaw: "saw:hooked" })
        expect(body).not.toHaveProperty("hookPersistence")
      })

      it(`update projectCommittedResult hook reads the just-updated ${kind}-scoped row through its context persistence`, async () => {
        const handlers = handlersFor(driver, kind, true)
        const seed = kind === "tenant" ? { id: `hook-${kind}-${crypto.randomUUID()}`, tenantId: "tenant-1", name: "before", version: 1 } : { id: `hook-${kind}-${crypto.randomUUID()}`, name: "before", version: 1 }
        await driver.provider().repository((kind === "tenant" ? crudCommittedReadTenantDescriptor : crudCommittedReadPlatformDescriptor) as VersionedEntityDescriptor<Record<string, unknown>>).insert(seed as never)
        const response = await handlers.update(json("PATCH", { name: "after" }, { "if-match": '"1"' }), { params: Promise.resolve({ id: seed.id }) })
        const body = await response.json() as Record<string, unknown>
        expect(body).not.toHaveProperty("error")
        expect(response.status).toBe(200)
        expect(body).toMatchObject({ id: seed.id, name: "after", version: 2, hookSaw: "saw:after" })
        expect(body).not.toHaveProperty("hookPersistence")
      })
    }
  })
}
