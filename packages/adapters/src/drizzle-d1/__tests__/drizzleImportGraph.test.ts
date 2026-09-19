import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const internalModules = [
  "d1Session.ts",
  "drizzleRepository.ts",
  "drizzlePersistenceProvider.ts",
  "drizzleAuditSink.ts",
  "drizzleOutboxSink.ts",
] as const

describe("drizzle-d1 import graph", () => {
  it("keeps implementation imports out of the public barrel", () => {
    for (const moduleName of internalModules) {
      const source = readFileSync(new URL(`../${moduleName}`, import.meta.url), "utf8")
      expect(source).not.toMatch(/from ["']\.["']/)
    }
  })

  it("preserves the public drizzle-d1 barrel exports", () => {
    const barrel = readFileSync(new URL("../index.ts", import.meta.url), "utf8")
    for (const moduleName of [
      "d1Session",
      "d1Utils",
      "d1BatchLimits",
      "drizzleRepository",
      "drizzlePersistenceProvider",
      "drizzleAuditSink",
      "drizzleOutboxSink",
      "drizzleJobStore",
      "drizzleScheduleStore",
    ]) {
      expect(barrel).toContain(`export * from "./${moduleName}"`)
    }
    expect(barrel).toContain('export type { DrizzleColumnMap } from "../drizzle-shared/predicateCompiler"')
    expect(barrel).toContain('export { compileDrizzlePredicate } from "../drizzle-shared/predicateCompiler"')
  })
})
