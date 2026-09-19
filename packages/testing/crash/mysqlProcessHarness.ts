import {spawn} from "node:child_process"
import {dirname,join} from "node:path"
import {fileURLToPath} from "node:url"
import type {DurableFailpoint} from "./failpoints.js"
export async function runMySqlUntilFailpoint(url:string,failpoint:DurableFailpoint,mode:"execute"|"recover"){const child=spawn(process.execPath,[join(dirname(fileURLToPath(import.meta.url)),"mysqlWorkerEntry.mjs"),url,failpoint,mode],{stdio:["ignore","pipe","pipe"]});await new Promise<void>((resolve,reject)=>{let errors="";let expectedKill=false;child.stderr.on("data",x=>errors+=String(x));child.stdout.on("data",x=>{if(String(x).includes(`FAILPOINT:${failpoint}`)){expectedKill=true;child.kill("SIGKILL")}});child.on("error",reject);child.on("exit",code=>{if(expectedKill||code===0)resolve();else reject(new Error(errors||`worker exited ${code}`))})})}
