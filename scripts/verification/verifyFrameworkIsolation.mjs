import { execFileSync } from "node:child_process"
import { existsSync, renameSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error("npm_execpath is required to run the framework isolation profile")
const apps = resolve(root, "apps")
const hidden = resolve(root, `.framework-isolation-apps-${process.pid}`)
if (existsSync(hidden)) throw new Error(`isolation staging path already exists: ${hidden}`)
if (existsSync(apps)) renameSync(apps, hidden)
try {
  const commands = [
    ["run", "verify:framework:fixtures"],
    ["run", "typecheck"],
    ["run", "test:framework:integration:d1"],
    ["run", "test:framework:conformance:d1"],
    ["run", "test:framework:race:d1"],
    ["run", "test:framework:crash:d1"],
  ]
  for (const args of commands) execFileSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: "inherit", env: process.env })
} finally {
  if (existsSync(hidden)) renameSync(hidden, apps)
}
console.log("Framework-only isolation profile passed")
