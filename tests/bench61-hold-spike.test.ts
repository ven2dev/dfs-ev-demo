import {afterAll,beforeAll,describe,expect,it} from "vitest";
import type {Pool,PoolClient} from "pg";
import {randomUUID} from "node:crypto";
import {writeFileSync} from "node:fs";
import {performance} from "node:perf_hooks";
import {candidateSchema,candidateSql,debitParams,type CandidateContext} from "@/lib/bench61-candidate";
import {cleanupCandidate,local,operatorPool,setupCandidate,workerPool} from "./bench61-candidate-fixture";

// Opt-in local spike. It measures how long one contended row stays locked per
// debit, by running 20 workers on one row until the queue is always non-empty:
// then commits/second = 1 / hold time. No wall-clock assertion; the receipt
// records the numbers. Only the fixed local fixture is used.
const spike=local && process.env.BENCH61_HOLD_SPIKE==="1";
const s='"'+candidateSchema+'"',owner="local-hold-spike-owner",amount=3,start=10_000_000;
const context:CandidateContext={owner,request:randomUUID(),account:"candidate-account",period:"local-period"};
type Mode="single"|"batch"|"single-async";
const modes:Mode[]=["single","batch","single-async"];
const op=spike?operatorPool():undefined;
let owned=false;
// The worker role allows 24 connections, so each measurement opens and closes its
// own pool (outside the timed region) instead of holding two pools at once.
const poolFor=(mode:Mode)=>workerPool(mode==="single-async"?"-c synchronous_commit=off":undefined);
const percentile=(sorted:number[],p:number)=>sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)];
const round=(value:number)=>Math.round(value*1000)/1000;

// "batch" mirrors the old shape: an explicit transaction of timeout setup, guard,
// then the debit, committed by a separate COMMIT round trip.
const debit=async(client:PoolClient,mode:Mode)=>{
  const params=debitParams(context,amount,true);
  if(mode!=="batch")return (await client.query(candidateSql("debit"),params)).rows;
  await client.query("BEGIN");
  try{
    await client.query("SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true)");
    await client.query(`SELECT ${s}.guard($1,$2)`,[context.owner,context.request]);
    const rows=(await client.query(candidateSql("debit"),params)).rows;
    await client.query("COMMIT");
    return rows;
  }catch(error){await client.query("ROLLBACK");throw error;}
};
const reset=()=>op!.query(`UPDATE ${s}.budgets SET balance=$1,observed_at=clock_timestamp(),active=true`,[start]);
const measure=async(mode:Mode,workers:number,count:number)=>{
  await reset();
  const pool=poolFor(mode);
  const clients=await Promise.all(Array.from({length:workers},()=>pool.connect()));
  try{
  const latencies:number[]=[],pids=new Set<unknown>();
  let next=0,admitted=0;
  const observedAt=new Date().toISOString();
  const began=performance.now();
  // allSettled drains every started debit before any failure is reported.
  const results=await Promise.allSettled(clients.map(async client=>{
    while(next<count){
      next++;
      const t=performance.now();
      const rows=await debit(client,mode);
      latencies.push(performance.now()-t);
      if(rows.length){admitted++;pids.add(rows[0].pid);}
    }
  }));
  const elapsedMs=performance.now()-began;
  const failure=results.find(result=>result.status==="rejected");
  if(failure?.status==="rejected")throw failure.reason;
  const balance=Number((await op!.query(`SELECT balance FROM ${s}.budgets`)).rows[0].balance);
  expect(admitted).toBe(count);
  expect(balance).toBe(start-count*amount);
  const sorted=[...latencies].sort((a,b)=>a-b);
  return {mode,workers,count,observedAt,admitted,backends:pids.size,elapsedMs:round(elapsedMs),
    commitsPerSecond:round(admitted/(elapsedMs/1000)),
    // Valid as a hold-time estimate only when the row is always contended (workers>1).
    impliedHoldMs:round(elapsedMs/admitted),
    p50Ms:round(percentile(sorted,0.5)),p95Ms:round(percentile(sorted,0.95)),maxMs:round(sorted.at(-1)!)};
  }finally{clients.forEach(client=>client.release());await pool.end();}
};

beforeAll(async()=>{
  if(!spike)return;
  await setupCandidate(op!,context);owned=true;
},15000);
afterAll(async()=>{
  if(owned)await cleanupCandidate(op!,owner);
  await op?.end();
});
describe.skipIf(!spike)("fixed local lock-hold spike",()=>{
  it("records commits per second and implied hold time for three commit shapes",async()=>{
    const startedAt=new Date().toISOString();
    const setting=async(pool:Pool,name:string)=>(await pool.query(`SELECT current_setting($1) AS v`,[name])).rows[0].v;
    const loginSetting=async(mode:Mode)=>{const pool=poolFor(mode);try{return await setting(pool,"synchronous_commit");}finally{await pool.end();}};
    const settings={server_version:await setting(op!,"server_version"),fsync:await setting(op!,"fsync"),
      wal_sync_method:await setting(op!,"wal_sync_method"),full_page_writes:await setting(op!,"full_page_writes"),
      synchronous_commit:{durable:await loginSetting("single"),async:await loginSetting("single-async")}};
    expect(settings.synchronous_commit).toEqual({durable:"on",async:"off"});
    const runs=[];
    // Warm every pool connection once, then alternate modes across three rounds.
    for(const mode of modes)await measure(mode,20,100);
    for(let roundIndex=0;roundIndex<3;roundIndex++){
      for(const mode of modes){
        runs.push({round:roundIndex+1,...await measure(mode,20,1000)});
        runs.push({round:roundIndex+1,...await measure(mode,1,200)});
      }
    }
    const receipt={scope:"local lock-hold spike for the #61 short-statement candidate",startedAt,finishedAt:new Date().toISOString(),
      node:process.version,fixture:"127.0.0.1:54361/bench61, PostgreSQL 18.6, 512 MiB container",settings,
      method:"20 workers debit one row until 1000 commits; implied hold = elapsed / commits. Single-worker runs give uncontended latency. 'batch' = BEGIN, set_config, guard, debit, COMMIT as separate round trips; 'single' = one autocommit statement; 'single-async' = single with synchronous_commit=off at login.",
      limits:"Loopback client and local container disk. Neon commit latency (WAL quorum) and proxy round trips differ, so these numbers show the mechanism, not hosted hold time.",
      runs};
    if(process.env.BENCH61_SPIKE_RECEIPT)writeFileSync(process.env.BENCH61_SPIKE_RECEIPT,JSON.stringify(receipt,null,2)+"\n",{flag:"wx"});
    console.log(JSON.stringify(runs.map(r=>({round:r.round,mode:r.mode,workers:r.workers,cps:r.commitsPerSecond,holdMs:r.impliedHoldMs,p95Ms:r.p95Ms,backends:r.backends}))));
  },120000);
});
