/**
 * Plans the nightly mutation matrix from .github/mutation-slices.json.
 *
 * Every module (a directory or a .ts file directly under src/, tests excluded) of @xonava/core and @xonava/adapters must
 * be named by exactly one slice, and every named module must exist; otherwise this exits non-zero. A new module therefore
 * fails the nightly plan until it is added to a slice.
 *
 *   node scripts/ci/mutationSlices.mjs                 print the matrix as JSON
 *   node scripts/ci/mutationSlices.mjs --github-output append `matrix=<json>` to $GITHUB_OUTPUT
 */
import { appendFileSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const slices = JSON.parse(await readFile(resolve(root, ".github/mutation-slices.json"), "utf8"))
const excluded = ["!src/**/*.test.ts", "!src/**/__tests__/**", "!src/**/*.d.ts"]
const problems = []
const include = []

for (const [pkg, list] of Object.entries(slices)) {
  const entries = await readdir(resolve(root, "packages", pkg, "src"), { withFileTypes: true })
  const modules = entries
    .filter(entry => entry.name !== "__tests__" && (entry.isDirectory() || (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".test.ts"))))
    .map(entry => entry.name)
  const owner = new Map()
  for (const slice of list) {
    if (slice.modules.length === 0) problems.push(`${slice.name} has no modules`)
    for (const module of slice.modules) {
      if (!modules.includes(module)) problems.push(`${slice.name} names ${pkg}/src/${module}, which does not exist`)
      else if (owner.has(module)) problems.push(`${pkg}/src/${module} is in both ${owner.get(module)} and ${slice.name}`)
      else owner.set(module, slice.name)
    }
    include.push({
      name: slice.name,
      package: pkg,
      mutate: [...slice.modules.map(module => (module.endsWith(".ts") ? `src/${module}` : `src/${module}/**/*.ts`)), ...excluded].join(","),
    })
  }
  for (const module of modules) if (!owner.has(module)) problems.push(`${pkg}/src/${module} is in no mutation slice`)
}
const names = include.map(slice => slice.name)
if (new Set(names).size !== names.length) problems.push("slice names must be unique")
if (problems.length > 0) {
  console.error(`Mutation slices are inconsistent with packages/*/src:\n- ${problems.join("\n- ")}`)
  process.exit(1)
}
const matrix = JSON.stringify(include)
if (process.argv.includes("--github-output")) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is not set")
  appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`)
}
console.log(JSON.stringify(include, null, 2))
