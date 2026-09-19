import { readdir, readFile, stat } from "node:fs/promises"
import { extname, join, relative, resolve } from "node:path"

const root = process.cwd()
const roots = ["packages", "scripts/verification", "docs", "artifacts", "release", "spec"]
const rootFiles = [".gitignore", "eslint.config.mjs", "README.md", "FRAMEWORK-RELEASE-VERIFICATION.md", "package.json", "package-lock.json", "tsconfig.base.json"]
const ignoredSegments = new Set(["node_modules", ".npm-cache"])

async function walk(path) {
  const info = await stat(path)
  if (!info.isDirectory()) return [path]
  const result = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (ignoredSegments.has(entry.name)) continue
    const child = join(path, entry.name)
    if (entry.isDirectory()) result.push(...await walk(child))
    else result.push(child)
  }
  return result
}

function classify(path) {
  const normalized = path.replaceAll("\\", "/")
  if (normalized.includes("/dist/") || normalized.endsWith(".tsbuildinfo")) return "GENERATED"
  if (normalized.includes("/artifacts/") || normalized.includes("/ci-artifacts/")) return "GENERATED"
  return "KEEP"
}

function category(path) {
  const normalized = path.replaceAll("\\", "/")
  if (normalized.includes("/dist/") || normalized.endsWith(".tsbuildinfo")) return "generated-build"
  if (normalized.includes("/artifacts/")) return "certification-evidence"
  if (normalized.includes("/docs/") || normalized.includes("/spec/") || normalized.endsWith(".md")) return "documentation"
  if (normalized.includes("/__tests__/") || normalized.endsWith(".test.ts")) return "test"
  if (normalized.includes("/scripts/verification/")) return "verification-tooling"
  if (normalized.includes("/packages/") && [".ts", ".mts", ".mjs"].includes(extname(normalized))) return "source"
  return "configuration"
}

function semanticOwner(path) {
  const parts = path.replaceAll("\\", "/").split("/")
  const source = parts.indexOf("src")
  if (source >= 0) return parts[source + 1] ?? "package-root"
  if (parts[0] === "scripts") return "verification"
  if (parts[0] === "docs") return "documentation"
  return parts[0] ?? "repository"
}

const absolute = []
for (const path of roots) absolute.push(...await walk(resolve(path)))
for (const path of rootFiles) absolute.push(resolve(path))
const unique = [...new Set(absolute)].sort()
const rows = []
for (const path of unique) {
  const repositoryPath = relative(root, path).replaceAll("\\", "/")
  const info = await stat(path)
  let text = ""
  if (info.size <= 2_000_000) {
    try { text = await readFile(path, "utf8") } catch {}
  }
  const fileCategory = category(path)
  const classification = classify(path)
  rows.push({
    path: repositoryPath,
    classification,
    fileCategory,
    responsibility: `${semanticOwner(repositoryPath)} ${fileCategory}`,
    visibility: /package\.json$/.test(repositoryPath) || repositoryPath.endsWith("/index.ts") ? "boundary-or-manifest" : "private-or-evidence",
    lifecycle: classification === "GENERATED" ? "generated" : classification === "HISTORICAL" ? "history" : fileCategory,
    consumers: null,
    exports: (text.match(/\bexport\s/g) ?? []).length,
    changeFrequency: "unavailable-no-vcs-metadata",
    semanticOwner: semanticOwner(repositoryPath),
    bytes: info.size,
    independentlyMeaningful: classification !== "GENERATED" || fileCategory === "certification-evidence",
  })
}
if (rows.some(row => !["KEEP", "MERGE", "MOVE", "DELETE", "GENERATED", "HISTORICAL"].includes(row.classification))) {
  throw new Error("repository inventory contains an unclassified file")
}
const counts = Object.fromEntries(["KEEP", "MERGE", "MOVE", "DELETE", "GENERATED", "HISTORICAL"].map(value => [value, rows.filter(row => row.classification === value).length]))
console.log(`repository inventory verified: ${rows.length} files classified (${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(", ")})`)
