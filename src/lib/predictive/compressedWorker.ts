import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { CompressedInspectionRequest, inspectCompressedSource } from "./compressedSource.ts";
import type { prepareCompressedSourceClaims } from "./compressedClaims.ts";
import { exact, refuse } from "./validation.ts";

export const CODEC_WORKER_IMAGE = "node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1";
export const CODEC_WORKER_MEMORY = 268_435_456;
export const codecSandboxArgs = () => ["--network=none","--read-only","--log-driver=none","--memory="+CODEC_WORKER_MEMORY,
  "--memory-swap="+CODEC_WORKER_MEMORY,"--pids-limit=32","--cpus=1","--cap-drop=ALL",
  "--security-opt=no-new-privileges","--user=65534:65534","--pull=never"];
const root = fileURLToPath(new URL("../../../",import.meta.url));
let active = false; // One worker per parent process; no unbounded waiting queue.
const dockerEnv = () => { const env={...process.env}; delete env.DOCKER_HOST; delete env.DOCKER_CONTEXT; return env; };
const command = (args: string[], timeout=5000) => new Promise<string>((resolve,reject) => {
  const child=spawn("docker",args,{env:dockerEnv(),stdio:["ignore","pipe","ignore"]}); let output="";
  const timer=setTimeout(() => child.kill("SIGKILL"),timeout);
  child.stdout.on("data",chunk => { output+=chunk; if(output.length>4096)child.kill("SIGKILL"); });
  child.on("error",() => {clearTimeout(timer);reject(new Error("compressed-worker-runtime-unavailable"));});
  child.on("close",code => {clearTimeout(timer);if(code!==0)reject(new Error("compressed-worker-runtime-unavailable"));else resolve(output.trim());});
});

