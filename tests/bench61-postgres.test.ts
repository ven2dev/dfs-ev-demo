import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";
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
  const query=(text:string,params:unknown[]=[])=>({text,params});
  const transaction=async (queries:ReturnType<typeof query>[])=>{
    inFlight++;
    const client=await pool!.connect();
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
        results.push((await client.query(q.text,q.params)).rows);
      }
      if(cleanup && currentFault==="after-drop") {fault=undefined;throw new Error("injected rollback after drop");}
      await client.query("COMMIT");
      if(cleanup && currentFault==="after-commit") {fault=undefined;throw new Error("injected lost commit reply");}
      return results;
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();inFlight--;}
  };
  vi.mocked(neon).mockReturnValue({query,transaction} as unknown as ReturnType<typeof neon>);
  return { pending:()=>inFlight, failNext: (value:Fault)=>{fault=value;} };
};
const control = async () => (await pool!.query('SELECT last_query_at,active_action FROM "bench61_206_20261022".run')).rows[0];
const ageCompletion = () => pool!.query('UPDATE "bench61_206_20261022".run SET last_query_at=clock_timestamp()-interval \'7 minutes\'');
const cleanup = async () => {expect(await executeBenchmark("cleanup")).toMatchObject({schemaAbsent:true});};

describe.skipIf(!local)("local PostgreSQL regressions",()=>{
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
