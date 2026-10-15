import { readFile, readdir } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url))
const manifestPath = join(repositoryRoot, "scripts/verification/approvedFrameworkExports.json")
const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
const packageDirectories = new Map([
  ["@xonava/core", "packages/core"],
  ["@xonava/adapters", "packages/adapters"],
])
const failures = []

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries
    .filter((entry) => entry.name !== "node_modules" && entry.name !== "dist" && !entry.name.startsWith(".framework-isolation-"))
    .map(async (entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesUnder(path) : [path]
    }))
  return nested.flat()
}

function stable(values) {
  return [...values].sort((left, right) => left.localeCompare(right))
}

function moduleSpecifiers(source, path) {
  const result = []
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        result.push(node.arguments[0].text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return result
}

for (const [packageName, approvedEntries] of Object.entries(manifest.packages)) {
  const directory = packageDirectories.get(packageName)
  if (!directory) {
    failures.push(`manifest names unknown package ${packageName}`)
    continue
  }
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, directory, "package.json"), "utf8"))
  const actualEntries = stable(Object.keys(packageJson.exports ?? {}))
  const expectedEntries = stable(approvedEntries)
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    failures.push(`${directory}/package.json exports changed: expected ${expectedEntries.join(", ")}; received ${actualEntries.join(", ")}`)
  }
  for (const [entry, targets] of Object.entries(packageJson.exports ?? {})) {
    if (entry !== "." && entry.split("/").length > 2) failures.push(`${packageName} exposes internal leaf path ${entry}`)
    if (!targets || typeof targets !== "object" || typeof targets.types !== "string" || typeof targets.default !== "string") {
      failures.push(`${packageName} export ${entry} must define types and default targets`)
    }
  }
}

