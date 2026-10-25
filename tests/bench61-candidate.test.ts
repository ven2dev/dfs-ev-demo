import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import type {Pool} from "pg";
import {randomUUID} from "node:crypto";
import {candidateFence,candidateRole as role,candidateSchema,candidateSql,correctionParams,debitParams,runCandidateBatch,type CandidateContext} from "@/lib/bench61-candidate";
import {cleanupCandidate,local,operatorPool,setupCandidate,workerPool} from "./bench61-candidate-fixture";
const s='"'+candidateSchema+'"',fence=candidateFence,owner="local-candidate-owner";
const context:CandidateContext={owner,request:randomUUID(),account:"candidate-account",period:"local-period"};
const op=local?operatorPool():undefined;
let worker:Pool|undefined,owned=false;
const rows=async(text:string,params:unknown[]=[]) => (await worker!.query(text,params)).rows;
const params=(value=3,interactive=true)=>debitParams(context,value,interactive);
const correction=(value:number,observedAt:string,changed=context)=>correctionParams(changed,value,observedAt);
it("caps work and refuses invalid amount before dispatch",async()=>{
  for(const [count,workers] of [[0,1],[1001,20],[1,21],[1,0]])
    await expect(runCandidateBatch(async()=>{throw Error("Must not dispatch");},"debit",params(),count,workers)).rejects.toThrow("cap");
  for(const value of [-1,0.1,NaN,Number.MAX_SAFE_INTEGER+1])expect(()=>params(value)).toThrow("amount");
  expect(()=>candidateSql("arbitrary" as never)).toThrow("mode");
  for(const observed of ["not-a-time",true as never])expect(()=>correction(1,observed)).toThrow("observation");
});
it("drains started requests after the first failure without retrying",async()=>{
  let calls=0,finished=0,fail!:()=>void;
  const releases:(()=>void)[]=[];
  const batch=runCandidateBatch(async()=>{
    const n=++calls;
    if(n===1)return await new Promise((_,reject)=>{fail=()=>{finished++;reject(Error("ambiguous result"));};});
    await new Promise<void>(resolve=>releases.push(resolve));finished++;return [{balance:1}];
  },"debit",params(),1000,20);
  // Handle the rejection before triggering it, then prove completion waits for
  // all other started requests rather than returning on the first failure.
  const rejection=expect(batch).rejects.toThrow("ambiguous result");
  expect(calls).toBe(20);fail();await Promise.resolve();
  expect(finished).toBe(1);releases.forEach(resolve=>resolve());await rejection;
  expect(calls).toBe(20);expect(finished).toBe(20);
});
beforeAll(async()=>{
  if(!local)return;
  await setupCandidate(op!,context);owned=true;
  worker=workerPool();
},15000);
beforeEach(async()=>{
  if(!local||!owned)return;
  await op!.query(`UPDATE ${s}.budgets SET period=$1,balance=100,floor=20,observed_at=date_trunc('milliseconds',clock_timestamp()),active=true`,[context.period]);
  await op!.query(`UPDATE ${s}.run SET owner=$1,request=$2,lease_until=clock_timestamp()+interval '5 minutes'`,[owner,context.request]);
});
afterAll(async()=>{
  await worker?.end();
  // Exclusive fence, schema and role ownership, drop, then confirmed absence.
  if(owned)await cleanupCandidate(op!,owner);
  await op?.end();
});
describe.skipIf(!local)("fixed local short-statement candidate",()=>{
  it("uses pre-login server defaults on20 simultaneous worker logins",async()=>{
    const connections=await Promise.allSettled(Array.from({length:20},()=>worker!.connect()));
    const clients=connections.flatMap(result=>result.status==="fulfilled"?[result.value]:[]);
    try{
      expect(clients.length).toBe(20);
      const identities=await Promise.allSettled(clients.map(c=>c.query("SELECT session_user,current_user,current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock")));
      expect(identities.every(result=>result.status==="fulfilled"&&result.value.rows[0].session_user===role&&result.value.rows[0].current_user===role&&result.value.rows[0].statement==="5s"&&result.value.rows[0].lock==="2s")).toBe(true);
    }finally{clients.forEach(c=>c.release());}
  });
  it("preserves interactive floor and total budget with1000 attempts at20 workers",async()=>{
    const interactive=await runCandidateBatch(rows,"debit",params(),1000,20);
    expect(interactive).toMatchObject({started:1000,admitted:26,denied:974,roundTrips:1000,submittedStatements:1000});
    expect(interactive.backends).toBeGreaterThan(1);
    const collector=await runCandidateBatch(rows,"debit",params(3,false),100,20);
    expect(collector.admitted).toBe(7);
    expect((await op!.query(`SELECT balance::integer FROM ${s}.budgets`)).rows[0].balance).toBe(1);
  },15000);
  it("baseline leaves balance intact and invalid/stale/retired inputs never debit",async()=>{
    expect((await rows(candidateSql("baseline"),params())).length).toBe(1);
    for(const changed of [{...context,period:"old-period"},{...context,account:"missing"}])
      expect(await rows(candidateSql("debit"),debitParams(changed,3,true))).toEqual([]);
    expect(await rows(candidateSql("debit"),params(0))).toEqual([]);
    for(const patch of ["active=false","observed_at=clock_timestamp()-interval '6 minutes'","observed_at=clock_timestamp()+interval '1 minute'"]){
      await op!.query(`UPDATE ${s}.budgets SET observed_at=clock_timestamp(),active=true`);
      await op!.query(`UPDATE ${s}.budgets SET ${patch}`);
      expect(await rows(candidateSql("debit"),params())).toEqual([]);
    }
    expect((await op!.query(`SELECT balance::integer FROM ${s}.budgets`)).rows[0].balance).toBe(100);
  });
  it("quota corrections only lower balance and reject old/future/retired observations",async()=>{
    const before=(await op!.query(`SELECT observed_at FROM ${s}.budgets`)).rows[0].observed_at;
    expect((await rows(candidateSql("correction"),correction(90,before.toISOString())))[0].balance).toBe("90");
    expect((await rows(candidateSql("correction"),correction(99,before.toISOString())))[0].balance).toBe("90");
    expect(await rows(candidateSql("correction"),correction(1,new Date(before.getTime()-1).toISOString()))).toEqual([]);
    expect(await rows(candidateSql("correction"),correction(1,new Date(Date.now()+60000).toISOString()))).toEqual([]);
    expect(await rows(candidateSql("correction"),correction(1,before.toISOString(),{...context,period:"retired"}))).toEqual([]);
  });
  it("handles concurrent debit and downward correction work with20 total workers",async()=>{
    await op!.query(`UPDATE ${s}.budgets SET balance=1000000`);
    const observed=(await op!.query(`SELECT observed_at FROM ${s}.budgets`)).rows[0].observed_at.toISOString();
    const [debits,corrections]=await Promise.all([
      runCandidateBatch(rows,"debit",params(),900,18),
      runCandidateBatch(rows,"correction",correction(800000,observed),100,2),
    ]);
    expect(debits.admitted).toBe(900);expect(corrections.admitted).toBe(100);
    expect(debits.submittedStatements+corrections.submittedStatements).toBe(1000);
    const balance=(await op!.query(`SELECT balance::integer FROM ${s}.budgets`)).rows[0].balance;
    expect(balance).toBeGreaterThanOrEqual(800000-900*3);
    expect(balance).toBeLessThanOrEqual(800000);
  });
  it("an uncertain committed debit is not retried by the worker runner",async()=>{
    let calls=0;
    await expect(runCandidateBatch(async(text,p)=>{calls++;await rows(text,p);throw Error("commit response lost");},"debit",params(),10,1)).rejects.toThrow("response lost");
    expect(calls).toBe(1);
    expect((await op!.query(`SELECT balance::integer FROM ${s}.budgets`)).rows[0].balance).toBe(97);
  });
  it("requires real statement cancellation and rolls back a cancelled candidate debit",async()=>{
    for(const [text,p] of [["SELECT pg_sleep(6)",[]],[candidateSql("debit").replace("RETURNING balance","RETURNING balance,pg_sleep(6)"),params()]] as const){
      await expect(rows(text,[...p])).rejects.toMatchObject({code:"57014",message:expect.stringMatching(/statement timeout/i)});
    }
    expect((await op!.query(`SELECT balance::integer FROM ${s}.budgets`)).rows[0].balance).toBe(100);
  },15000);
  it("requires a real lock timeout while another transaction holds the account row",async()=>{
    const c=await op!.connect();
    try{await c.query("BEGIN");await c.query(`SELECT * FROM ${s}.budgets FOR UPDATE`);
      await expect(rows(candidateSql("debit"),params())).rejects.toMatchObject({code:"55P03",message:expect.stringMatching(/lock timeout/i)});
    }finally{await c.query("ROLLBACK");c.release();}
    expect((await op!.query(`SELECT balance::integer FROM ${s}.budgets`)).rows[0].balance).toBe(100);
  },6000);
  it("fences exclusive cleanup during admitted work and refuses late or wrong identities",async()=>{
    const running=rows(candidateSql("debit").replace("RETURNING balance","RETURNING balance,pg_sleep(2)"),params());
    // Attach handling immediately so test failures still drain the statement.
    const drained=running.then(value=>({value}),error=>({error}));
    try{
      let observed=false;
      for(let i=0;i<30;i++){
        observed=(await op!.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=610061 AND objid=20261025 AND mode='ShareLock' AND granted) AS held")).rows[0].held;
        if(observed)break;await new Promise(resolve=>setTimeout(resolve,25));
      }
      expect(observed).toBe(true);
      const c=await op!.connect();try{await c.query("BEGIN");expect((await c.query(`SELECT pg_try_advisory_xact_lock(${fence}) AS held`)).rows[0].held).toBe(false);}finally{await c.query("ROLLBACK");c.release();}
      await op!.query(`UPDATE ${s}.run SET lease_until=clock_timestamp()-interval '1 second'`);
      await expect(rows(candidateSql("baseline"),params())).rejects.toMatchObject({code:"P0001"});
      await expect(rows(candidateSql("debit"),params())).rejects.toMatchObject({code:"P0001"});
    }finally{const result=await drained;if("error" in result)throw result.error;}
    await op!.query(`UPDATE ${s}.run SET lease_until=clock_timestamp()+interval '5 minutes'`);
    await expect(rows(candidateSql("debit"),debitParams({...context,owner:"wrong-owner"},3,true))).rejects.toMatchObject({code:"P0001"});
    await expect(rows(candidateSql("debit"),debitParams({...context,request:randomUUID()},3,true))).rejects.toMatchObject({code:"P0001"});
    expect((await op!.query(`SELECT balance::integer FROM ${s}.budgets`)).rows[0].balance).toBe(97);
  },7000);
});
