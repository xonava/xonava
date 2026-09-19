import { access, readdir, readFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

const failures = []
const forbiddenDirectories = [
  "packages/core/dist/ports",
  "packages/core/dist/readModel",
  "packages/core/dist/utils",
  "packages/adapters/dist/internal",
  "packages/adapters/dist/utils",
]
const forbiddenGeneratedReferences = [
  { label: "removed ports path", pattern: /(?:^|[\\/])ports[\\/]/m },
  { label: "obsolete readModel path", pattern: /(?:^|[\\/])readModel[\\/]/m },
  { label: "obsolete enterprise package identity", pattern: /@enterprise\/framework-/m },
  { label: "obsolete core package identity", pattern: new RegExp(`(?:^|["'\\s])${"framework-" + "core"}(?:[\\s"'/]|$)`, "m") },
  { label: "obsolete adapters package identity", pattern: new RegExp(`(?:^|["'\\s])${"framework-" + "adapters"}(?:[\\s"'/]|$)`, "m") },
  { label: "obsolete testing package identity", pattern: new RegExp(`(?:^|["'\\s])${"framework-" + "testing"}(?:[\\s"'/]|$)`, "m") },
]

for (const path of forbiddenDirectories) {
  try { await access(path); failures.push(`obsolete generated directory exists: ${path}`) } catch {}
}

async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(path))
    else result.push(path)
  }
  return result
}

for (const packageName of ["core", "adapters", "testing"]) {
  const manifest = JSON.parse(await readFile(`packages/${packageName}/package.json`, "utf8"))
  for (const [subpath, entry] of Object.entries(manifest.exports)) {
    for (const target of [entry.types, entry.default]) {
      try { await access(resolve(`packages/${packageName}`, target)) }
      catch { failures.push(`${packageName} export ${subpath} target is missing: ${target}`) }
    }
  }
  for (const path of await files(resolve(`packages/${packageName}/dist`))) {
    if (/\.(?:js|d\.ts)$/.test(path)) {
      const generated = await readFile(path, "utf8")
      for (const forbidden of forbiddenGeneratedReferences) {
        if (forbidden.pattern.test(generated)) {
          failures.push(`${relative(process.cwd(), path)} contains ${forbidden.label}`)
        }
      }
    }
    if (/\.(?:js|d\.ts)\.map$/.test(path)) {
      const sourceMap = JSON.parse(await readFile(path, "utf8"))
      for (const source of sourceMap.sources ?? []) {
        const normalized = String(source).replaceAll("\\", "/")
        if (/(?:^|\/)src\/(?:ports|utils|internal|readModel)(?:\/|$)/.test(normalized)) {
          failures.push(`${relative(process.cwd(), path)} points to obsolete source ${normalized}`)
        }
      }
    }
  }
}

if (failures.length) {
  console.error(`generated-surface verification failed:\n${failures.map(item => `- ${item}`).join("\n")}`)
  process.exitCode = 1
} else {
  console.log("generated surface verified: exports exist and generated code, declarations, maps, and directories contain no obsolete references")
}
