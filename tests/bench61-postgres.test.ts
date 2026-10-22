import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { proveServerLockCancellation, qualifyHttpTimeout, timeoutRole } from "@/lib/bench61-timeout";
const fixture = vi.hoisted(() => ({ token: "a".repeat(64), host: "fixture.neon.tech" }));
vi.mock("@/lib/bench61-config.json", async () => {
  const { createHash } = await import("node:crypto");
  return { default: { tokenHash:createHash("sha256").update(fixture.token).digest("hex"),
    expiresAt:"2099-01-01T00:00:00Z",host:fixture.host,schema:"bench61_206_20261022",maxStatements:16040,maxRoundTrips:8020 } };
});
vi.mock("@neondatabase/serverless",()=>({neon:vi.fn()}));
import { executeBenchmark, profileDeductSql, profileWaitSql } from "@/lib/bench61";
beforeEach(()=>{vi.mocked(neon).mockReset();});

// Opt-in local SQL behavior proof. Never run against a supplied/hosted DATABASE_URL.
const local = process.env.BENCH61_LOCAL_TEST === "1";
const pool = local ? new Pool({host:"127.0.0.1",port:54361,user:"bench61",password:"disposable-local-only",database:"bench61",max:20}) : undefined;
afterAll(async()=>{await pool?.end();});
type Fault = "before-drop" | "after-drop" | "after-commit" | "warm" | "profile";
const useLocalAdapter = () => {
  let fault: Fault | undefined;
  let inFlight=0;
  const executed: string[]=[];
  let pause: {entered:()=>void;resumed:Promise<void>} | undefined;
  const query=(text:string,params:unknown[]=[])=>({text,params});
  const transaction=async (queries:ReturnType<typeof query>[])=>{
    if(pause && queries.some(q=>q.text.startsWith("INSERT INTO") && q.params[0]==="cold")) {
      const held=pause;pause=undefined;held.entered();await held.resumed;
    }
    const client=await pool!.connect();
    inFlight++;
    const cleanup=queries.some(q=>q.text.includes("DROP SCHEMA"));
    const currentFault=fault;
    try {
      await client.query("BEGIN");
      const results=[];
      for(const q of queries) {
        if(cleanup && currentFault==="before-drop" && q.text.startsWith("DO $cleanup$")) {
          fault=undefined;throw new Error("injected before drop");
        }
        if(currentFault==="warm" && q.text.startsWith("INSERT INTO") && q.params[0]==="headers") {
          fault=undefined;throw new Error("injected warm failure");
        }
        if(currentFault==="profile" && q.text.startsWith("WITH bench61_clock") && String(q.params[0]).startsWith("trial-20")) {
          fault=undefined;throw new Error("injected profile failure");
        }
        executed.push(q.text);
        results.push((await client.query(q.text,q.params)).rows);
      }
      if(cleanup && currentFault==="after-drop") {fault=undefined;throw new Error("injected rollback after drop");}
      await client.query("COMMIT");
      if(cleanup && currentFault==="after-commit") {fault=undefined;throw new Error("injected lost commit reply");}
      return results;
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();inFlight--;}
  };
  vi.mocked(neon).mockReturnValue({query,transaction} as unknown as ReturnType<typeof neon>);
  return { pending:()=>inFlight, executed, failNext: (value:Fault)=>{fault=value;}, pauseNextSeed:()=>{
    let entered!:()=>void,release!:()=>void;
    const waiting=new Promise<void>(resolve=>{entered=resolve;});
    const resumed=new Promise<void>(resolve=>{release=resolve;});
    pause={entered,resumed};return {entered:waiting,release};
  } };
};
const control = async () => (await pool!.query('SELECT last_query_at,active_action FROM "bench61_206_20261022".run')).rows[0];
const ageCompletion = () => pool!.query('UPDATE "bench61_206_20261022".run SET last_query_at=clock_timestamp()-interval \'7 minutes\'');
const cleanup = async () => {
  // Tests call this only after their request has settled. Age a failed request's
  // lease instead of waiting five minutes; the real endpoint never changes it.
  await pool!.query(`DO $fixture$ BEGIN
    IF to_regnamespace('bench61_206_20261022') IS NOT NULL THEN
      UPDATE "bench61_206_20261022".run SET lease_until=clock_timestamp()-interval '1 second' WHERE lease_until IS NOT NULL;
    END IF;
  END $fixture$`);
  expect(await executeBenchmark("cleanup")).toMatchObject({schemaAbsent:true});
};

