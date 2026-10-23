import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,stat,chmod,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createRuntimeSpec,validateRuntimeSpec,writeRuntimeSpec,deployPreparedPreview,submitGitPreview} from "../scripts/bench61-deploy.mjs";
const now=Date.parse("2026-10-22T22:00:00Z"),sha="c".repeat(40);
const url="postgres://operator:never-copied@ep-broad-mouse-b773hf6f-pooler.c-13.us-east-1.aws.neon.tech/neondb?sslmode=require";
const link={projectId:"prj_GLXDEeScMKPAeDAUoYIoiNknwKJd",orgId:"team_s66WXM6S37xvFRoA68265CFl"};
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
    assert.equal(endpoint,"https://api.vercel.com/v13/deployments?teamId="+link.orgId);
    assert.equal(options.method,"POST");assert.equal(options.redirect,"error");
    assert.equal(options.headers.Authorization,"Bearer private-access");
    assert.deepEqual(JSON.parse(options.body),request);
    assert(options.signal instanceof AbortSignal);
    return {ok:true,json:async()=>({id:"dpl_disposable",url:"dfs-ev-demo-abc123def-vernon-neillys-projects.vercel.app",
      projectId:link.projectId,target:null,meta:{githubCommitSha:sha},env:request.env})};
  });
  assert.equal(calls,1);assert.equal(receipt.ready,false);
  assert.deepEqual(Object.keys(receipt).sort(),["id","ready","reviewedSha","url"]);
  assert(!JSON.stringify(receipt).includes(spec.runtime.BENCH61_DATABASE_URL));
  assert(!JSON.stringify(receipt).includes("private-access"));
});
test("ambiguous create and wrong identity never retry or expose captured credentials",async()=>{
  const spec=createRuntimeSpec(url,sha,now),request=validateRuntimeSpec(spec,sha,link,true,now);
  const valid={id:"dpl_test",url:"dfs-ev-demo-abc123def-vernon-neillys-projects.vercel.app",projectId:link.projectId,meta:{githubCommitSha:sha}};
  for(const response of [{ok:false,json:async()=>spec}, {ok:true,json:async()=>{throw Error(spec.token);}},
    ...[null,{...valid,target:"production"},{...valid,projectId:"wrong"},
      {...valid,meta:{githubCommitSha:"d".repeat(40)}},{...valid,url:"attacker.example"}].map(d=>({ok:true,json:async()=>d}))]){
    let calls=0;
    await assert.rejects(submitGitPreview(request,sha,"private-access",async()=>{calls++;return response;}),error=>
      /unconfirmed/.test(error.message) && !error.message.includes(spec.token));
    assert.equal(calls,1);
  }
  await assert.rejects(submitGitPreview(request,sha,"private-access",async()=>{throw Error("private-access");}),error=>!error.message.includes("private-access"));
  await assert.rejects(submitGitPreview(request,sha,undefined,async()=>{assert.fail("No call without credential");}),/Missing Vercel/);
});
