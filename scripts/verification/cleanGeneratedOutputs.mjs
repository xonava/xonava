import { rm } from "node:fs/promises"
import { resolve, sep } from "node:path"

const root = process.cwd()
const targets = [
  "packages/core/dist",
  "packages/adapters/dist",
  "packages/testing/dist",
  "packages/core/tsconfig.build.tsbuildinfo",
  "packages/adapters/tsconfig.build.tsbuildinfo",
  "packages/testing/tsconfig.build.tsbuildinfo",
  "packages/core/coverage",
  "packages/adapters/coverage",
  "packages/testing/coverage",
]

for (const relativePath of targets) {
  const target = resolve(relativePath)
  if (!target.startsWith(`${root}${sep}`)) throw new Error(`Refusing to clean path outside workspace: ${target}`)
  await rm(target, { recursive: true, force: true })
}

console.log(`cleaned ${targets.length} generated build targets`)
