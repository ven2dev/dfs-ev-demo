// Reviewed deployment helper. Importing it performs no network or deployment.
import {createHash,randomBytes} from "node:crypto";
import {lstat,readFile,realpath,writeFile} from "node:fs/promises";
import {dirname,isAbsolute,relative,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import config from "../apps/web/src/lib/bench61-config.json" with {type:"json"};
const root=fileURLToPath(new URL("../",import.meta.url));
const {host,database}=config;
const project="prj_GLXDEeScMKPAeDAUoYIoiNknwKJd",org="team_s66WXM6S37xvFRoA68265CFl";
const scope="vernon-neillys-projects";
const ref="feature/dfsEV-206-budget-latency-profile",repoId="1350991998";
const remoteUrl="https://github.com/ven2dev/dfs-ev-demo.git";
const keys=["BENCH61_DATABASE_URL","BENCH61_TOKEN_HASH","BENCH61_ISSUED_AT","BENCH61_EXPIRES_AT","BENCH61_REVIEWED_SHA"];
const ensure=(ok,message)=>{if(!ok)throw new Error(message);};
const readUrl=value=>{try{return new URL(value);}catch{throw new Error("Invalid connection URL");}};
const readJson=value=>{try{return JSON.parse(value);}catch{throw new Error("Invalid preparation metadata");}};
export const createRuntimeSpec=(operatorUrl,reviewedSha,now=Date.now())=>{
  ensure(/^[a-f0-9]{40}$/.test(reviewedSha),"Invalid reviewed SHA");
  const url=readUrl(operatorUrl);
  ensure(["postgres:","postgresql:"].includes(url.protocol) && url.hostname===host
    && decodeURIComponent(url.pathname.slice(1))===database,"Wrong Preview target");
  ensure([...url.searchParams.keys()].every(key=>["sslmode","channel_binding"].includes(key)),"Unsupported connection options");
  url.username="bench61_http_timeout_20261022";
  url.password=randomBytes(32).toString("hex");
  const token=randomBytes(32).toString("hex");
  return {project,org,scope,token,runtime:{
    BENCH61_DATABASE_URL:url.toString(),BENCH61_TOKEN_HASH:createHash("sha256").update(token).digest("hex"),
    BENCH61_ISSUED_AT:new Date(now).toISOString(),BENCH61_EXPIRES_AT:new Date(now+86400000).toISOString(),
    BENCH61_REVIEWED_SHA:reviewedSha,
  }};
};
const privatePath=async file=>{
  ensure(isAbsolute(file),"Credential file path must be absolute");
  const parent=await realpath(dirname(file)),repo=await realpath(root);
  const rel=relative(repo,resolve(parent,file.split("/").at(-1)));
  ensure(rel.startsWith("../") || isAbsolute(rel),"Credential file must be outside checkout");
};
export const writeRuntimeSpec=async(file,operatorUrl,reviewedSha)=>{
  await privatePath(file);
  const spec=createRuntimeSpec(operatorUrl,reviewedSha);
  await writeFile(file,JSON.stringify(spec)+"\n",{mode:0o600,flag:"wx"});
  // Neither raw token nor credential is returned to a tool/log.
  return {path:file,reviewedSha,expiresAt:spec.runtime.BENCH61_EXPIRES_AT};
};
export const validateRuntimeSpec=(spec,head,link,clean,now=Date.now())=>{
  ensure(spec.project===project && spec.org===org && spec.scope===scope,"Wrong deployment project");
  ensure(link.projectId===project && link.orgId===org,"Checkout not linked to designated project");
  ensure(clean && /^[a-f0-9]{40}$/.test(head) && head===spec.runtime.BENCH61_REVIEWED_SHA,"Checkout is dirty or SHA differs");
  ensure(keys.length===Object.keys(spec.runtime).length && keys.every(k=>typeof spec.runtime[k]==="string"),"Unexpected runtime keys");
  const {runtime:r}=spec,url=readUrl(r.BENCH61_DATABASE_URL);
  ensure(["postgres:","postgresql:"].includes(url.protocol) && url.hostname===host
    && url.username==="bench61_http_timeout_20261022" && decodeURIComponent(url.pathname.slice(1))===database
    && url.password.length===64,"Wrong worker credential");
  ensure([...url.searchParams.keys()].every(key=>["sslmode","channel_binding"].includes(key)),"Unsupported connection options");
  ensure(/^[a-f0-9]{64}$/.test(spec.token) && createHash("sha256").update(spec.token).digest("hex")===r.BENCH61_TOKEN_HASH,"Token fingerprint mismatch");
  const issued=Date.parse(r.BENCH61_ISSUED_AT),expires=Date.parse(r.BENCH61_EXPIRES_AT);
  ensure(issued<=now && expires-now>=1800000 && expires-issued<=86400000,"Token window does not leave cleanup headroom");
  // Omit target: this fixed non-production branch receives a Preview. No files,
  // settings overrides, system variables, or mutable latest-commit option.
  return {name:"dfs-ev-demo",project,gitSource:{type:"github",repoId,ref,sha:head},
    env:Object.fromEntries(keys.map(key=>[key,r[key]])),meta:{bench61ReviewedSha:head}};
};
export const deployPreparedPreview=async (file,accessToken)=>{
  await privatePath(file);
  const stat=await lstat(file);
  ensure(stat.isFile() && (stat.mode&0o077)===0 && stat.uid===process.getuid(),"Credential file is not private and owned");
  const spec=readJson(await readFile(file,"utf8"));
  const git=args=>{const r=spawnSync("git",args,{cwd:root,encoding:"utf8",timeout:5000});ensure(r.status===0,"Git preflight failed");return r.stdout.trim();};
  const link=readJson(await readFile(resolve(root,".vercel/project.json"),"utf8"));
  const head=git(["rev-parse","HEAD"]);
  const request=validateRuntimeSpec(spec,head,link,git(["status","--porcelain","--untracked-files=all"])==="");
  // Read-only: an unpushed SHA is a local stop, not an ambiguous provider failure.
  const remote=spawnSync("git",["ls-remote","--heads",remoteUrl,"refs/heads/"+ref],{cwd:root,encoding:"utf8",timeout:15000});
  ensure(remote.status===0 && remoteRefMatches(remote.stdout,head),"Reviewed SHA is not the pushed branch tip");
  return {...await submitGitPreview(request,head,accessToken),expiresAt:spec.runtime.BENCH61_EXPIRES_AT};
};
export const remoteRefMatches=(output,head)=>{
  const lines=(output ?? "").trim().split("\n").filter(Boolean);
  return lines.length===1 && lines[0]===head+"\trefs/heads/"+ref;
};
// Status and a provider code word are public. Message text and body are never surfaced.
const failure=async response=>{
  let code="";
  try{const body=await response.json();if(/^[a-z][a-z0-9_]{0,63}$/i.test(body?.error?.code ?? ""))code=" "+body.error.code;}catch{}
  const status=Number.isInteger(response.status)?response.status:0;
  // 4xx other than 408/429 is a provider rejection; still inspect before any retry.
  return status>=400 && status<500 && status!==408 && status!==429
    ? "Deployment rejected (HTTP "+status+code+"); inspect Preview before retrying"
    : "Deployment completion unconfirmed (HTTP "+status+code+"); inspect Preview before retrying";
};
// Injectable HTTP boundary permits offline tests without hosted mutations.
export const submitGitPreview=async(request,reviewedSha,accessToken,send=fetch)=>{
  ensure(typeof accessToken==="string" && accessToken.length>0,"Missing Vercel access credential");
  let deployment,rejected;
  try {
    // CLI `api` retries POSTs internally. A direct single fetch preserves the
    // one-attempt rule. Credentials exist only in memory and encrypted transport.
    // forceNew bypasses deduplication onto the push-triggered Preview of this SHA.
    const response=await send("https://api.vercel.com/v13/deployments?teamId="+org+"&forceNew=1",{
      method:"POST",redirect:"error",signal:AbortSignal.timeout(60000),
      headers:{Authorization:"Bearer "+accessToken,"Content-Type":"application/json"},
      body:JSON.stringify(request),
    });
    if(!response.ok)rejected=await failure(response);
    else deployment=await response.json();
  }catch{throw new Error("Deployment completion unconfirmed; inspect Preview before retrying");}
  ensure(!rejected,rejected);
  // Creation proves identity only. The canary showed env names empty while
  // building and present at READY, so configuration is checked by awaitPreviewReady.
  ensure(identityMatches(deployment,reviewedSha),"Deployment identity unconfirmed; inspect Preview before retrying");
  return {id:deployment.id,url:"https://"+deployment.url,reviewedSha,ready:false};
};
// The documented response requires only gitSource type/repoId. At least one
// provider-reported SHA must exist and none may differ; a reported ref must match.
const identityMatches=(deployment,reviewedSha)=>{
  const source=deployment?.gitSource;
  const shas=[source?.sha,deployment?.meta?.githubCommitSha].filter(value=>value!==undefined);
  return /^dpl_[a-zA-Z0-9]+$/.test(deployment?.id ?? "")
    && /^dfs-ev-demo-[a-z0-9]{6,}-vernon-neillys-projects\.vercel\.app$/.test(deployment.url ?? "")
    && deployment.projectId===project && deployment.target===null && deployment.customEnvironment==null
    && source?.type==="github" && String(source.repoId)===repoId && (source.ref===undefined || source.ref===ref)
    && shas.length>0 && shas.every(value=>value===reviewedSha);
};
const pending=["QUEUED","INITIALIZING","BUILDING"];
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
// Standard create-then-poll. GET is read-only, so transient failures are re-polled
// until the deadline; the POST is never repeated. READY is build readiness plus
// finalized configuration, not runtime delivery or qualification.
export const awaitPreviewReady=async(receipt,accessToken,{send=fetch,wait=sleep,now=Date.now,deadlineMs=900000,intervalMs=5000}={})=>{
  ensure(typeof accessToken==="string" && accessToken.length>0,"Missing Vercel access credential");
  ensure(/^dpl_[a-zA-Z0-9]+$/.test(receipt?.id ?? ""),"Invalid deployment receipt");
  const endpoint="https://api.vercel.com/v13/deployments/"+receipt.id+"?teamId="+org+"&withGitRepoInfo=true";
  const deadline=now()+deadlineMs;
  let last="no response";
  while(now()<deadline) {
    let deployment;
    try {
      const response=await send(endpoint,{method:"GET",redirect:"error",signal:AbortSignal.timeout(15000),
        headers:{Authorization:"Bearer "+accessToken}});
      if(response.ok)deployment=await response.json();
      else {
        const message=await failure(response);
        // A provider rejection (e.g. 403/404) will not resolve by polling.
        ensure(!message.startsWith("Deployment rejected"),message.replace("Deployment rejected","Readiness check rejected"));
        last=message.match(/\(HTTP [^)]*\)/)[0];
      }
    }catch(error){
      if(error.message.startsWith("Readiness check rejected"))throw error;
      last="transport failure";
    }
    if(deployment) {
      ensure(identityMatches(deployment,receipt.reviewedSha) && "https://"+deployment.url===receipt.url && deployment.id===receipt.id,
        "Deployment identity changed; inspect Preview before use");
      const state=deployment.readyState;
      if(state==="READY") {
        ensure(Array.isArray(deployment.env) && keys.every(key=>deployment.env.includes(key)),
          "Deployment configuration unconfirmed at READY; inspect Preview before use");
        const regions=Array.isArray(deployment.regions)?deployment.regions.filter(region=>typeof region==="string"):[];
        return {...receipt,ready:true,readyState:state,regions};
      }
      ensure(pending.includes(state),"Deployment did not become ready ("+(/^[A-Z_]{1,32}$/.test(state ?? "")?state:"unknown state")+"); inspect Preview before use");
      last=state;
    }
    await wait(intervalMs);
  }
  throw new Error("Readiness unconfirmed by deadline (last: "+last+"); inspect Preview before use");
};
