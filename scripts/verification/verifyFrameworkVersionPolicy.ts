import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  FRAMEWORK_PACKAGE_DIRECTORIES,
  FRAMEWORK_VERSION_POLICY,
  RELEASE_EVIDENCE_SCHEMA,
  RELEASE_EVIDENCE_SCHEMA_VERSION,
  isForbiddenCompatibilityExport,
  lockstepViolations,
} from "./frameworkVersionPolicy.mjs"

type JsonRecord = Record<string, unknown>

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "../..")
const approvedManifestPath = join(repositoryRoot, "docs/governance/public-api-manifest.json")
const outputPath = resolve(
  repositoryRoot,
  process.env.FRAMEWORK_RELEASE_EVIDENCE_PATH ?? "ci-artifacts/framework-release-verification.json",
)

async function readJson(path: string): Promise<JsonRecord> {
  return JSON.parse(await readFile(path, "utf8")) as JsonRecord
}

function sorted(value: readonly string[]): string[] {
  return [...value].sort((a, b) => a.localeCompare(b))
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

async function frameworkSourceFiles(directory: string): Promise<string[]> {
  const result: string[] = []
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (["node_modules", "dist", "coverage", "ci-artifacts", "artifacts"].includes(entry.name)) continue
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) result.push(child)
    }
  }
  await visit(directory)
  return sorted(result)
}

async function resolveSourceRevision(): Promise<{ kind: "git" | "content-sha256"; value: string }> {
  const supplied = process.env.FRAMEWORK_SOURCE_REVISION?.trim()
  if (supplied) return { kind: "git", value: supplied }
  try {
    const value = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    if (value) return { kind: "git", value }
  } catch {
    // Source archives have no Git metadata. Their exact framework content digest is the revision.
  }
  const digest = createHash("sha256")
  for (const packageDirectory of FRAMEWORK_PACKAGE_DIRECTORIES) {
    for (const path of await frameworkSourceFiles(join(repositoryRoot, packageDirectory))) {
      digest.update(relative(repositoryRoot, path)).update("\0").update(await readFile(path)).update("\0")
    }
  }
  return { kind: "content-sha256", value: digest.digest("hex") }
}

function fail(message: string): never {
  throw new Error(`Framework version policy violation: ${message}`)
}

const approvedManifest = await readJson(approvedManifestPath)
if (approvedManifest.schema !== "framework.public-api-manifest" || approvedManifest.schemaVersion !== 1) {
  fail("approved public API manifest has an unknown schema")
}
const approvedPackages = approvedManifest.packages as Record<string, readonly string[]>
const packageEvidence: Array<{ name: string; version: string; exports: string[] }> = []
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
  packageEvidence.push({ name, version: manifest.version as string, exports: actualExports })
}

if (sorted(Object.keys(approvedPackages)).length !== FRAMEWORK_PACKAGE_DIRECTORIES.length) {
  fail("approved manifest contains an unexpected framework package")
}

const versionViolations = lockstepViolations(packageManifests)
if (versionViolations.length > 0) fail(versionViolations.join("; "))
const frameworkVersion = packageManifests[0]?.version as string

const lockfilePath = join(repositoryRoot, "package-lock.json")
await stat(lockfilePath)
const evidence = {
  schema: RELEASE_EVIDENCE_SCHEMA,
  schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  frameworkVersion,
  versionPolicy: FRAMEWORK_VERSION_POLICY,
  certificationScope: "framework-only",
  applicationPackageVersionsConsidered: false,
  sourceRevision: await resolveSourceRevision(),
  lockfile: { path: "package-lock.json", sha256: await hashFile(lockfilePath) },
  publicApi: {
    manifest: relative(repositoryRoot, approvedManifestPath),
    sha256: await hashFile(approvedManifestPath),
    packages: packageEvidence,
  },
} as const
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8")
console.log(`Framework ${frameworkVersion} version/export policy verified; evidence: ${relative(repositoryRoot, outputPath)}`)
