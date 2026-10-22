import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,stat,chmod,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createRuntimeSpec,validateRuntimeSpec,writeRuntimeSpec,deployPreparedPreview} from "../scripts/bench61-deploy.mjs";
const now=Date.parse("2026-10-22T22:00:00Z"),sha="c".repeat(40);
const url="postgres://operator:never-copied@ep-broad-mouse-b773hf6f-pooler.c-13.us-east-1.aws.neon.tech/neondb?sslmode=require";
const link={projectId:"prj_GLXDEeScMKPAeDAUoYIoiNknwKJd",orgId:"team_s66WXM6S37xvFRoA68265CFl"};
test("generates independent private credentials and only key names appear in Preview arguments",()=>{
  const spec=createRuntimeSpec(url,sha,now),other=createRuntimeSpec(url,sha,now);
  assert.notEqual(spec.token,other.token);
  assert.notEqual(spec.runtime.BENCH61_DATABASE_URL,other.runtime.BENCH61_DATABASE_URL);
  assert(!JSON.stringify(spec).includes("never-copied"));
  const args=validateRuntimeSpec(spec,sha,link,true,now);
  assert(!args.includes("--prod"));assert(!args.includes("--build-env"));
  assert(args.includes("--env"));
  assert(!args.join(" ").includes(spec.token));
  assert(!args.join(" ").includes(spec.runtime.BENCH61_DATABASE_URL));
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
