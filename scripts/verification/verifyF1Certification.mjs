import {execFileSync} from "node:child_process"
import {createHash} from "node:crypto"
import {access,mkdir,readFile,writeFile} from "node:fs/promises"
import {resolve} from "node:path"
const runId=process.env.FRAMEWORK_CONFORMANCE_RUN_ID??"local-f1";const directory=resolve("artifacts/framework-conformance",runId,"f1");const run=args=>execFileSync("npm",args,{cwd:process.cwd(),stdio:"inherit",env:process.env,shell:process.platform==="win32"})
const specifications=["docs/spec/README.md","docs/spec/execution/scope.md","docs/spec/persistence/entity-version.md","docs/spec/persistence/predicates.md","docs/spec/serialization/canonical-json.md","docs/spec/query/cursor.md","docs/spec/events/idempotency.md","docs/spec/events/outbox-inbox.md","docs/spec/persistence/leases.md","docs/spec/events/envelope.md","docs/spec/errors/identity.md","docs/spec/workflow/durable-state.md"]
for(const path of specifications)await access(resolve(path))
const manifest=JSON.parse(await readFile(resolve("spec/conformance-vectors/manifest.json"),"utf8"));if(manifest.schema!=="framework.conformance-vector-manifest"||manifest.canonicalizationVersion!=="jcs-rfc8785-v1"||manifest.digestAlgorithmVersion!=="sha256-v1")throw new Error("Invalid F1 vector manifest")
for(const name of manifest.vectors)await access(resolve("spec/conformance-vectors",manifest.baseDirectory,name))
run(["run","test","-w","@xonava/core","--","--run","src/serialization/__tests__/f1Core.test.ts"]);run(["run","test","-w","@xonava/testing","--","--run","tests/f1ConformanceVectors.test.ts"]);run(["run","verify:framework:core-purity"])
const sources=[...specifications,"spec/conformance-vectors/manifest.json","packages/core/src/serialization/canonicalJson.ts","packages/core/src/serialization/sha256.ts"];const sourceManifest=await Promise.all(sources.map(async path=>({path,sha256:createHash("sha256").update(await readFile(resolve(path))).digest("hex")})))
await mkdir(directory,{recursive:true});await writeFile(resolve(directory,"durable-serialization-specification.json"),`${JSON.stringify({phase:"F1",status:"proven",runId,canonicalizationVersion:manifest.canonicalizationVersion,digestAlgorithmVersion:manifest.digestAlgorithmVersion,specifications,vectors:manifest.vectors,sourceManifest},null,2)}\n`);console.log(`F1 certification verified: ${directory}`)
