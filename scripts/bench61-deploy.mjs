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
  return {...await submitGitPreview(request,head,accessToken),expiresAt:spec.runtime.BENCH61_EXPIRES_AT};
};
// Injectable HTTP boundary permits offline tests without hosted mutations.
export const submitGitPreview=async(request,reviewedSha,accessToken,send=fetch)=>{
  ensure(typeof accessToken==="string" && accessToken.length>0,"Missing Vercel access credential");
  let deployment;
  try {
    // CLI `api` retries POSTs internally. A direct single fetch preserves the
    // one-attempt rule. Credentials exist only in memory and encrypted transport.
    const response=await send("https://api.vercel.com/v13/deployments?teamId="+org,{
      method:"POST",redirect:"error",signal:AbortSignal.timeout(60000),
      headers:{Authorization:"Bearer "+accessToken,"Content-Type":"application/json"},
      body:JSON.stringify(request),
    });
    if(!response.ok)throw new Error();
    deployment=await response.json();
  }catch{throw new Error("Deployment completion unconfirmed; inspect Preview before retrying");}
  ensure(/^dpl_[a-zA-Z0-9]+$/.test(deployment?.id ?? "")
    && /^dfs-ev-demo-[a-z0-9]{6,}-vernon-neillys-projects\.vercel\.app$/.test(deployment.url ?? "")
    && deployment.projectId===project && deployment.target==null
    && deployment.meta?.githubCommitSha===reviewedSha,
    "Deployment identity unconfirmed; inspect Preview before retrying");
  // Creation is not readiness or runtime qualification. Independently inspect
  // the deployment's protection/region/SHA and require catalog before setup.
  return {id:deployment.id,url:"https://"+deployment.url,reviewedSha,ready:false};
};
