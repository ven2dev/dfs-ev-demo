import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {Pool} from "pg";
import {randomUUID} from "node:crypto";
import {candidateParams,candidateSchema,candidateSql,runCandidateBatch,type CandidateContext} from "@/lib/bench61-candidate";
const local=process.env.BENCH61_LOCAL_TEST==="1";
const target={host:"127.0.0.1",port:54361,database:"bench61",user:"bench61",password:"disposable-local-only",connectionTimeoutMillis:3000};
const role="bench61_candidate_worker_20261024",password="disposable-candidate-only";
const s='"'+candidateSchema+'"',fence="610061,20261025",owner="local-candidate-owner";
const context:CandidateContext={owner,request:randomUUID(),account:"candidate-account",period:"local-period"};
const op=local?new Pool({...target,max:4}):undefined;
let worker:Pool|undefined,owned=false;
const rows=async(text:string,params:unknown[]=[]) => (await worker!.query(text,params)).rows;
const params=(value=3,interactive:boolean|string=true)=>candidateParams(context,value,interactive);
it("caps work and refuses invalid amount before dispatch",async()=>{
  for(const [count,workers] of [[0,1],[1001,20],[1,21],[1,0]])
    await expect(runCandidateBatch(async()=>{throw Error("Must not dispatch");},"debit",params(),count,workers)).rejects.toThrow("cap");
  for(const value of [-1,0.1,NaN,Number.MAX_SAFE_INTEGER+1])expect(()=>params(value)).toThrow("amount");
  expect(()=>candidateSql("arbitrary" as never)).toThrow("mode");
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
  expect((await op!.query("SELECT to_regnamespace($1) IS NULL AS schema_absent,NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) AS role_absent",[candidateSchema,role])).rows[0])
    .toEqual({schema_absent:true,role_absent:true});
  const c=await op!.connect();
  try{
    await c.query("BEGIN");
    await c.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 24`);
    await c.query(`ALTER ROLE ${role} IN DATABASE bench61 SET statement_timeout='5s'`);
    await c.query(`ALTER ROLE ${role} IN DATABASE bench61 SET lock_timeout='2s'`);
    await c.query(`COMMENT ON ROLE ${role} IS '${owner}'`);
    await c.query(`CREATE SCHEMA ${s}`);
    await c.query(`CREATE TABLE ${s}.run(owner text NOT NULL,request uuid NOT NULL,lease_until timestamptz NOT NULL)`);
    await c.query(`INSERT INTO ${s}.run VALUES($1,$2,clock_timestamp()+interval '5 minutes')`,[owner,context.request]);
    await c.query(`CREATE TABLE ${s}.budgets(account text PRIMARY KEY,period text NOT NULL,balance bigint NOT NULL CHECK(balance>=0),floor bigint NOT NULL CHECK(floor>=0),observed_at timestamptz NOT NULL,active boolean NOT NULL)`);
    await c.query(`INSERT INTO ${s}.budgets VALUES($1,$2,100,20,clock_timestamp(),true)`,[context.account,context.period]);
    await c.query(`CREATE FUNCTION ${s}.guard(who text,req uuid) RETURNS void LANGUAGE plpgsql AS $$ DECLARE r record; BEGIN
      PERFORM pg_advisory_xact_lock_shared(${fence}); SELECT * INTO r FROM ${s}.run;
      IF r.owner IS DISTINCT FROM who OR r.request IS DISTINCT FROM req OR r.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'candidate owner/request/lease refused'; END IF; END $$`);
    await c.query(`REVOKE ALL ON FUNCTION ${s}.guard(text,uuid) FROM PUBLIC`);
    await c.query(`GRANT USAGE ON SCHEMA ${s} TO ${role}`);
    await c.query(`GRANT SELECT ON ${s}.run TO ${role}`);
    await c.query(`GRANT SELECT,UPDATE ON ${s}.budgets TO ${role}`);
    await c.query(`GRANT EXECUTE ON FUNCTION ${s}.guard(text,uuid) TO ${role}`);
    await c.query("COMMIT");owned=true;
  }catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
  worker=new Pool({...target,user:role,password,max:20});
},15000);
beforeEach(async()=>{
  if(!local||!owned)return;
  await op!.query(`UPDATE ${s}.budgets SET period=$1,balance=100,floor=20,observed_at=date_trunc('milliseconds',clock_timestamp()),active=true`,[context.period]);
  await op!.query(`UPDATE ${s}.run SET owner=$1,request=$2,lease_until=clock_timestamp()+interval '5 minutes'`,[owner,context.request]);
});
afterAll(async()=>{
  await worker?.end();
  if(owned){
    const c=await op!.connect();
    try{
      await c.query("BEGIN");
      expect((await c.query(`SELECT pg_try_advisory_xact_lock(${fence}) AS held`)).rows[0].held).toBe(true);
      expect((await c.query(`SELECT owner FROM ${s}.run`)).rows[0].owner).toBe(owner);
      expect((await c.query("SELECT shobj_description(oid,'pg_authid') AS owner FROM pg_roles WHERE rolname=$1",[role])).rows[0].owner).toBe(owner);
      await c.query(`DROP SCHEMA ${s} CASCADE`);await c.query(`DROP ROLE ${role}`);
      await c.query("COMMIT");
      expect((await c.query("SELECT to_regnamespace($1) IS NULL AS schema_absent,NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) AS role_absent",[candidateSchema,role])).rows[0])
        .toEqual({schema_absent:true,role_absent:true});
    }catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
  }
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
    expect(interactive).toEqual({started:1000,admitted:26,denied:974,roundTrips:1000,submittedStatements:1000});
    const collector=await runCandidateBatch(rows,"debit",params(3,false),100,20);
    expect(collector.admitted).toBe(7);
    expect((await op!.query(`SELECT balance::integer FROM ${s}.budgets`)).rows[0].balance).toBe(1);
  },15000);
  it("baseline leaves balance intact and invalid/stale/retired inputs never debit",async()=>{
    expect((await rows(candidateSql("baseline"),params())).length).toBe(1);
    for(const changed of [{...context,period:"old-period"},{...context,account:"missing"}])
      expect(await rows(candidateSql("debit"),candidateParams(changed,3,true))).toEqual([]);
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
    expect((await rows(candidateSql("correction"),params(90,before.toISOString())))[0].balance).toBe("90");
    expect((await rows(candidateSql("correction"),params(99,before.toISOString())))[0].balance).toBe("90");
    expect(await rows(candidateSql("correction"),params(1,new Date(before.getTime()-1).toISOString()))).toEqual([]);
    expect(await rows(candidateSql("correction"),params(1,new Date(Date.now()+60000).toISOString()))).toEqual([]);
    expect(await rows(candidateSql("correction"),candidateParams({...context,period:"retired"},1,before.toISOString()))).toEqual([]);
  });
  it("handles concurrent debit and downward correction work with20 total workers",async()=>{
    await op!.query(`UPDATE ${s}.budgets SET balance=1000000`);
    const observed=(await op!.query(`SELECT observed_at FROM ${s}.budgets`)).rows[0].observed_at.toISOString();
    const [debits,corrections]=await Promise.all([
      runCandidateBatch(rows,"debit",params(),900,18),
      runCandidateBatch(rows,"correction",params(800000,observed),100,2),
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
    }finally{const result=await drained;if("error" in result)throw result.error;}
    await op!.query(`UPDATE ${s}.run SET lease_until=clock_timestamp()+interval '5 minutes'`);
    await expect(rows(candidateSql("debit"),candidateParams({...context,owner:"wrong-owner"},3,true))).rejects.toMatchObject({code:"P0001"});
    await expect(rows(candidateSql("debit"),candidateParams({...context,request:randomUUID()},3,true))).rejects.toMatchObject({code:"P0001"});
    expect((await op!.query(`SELECT balance::integer FROM ${s}.budgets`)).rows[0].balance).toBe(97);
  },7000);
});
