import { describe, expect, it } from "vitest"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

/**
 * Architecture guard: core stays a DAG at runtime and foundation modules never
 * depend on higher layers, so capabilities remain independently consumable
 * and portable module by module. Type-only imports are erased and ignored.
 */
const root = resolve(import.meta.dirname, "..")
const FOUNDATION = ["kernel", "serialization", "domain", "resilience", "telemetry", "spec"]
const UPPER = ["operation", "workflow", "execution", "events", "persistence", "bootstrap", "read-model", "cache", "security", "query", "entity"]

function sourceFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) { if (entry !== "__tests__") sourceFiles(path, out) }
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts")) out.push(path)
  }
  return out
}

function runtimeGraph(): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>()
  const statement = /^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/gm
  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, "utf8")
    const dependencies = new Set<string>()
    for (const match of source.matchAll(statement)) {
      if (match[2]) continue
      const clause = match[3]!.trim()
      if (/^\{[^}]*\}$/.test(clause) && clause.slice(1, -1).split(",").map((part) => part.trim()).filter(Boolean).every((part) => part.startsWith("type "))) continue
      const specifier = match[4]!
      if (!specifier.startsWith(".")) continue
      const base = resolve(dirname(file), specifier.replace(/\.js$/, ""))
      const target = [`${base}.ts`, join(base, "index.ts")].find((candidate) => existsSync(candidate))
      if (target) dependencies.add(target)
    }
    graph.set(file, dependencies)
  }
  return graph
}

function cycles(graph: Map<string, Set<string>>): string[][] {
  let counter = 0
  const index = new Map<string, number>(); const low = new Map<string, number>(); const stack: string[] = []; const onStack = new Set<string>(); const found: string[][] = []
  const visit = (node: string): void => {
    index.set(node, counter); low.set(node, counter); counter++; stack.push(node); onStack.add(node)
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) { visit(next); low.set(node, Math.min(low.get(node)!, low.get(next)!)) }
      else if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, index.get(next)!))
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = []
      let member: string
      do { member = stack.pop()!; onStack.delete(member); component.push(relative(root, member)) } while (member !== node)
      if (component.length > 1) found.push(component.sort())
    }
  }
  for (const node of graph.keys()) if (!index.has(node)) visit(node)
  return found
}

describe("core module graph", () => {
  const graph = runtimeGraph()

  it("has no runtime import cycles", () => {
    expect(graph.size).toBeGreaterThan(150)
    expect(cycles(graph)).toEqual([])
  })

  it("keeps foundation modules independent of higher layers", () => {
    const top = (file: string) => relative(root, file).split(/[\\/]/)[0]!
    const violations: string[] = []
    for (const [file, dependencies] of graph) {
      if (!FOUNDATION.includes(top(file))) continue
      for (const dependency of dependencies) if (UPPER.includes(top(dependency))) violations.push(`${relative(root, file)} -> ${relative(root, dependency)}`)
    }
    expect(violations).toEqual([])
  })
})