describe.skipIf(!local)("local PostgreSQL regressions",()=>{
  it("qualifies role-default cancellation and single-command fencing on the fixed local fixture",async()=>{
    const role="bench61_local_probe_20261022",password=randomUUID();
    let madeRole=false,worker:Pool|undefined;
    const adapter=useLocalAdapter();
    expect((await pool!.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount).toBe(0);
    await executeBenchmark("setup");
    const request=randomUUID();
    const owner=(await pool!.query('SELECT owner FROM "bench61_206_20261022".run')).rows[0].owner;
    const statement=`WITH guard AS MATERIALIZED (SELECT "bench61_206_20261022".guard($1,$2,false)),
      debit AS (UPDATE "bench61_206_20261022".budgets SET balance=balance-3 FROM guard
        WHERE account='timeout-proof' AND active AND balance-3>=floor RETURNING balance)
      SELECT balance FROM debit`;
    try {
      await pool!.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8`);madeRole=true;
      await pool!.query(`ALTER ROLE ${role} IN DATABASE bench61 SET statement_timeout='5s'`);
      await pool!.query(`ALTER ROLE ${role} IN DATABASE bench61 SET lock_timeout='2s'`);
      await pool!.query(`GRANT USAGE ON SCHEMA "bench61_206_20261022" TO ${role}`);
      await pool!.query(`GRANT SELECT ON "bench61_206_20261022".run TO ${role}`);
      await pool!.query(`GRANT SELECT,UPDATE ON "bench61_206_20261022".budgets TO ${role}`);
      await pool!.query(`GRANT EXECUTE ON FUNCTION "bench61_206_20261022".guard(text,uuid,boolean) TO ${role}`);
      await pool!.query(`INSERT INTO "bench61_206_20261022".budgets VALUES('timeout-proof',100,20,clock_timestamp(),true)`);
      await pool!.query(`UPDATE "bench61_206_20261022".run SET active_action='qualify',lease_request=$1,lease_until=clock_timestamp()+interval '300 seconds'`,[request]);
      worker=new Pool({host:"127.0.0.1",port:54361,database:"bench61",user:role,password,max:3,connectionTimeoutMillis:3000});
      const query=async(text:string,params:unknown[]=[]) => (await worker!.query(text,params)).rows;
      // Transport adapter only: actual PostgreSQL role/defaults, SQL and errors.
      // Normalize solely the test identity expected by the HTTP credential check.
      // This is direct local PostgreSQL, never evidence of Neon HTTP behavior.
      const transportQuery=async(text:string,params:unknown[]=[]) => {
        const rows=await query(text,params);
        return text.includes("session_user") ? rows.map(r=>({...r,session_user:r.session_user===role?timeoutRole:r.session_user,
          current_user:r.current_user===role?timeoutRole:r.current_user})) : rows;
      };
      vi.mocked(neon).mockReturnValue({query:transportQuery} as unknown as ReturnType<typeof neon>);
      const result=await qualifyHttpTimeout(`postgres://${timeoutRole}:test-only@${fixture.host}/bench61`,fixture.host,"bench61",
        {schema:'"bench61_206_20261022"',owner,request},async(text,params=[]) => (await pool!.query(text,params)).rows);
      expect(result).toMatchObject({serverStatementCancellation:true,debitRolledBack:true,performanceEnabled:false,roundTrips:10});
      expect(adapter.pending()).toBe(0);
      useLocalAdapter();
      const holder=await pool!.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SET LOCAL idle_in_transaction_session_timeout='10s'");
        await holder.query(`SELECT * FROM "bench61_206_20261022".budgets WHERE account='timeout-proof' FOR UPDATE`);
        await proveServerLockCancellation(query,statement,[owner,request]);
      }finally{await holder.query("ROLLBACK");holder.release();}
      expect((await query(`SELECT balance FROM "bench61_206_20261022".budgets WHERE account='timeout-proof'`))[0].balance).toBe(100);
      await expect(query(statement,["wrong-owner",request])).rejects.toThrow("ownership mismatch");
      await expect(query(statement,[owner,randomUUID()])).rejects.toThrow("does not match");
      await pool!.query(`UPDATE "bench61_206_20261022".run SET lease_until=clock_timestamp()+interval '500 milliseconds'`);
      const pending=query(statement.replace('SELECT balance FROM debit','SELECT balance,pg_sleep(1.5) FROM debit'),[owner,request])
        .then(value=>({value}),error=>({error}));
      try {
        let held=false;
        for(let i=0;i<40;i++){
          held=(await pool!.query(`SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
            WHERE a.usename=$1 AND l.locktype='advisory' AND l.granted) AS held`,[role])).rows[0].held;
          if(held)break;
          await new Promise(resolve=>setTimeout(resolve,5));
        }
        expect(held).toBe(true);
        await new Promise(resolve=>setTimeout(resolve,600));
        const before=(await pool!.query('SELECT * FROM "bench61_206_20261022".run')).rows[0];
        expect(before.lease_until.getTime()).toBeLessThan(Date.now());
        await expect(executeBenchmark("cleanup")).rejects.toThrow("transaction still in flight");
        expect((await pool!.query('SELECT * FROM "bench61_206_20261022".run')).rows[0]).toEqual(before);
        await expect(query(statement,[owner,request])).rejects.toThrow("lease expired");
      }finally{
        const outcome=await pending;
        if("error" in outcome)throw outcome.error;
        expect(outcome.value[0].balance).toBe(97);
      }
      expect(await executeBenchmark("cleanup")).toMatchObject({schemaAbsent:true});
      expect(await executeBenchmark("cleanup")).toMatchObject({schemaAbsent:true});
    }finally{
      await worker?.end();useLocalAdapter();await cleanup();
      if(madeRole)await pool!.query(`DROP ROLE ${role}`);
      expect((await pool!.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount).toBe(0);
    }
  },30000);

  it("refuses a separate cleanup between a live run's transactions without changing its control state",async()=>{
    const adapter=useLocalAdapter();await executeBenchmark("setup");
    const pause=adapter.pauseNextSeed();
    const running=executeBenchmark("run").then(value=>({value}),error=>({error}));
    try {
      await pause.entered;
      const before=(await pool!.query('SELECT * FROM "bench61_206_20261022".run')).rows[0];
      expect(before).toMatchObject({active_action:"run",lease_request:expect.any(String),lease_until:expect.any(Date)});
      await expect(executeBenchmark("cleanup")).rejects.toThrow("lease still live");
      const after=(await pool!.query('SELECT * FROM "bench61_206_20261022".run')).rows[0];
      expect(after).toEqual(before);
      pause.release();const result=await running;
      if("error" in result) throw result.error;
      expect(result.value).toMatchObject({correctness:{admitted:26,collected:7}});
      expect((await pool!.query('SELECT lease_request,lease_until FROM "bench61_206_20261022".run')).rows[0]).toEqual({lease_request:null,lease_until:null});
      expect(await executeBenchmark("cleanup")).toMatchObject({schemaAbsent:true});
    }finally{pause.release();await running;await cleanup();}
  },120000);

  it("recovers an abandoned lease and fences the paused request if it later resumes",async()=>{
    const adapter=useLocalAdapter();await executeBenchmark("setup");
    const pause=adapter.pauseNextSeed();
    const running=executeBenchmark("run").then(value=>({value}),error=>({error}));
    try {
      await pause.entered;
      await pool!.query(`UPDATE "bench61_206_20261022".run SET lease_until=clock_timestamp()-interval '1 second'`);
      expect(await executeBenchmark("cleanup")).toMatchObject({schemaAbsent:true});
      const at=adapter.executed.length;
      pause.release();expect(await running).toHaveProperty("error");
      expect(adapter.executed.slice(at).some(text=>text.startsWith("INSERT INTO"))).toBe(false);
      expect(adapter.pending()).toBe(0);
      expect(await executeBenchmark("cleanup")).toMatchObject({schemaAbsent:true});
    }finally{pause.release();await running;await cleanup();}
  });

  it("keeps expired in-flight transactions fenced from cleanup until commit, and rejects late transactions",async()=>{
    useLocalAdapter();await executeBenchmark("setup");
    const client=await pool!.connect();
    try {
      const owner=(await pool!.query('SELECT owner FROM "bench61_206_20261022".run')).rows[0].owner;
      const request="00000000-0000-4000-8000-000000000001";
      await pool!.query(`UPDATE "bench61_206_20261022".run SET active_action='run',lease_request=$1,lease_until=clock_timestamp()+interval '300 seconds'`,[request]);
      await client.query("BEGIN");
      await client.query('SELECT "bench61_206_20261022".guard($1,$2,false)',[owner,request]);
      await expect(pool!.query('SELECT "bench61_206_20261022".guard($1,$2,false)',[owner,"00000000-0000-4000-8000-000000000002"])).rejects.toThrow("does not match");
      await pool!.query(`UPDATE "bench61_206_20261022".run SET lease_until=clock_timestamp()-interval '1 second'`);
      await expect(executeBenchmark("cleanup")).rejects.toThrow("transaction still in flight");
      expect(await control()).toMatchObject({active_action:"run"});
      await expect(pool!.query('SELECT "bench61_206_20261022".guard($1,$2,false)',[owner,request])).rejects.toThrow("lease expired");
      await client.query("COMMIT");
      expect(await executeBenchmark("cleanup")).toMatchObject({schemaAbsent:true});
    }finally{await client.query("ROLLBACK");client.release();await cleanup();}
  });

  it("executor timing includes a held row lock and wait snapshots see that synthetic waiter",async()=>{
    useLocalAdapter();await executeBenchmark("setup");
    const blocker=await pool!.connect();
    try {
      await pool!.query(`INSERT INTO "bench61_206_20261022".budgets VALUES('timing',100,20,clock_timestamp(),true)`);
      await blocker.query("BEGIN");
      await blocker.query(`SELECT * FROM "bench61_206_20261022".budgets WHERE account='timing' FOR UPDATE`);
      const started=performance.now();
      const waiting=pool!.query(profileDeductSql,["timing",3,new Date().toISOString(),false]);
      // Attach rejection handling immediately; release the blocker in finally.
      const outcome=waiting.then(value=>({value}),error=>({error}));
      let observed=false;
      for(let i=0;i<100;i++) {
        const snapshot=await pool!.query(profileWaitSql,['UPDATE "bench61_206_20261022".budgets']);
        if(snapshot.rows[0].lock_waiters>0) {observed=true;break;}
        await new Promise(resolve=>setTimeout(resolve,5));
      }
      expect(observed).toBe(true);
      await new Promise(resolve=>setTimeout(resolve,80));
      await blocker.query("ROLLBACK");
      const result=await outcome;
      if("error" in result) throw result.error;
      const server=Number(result.value.rows[0].server_ms);
      expect(server).toBeGreaterThanOrEqual(75);
      expect(server).toBeLessThanOrEqual(performance.now()-started+1);
      expect(result.value.rows[0].balance).toBe(97);
      if(process.env.BENCH61_LOCAL_RECEIPT==="1") console.info("BENCH206_LOCK_RECEIPT "+JSON.stringify({server_ms:server,client_ms:performance.now()-started,observedLock:true}));
      const at=new Date().toISOString();
      for(const cost of [0,-3,78]) expect((await pool!.query(profileDeductSql,["timing",cost,at,false])).rows).toHaveLength(0);
      expect((await pool!.query(profileDeductSql,["timing",77,at,false])).rows[0].balance).toBe(20);
      expect((await pool!.query(profileDeductSql,["timing",1,at,false])).rows).toHaveLength(0);
      expect((await pool!.query(profileDeductSql,["timing",20,at,true])).rows[0].balance).toBe(0);
      for(const [name,observed,active] of [
        ["stale-timing",new Date(Date.parse(at)-300001).toISOString(),true],
        ["future-timing",new Date(Date.parse(at)+60000).toISOString(),true],
        ["inactive-timing",at,false],
      ] as const) {
        await pool!.query(`INSERT INTO "bench61_206_20261022".budgets VALUES($1,100,20,$2,$3)`,[name,observed,active]);
        expect((await pool!.query(profileDeductSql,[name,3,at,false])).rows).toHaveLength(0);
      }
      expect((await pool!.query(profileDeductSql,["unknown-timing",3,at,false])).rows).toHaveLength(0);
    }finally{await blocker.query("ROLLBACK");blocker.release();await cleanup();}
  });

  it("runs target concurrency and makes a later catalog query restart idle eligibility",async()=>{
    useLocalAdapter();
    expect(await executeBenchmark("setup")).toMatchObject({setup:true});
    try {
      const result=await executeBenchmark("run");
      if(process.env.BENCH61_LOCAL_RECEIPT==="1") console.info("BENCH206_RUN_RECEIPT "+JSON.stringify(result));
      expect(result).toMatchObject({correctness:{attempts:1000,concurrency:20,admitted:26,collected:7,remaining:1}});
      if("statements" in result) {
        expect(result.roundTrips).toBeGreaterThanOrEqual(7731);
        expect(result.roundTrips).toBeLessThanOrEqual(7761);
        expect(result.statements).toBe(result.roundTrips!*2);
        expect(result.statements).toBeLessThanOrEqual(15800);
      }
      if ("trials" in result) {
        expect(result.trials).toHaveLength(3);
        expect(result.diagnostics).toHaveLength(3);
        for (const trial of [...result.trials,...result.diagnostics]) {
          for (const mode of ["baseline","budget"]) {
            expect(trial.pair[mode].client.samples).toBe(trial.workers===20 ? 1000 : 100);
            expect(trial.pair[mode].server_executor_including_row_wait.p95_ms).toBeGreaterThanOrEqual(0);
            expect(trial.pair[mode].residual.samples).toBe(trial.pair[mode].client.samples);
            expect(trial.pair[mode].lockObservations.length).toBeLessThanOrEqual(10);
          }
        }
      }
      expect(await control()).toMatchObject({active_action:null,last_query_at:expect.any(Date)});
      await ageCompletion();
      expect(await executeBenchmark("catalog")).toHaveProperty("inventory");
      expect(Date.now()-(await control()).last_query_at.getTime()).toBeLessThan(60000);
      await expect(executeBenchmark("cold1")).rejects.toThrow("known six-minute idle");
      expect(await control()).toMatchObject({last_query_at:null,active_action:"cold1"});
    }finally{await cleanup();await cleanup();}
  },120000);

  it("requires known completion for a cold sample and records completion after its last query",async()=>{
    useLocalAdapter();await executeBenchmark("setup");
    try {
      await pool!.query('INSERT INTO "bench61_206_20261022".budgets VALUES(\'cold\',10000,20,clock_timestamp(),true)');
      await ageCompletion();
      expect(await executeBenchmark("cold1")).toMatchObject({roundTrips:2,statements:4});
      expect(await control()).toMatchObject({active_action:null,last_query_at:expect.any(Date)});
      await expect(executeBenchmark("setup")).rejects.toThrow("setup refuses");
      expect(await control()).toMatchObject({last_query_at:null,active_action:"setup"});
      await expect(executeBenchmark("cold2")).rejects.toThrow("known six-minute idle");
    }finally{await cleanup();}
  });

  it("leaves idle eligibility unknown when a warm run fails after its concurrent queries",async()=>{
    const adapter=useLocalAdapter();await executeBenchmark("setup");
    try {
      await ageCompletion();adapter.failNext("warm");
      await expect(executeBenchmark("run")).rejects.toThrow("injected warm failure");
      await expect(executeBenchmark("cleanup")).rejects.toThrow("lease still live");
      expect(await control()).toMatchObject({last_query_at:null,active_action:"run"});
      await expect(executeBenchmark("cold1")).rejects.toThrow("known six-minute idle");
      expect(await control()).toMatchObject({last_query_at:null,active_action:"run"});
    }finally{await cleanup();}
  },120000);

  it("drains concurrent profile requests on failure before allowing owned cleanup",async()=>{
    const adapter=useLocalAdapter();await executeBenchmark("setup");
    try {
      adapter.failNext("profile");
      await expect(executeBenchmark("run")).rejects.toThrow("injected profile failure");
      expect(adapter.pending()).toBe(0);
      expect(await control()).toMatchObject({last_query_at:null,active_action:"run"});
    }finally{await cleanup();}
  },120000);

  it("retries cleanup after interruption or lost commit reply, and refuses a different current owner",async()=>{
    const adapter=useLocalAdapter();
    for(const fault of ["before-drop","after-drop","after-commit"] as const) {
      await executeBenchmark("setup");adapter.failNext(fault);
      await expect(executeBenchmark("cleanup")).rejects.toThrow("injected");
      const absent=(await pool!.query("SELECT to_regnamespace('bench61_206_20261022') IS NULL AS absent")).rows[0].absent;
      expect(absent).toBe(fault==="after-commit");
      if(!absent) {
        expect(await control()).toMatchObject({last_query_at:null,active_action:"cleanup"});
        await expect(executeBenchmark("cold1")).rejects.toThrow("known six-minute idle");
      }
      await cleanup();await cleanup();
    }
    await executeBenchmark("setup");
    const original=(await pool!.query('SELECT owner FROM "bench61_206_20261022".run')).rows[0].owner;
    try {
      await pool!.query('UPDATE "bench61_206_20261022".run SET owner=\'different-owner\'');
      await expect(executeBenchmark("cleanup")).rejects.toThrow("ownership mismatch");
      expect((await pool!.query("SELECT to_regnamespace('bench61_206_20261022') IS NOT NULL AS present")).rows[0].present).toBe(true);
    }finally{
      await pool!.query('UPDATE "bench61_206_20261022".run SET owner=$1',[original]);await cleanup();
    }
  });
});
