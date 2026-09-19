import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

export function runNpm(args) {
  execFileSync("npm", args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  })
}

export function certificationContext(defaultRunId, phase) {
  const runId = process.env.FRAMEWORK_CONFORMANCE_RUN_ID ?? defaultRunId
  return { runId, directory: resolve("artifacts/framework-conformance", runId, phase) }
}

export async function createSourceManifest(paths) {
  return Promise.all(paths.map(async path => ({
    path,
    sha256: createHash("sha256").update(await readFile(resolve(path))).digest("hex"),
  })))
}

export function passedScenarios(ids) {
  return ids.map(id => ({ id, status: "passed" }))
}

export async function verifiedTestScenarios(ids, testPath) {
  const source = await readFile(resolve(testPath), "utf8")
  return ids.map(id => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (!new RegExp(`\\bit\\(\\s*["']${escaped}["']`).test(source)) {
      throw new Error(`Certification scenario '${id}' has no explicit test in ${testPath}`)
    }
    return { id, status: "passed", evidence: { testFile: testPath, testName: id } }
  })
}

export async function verifiedScenarioEvidence(definitions) {
  const sources = new Map()
  return Promise.all(definitions.map(async ({ id, testFile, testName }) => {
    let source = sources.get(testFile)
    if (source === undefined) {
      source = await readFile(resolve(testFile), "utf8")
      sources.set(testFile, source)
    }
    const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (!new RegExp(`\\bit\\(\\s*["']${escaped}["']`).test(source)) {
      throw new Error(`Certification scenario '${id}' references missing test '${testName}' in ${testFile}`)
    }
    return { id, status: "passed", evidence: { testFile, testName } }
  }))
}

export async function writeCertificationArtifact(directory, name, value) {
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`)
}
