// Applies the pending changesets: bumps the framework packages in lockstep, writes one entry to the root
// CHANGELOG.md, and refreshes package-lock.json. Changesets' own per-package changelogs are disabled so the
// root changelog stays the only one.
import { execFileSync } from "node:child_process"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { FRAMEWORK_PACKAGE_DIRECTORIES, lockstepViolations } from "../verification/frameworkVersionPolicy.mjs"

const repositoryRoot = resolve(import.meta.dirname, "../..")
const changesetDirectory = join(repositoryRoot, ".changeset")
const changelogPath = join(repositoryRoot, "CHANGELOG.md")
const BUMPS = ["patch", "minor", "major"]

function fail(message) {
  console.error(`release:version: ${message}`)
  process.exit(1)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"))
}

/** Parses one changeset file into its highest bump and its summary. */
export function parseChangeset(name, text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (!match) fail(`${name} has no front matter`)
  let bump = -1
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue
    const entry = /^\s*["']?(@xonava\/[a-z-]+)["']?\s*:\s*(patch|minor|major)\s*$/.exec(line)
    if (!entry) fail(`${name} has an unrecognised release line: ${line}`)
    bump = Math.max(bump, BUMPS.indexOf(entry[2]))
  }
  const summary = match[2].trim()
  if (bump < 0 || !summary) fail(`${name} needs at least one package and a summary`)
  return { bump: BUMPS[bump], summary }
}

async function packageManifests() {
  return Promise.all(FRAMEWORK_PACKAGE_DIRECTORIES.map((directory) => readJson(join(repositoryRoot, directory, "package.json"))))
}

const before = await packageManifests()
const previousVersion = before[0].version
const files = (await readdir(changesetDirectory)).filter((name) => name.endsWith(".md") && name !== "README.md").sort()
if (files.length === 0) fail("there are no pending changesets in .changeset/")
const changes = []
for (const name of files) changes.push(parseChangeset(name, await readFile(join(changesetDirectory, name), "utf8")))
if (previousVersion.startsWith("0.") && changes.some((change) => change.bump === "major") && process.env.RELEASE_MAJOR !== "1") {
  fail("a major changeset would release 1.0.0. Use minor for breaking changes during 0.x, or set RELEASE_MAJOR=1 to release 1.0.0")
}

execFileSync(join(repositoryRoot, "node_modules/.bin/changeset"), ["version"], { cwd: repositoryRoot, stdio: "inherit" })

const after = await packageManifests()
const violations = lockstepViolations(after)
if (violations.length > 0) fail(`packages are not in lockstep after versioning: ${violations.join("; ")}`)
const version = after[0].version
if (version === previousVersion) fail(`changesets did not change the version (${version})`)

const date = new Date().toISOString().slice(0, 10)
const sections = [
  ["major", "Major changes"],
  ["minor", "Minor changes"],
  ["patch", "Patch changes"],
]
let entry = `## [${version}] — ${date}\n`
for (const [bump, heading] of sections) {
  const items = changes.filter((change) => change.bump === bump)
  if (items.length === 0) continue
  entry += `\n### ${heading}\n\n`
  for (const item of items) entry += `- ${item.summary.replace(/\n/g, "\n  ")}\n`
}
const changelog = await readFile(changelogPath, "utf8")
const firstRelease = changelog.indexOf("\n## ")
if (firstRelease < 0) fail("CHANGELOG.md has no release heading to insert before")
await writeFile(changelogPath, `${changelog.slice(0, firstRelease + 1)}${entry}\n${changelog.slice(firstRelease + 1)}`, "utf8")

execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: repositoryRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
})
console.log(`Versioned ${previousVersion} → ${version}. Review the diff, then open a release/${version} pull request into dev.`)
