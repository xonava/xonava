import { readdir, readFile } from "node:fs/promises"
import { extname, join, relative, resolve, sep } from "node:path"

const packages = ["core", "adapters", "testing"]
const forbiddenOwners = new Set(["ports", "utils", "internal", "compat", "legacy", "misc"])
let checked = 0
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
  for (const path of await walk(sourceRoot)) {
    if (extname(path) !== ".ts" || path.endsWith(".test.ts") || path.includes(`${sep}__tests__${sep}`)) continue
    const sourcePath = relative(sourceRoot, path).replaceAll("\\", "/")
    const owner = sourcePath.includes("/") ? sourcePath.split("/")[0] : "package-root"
    if (forbiddenOwners.has(owner)) failures.push(`${packageName}/${sourcePath} has forbidden generic owner ${owner}`)
    checked += 1
  }
}

if (failures.length) throw new Error(failures.join("\n"))
console.log(`canonical ownership verified for ${checked} production files`)
