import { build } from "esbuild"
import ts from "typescript"
import { access, readdir, readFile } from "node:fs/promises"
import { dirname, extname, join, relative, resolve } from "node:path"

const root = process.cwd()
const coreRoot = resolve("packages/core/src")
const failures = []

async function files(directory, predicate) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "artifacts", ".release-check", ".npm-cache", "release"].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(path, predicate))
    else if (predicate(path)) result.push(path)
  }
  return result
}

const coreManifest = JSON.parse(await readFile("packages/core/package.json", "utf8"))
const adapterManifest = JSON.parse(await readFile("packages/adapters/package.json", "utf8"))
const testingManifest = JSON.parse(await readFile("packages/testing/package.json", "utf8"))
const workspaceManifest = JSON.parse(await readFile("package.json", "utf8"))
if (coreManifest.sideEffects !== false) failures.push("core/package.json must declare sideEffects:false")
if (Object.hasOwn(coreManifest.exports, "./" + "ports")) failures.push("obsolete broad port subpath must not be public")
if (JSON.stringify(workspaceManifest.workspaces) !== JSON.stringify(["packages/core", "packages/adapters", "packages/testing"])) failures.push("workspace list is not canonical")
if (coreManifest.name !== "@xonava/core" || adapterManifest.name !== "@xonava/adapters" || testingManifest.name !== "@xonava/testing") failures.push("package identities are not canonical")
if (Object.keys(coreManifest.dependencies ?? {}).length !== 0) failures.push("core must have zero runtime dependencies")
// Dependency direction: testing -> adapters -> core. Versions are pinned by verify:version.
const runtimeDependencies = manifest => Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })
if (!adapterManifest.dependencies?.["@xonava/core"] || runtimeDependencies(adapterManifest).includes("@xonava/testing")) failures.push("adapters must depend on core and never on testing")
if (!testingManifest.dependencies?.["@xonava/core"] || !testingManifest.devDependencies?.["@xonava/adapters"]) failures.push("testing must depend on core and use adapters")
if (runtimeDependencies(coreManifest).some(name => name.startsWith("@xonava/"))) failures.push("core must not depend on another framework package")
try { await access("packages/core/src/ports"); failures.push("obsolete physical packages/core/src/ports directory exists") } catch {}
for (const directory of ["core", "adapters", "testing"].map(name => `packages/framework-${name}`)) {
  try { await access(directory); failures.push(`obsolete package directory exists: ${directory}`) } catch {}
}

const activeFiles = await files(root, (path) => [".ts", ".mts", ".js", ".mjs", ".json", ".yml", ".yaml"].includes(extname(path)))
const obsoleteNames = ["core", "adapters", "testing"].map(name => `@enterprise/framework-${name}`)
const obsoletePackageNames = ["framework-" + "core", "framework-" + "adapters", "framework-" + "testing"]
const forbiddenCompatibility = ["executionScope" + "FromLegacy", "migration" + "Scopes", "effectFailure" + "Reporter", "Pagination" + "Spec", "legacy" + "1j", "InvalidationFinalizer" + "Telemetry", "hasObject" + "StorageCapability", "validate" + "Compatibility"]
const obsoleteFilePattern = /(?:^|[\\/])(?:legacy1j|compat(?:ibility)?|deprecated|migration[-_]?bridge|shim)(?:[.\\/_-]|$)/i
for (const path of activeFiles) {
  const source = await readFile(path, "utf8")
  for (const value of obsoleteNames) if (source.includes(value)) failures.push(`${relative(root, path)} contains obsolete package identity`)
  for (const value of obsoletePackageNames) if (source.includes(value)) failures.push(`${relative(root, path)} contains obsolete package name`)
  if (source.includes("core/" + "ports")) failures.push(`${relative(root, path)} imports obsolete broad core capability path`)
  if (path.startsWith(coreRoot) && /(?:from\s+|import\s*\()["'][^"']*(?:^|\/)ports(?:\/|["'])/m.test(source)) failures.push(`${relative(root, path)} imports the removed physical ports tree`)
  if (obsoleteFilePattern.test(relative(root, path)) && path.includes(`${join("packages", "")}`)) failures.push(`${relative(root, path)} has an obsolete compatibility filename`)
  if (path.includes(`${join("packages", "core", "src")}`) || path.includes(`${join("packages", "adapters", "src")}`)) {
    for (const value of forbiddenCompatibility) if (source.toLowerCase().includes(value.toLowerCase())) failures.push(`${relative(root, path)} contains removed compatibility surface ${value}`)
  }
}

