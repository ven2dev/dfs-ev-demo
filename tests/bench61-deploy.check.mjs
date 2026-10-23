import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,stat,chmod,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createRuntimeSpec,validateRuntimeSpec,writeRuntimeSpec,deployPreparedPreview,submitGitPreview,remoteRefMatches,awaitPreviewReady} from "../scripts/bench61-deploy.mjs";
const now=Date.parse("2026-10-22T22:00:00Z"),sha="c".repeat(40);
const url="postgres://operator:never-copied@ep-broad-mouse-b773hf6f-pooler.c-13.us-east-1.aws.neon.tech/neondb?sslmode=require";
const link={projectId:"prj_GLXDEeScMKPAeDAUoYIoiNknwKJd",orgId:"team_s66WXM6S37xvFRoA68265CFl"};
const ref="feature/dfsEV-206-budget-latency-profile";
const valid={id:"dpl_test",url:"dfs-ev-demo-abc123def-vernon-neillys-projects.vercel.app",projectId:link.projectId,target:null,
  gitSource:{type:"github",repoId:"1350991998",ref,sha},meta:{githubCommitSha:sha},
  env:["BENCH61_DATABASE_URL","BENCH61_TOKEN_HASH","BENCH61_ISSUED_AT","BENCH61_EXPIRES_AT","BENCH61_REVIEWED_SHA","DATABASE_URL"]};
