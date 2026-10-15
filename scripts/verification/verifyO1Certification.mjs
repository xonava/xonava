import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { verifiedScenarioEvidence } from "./certificationSupport.mjs"

const runId=process.env.FRAMEWORK_CONFORMANCE_RUN_ID??"local-o1"
const directory=resolve("artifacts/framework-conformance",runId,"o1")
const run=args=>execFileSync("npm",args,{cwd:process.cwd(),stdio:"inherit",env:process.env,shell:process.platform==="win32"})
run(["run","typecheck"])
run(["run","test","-w","@xonava/core","--","--run","src/storage/__tests__/attachment.test.ts","src/object-store/__tests__/objectStore.test.ts"])
run(["run","test","-w","@xonava/adapters","--","--run","src/storage/__tests__/inMemoryObjectStore.test.ts"])
const sources=["packages/core/src/object-store/objectStore.ts","packages/core/src/storage/attachment.ts","packages/core/src/bootstrap/runtimeCapabilities.ts","packages/adapters/src/storage/inMemoryObjectStore.ts"]
const sourceManifest=await Promise.all(sources.map(async path=>({path,sha256:createHash("sha256").update(await readFile(resolve(path))).digest("hex")})))
const scenarios=["uint8array-put-get","web-readable-stream-put","head-metadata","delete","content-length-validation","checksum-metadata","cancellation","deadline","scoped-attachment-metadata","object-store-capability-presence","optional-signed-reference-contract"]
const adapter="packages/adapters/src/storage/__tests__/inMemoryObjectStore.test.ts",core="packages/core/src/object-store/__tests__/objectStore.test.ts",attachment="packages/core/src/storage/__tests__/attachment.test.ts"
const evidence=await verifiedScenarioEvidence([
  {id:scenarios[0],testFile:adapter,testName:"supports put, head, get and delete with immutable byte copies"},{id:scenarios[1],testFile:adapter,testName:"accepts Web streams and enforces declared length"},{id:scenarios[2],testFile:adapter,testName:"supports put, head, get and delete with immutable byte copies"},{id:scenarios[3],testFile:adapter,testName:"supports put, head, get and delete with immutable byte copies"},{id:scenarios[4],testFile:core,testName:"validates byte puts and rejects malformed declarations"},{id:scenarios[5],testFile:core,testName:"snapshots authoritative metadata and signed references"},{id:scenarios[6],testFile:adapter,testName:"honors cancellation and deadlines"},{id:scenarios[7],testFile:core,testName:"validates request activity and object keys"},{id:scenarios[8],testFile:attachment,testName:"defines immutable scoped attachment metadata without binary content"},{id:scenarios[9],testFile:core,testName:"requires an object-store capability"},{id:scenarios[10],testFile:core,testName:"snapshots authoritative metadata and signed references"},
])
await mkdir(directory,{recursive:true})
await writeFile(resolve(directory,"object-storage-conformance.json"),`${JSON.stringify({phase:"O1",status:"proven",runId,adapterScope:"Deterministic in-memory reference adapter; no cloud-vendor certification claimed",scenarios:evidence,sourceManifest},null,2)}\n`)
console.log(`O1 certification verified: ${directory}`)