type WorkerResult = Awaited<ReturnType<typeof inspectCompressedSource>> | Awaited<ReturnType<typeof prepareCompressedSourceClaims>>;
export async function runCompressedWorker(mode: "inspect"|"claims", source: Uint8Array, request: CompressedInspectionRequest,
  options: { captureId?:string; signal?:AbortSignal; deadlineMs?:number } = {}): Promise<{ result:WorkerResult; memoryLimitBytes:number; peakRssBytes:number }> {
  if(active)refuse("compressed-worker-busy");
  exact(request,["feed","season","wireSha256","wireBytes"]);
  if(!["inspect","claims"].includes(mode)||!["player","team","roster"].includes(request.feed)||![2025,2026].includes(request.season))refuse("compressed-worker-input-refused");
  if(!(source instanceof Uint8Array)||source.length<1||source.length>8_000_000||request.wireBytes!==source.length)refuse("compressed-worker-input-refused");
  const bytes=Buffer.from(source), scoped={...request};
  if(createHash("sha256").update(bytes).digest("hex")!==scoped.wireSha256)refuse("compressed-wire-integrity-failed");
  if(!options||typeof options!=="object"||Array.isArray(options)||Object.keys(options).some(key=>!["captureId","signal","deadlineMs"].includes(key)))refuse("compressed-worker-input-refused");
  const deadline=options.deadlineMs===undefined?30_000:options.deadlineMs, signal=options.signal, captureId=options.captureId??null;
  if(signal!==undefined&&!(signal instanceof AbortSignal))refuse("compressed-worker-input-refused");
  if(!Number.isSafeInteger(deadline)||deadline<1||deadline>30_000)refuse("compressed-worker-input-refused");
  if(mode==="claims"&&(typeof captureId!=="string"||!captureId.trim()||captureId.length>256||/[\u0000-\u001f\u007f]/.test(captureId)))refuse("source-publication-id-refused");
  if(signal?.aborted)refuse("compressed-cancelled");
  active=true;
  const name="dfs106-codec-"+randomUUID(), started=performance.now(); let endpoint="", launched=false;
  try {
    try {endpoint=await command(["context","inspect","--format",'{{(index .Endpoints "docker").Host}}'],Math.min(5000,deadline));}
    catch {if(signal?.aborted)refuse("compressed-cancelled");if(performance.now()-started>=deadline)refuse("compressed-deadline-exceeded");refuse("compressed-worker-runtime-unavailable");}
    if(!/^unix:\/\/\/[^\r\n]+$/.test(endpoint))refuse("compressed-worker-local-runtime-required");
    let remaining=deadline-(performance.now()-started);
    if(remaining<=0)refuse("compressed-deadline-exceeded");
    if(signal?.aborted)refuse("compressed-cancelled");
    const args=["--host",endpoint,"create","-i","--name",name,...codecSandboxArgs(),
      "--mount",`type=bind,src=${join(root,"src/lib")},dst=/work/src/lib,readonly`,
      "--mount",`type=bind,src=${join(root,"node_modules/csv-parse")},dst=/work/node_modules/csv-parse,readonly`,
      "--mount",`type=bind,src=${join(root,"scripts/predictive/compressedWorker.ts")},dst=/work/scripts/predictive/compressedWorker.ts,readonly`,
      "--workdir=/work",CODEC_WORKER_IMAGE,"node","--max-old-space-size=192","--disable-warning=MODULE_TYPELESS_PACKAGE_JSON","scripts/predictive/compressedWorker.ts"];
    launched=true;
    try {if(!/^[a-f0-9]{64}$/.test(await command(args,remaining)))refuse("compressed-worker-runtime-unavailable");}
    catch {if(signal?.aborted)refuse("compressed-cancelled");if(performance.now()-started>=deadline)refuse("compressed-deadline-exceeded");refuse("compressed-worker-runtime-unavailable");}
    remaining=deadline-(performance.now()-started);
    if(remaining<=0)refuse("compressed-deadline-exceeded");
    if(signal?.aborted)refuse("compressed-cancelled");
    return await new Promise((resolve,reject) => {
      const child=spawn("docker",["--host",endpoint,"start","--attach","--interactive",name],{env:dockerEnv(),stdio:["pipe","pipe","ignore"]});
      const chunks:Buffer[]=[];let size=0,reason:string|null=null;
      const stop=(code:string) => {reason??=code;child.kill("SIGKILL");};
      const cancel=()=>stop("compressed-cancelled");
      const timer=setTimeout(()=>stop("compressed-deadline-exceeded"),remaining);
      signal?.addEventListener("abort",cancel,{once:true});
      child.stdout.on("data",chunk=>{size+=chunk.length;if(size>64_000_000)stop("compressed-worker-output-refused");else chunks.push(chunk);});
      child.stdin.on("error",()=>{});
      child.on("error",()=>{reason??="compressed-worker-runtime-unavailable";});
      child.on("close",code=>{
        clearTimeout(timer);signal?.removeEventListener("abort",cancel);
        if(reason)return reject(new Error(reason));
        try {const response=JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if(code!==0||response.ok!==true)return reject(new Error(response.error??"compressed-worker-failed"));
          if(response.memoryLimitBytes!==CODEC_WORKER_MEMORY)return reject(new Error("compressed-worker-sandbox-refused"));
          resolve({result:response.result,memoryLimitBytes:response.memoryLimitBytes,peakRssBytes:response.peakRssBytes});
        } catch {reject(new Error(code===137?"compressed-worker-memory-exceeded":"compressed-worker-failed"));}
      });
      child.stdin.end(Buffer.concat([Buffer.from(JSON.stringify({mode,captureId:mode==="inspect"?null:captureId,request:scoped})+"\n"),bytes]));
      if(signal?.aborted)cancel();
    });
  } finally {
    if(launched) {
      try {
        try {await command(["--host",endpoint,"rm","-f",name]);} catch { /* Verify absence independently before releasing the permit. */ }
        if(await command(["--host",endpoint,"container","ls","-a","--filter","name=^/"+name+"$","--format","{{.ID}}"]))refuse("compressed-worker-cleanup-refused");
      } catch {refuse("compressed-worker-cleanup-refused");} // Keep the permit held on ambiguous cleanup.
    }
    active=false;
  }
}