const sourceRoots = ["packages/core", "packages/adapters", "packages/testing", "apps"]
const sourceFiles = (await Promise.all(sourceRoots.map(async (root) => {
  try { return await filesUnder(join(repositoryRoot, root)) } catch (error) { if (error?.code === "ENOENT") return []; throw error }
}))).flat().filter((path) => [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].includes(extname(path)))
for (const path of sourceFiles) {
  const source = await readFile(path, "utf8")
  const repositoryPath = relative(repositoryRoot, path).replaceAll("\\", "/")
  const productionCore = repositoryPath.startsWith("packages/core/src/") && !repositoryPath.includes("/__tests__/") && !/\.(?:test|spec)\.[cm]?[jt]s$/.test(repositoryPath)
  for (const specifier of moduleSpecifiers(source, path)) {
    if (productionCore && /^(?:node:|fs(?:\/|$)|path(?:\/|$)|crypto(?:\/|$)|stream(?:\/|$)|buffer$|util(?:\/|$)|os$|child_process$|worker_threads$)/.test(specifier)) failures.push(`${repositoryPath} imports host-runtime module ${specifier}`)
    if (productionCore && /(?:clinic|application-framework|apps\/)/i.test(specifier)) failures.push(`${repositoryPath} imports application code ${specifier}`)
    for (const [packageName, approvedEntries] of Object.entries(manifest.packages)) {
      if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) continue
      const entry = specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`
      if (!approvedEntries.includes(entry)) failures.push(`${relative(repositoryRoot, path)} imports non-public path ${specifier}`)
    }
  }
  const isTestSource = path.includes("/__tests__/") || /\.(?:test|spec)\.[cm]?[jt]s$/.test(path)
  if (!isTestSource && /\bas unknown as\s+(?:PersistenceProvider|ReadOnlyPersistenceProvider|TenantScopedPersistenceProvider|RootPersistenceProvider)\b/.test(source)) {
    failures.push(`${relative(repositoryRoot, path)} contains a privilege-bearing persistence cast bridge`)
  }
  if (!isTestSource && /\b(?:@ts-ignore|@ts-nocheck)\b/.test(source)) failures.push(`${relative(repositoryRoot, path)} disables TypeScript safety checks`)
  if (!isTestSource && /\bversion\??\s*:\s*(?:string\s*\|\s*number|number\s*\|\s*string)\b/.test(source)) failures.push(`${repositoryPath} uses ambiguous string-or-number version typing`)

  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === "FrameworkAdapterDeps" && statement.members.some(ts.isIndexSignatureDeclaration)) failures.push(`${repositoryPath} gives FrameworkAdapterDeps a broad index signature`)
  }
}

const executionScopeSource = await readFile(join(repositoryRoot, "packages/core/src/domain/executionScope.ts"), "utf8")
if (/\|\s*\{[^}]*kind:\s*["']public["']/.test(executionScopeSource)) failures.push("ExecutionScope includes forbidden public scope")
const idempotencySource = await readFile(join(repositoryRoot, "packages/core/src/events/durability/idempotency.ts"), "utf8")
const basePort = idempotencySource.match(/export interface IdempotencyPort[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? ""
if (/claimPendingInvalidations|ackClaimedInvalidation|completeClaimedInvalidation/.test(basePort)) failures.push("base IdempotencyPort exposes finalizer claim mutation APIs")

const compatibilityPattern = /(?:^|[\/_\-.])(?:legacy|compat(?:ibility)?|v?1j|1\.0-j)(?:$|[\/_\-.])/i
for (const [packageName, approvedEntries] of Object.entries(manifest.packages)) {
  for (const entry of approvedEntries) {
    if (compatibilityPattern.test(entry)) failures.push(`${packageName} exposes compatibility path ${entry}`)
  }
}

const publicIndexes = [
  "packages/core/src/index.ts",
  "packages/core/src/bootstrap/index.ts",
  "packages/core/src/domain/index.ts",
  "packages/core/src/entity/index.ts",
  "packages/core/src/execution/index.ts",
  "packages/core/src/events/index.ts",
  "packages/core/src/operation/index.ts",
  "packages/core/src/kernel/index.ts",
  "packages/core/src/cache/index.ts",
  "packages/core/src/rate-limit/index.ts",
  "packages/core/src/telemetry/index.ts",
  "packages/core/src/quota/index.ts",
  "packages/core/src/resilience/index.ts",
  "packages/core/src/object-store/index.ts",
  "packages/core/src/health/index.ts",
  "packages/core/src/secrets/index.ts",
  "packages/core/src/feature-flags/index.ts",
  "packages/core/src/business-calendar/index.ts",
  "packages/core/src/persistence/index.ts",
  "packages/core/src/query/index.ts",
  "packages/core/src/read-model/index.ts",
  "packages/core/src/security/index.ts",
  "packages/core/src/serialization/index.ts",
  "packages/core/src/storage/index.ts",
  "packages/core/src/workflow/index.ts",
  "packages/adapters/src/index.ts",
  "packages/adapters/src/http/index.ts",
  "packages/adapters/src/server/index.ts",
  "packages/adapters/src/cache/index.ts",
  "packages/adapters/src/storage/index.ts",
  "packages/adapters/src/drizzle-d1/index.ts",
  "packages/adapters/src/drizzle-mysql/index.ts",
  "packages/adapters/src/drizzle-pg/index.ts"
]
async function resolveRelativeModule(from, specifier) {
  const base = join(from, "..", specifier.replace(/\.js$/, ""))
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    try { await readFile(candidate, "utf8"); return candidate } catch (error) { if (error?.code !== "ENOENT") throw error }
  }
  return undefined
}

async function exportedNames(path, seen = new Set()) {
  if (seen.has(path)) return new Set()
  seen.add(path)
  const source = await readFile(path, "utf8")
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const names = new Set()
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text)
      } else if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith(".")) {
        const target = await resolveRelativeModule(path, statement.moduleSpecifier.text)
        if (target) for (const name of await exportedNames(target, seen)) names.add(name)
      }
      continue
    }
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    if ("name" in statement && statement.name && ts.isIdentifier(statement.name)) names.add(statement.name.text)
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
    }
  }
  return names
}

for (const index of publicIndexes) {
  const names = await exportedNames(join(repositoryRoot, index))
  for (const symbol of manifest.forbiddenPublicSymbols) {
    if (names.has(symbol)) failures.push(`${index} exposes forbidden internal symbol ${symbol}`)
  }
}

for (const [packageName, expectedSymbols] of Object.entries(manifest.rootSymbols ?? {})) {
  const directory = packageDirectories.get(packageName)
  const actualSymbols = stable(await exportedNames(join(repositoryRoot, directory, "src/index.ts")))
  const expected = stable(expectedSymbols)
  if (JSON.stringify(actualSymbols) !== JSON.stringify(expected)) {
    failures.push(`${directory}/src/index.ts root symbols changed: expected ${expected.join(", ")}; received ${actualSymbols.join(", ")}`)
  }
}

if (failures.length > 0) {
  console.error("framework hardening verification failed:\n" + stable(new Set(failures)).map((failure) => `- ${failure}`).join("\n"))
  process.exitCode = 1
} else {
  console.log(`framework hardening verified: ${Object.keys(manifest.packages).length} package export maps and ${sourceFiles.length} source modules`)
}
