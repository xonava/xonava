import { describe, expect, it } from "vitest"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { ConflictError, Predicate } from "@xonava/core/domain"
import { createDrizzleRepository } from "../drizzleRepository"
import { createScriptedDb, type ScriptedHandler } from "../../__tests__/support/scriptedDb"

const widgets = pgTable("widgets", { id: text("id").primaryKey(), name: text("name").notNull(), score: integer("score"), version: integer("version").notNull() })
const columns = { id: widgets.id, name: widgets.name, score: widgets.score, version: widgets.version }
const entity = { name: "widget", primaryKey: "id", versionField: "version", fields: {} }

type Repo = Record<string, (...args: unknown[]) => Promise<unknown>>
function build(handler: ScriptedHandler) {
  const scripted = createScriptedDb("pg", handler)
  const repo = createDrizzleRepository({ db: scripted.db as never, table: widgets as never, entity: entity as never, columnMap: columns as never } as never) as unknown as Repo
  return { repo, ops: scripted.ops }
}

describe("a failed versioned update never falls through to a second write", () => {
  it("updateOneWhere stops at the first failing update even if a retry would succeed", async () => {
    let updates = 0
    const { repo, ops } = build((op) => {
      if (op.kind === "select") return [{ primaryKey: "w1" }]
      updates += 1
      if (updates === 1) throw Object.assign(new Error("provider text"), { code: "23505" })
      return [{ id: "w1", version: 2 }]
    })
    const error = await repo.updateOneWhere!(Predicate.eq("name", "a"), { name: "b" }, { optimisticConcurrency: { expectedVersion: 1 } }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect(ops.filter((op) => op.kind === "update")).toHaveLength(1)
  })
})
