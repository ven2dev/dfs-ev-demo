import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash,randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { runCompressedWorker,codecSandboxArgs,CODEC_WORKER_IMAGE,CODEC_WORKER_MEMORY } from "../../src/lib/predictive/compressedWorker.ts";
import { inspectCompressedSource } from "../../src/lib/predictive/compressedSource.ts";
import { sourceCsv } from "./fixtures/source.ts";
import { SOURCE_HEADERS } from "../../src/lib/predictive/sourceHeaders.ts";
const wire=()=>gzipSync(sourceCsv("player"));
const request=bytes=>({feed:"player",season:2026,wireSha256:createHash("sha256").update(bytes).digest("hex"),wireBytes:bytes.length});

test("isolated worker reproduces exact inspection under kernel memory and swap limits",async()=>{
  const bytes=wire(),proof=await runCompressedWorker("inspect",bytes,request(bytes));
  assert.deepEqual(proof.result,await inspectCompressedSource(bytes,request(bytes)));
  assert.equal(proof.memoryLimitBytes,CODEC_WORKER_MEMORY);assert.ok(proof.peakRssBytes>0&&proof.peakRssBytes<=CODEC_WORKER_MEMORY);
});
test("isolated worker prepares complete claims without publication activation",async()=>{
  const bytes=wire(),proof=await runCompressedWorker("claims",bytes,request(bytes),{captureId:"worker-capture"});
  assert.equal(proof.result.rows.length,1);assert.equal(proof.result.rows[0].projection.values.passingYards,80);
  assert.equal(proof.result.publicationSupported,false);
});
test("isolated worker pins caller buffers and scope before asynchronous startup",async()=>{
  const bytes=wire(),scope=request(bytes),limits={rows:1},pending=runCompressedWorker("inspect",bytes,scope,{limits});
  bytes.fill(0);scope.season=2025;limits.rows=0;
  const proof=await pending;assert.equal(proof.result.season,2026);assert.equal(proof.result.rows,1);assert.equal(proof.result.limits.rows,1);
});
test("isolated worker enforces downward decoded budgets and recovers after refusal",async()=>{
  const bytes=wire(),decodedBytes=Buffer.byteLength(sourceCsv("player"));
  await assert.rejects(runCompressedWorker("inspect",bytes,request(bytes),{limits:{decodedBytes:decodedBytes-1}}),/compressed-decoded-budget-exceeded/);
  assert.equal((await runCompressedWorker("inspect",bytes,request(bytes),{limits:{decodedBytes}})).result.decodedBytes,decodedBytes);
});
test("isolated worker refuses valid-wire CRC damage and recovers for the next job",async()=>{
  const bad=wire();bad[bad.length-8]^=1;
  await assert.rejects(runCompressedWorker("claims",bad,request(bad),{captureId:"crc"}),/compressed-gzip-refused/);
  const good=wire();assert.equal((await runCompressedWorker("inspect",good,request(good))).result.rows,1);
});
test("isolated worker refuses parallel jobs and cleans up cancellation before reuse",async()=>{
  const bytes=wire(),controller=new AbortController();
  const pending=runCompressedWorker("inspect",bytes,request(bytes),{signal:controller.signal});
  await assert.rejects(runCompressedWorker("inspect",bytes,request(bytes)),/compressed-worker-busy/);
  controller.abort();await assert.rejects(pending,/compressed-cancelled/);
  assert.equal((await runCompressedWorker("inspect",bytes,request(bytes))).result.rows,1);
});
test("isolated worker enforces bounded deadline and rejects an already cancelled job",async()=>{
  const bytes=wire(),controller=new AbortController();controller.abort();
  await assert.rejects(runCompressedWorker("inspect",bytes,request(bytes),{signal:controller.signal}),/compressed-cancelled/);
  await assert.rejects(runCompressedWorker("inspect",bytes,request(bytes),{deadlineMs:1}),/compressed-deadline-exceeded/);
  assert.equal((await runCompressedWorker("inspect",bytes,request(bytes))).result.rows,1);
});
test("the same kernel sandbox kills native Buffer allocation beyond 256 MiB",()=>{
  const name="dfs106-worker-test-"+randomUUID();
  try {
    const created=spawnSync("docker",["create","--name",name,...codecSandboxArgs(),CODEC_WORKER_IMAGE,"node","-e",
      "process.stdout.write(require('node:fs').readFileSync('/sys/fs/cgroup/memory.max','utf8'));const b=Buffer.alloc(512*1024*1024,1);process.stdout.write('allocation-survived:'+b.length)"],{encoding:"utf8",timeout:15000});
    assert.equal(created.status,0);
    const config=JSON.parse(spawnSync("docker",["inspect",name],{encoding:"utf8",timeout:5000}).stdout)[0];
    assert.equal(config.HostConfig.Memory,CODEC_WORKER_MEMORY);assert.equal(config.HostConfig.MemorySwap,CODEC_WORKER_MEMORY);
    assert.equal(config.HostConfig.NetworkMode,"none");assert.equal(config.HostConfig.ReadonlyRootfs,true);
    assert.equal(config.HostConfig.LogConfig.Type,"none");assert.equal(config.Config.User,"65534:65534");
    const result=spawnSync("docker",["start","--attach",name],{encoding:"utf8",timeout:15000});
    assert.equal(result.status,137);assert.equal(result.stdout,String(CODEC_WORKER_MEMORY)+"\n");
    const stopped=JSON.parse(spawnSync("docker",["inspect",name],{encoding:"utf8",timeout:5000}).stdout)[0];
    assert.equal(stopped.State.OOMKilled,true);
    assert.equal(spawnSync("docker",["container","ls","-a","--filter","name=^/"+name+"$","--format","{{.ID}}"],{encoding:"utf8",timeout:5000}).stdout.trim(),created.stdout.trim().slice(0,12));
  } finally {spawnSync("docker",["rm","-f",name],{stdio:"ignore",timeout:5000});}
});
test("worker recovers after resource refusal and leaves no owned running or stopped containers",async()=>{
  const raw={player_id:"00-0000001",season:"2026",week:"6",season_type:"REG",game_id:"2026_06_CAR_PHI",team:"PHI",opponent_team:"CAR"};
  const record=SOURCE_HEADERS.player.map(column=>raw[column]??"").join(",")+"\n";
  const large=gzipSync(SOURCE_HEADERS.player.join(",")+"\n"+record.repeat(80000));
  await assert.rejects(runCompressedWorker("claims",large,request(large),{captureId:"resource-stress"}),/compressed-worker-(memory-exceeded|failed|output-refused)/);
  const bytes=wire();assert.equal((await runCompressedWorker("inspect",bytes,request(bytes))).result.rows,1);
  const result=spawnSync("docker",["container","ls","-a","--filter","name=dfs106-","--format","{{.ID}}"],{encoding:"utf8",timeout:5000});
  assert.equal(result.status,0);assert.equal(result.stdout.trim(),"");
});
