import { describe, expect, it, vi } from "vitest"
import { DrizzleD1TemporalHistoryStore } from "../drizzle-d1/drizzleTemporalHistoryStore.js"
import { DrizzleMySqlTemporalHistoryStore } from "../drizzle-mysql/drizzleTemporalHistoryStore.js"
import { DrizzlePgTemporalHistoryStore } from "../drizzle-pg/drizzleTemporalHistoryStore.js"

const invalid = { scopeId: "tenant" as never, entityType: "invoice", entityId: "one", occurredAt: new Date(), kind: "deleted" as const, state: { invalid: true } }
describe("temporal provider write validation", () => {
  it("rejects invalid PostgreSQL input before issuing SQL", async () => { const query = vi.fn(); await expect(new DrizzlePgTemporalHistoryStore({ query }).append(invalid)).rejects.toThrow(/null state/); expect(query).not.toHaveBeenCalled() })
  it("rejects invalid D1 input before preparing SQL", async () => { const prepare = vi.fn(); await expect(new DrizzleD1TemporalHistoryStore({ prepare, batch: vi.fn() } as never).append(invalid)).rejects.toThrow(/null state/); expect(prepare).not.toHaveBeenCalled() })
  it("rejects invalid MySQL input before opening a transaction", async () => { const getConnection = vi.fn(); await expect(new DrizzleMySqlTemporalHistoryStore({ getConnection, query: vi.fn() } as never).append(invalid)).rejects.toThrow(/null state/); expect(getConnection).not.toHaveBeenCalled() })
})