test("generates independent credentials and pins a Git-source Preview with deployment-only runtime keys",()=>{
  const spec=createRuntimeSpec(url,sha,now),other=createRuntimeSpec(url,sha,now);
  assert.notEqual(spec.token,other.token);
  assert.notEqual(spec.runtime.BENCH61_DATABASE_URL,other.runtime.BENCH61_DATABASE_URL);
  assert(!JSON.stringify(spec).includes("never-copied"));
  const request=validateRuntimeSpec(spec,sha,link,true,now);
  assert.deepEqual(Object.keys(request).sort(),["env","gitSource","meta","name","project"]);
  assert.deepEqual(request.gitSource,{type:"github",repoId:"1350991998",ref:"feature/dfsEV-206-budget-latency-profile",sha});
  assert.equal(request.project,link.projectId);
  assert.deepEqual(request.env,spec.runtime);
  assert(!JSON.stringify(request).includes(spec.token));
  assert(!("VERCEL_GIT_COMMIT_SHA" in request.env));
  assert(!Object.keys(spec.runtime).includes("DATABASE_URL"));
  assert.equal(new URL(spec.runtime.BENCH61_DATABASE_URL).search,"?sslmode=require");
});
test("refuses wrong target, dirty/unreviewed checkout, project, extra env, or short cleanup window",()=>{
  assert.throws(()=>createRuntimeSpec("invalid-secret-input",sha,now),error=>error.message==="Invalid connection URL" && !JSON.stringify(error).includes("invalid-secret-input"));
  assert.throws(()=>createRuntimeSpec(url.replace("ep-broad-mouse","ep-other"),sha,now),/Wrong Preview/);
  assert.throws(()=>createRuntimeSpec(url+"&password=operator-secret",sha,now),/Unsupported connection options/);
  for(const [head,target,clean] of [[sha,link,false],["d".repeat(40),link,true],[sha,{...link,projectId:"wrong"},true]]) {
    assert.throws(()=>validateRuntimeSpec(createRuntimeSpec(url,sha,now),head,target,clean,now));
  }
  const spec=createRuntimeSpec(url,sha,now);
  spec.runtime.DATABASE_URL=url;
  assert.throws(()=>validateRuntimeSpec(spec,sha,link,true,now),/Unexpected runtime/);
  assert.throws(()=>validateRuntimeSpec(createRuntimeSpec(url,sha,now),sha,link,true,now+85500000),/cleanup headroom/);
});
test("pins the reviewed database during preparation and validation, including normalized URI names",()=>{
  assert.throws(()=>createRuntimeSpec(url.replace("/neondb","/ordinary_app_db"),sha,now),/Wrong Preview target/);
  const spec=createRuntimeSpec(url,sha,now);
  spec.runtime.BENCH61_DATABASE_URL=spec.runtime.BENCH61_DATABASE_URL.replace("/neondb","/ordinary_app_db");
  assert.throws(()=>validateRuntimeSpec(spec,sha,link,true,now),/Wrong worker credential/);
  const normalized=createRuntimeSpec(url.replace("/neondb","/%6Eeondb"),sha,now);
  assert.doesNotThrow(()=>validateRuntimeSpec(normalized,sha,link,true,now));
});
test("private preparation refuses checkout paths and overwrite; unsafe permissions stop before deployment",async()=>{
  const folder=await mkdtemp(join(tmpdir(),"bench61-deploy-unit-")),file=join(folder,"credential.json");
  try {
    const summary=await writeRuntimeSpec(file,url,sha);
    assert.equal(summary.path,file);assert(!("token" in summary));
    assert.equal((await stat(file)).mode&0o077,0);
    await assert.rejects(writeRuntimeSpec(file,url,sha));
    const inside=fileURLToPath(new URL("../bench61-never-written.json",import.meta.url));
    await assert.rejects(writeRuntimeSpec(inside,url,sha),/outside checkout/);
    await chmod(file,0o644);
    await assert.rejects(deployPreparedPreview(file),/not private/);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test("posts once to the fixed API with private credentials and returns only safe metadata",async()=>{
  const spec=createRuntimeSpec(url,sha,now),request=validateRuntimeSpec(spec,sha,link,true,now);
  let calls=0;
  const receipt=await submitGitPreview(request,sha,"private-access",async(endpoint,options)=>{
    calls++;
    assert.equal(endpoint,"https://api.vercel.com/v13/deployments?teamId="+link.orgId+"&forceNew=1");
    assert.equal(options.method,"POST");assert.equal(options.redirect,"error");
    assert.equal(options.headers.Authorization,"Bearer private-access");
    assert.deepEqual(JSON.parse(options.body),request);
    assert(options.signal instanceof AbortSignal);
    // Real responses list env names only; gitSource repoId may be numeric.
    return {ok:true,json:async()=>({...valid,gitSource:{type:"github",repoId:1350991998,ref,sha}})};
  });
  assert.equal(calls,1);assert.equal(receipt.ready,false);
  assert.deepEqual(Object.keys(receipt).sort(),["id","ready","reviewedSha","url"]);
  assert(!JSON.stringify(receipt).includes(spec.runtime.BENCH61_DATABASE_URL));
  assert(!JSON.stringify(receipt).includes("private-access"));
  // Canary: env names are empty while building, so creation must not require them.
  for(const accepted of [{...valid,meta:{}},{...valid,gitSource:{type:"github",repoId:"1350991998"}},
    {...valid,env:[],readyState:"BUILDING"},{...valid,env:undefined}]) {
    assert.equal((await submitGitPreview(request,sha,"private-access",async()=>({ok:true,json:async()=>accepted}))).id,"dpl_test");
  }
});
test("ambiguous create and wrong identity never retry or expose captured credentials",async()=>{
  const spec=createRuntimeSpec(url,sha,now),request=validateRuntimeSpec(spec,sha,link,true,now);
  const noTarget={...valid};delete noTarget.target;
  for(const response of [{ok:false,status:503,json:async()=>spec},{ok:false,status:429,json:async()=>({error:{code:"rate_limited"}})},
    {ok:true,json:async()=>{throw Error(spec.token);}},
    ...[null,noTarget,{...valid,target:"production"},{...valid,customEnvironment:{id:"env_x"}},{...valid,projectId:"wrong"},
      {...valid,meta:{githubCommitSha:"d".repeat(40)}},{...valid,gitSource:{...valid.gitSource,sha:"d".repeat(40)}},
      {...valid,meta:{},gitSource:{type:"github",repoId:"1350991998"}},{...valid,gitSource:{...valid.gitSource,repoId:"1"}},
      {...valid,gitSource:{...valid.gitSource,ref:"main"}},{...valid,url:"attacker.example"}].map(d=>({ok:true,json:async()=>d}))]){
    let calls=0;
    await assert.rejects(submitGitPreview(request,sha,"private-access",async()=>{calls++;return response;}),error=>
      /unconfirmed/.test(error.message) && !error.message.includes(spec.token));
    assert.equal(calls,1);
  }
  await assert.rejects(submitGitPreview(request,sha,"private-access",async()=>({ok:false,status:503,json:async()=>spec})),
    error=>error.message.includes("HTTP 503)") && !error.message.includes(spec.token) && !error.message.includes(spec.runtime.BENCH61_DATABASE_URL));
  await assert.rejects(submitGitPreview(request,sha,"private-access",async()=>({ok:false,status:429,json:async()=>({error:{code:"rate_limited"}})})),
    /unconfirmed \(HTTP 429 rate_limited\)/);
  await assert.rejects(submitGitPreview(request,sha,"private-access",async()=>{throw Error("private-access");}),error=>!error.message.includes("private-access"));
  await assert.rejects(submitGitPreview(request,sha,undefined,async()=>{assert.fail("No call without credential");}),/Missing Vercel/);
});
test("provider rejection reports status and code word only, never message text or body",async()=>{
  const spec=createRuntimeSpec(url,sha,now),request=validateRuntimeSpec(spec,sha,link,true,now);
  for(const [status,body,expected] of [[404,{error:{code:"not_found",message:spec.token}},"Deployment rejected (HTTP 404 not_found);"],
    [400,{error:{code:"bad request "+spec.token}},"Deployment rejected (HTTP 400);"],[403,"<html>",/^Deployment rejected \(HTTP 403\);/],
    [408,{},"Deployment completion unconfirmed (HTTP 408);"]]) {
    let calls=0;
    await assert.rejects(submitGitPreview(request,sha,"private-access",async()=>{calls++;
      return {ok:false,status,json:async()=>{if(typeof body==="string")throw Error(body);return body;}};}),error=>
      (typeof expected==="string"?error.message.startsWith(expected):expected.test(error.message))
      && !error.message.includes(spec.token) && !error.message.includes("private-access"));
    assert.equal(calls,1);
  }
});
test("remote preflight requires exactly the reviewed SHA at the fixed branch",()=>{
  assert(remoteRefMatches(sha+"\trefs/heads/"+ref+"\n",sha));
  for(const output of ["","d".repeat(40)+"\trefs/heads/"+ref,sha+"\trefs/heads/main",
    sha+"\trefs/heads/"+ref+"\n"+sha+"\trefs/heads/"+ref+"-copy",undefined]) assert(!remoteRefMatches(output,sha));
});
const receipt={id:"dpl_test",url:"https://"+valid.url,reviewedSha:sha,ready:false};
const poller=(responses,options={})=>{
  let clock=0,calls=0,waits=0;
  const run=awaitPreviewReady(receipt,"private-access",{now:()=>clock,wait:async ms=>{waits++;clock+=ms;},deadlineMs:60000,intervalMs:5000,...options,
    send:async(endpoint,init)=>{
      assert.equal(endpoint,"https://api.vercel.com/v13/deployments/dpl_test?teamId="+link.orgId+"&withGitRepoInfo=true");
      assert.equal(init.method,"GET");assert.equal(init.redirect,"error");assert.equal(init.body,undefined);
      assert.equal(init.headers.Authorization,"Bearer private-access");assert(init.signal instanceof AbortSignal);
      const next=responses[Math.min(calls++,responses.length-1)];
      if(next instanceof Error)throw next;
      return next;
    }});
  return {run,stats:()=>({calls,waits})};
};
const ok=deployment=>({ok:true,json:async()=>deployment});
test("readiness polls past empty building env and requires every runtime key at READY",async()=>{
  const {run,stats}=poller([ok({...valid,readyState:"QUEUED",env:[]}),ok({...valid,readyState:"BUILDING",env:[]}),
    {ok:false,status:503,json:async()=>({})},Error("private-access"),ok({...valid,readyState:"READY",regions:["iad1"]})]);
  const ready=await run;
  assert.deepEqual(ready,{...receipt,ready:true,readyState:"READY",regions:["iad1"]});
  assert.deepEqual(stats(),{calls:5,waits:4});
  assert(!JSON.stringify(ready).includes("private-access"));
});
test("readiness stops on missing configuration, terminal state, identity change or provider rejection",async()=>{
  for(const [responses,expected] of [
    [[ok({...valid,readyState:"READY",env:valid.env.slice(1)})],/configuration unconfirmed at READY/],
    [[ok({...valid,readyState:"READY",env:undefined})],/configuration unconfirmed at READY/],
    [[ok({...valid,readyState:"ERROR"})],/did not become ready \(ERROR\)/],
    [[ok({...valid,readyState:"CANCELED"})],/did not become ready \(CANCELED\)/],
    [[ok({...valid,readyState:"BLOCKED"})],/did not become ready \(BLOCKED\)/],
    [[ok({...valid,readyState:"private-access"})],/did not become ready \(unknown state\)/],
    [[ok({...valid,readyState:"BUILDING",gitSource:{...valid.gitSource,sha:"d".repeat(40)}})],/identity changed/],
    [[ok({...valid,readyState:"READY",target:"production"})],/identity changed/],
    [[ok({...valid,id:"dpl_other",readyState:"READY"})],/identity changed/],
    [[{ok:false,status:404,json:async()=>({error:{code:"not_found",message:"private-access"}})}],/^Readiness check rejected \(HTTP 404 not_found\)/],
  ]) {
    const {run,stats}=poller(responses);
    await assert.rejects(run,error=>expected.test(error.message) && !error.message.includes("private-access"));
    assert.equal(stats().calls,1);
  }
});
test("readiness reports the last observation at the deadline and never polls without credentials",async()=>{
  const {run,stats}=poller([ok({...valid,readyState:"BUILDING",env:[]})]);
  await assert.rejects(run,/Readiness unconfirmed by deadline \(last: BUILDING\)/);
  assert.deepEqual(stats(),{calls:12,waits:12});
  const failing=poller([{ok:false,status:502,json:async()=>({})}]);
  await assert.rejects(failing.run,/last: \(HTTP 502\)/);
  await assert.rejects(awaitPreviewReady(receipt,undefined,{send:async()=>assert.fail("No call without credential")}),/Missing Vercel/);
  await assert.rejects(awaitPreviewReady({...receipt,id:"../x"},"private-access",{send:async()=>assert.fail("No call for invalid id")}),/Invalid deployment receipt/);
});
