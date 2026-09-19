import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { DurableFailpoint } from "./failpoints.js"

export async function runUntilFailpoint(databasePath: string, failpoint: DurableFailpoint, mode: "execute" | "recover"): Promise<void> {
  const worker = join(dirname(fileURLToPath(import.meta.url)), "d1WorkerEntry.mjs")
  const child = spawn(process.execPath, [worker, databasePath, failpoint, mode], { stdio: ["ignore", "pipe", "pipe"] })
  await new Promise<void>((resolve, reject) => {
    let errors = ""
    let expectedKill = false
    child.stderr.on("data", chunk => { errors += String(chunk) })
    child.stdout.on("data", chunk => {
      const output = String(chunk)
      if (output.includes(`FAILPOINT:${failpoint}`)) { expectedKill = true; child.kill("SIGKILL") }
    })
    child.on("error", reject)
    child.on("exit", code => { if (expectedKill || code === 0) resolve(); else reject(new Error(errors || `worker exited ${code}`)) })
  })
}
