import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const docsRoot = join(root, "docs")

async function filesBelow(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await filesBelow(path))
    else result.push(path)
  }
  return result
}

const allDocs = (await filesBelow(docsRoot)).filter((path) => extname(path) === ".md")
const workspaceDocs = [
  join(root, "README.md"),
  join(root, "CHANGELOG.md"),
  join(root, "packages/core/README.md"),
  join(root, "packages/adapters/README.md"),
  join(root, "packages/testing/README.md"),
].filter(existsSync)
const canonical = [...allDocs, ...workspaceDocs]
const forbidden = [
  /@enterprise\//i,
  /\bframework-(?:core|adapters|testing)\b/i,
  /\bcore\/ports\b/i,
  /\blegacy1j\b/i,
  /\bexecutionScopeFromLegacy\b/,
  /\bmigrationScopes\b/,
  /\bInvalidationFinalizerTelemetry\b/,
  /\beffectFailureReporter\b/,
  /\bPaginationSpec\b/,
  /\bCompiledRoutePlan\.path\b/,
]

const coreManifest = JSON.parse(await readFile(join(root, "packages/core/package.json"), "utf8"))
const adapterManifest = JSON.parse(await readFile(join(root, "packages/adapters/package.json"), "utf8"))
const allowedImports = new Set([
  ...Object.keys(coreManifest.exports).map((key) => key === "." ? "core" : `core${key.slice(1)}`),
  ...Object.keys(adapterManifest.exports).map((key) => key === "." ? "adapters" : `adapters${key.slice(1)}`),
])

const failures = []
for (const path of canonical) {
  const source = await readFile(path, "utf8")
  const display = relative(root, path).replaceAll("\\", "/")
  for (const pattern of forbidden) if (pattern.test(source)) failures.push(`${display}: obsolete canonical reference ${pattern}`)

  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim()
    if (/^(?:https?:|mailto:|#)/.test(target)) continue
    const clean = decodeURIComponent(target.split("#", 1)[0])
    if (clean && !existsSync(resolve(dirname(path), clean))) failures.push(`${display}: broken link ${target}`)
  }

  for (const match of source.matchAll(/from\s+["'](core(?:\/[^"']+)?|adapters(?:\/[^"']+)?)["']/g)) {
    if (!allowedImports.has(match[1])) failures.push(`${display}: non-public package import ${match[1]}`)
  }

  for (const match of source.matchAll(/`((?:packages|scripts|artifacts)\/[A-Za-z0-9_./*-]+)`/g)) {
    const target = match[1]
    if (target.includes("*") || target.includes("<")) continue
    if (!existsSync(join(root, target))) failures.push(`${display}: missing repository path ${target}`)
  }

  if (/automatically generates? all REST endpoints|automatic CRUD endpoint inference is implemented/i.test(source)) {
    failures.push(`${display}: presents unimplemented route inference as current`)
  }
}

const specNames = canonical.filter((path) => relative(docsRoot, path).startsWith("spec"))
  .map((path) => relative(join(docsRoot, "spec"), path).toLowerCase())
if (new Set(specNames).size !== specNames.length) failures.push("duplicate canonical specification page")

const criticalSpecifications = ["cache.md", "rate-limit.md", "persistence.md", "transactions-and-occ.md", "query.md", "events.md", "operations.md", "execution.md", "workflow.md", "serialization-and-formats.md", "security.md"]
for (const name of criticalSpecifications) {
  const source = await readFile(join(docsRoot, "spec", name), "utf8")
  const words = source.split(/\s+/).filter(Boolean).length
  const headings = source.match(/^##\s+/gm)?.length ?? 0
  if (words < 120) failures.push(`docs/spec/${name}: critical specification has only ${words} words; minimum is 120`)
  if (headings < 3 || !/^## .*scope/im.test(source) || !/^## .*errors/im.test(source) || !/conformance/i.test(source)) {
    failures.push(`docs/spec/${name}: critical specification requires scope, errors/failure, conformance, and at least three sections`)
  }
}
const rootSpecMarkdown = (await filesBelow(join(root, "spec"))).filter((path) => extname(path) === ".md")
if (rootSpecMarkdown.length) failures.push(`root spec/ must contain only machine-readable conformance material: ${rootSpecMarkdown.map(path => relative(root, path)).join(", ")}`)

const errorIdentitySource = await readFile(join(docsRoot, "spec/errors/identity.md"), "utf8")
if (/HTTP\s+status/i.test(errorIdentitySource)) failures.push("docs/spec/errors/identity.md: transport status is forbidden in canonical core identity")
for (const path of (await filesBelow(join(docsRoot, "spec"))).filter(path => extname(path) === ".md" && !path.endsWith("language-neutrality.md"))) {
  const source = await readFile(path, "utf8")
  if (/\bPromise\s*</.test(source) || /\bAbortSignal\b/.test(source) || /\b(?:Express|Fastify|Hono|NestJS|Next\.js)\b/.test(source)) {
    failures.push(`${relative(root, path)}: implementation-specific API appears in normative specification`)
  }
}
const errorImplementation = await readFile(join(root, "packages/core/src/domain/errors.ts"), "utf8")
const errorSpecification = await readFile(join(docsRoot, "spec/errors.md"), "utf8")
const canonicalCodes = [...errorImplementation.matchAll(/^\s*\|\s*"([A-Z_]+)"/gm)].map(match => match[1])
const publicCodes = [...errorImplementation.matchAll(/publicCode:"([A-Z_]+)"/g)].map(match => match[1])
for (const value of new Set([...canonicalCodes, ...publicCodes])) {
  if (!errorSpecification.includes(`\`${value}\``)) failures.push(`docs/spec/errors.md: missing normative error/public code ${value}`)
}

if (failures.length) throw new Error(`documentation verification failed:\n${failures.join("\n")}`)
console.log(`documentation verified: ${canonical.length} current pages, ${allowedImports.size} public import paths`)
