import manifest from "../../package.json"
import { describe, expect, it } from "vitest"
import * as drizzleD1 from "../drizzle-d1"
import * as drizzlePg from "../drizzle-pg"
import * as drizzleMySql from "../drizzle-mysql"
import * as root from "../index"
import * as fastify from "../fastify"
import * as hono from "../hono"
import * as express from "../express"
import path from "node:path"
import { access, readFile } from "node:fs/promises"

describe("packages/adapters package exports", () => {
  async function localImportGraph(entry: string): Promise<string[]> {
    const visited = new Set<string>()
    const imports: string[] = []
    const visit = async (file: string): Promise<void> => {
      if (visited.has(file)) return
      visited.add(file)
      const source = await readFile(file, 'utf8')
      const matches = source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)
      for (const match of matches) {
        const specifier = match[1]!
        imports.push(specifier)
        if (!specifier.startsWith('.')) continue
        const candidate = path.resolve(path.dirname(file), specifier)
        if (path.extname(candidate)) await visit(candidate.endsWith('.js') ? `${candidate.slice(0, -3)}.ts` : candidate)
        else {
          const moduleFile = `${candidate}.ts`
          let moduleExists = true
          try { await access(moduleFile) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; moduleExists = false }
          await visit(moduleExists ? moduleFile : path.join(candidate, 'index.ts'))
        }
      }
    }
    await visit(entry)
    return imports
  }

  it.each([
    ['fastify', fastify, ['createFastifyHandler', 'fastifyCrudPlugin']],
    ['hono', hono, ['createHonoHandler', 'createHonoCrudApp']],
    ['express', express, ['createExpressHandler', 'createExpressCrudRouter']],
  ] as const)('exports the optional %s HTTP adapter independently', (name, api, symbols) => {
    expect(manifest.exports[`./${name}`]).toEqual({ types: `./dist/${name}/index.d.ts`, default: `./dist/${name}/index.js` })
    expect(manifest.peerDependenciesMeta[name].optional).toBe(true)
    for (const symbol of symbols) {
      expect(typeof (api as Record<string, unknown>)[symbol]).toBe('function')
      expect(root).not.toHaveProperty(symbol)
    }
  })

  it('keeps the Hono adapter import graph free of Node and unrelated frameworks', async () => {
    const imports = await localImportGraph(path.resolve(process.cwd(), 'src/hono/index.ts'))
    expect(imports.some(name => name.startsWith('node:') || name === 'express' || name === 'fastify')).toBe(false)
  })

  it('keeps optional frameworks outside the generic HTTP import graph', async () => {
    const imports = await localImportGraph(path.resolve(process.cwd(), 'src/http/index.ts'))
    expect(imports.some(name => name === 'express' || name === 'fastify' || name === 'hono')).toBe(false)
  })

  it("keeps internal HTTP helpers out of the public package surface", () => {
    const exports = manifest.exports as Record<string, unknown>
    expect(exports["./http/filterInterop"]).toBeUndefined()
    expect(exports["./http/createTenantFrameworkWriteHandler"]).toBeUndefined()
  })

  it("exports the generic HTTP surface", () => {
    expect(manifest.exports["./http"]).toEqual({
      types: "./dist/http/index.d.ts",
      default: "./dist/http/index.js",
    })
  })

  it("does not flatten adapter internals into the package root", async () => {
    const publicRoot = root as unknown as Record<string, unknown>
    expect(typeof publicRoot.CRUD).toBe("function")
    expect(publicRoot).not.toHaveProperty("createDrizzleRepository")
    expect(publicRoot).not.toHaveProperty("DrizzlePredicateCompiler")
    expect(publicRoot).not.toHaveProperty("InMemoryCacheAdapter")
  })

  it("does not export the Drizzle predicate compiler implementation", () => {
    expect(drizzleD1).not.toHaveProperty("DrizzlePredicateCompiler")
    expect(drizzlePg).not.toHaveProperty("DrizzlePredicateCompiler")
    expect(drizzleMySql).not.toHaveProperty("DrizzlePredicateCompiler")
  })

  it("exports the explicit MySQL adapter surface",()=>{expect(manifest.exports["./drizzle-mysql"]).toEqual({types:"./dist/drizzle-mysql/index.d.ts",default:"./dist/drizzle-mysql/index.js"});for(const symbol of ["createDrizzleMySqlPersistenceProvider","createDrizzleMySqlIdempotencyStore","createDrizzleMySqlAuditSinkFactory","createDrizzleMySqlOutboxSinkFactory","createMySqlInboxStore","createMySqlOutboxStore","createMySqlLeaseStore","createMySqlTagGenerationStore","DrizzleMySqlJobStore","DrizzleMySqlJobProgressStore","DrizzleMySqlScheduleStore","DrizzleMySqlWorkflowStore"] as const)expect(typeof drizzleMySql[symbol]).toBe("function");expect("DrizzlePredicateCompiler" in drizzleMySql).toBe(false)})
})
