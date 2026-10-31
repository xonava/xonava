import { readFile, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  FRAMEWORK_PACKAGE_DIRECTORIES,
  isForbiddenCompatibilityExport,
  lockstepViolations,
} from "./frameworkVersionPolicy.mjs"

type JsonRecord = Record<string, unknown>

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "../..")
const approvedManifestPath = join(repositoryRoot, "docs/governance/public-api-manifest.json")

async function readJson(path: string): Promise<JsonRecord> {
  return JSON.parse(await readFile(path, "utf8")) as JsonRecord
}

function sorted(value: readonly string[]): string[] {
  return [...value].sort((a, b) => a.localeCompare(b))
}

function fail(message: string): never {
  throw new Error(`Framework version policy violation: ${message}`)
}

const approvedManifest = await readJson(approvedManifestPath)
if (approvedManifest.schema !== "framework.public-api-manifest" || approvedManifest.schemaVersion !== 1) {
  fail("approved public API manifest has an unknown schema")
}
const approvedPackages = approvedManifest.packages as Record<string, readonly string[]>
const packageManifests: JsonRecord[] = []

for (const directory of FRAMEWORK_PACKAGE_DIRECTORIES) {
  const manifest = await readJson(join(repositoryRoot, directory, "package.json"))
  const name = manifest.name
  if (typeof name !== "string") fail(`${directory} has no package name`)
  packageManifests.push(manifest)
  if (!manifest.exports || typeof manifest.exports !== "object" || Array.isArray(manifest.exports)) {
    fail(`${name} has no explicit exports map`)
  }
  const actualExports = sorted(Object.keys(manifest.exports as JsonRecord))
  for (const exportName of actualExports) {
    if (isForbiddenCompatibilityExport(exportName)) fail(`${name} exposes forbidden compatibility alias ${exportName}`)
  }
  const approvedExports = approvedPackages[name]
  if (!approvedExports) fail(`${name} is absent from the approved public API manifest`)
  if (JSON.stringify(actualExports) !== JSON.stringify(sorted(approvedExports))) {
    fail(`${name} exports differ from the approved public API manifest`)
  }
}

if (sorted(Object.keys(approvedPackages)).length !== FRAMEWORK_PACKAGE_DIRECTORIES.length) {
  fail("approved manifest contains an unexpected framework package")
}

const versionViolations = lockstepViolations(packageManifests)
if (versionViolations.length > 0) fail(versionViolations.join("; "))
const frameworkVersion = packageManifests[0]?.version as string

await stat(join(repositoryRoot, "package-lock.json"))
console.log(`Framework ${frameworkVersion} version and export policy verified`)
