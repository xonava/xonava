import {execFileSync} from "node:child_process"
import {createHash} from "node:crypto"
import {mkdir,readFile,writeFile} from "node:fs/promises"
import {resolve} from "node:path"
const runId=process.env.FRAMEWORK_CONFORMANCE_RUN_ID??"local-api";const directory=resolve("artifacts/framework-conformance",runId,"api");const run=args=>execFileSync("npm",args,{cwd:process.cwd(),stdio:"inherit",env:process.env,shell:process.platform==="win32"})
run(["run","verify:framework-version"]);run(["run","verify:framework:hardening"]);run(["run","test","-w","@xonava/core","--","--run","src/__tests__/packageExports.test.ts"]);run(["run","test","-w","@xonava/adapters","--","--run","src/__tests__/packageExports.test.ts"])
const paths=["package.json","package-lock.json","packages/core/package.json","packages/adapters/package.json","packages/testing/package.json","scripts/verification/approvedFrameworkExports.json","docs/governance/public-api-manifest.json"];const files=await Promise.all(paths.map(async path=>({path,sha256:createHash("sha256").update(await readFile(resolve(path))).digest("hex")})))
const packages=await Promise.all(["packages/core","packages/adapters","packages/testing"].map(async directory=>{const manifest=JSON.parse(await readFile(resolve(directory,"package.json"),"utf8"));return {name:manifest.name,version:manifest.version,exports:Object.keys(manifest.exports).sort()}}))
await mkdir(directory,{recursive:true});await writeFile(resolve(directory,"public-api-snapshot.json"),`${JSON.stringify({phase:"API",status:"frozen",releaseCandidate:"2.0.0-rc.2",runId,packages,files},null,2)}\n`);console.log(`API certification verified: ${directory}`)
