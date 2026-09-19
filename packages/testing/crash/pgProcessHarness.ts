import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { DurableFailpoint } from "./failpoints.js"
export async function runPgUntilFailpoint(url: string, failpoint: DurableFailpoint, mode: "execute" | "recover"): Promise<void> {
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "pgWorkerEntry.mjs"), url, failpoint, mode], { stdio: ["ignore", "pipe", "pipe"] })
  await new Promise<void>((resolve, reject) => { let errors = ""; let expectedKill = false; child.stderr.on("data", x => errors += String(x)); child.stdout.on("data", x => { const s = String(x); if (s.includes(`FAILPOINT:${failpoint}`)) { expectedKill = true; child.kill("SIGKILL") } }); child.on("error", reject); child.on("exit", code => { if (expectedKill || code === 0) resolve(); else reject(new Error(errors || `worker exited ${code}`)) }) })
}
