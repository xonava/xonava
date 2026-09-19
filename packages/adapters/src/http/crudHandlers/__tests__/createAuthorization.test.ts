/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import { describe, expect, it, vi } from "vitest"
import type { EntityDescriptor, PersistenceProvider } from "core/persistence"
import { ForbiddenError } from "core/domain"
import { assertProtectedCreateFields } from "../shared"
import type { FrameworkAdapterDeps, TrustedFrameworkSession } from "../../../server"
import { createFrameworkWriteHandler } from "../../createFrameworkWriteHandler"
import { canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

type TestRow = {
  id: string
  tenantId: string
  version: number
  immutableCode: string
  name: string
}

const entity: EntityDescriptor<TestRow> = {
  name: "create-authorization-test",
  primaryKey: "id",
  tenantField: "tenantId",
  versionField: "version",
  immutableFields: ["immutableCode"],
  fields: {
    id: { type: "string" },
    tenantId: { type: "string" },
    version: { type: "number" },
    immutableCode: { type: "string" },
    name: { type: "string" },
  },
}

function session(): TrustedFrameworkSession { return trustedSession({ kind: "tenant", tenantId: "tenant-1" }) }

describe("CRUD create authorization", () => {
  it.each(["id", "tenantId", "version", "immutableCode"])(
    "rejects client-supplied %s",
    (field) => {
      expect(() => assertProtectedCreateFields(entity, { [field]: "client" })).toThrow(
        ForbiddenError,
      )
    },
  )

  it("fails closed when a capability-enabled write has no ABAC bundle", async () => {
    const execute = vi.fn()
    const deps: FrameworkAdapterDeps = {
      assertValidCsrf: vi.fn(),
      resolveAbacBundle: vi.fn(async () => null),
      resolveModuleAuthorizationFacts: vi.fn(() => ({ enabledModuleKeys: ["test.create-authorization"], enabledModuleActions: { "test.create-authorization": ["create"] }, enabledModuleCapabilities: { "test.create-authorization": ["manage"] } })),
    }
    const handler = createFrameworkWriteHandler({
      adapterDeps: deps,
      requestNormalization: canonicalRequestNormalization(session(), "test.create-authorization"),
      scope: { scope: "tenant" },
      moduleKey: "test.create-authorization",
      action: "create",
      customCapabilityKey: "manage",
      createPersistence: vi.fn(() => ({} as PersistenceProvider)),
      definition: { key: "test.create", execute } as never,
      resolveInput: vi.fn(async () => ({})),
    })

    const response = await handler(
      new Request("https://example.test/items", { method: "POST" }),
    )

    expect(response.status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it("fails closed when a skip-capability write has no ABAC bundle", async () => {
    const execute = vi.fn()
    const deps: FrameworkAdapterDeps = {
      assertValidCsrf: vi.fn(),
      resolveAbacBundle: vi.fn(async () => null),
    }
    const handler = createFrameworkWriteHandler({
      adapterDeps: deps,
      requestNormalization: canonicalRequestNormalization(session(), "test.create-authorization"),
      scope: { scope: "tenant" },
      moduleKey: "test.create-authorization",
      action: "create",
      skipCapabilityCheck: true,
      createPersistence: vi.fn(() => ({} as PersistenceProvider)),
      definition: { key: "test.create", execute } as never,
      resolveInput: vi.fn(async () => ({})),
    })

    const response = await handler(
      new Request("https://example.test/items", { method: "POST" }),
    )

    expect(response.status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it("does not let an impersonated owner bypass ABAC", async () => {
    const execute = vi.fn()
    const resolveAbacBundle = vi.fn(async () => null)
    const impersonated = trustedSession({ kind: "tenant", tenantId: "tenant-1" }, "platform-admin-1", "actor-1")
    const deps: FrameworkAdapterDeps = {
      assertValidCsrf: vi.fn(),
      resolveAbacBundle,
    }
    const handler = createFrameworkWriteHandler({
      adapterDeps: deps,
      requestNormalization: canonicalRequestNormalization(impersonated, "test.create-authorization"),
      scope: { scope: "tenant" },
      moduleKey: "test.create-authorization",
      action: "create",
      skipCapabilityCheck: true,
      createPersistence: vi.fn(() => ({} as PersistenceProvider)),
      definition: { key: "test.create", execute } as never,
      resolveInput: vi.fn(async () => ({})),
    })

    const response = await handler(new Request("https://example.test/items", { method: "POST" }))

    expect(response.status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
    expect(resolveAbacBundle).toHaveBeenCalledTimes(1)
  })
})
