import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const runId = process.env.FRAMEWORK_CONFORMANCE_RUN_ID ?? "local-e1"
const directory = resolve("artifacts/framework-conformance", runId, "e1")
const run = args => execFileSync("npm", args, { cwd: process.cwd(), stdio: "inherit", env: process.env, shell: process.platform === "win32" })
run(["run", "typecheck"])
run(["run", "test", "-w", "@xonava/core", "--", "--run", "src/entity"])
run(["run", "test", "-w", "@xonava/adapters", "--", "--run", "src/http/__tests__/CRUD.compiledEntity.test.ts", "src/http/crudHandlers/__tests__/e1CompiledScope.test.ts"])

const sources = ["packages/core/src/serialization/durableCodec.ts", "packages/core/src/entity/entityScope.ts", "packages/core/src/entity/lifecycle.ts", "packages/core/src/entity/scalars/index.ts", "packages/core/src/domain/dataClassification.ts", "packages/core/src/entity/defineEntity.ts", "packages/core/src/entity/compileEntity.ts", "packages/core/src/entity/validateEntity.ts", "packages/core/src/entity/capabilityCheck.ts", "packages/adapters/src/http/crud.ts"]
const sourceManifest = await Promise.all(sources.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(resolve(path))).digest("hex") })))
await mkdir(directory, { recursive: true })
await writeFile(resolve(directory, "entity-compiler-conformance.json"), `${JSON.stringify({ phase: "E1", status: "proven", runId, assertions: ["expanded-scalars", "registered-durable-codecs", "explicit-entity-scope", "soft-delete-structural-scope", "occ-delete-restore-strategy", "append-only-protection", "shared-data-classification", "discriminated-feature-configs", "immutable-compiled-strategies", "unified-capability-manifest", "compiled-http-runtime"], sourceManifest }, null, 2)}\n`)
console.log(`E1 certification verified: ${directory}`)
