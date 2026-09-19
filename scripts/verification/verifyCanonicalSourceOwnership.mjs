import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { extname, join, relative, resolve, sep } from "node:path"

const packages = ["core", "adapters", "testing"]
const forbiddenOwners = new Set(["ports", "utils", "internal", "compat", "legacy", "misc"])
const rows = []
const failures = []

async function walk(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist"].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await walk(path))
    else result.push(path)
  }
  return result
}

for (const packageName of packages) {
  const sourceRoot = resolve(`packages/${packageName}/src`)
  const manifest = JSON.parse(await readFile(`packages/${packageName}/package.json`, "utf8"))
  const publicEntries = new Set(Object.values(manifest.exports).map(entry => entry.default.replace(/^\.\/dist\//, "").replace(/\/index\.js$/, "")))
  for (const path of await walk(sourceRoot)) {
    if (extname(path) !== ".ts" || path.endsWith(".test.ts") || path.includes(`${sep}__tests__${sep}`)) continue
    const sourcePath = relative(sourceRoot, path).replaceAll("\\", "/")
    const owner = sourcePath.includes("/") ? sourcePath.split("/")[0] : "package-root"
    if (forbiddenOwners.has(owner)) failures.push(`${packageName}/${sourcePath} has forbidden generic owner ${owner}`)
    const source = await readFile(path, "utf8")
    rows.push({
      package: packageName,
      sourcePath,
      canonicalOwner: owner,
      publicDomain: owner === "package-root" || publicEntries.has(owner),
      runtimeStatements: (source.match(/^(?:import|export)\s/gu) ?? []).length,
      sha256: createHash("sha256").update(source).digest("hex"),
    })
  }
}

if (failures.length) throw new Error(failures.join("\n"))
rows.sort((a, b) => `${a.package}/${a.sourcePath}`.localeCompare(`${b.package}/${b.sourcePath}`))
const directory = resolve("artifacts/framework-conformance/canonical-20260916/source-organization")
await mkdir(directory, { recursive: true })
await writeFile(resolve(directory, "ownership-matrix.json"), `${JSON.stringify({ schemaVersion: 1, status: "proven", productionFiles: rows.length, rows }, null, 2)}\n`)
console.log(`canonical ownership verified for ${rows.length} production files`)