for (const path of await files(resolve("packages/adapters/src"), (value) => value.endsWith(".ts") && !value.includes(`${join("__tests__", "")}`) && !value.endsWith(".test.ts"))) {
  const source = await readFile(path, "utf8")
  if (/from\s+["'](?:core\/src\/|\.\.\/\.\.\/core\/src\/)/.test(source)) failures.push(`${relative(root, path)} bypasses the public core API`)
}

const kernelIndex = await readFile("packages/core/src/kernel/index.ts", "utf8")
if (kernelIndex.includes("../domain/")) failures.push("kernel re-exports domain-owned concepts")
for (const forbidden of ["cache", "persistence", "query", "events", "workflow", "execution", "bootstrap", "adapters", "testing"]) {
  if (kernelIndex.includes(`../${forbidden}/`)) failures.push(`kernel depends on ${forbidden}`)
}

const sourceFiles = await files(coreRoot, (path) => path.endsWith(".ts") && !path.includes(`${join("__tests__", "")}`) && !path.endsWith(".test.ts"))
const sourceSet = new Set(sourceFiles.map((path) => resolve(path)))
const graph = new Map()
const completeGraph = new Map()
for (const path of sourceFiles) {
  const source = await readFile(path, "utf8")
  const dependencies = []
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const runtimeSpecifiers = []
  const allSpecifiers = []
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement) && typeof statement.moduleSpecifier.text === "string") {
      allSpecifiers.push(statement.moduleSpecifier.text)
      const clause = statement.importClause
      const named = clause?.namedBindings
      const typeOnly = clause?.isTypeOnly || (named && ts.isNamedImports(named) && named.elements.every((item) => item.isTypeOnly))
      if (!typeOnly) runtimeSpecifiers.push(statement.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && typeof statement.moduleSpecifier.text === "string" && !statement.isTypeOnly) {
      runtimeSpecifiers.push(statement.moduleSpecifier.text)
      allSpecifiers.push(statement.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && typeof statement.moduleSpecifier.text === "string") {
      allSpecifiers.push(statement.moduleSpecifier.text)
    }
  }
  for (const specifier of runtimeSpecifiers.filter((value) => /^\.{1,2}\//.test(value))) {
    const base = resolve(dirname(path), specifier)
    const candidates = [base, `${base}.ts`, join(base, "index.ts")]
    const target = candidates.find((candidate) => sourceSet.has(candidate))
    if (target) dependencies.push(target)
  }
  graph.set(resolve(path), dependencies)
  const completeDependencies = []
  for (const specifier of allSpecifiers.filter((value) => /^\.{1,2}\//.test(value))) {
    const normalized = specifier.replace(/\.js$/, "")
    const base = resolve(dirname(path), normalized)
    const candidates = [base, `${base}.ts`, join(base, "index.ts")]
    const target = candidates.find((candidate) => sourceSet.has(candidate))
    if (target) completeDependencies.push(target)
  }
  completeGraph.set(resolve(path), completeDependencies)
}
const visiting = new Set(), visited = new Set(), stack = []
function walk(node) {
  if (visiting.has(node)) {
    const start = stack.indexOf(node)
    failures.push(`circular dependency: ${stack.slice(start).concat(node).map((path) => relative(coreRoot, path)).join(" -> ")}`)
    return
  }
  if (visited.has(node)) return
  visiting.add(node); stack.push(node)
  for (const next of graph.get(node) ?? []) walk(next)
  stack.pop(); visiting.delete(node); visited.add(node)
}
for (const node of graph.keys()) walk(node)

const publicRoots = Object.values(coreManifest.exports).map(entry => resolve("packages/core/src", entry.default.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts")))
const reachable = new Set()
function markReachable(node) {
  if (reachable.has(node)) return
  reachable.add(node)
  for (const next of completeGraph.get(node) ?? []) markReachable(next)
}
for (const node of publicRoots) markReachable(node)
const testFiles = await files(coreRoot, (path) => path.endsWith(".test.ts") || path.includes(`${join("__tests__", "")}`))
for (const testPath of testFiles) {
  const parsed = ts.createSourceFile(testPath, await readFile(testPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || typeof statement.moduleSpecifier.text !== "string" || !/^\.{1,2}\//.test(statement.moduleSpecifier.text)) continue
    const normalized = statement.moduleSpecifier.text.replace(/\.js$/, "")
    const base = resolve(dirname(testPath), normalized)
    const target = [base, `${base}.ts`, join(base, "index.ts")].find(candidate => sourceSet.has(candidate))
    if (target) markReachable(target)
  }
}
for (const path of sourceFiles) {
  if (!reachable.has(resolve(path))) failures.push(`orphaned core source: ${relative(coreRoot, path)}`)
}

async function auditPackageOrphans(packageDirectory, manifest) {
  const sourceRoot = resolve(packageDirectory, "src")
  const production = await files(sourceRoot, path => path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.includes(`${join("__tests__", "")}`))
  const productionSet = new Set(production.map(path => resolve(path)))
  const dependencyGraph = new Map()
  const resolveSource = (owner, specifier) => {
    if (!/^\.{1,2}\//.test(specifier)) return undefined
    const base = resolve(dirname(owner), specifier.replace(/\.js$/, ""))
    return [base, `${base}.ts`, join(base, "index.ts")].find(candidate => productionSet.has(candidate))
  }
  for (const path of production) {
    const parsed = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const dependencies = []
    for (const statement of parsed.statements) {
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier || typeof statement.moduleSpecifier.text !== "string") continue
      const target = resolveSource(path, statement.moduleSpecifier.text)
      if (target) dependencies.push(target)
    }
    dependencyGraph.set(resolve(path), dependencies)
  }
  const packageReachable = new Set()
  const mark = node => {
    if (!node || packageReachable.has(node)) return
    packageReachable.add(node)
    for (const next of dependencyGraph.get(node) ?? []) mark(next)
  }
  for (const entry of Object.values(manifest.exports)) mark(resolve(sourceRoot, entry.default.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts")))
  const packageTests = await files(resolve(packageDirectory), path => (path.endsWith(".test.ts") || path.includes(`${join("__tests__", "")}`)) && !path.includes(`${join("node_modules", "")}`))
  for (const testPath of packageTests) {
    const parsed = ts.createSourceFile(testPath, await readFile(testPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement) || typeof statement.moduleSpecifier.text !== "string") continue
      mark(resolveSource(testPath, statement.moduleSpecifier.text))
    }
  }
  for (const path of production) if (!packageReachable.has(resolve(path))) failures.push(`orphaned ${manifest.name} source: ${relative(sourceRoot, path)}`)
}
await auditPackageOrphans("packages/adapters", adapterManifest)
await auditPackageOrphans("packages/testing", testingManifest)

const fixtures = ["cache", "rate-limit", "telemetry", "quota", "object-store", "persistence", "cache-telemetry", "rate-limit-telemetry", "query-persistence"]
const unrelated = {
  cache: ["workflow", "execution/dispatcher", "query/", "objectStore", "rateLimit", "persistence/"],
  "rate-limit": ["workflow", "execution/dispatcher", "query/", "objectStore", "cache.ts", "persistence/"],
  telemetry: ["workflow", "execution/dispatcher", "query/", "objectStore", "cache.ts", "rateLimit", "persistence/"],
  quota: ["workflow", "execution/dispatcher", "query/", "objectStore", "cache.ts", "rateLimit", "persistence/"],
  "object-store": ["workflow", "execution/dispatcher", "query/", "cache.ts", "rateLimit", "persistence/"],
  persistence: ["workflow", "execution/dispatcher", "objectStore", "cache.ts", "rateLimit"],
}
for (const fixture of fixtures) {
  const fixturePath = resolve(`packages/testing/fixtures/consumption/${fixture}.ts`)
  const result = await build({ absWorkingDir: root, alias: { core: coreRoot }, stdin: { contents: await readFile(fixturePath, "utf8"), resolveDir: root, sourcefile: `consumption/${fixture}.ts`, loader: "ts" }, bundle: true, format: "esm", platform: "neutral", treeShaking: true, write: false, metafile: true, logLevel: "silent" })
  const inputs = Object.keys(result.metafile.inputs).join("\n").replaceAll("\\", "/")
  for (const marker of unrelated[fixture] ?? []) if (inputs.includes(marker)) failures.push(`${fixture} bundle includes unrelated ${marker}`)
}

const registry = await readFile("packages/core/src/serialization/formatRegistry.ts", "utf8")
if (/\nensureRegistryValid\(\);\s*$/.test(registry)) failures.push("serialization registry validates at import time")

const canonicalJsonImplementations = sourceFiles.filter(path => /canonicalJson\.ts$/i.test(path))
if (canonicalJsonImplementations.length !== 1 || relative(coreRoot, canonicalJsonImplementations[0]).replaceAll("\\", "/") !== "serialization/canonicalJson.ts") {
  failures.push(`canonical JSON must have exactly one implementation at serialization/canonicalJson.ts; found ${canonicalJsonImplementations.map(path => relative(coreRoot, path)).join(", ") || "none"}`)
}

if (failures.length) {
  console.error(`architecture verification failed:\n${[...new Set(failures)].sort().map((item) => `- ${item}`).join("\n")}`)
  process.exitCode = 1
} else {
  console.log(`architecture verified: ${sourceFiles.length} core modules, ${fixtures.length} standalone bundles, zero cycles or obsolete package identities`)
}
