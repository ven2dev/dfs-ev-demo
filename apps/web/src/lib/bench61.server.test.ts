import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";
const fixture = vi.hoisted(() => ({ token: "a".repeat(64), host: "fixture.neon.tech" }));
vi.mock("./bench61-config.json", async () => {
  const { createHash } = await import("node:crypto");
  return { default: { tokenHash:createHash("sha256").update(fixture.token).digest("hex"),
    expiresAt:"2099-01-01T00:00:00Z",host:fixture.host,schema:"bench61_20261019",maxStatements:16040,maxRoundTrips:8020 } };
});
vi.mock("@neondatabase/serverless",()=>({neon:vi.fn()}));
import { authorizeBenchmark, executeBenchmark } from "./bench61";
import { POST } from "@/app/api/bench61/route";
const env = { VERCEL_ENV:"preview",VERCEL_REGION:"iad1",DATABASE_URL:`postgres://user:local@${fixture.host}/fixture` };
beforeEach(()=>{vi.mocked(neon).mockReset();});
describe("disposable benchmark boundary",()=>{
  it("accepts only the designated Preview, region, unexpired token and enumerated action",()=>{
    expect(authorizeBenchmark(fixture.token,"setup",env)).toBe(true);
    for(const changed of [{VERCEL_ENV:"production"},{VERCEL_REGION:"sfo1"},{DATABASE_URL:"postgres://user:local@production.invalid/db"}])
      expect(authorizeBenchmark(fixture.token,"setup",{...env,...changed})).toBe(false);
    expect(authorizeBenchmark(fixture.token,"setup",env,Date.parse("2100-01-01"))).toBe(false);
    for(const token of [undefined,"", "b".repeat(64),{token:fixture.token}])
      expect(authorizeBenchmark(token,"setup",env)).toBe(false);
    expect(authorizeBenchmark(fixture.token,"DROP SCHEMA public",env)).toBe(false);
  });
  it("rejects invalid POSTs before constructing a database client",async()=>{
    for(const body of ["null","not json",JSON.stringify({token:"wrong",action:"setup"}),"x".repeat(1025)]) {
      const response=await POST(new Request("https://fixture.invalid/api/bench61",{method:"POST",body}));
      expect(response.status).toBe(404);
    }
    expect(neon).not.toHaveBeenCalled();
  });
  it("never adopts or drops a schema after an ambiguous setup error",async()=>{
    const transaction=vi.fn().mockRejectedValue(new Error("schema exists"));
    const query=vi.fn((text:string)=>text);
    vi.mocked(neon).mockReturnValue({query,transaction} as unknown as ReturnType<typeof neon>);
    await expect(executeBenchmark("setup")).rejects.toThrow("schema exists");
    expect(query.mock.calls.flat().join(" ")).not.toContain("DROP SCHEMA");
  });

});

// Opt-in local SQL behavior proof. Never run against a supplied/hosted DATABASE_URL.
const local = process.env.BENCH61_LOCAL_TEST === "1";
const pool = local ? new Pool({host:"127.0.0.1",port:54361,user:"bench61",password:"disposable-local-only",database:"bench61",max:20}) : undefined;
afterAll(async()=>{await pool?.end();});
type Fault = "before-drop" | "after-drop" | "after-commit" | "warm";
const useLocalAdapter = () => {
  let fault: Fault | undefined;
  const query=(text:string,params:unknown[]=[])=>({text,params});
  const transaction=async (queries:ReturnType<typeof query>[])=>{
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
        results.push((await client.query(q.text,q.params)).rows);
      }
      if(cleanup && currentFault==="after-drop") {fault=undefined;throw new Error("injected rollback after drop");}
      await client.query("COMMIT");
      if(cleanup && currentFault==="after-commit") {fault=undefined;throw new Error("injected lost commit reply");}
      return results;
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  };
  vi.mocked(neon).mockReturnValue({query,transaction} as unknown as ReturnType<typeof neon>);
  return { failNext: (value:Fault)=>{fault=value;} };
};
const control = async () => (await pool!.query('SELECT last_query_at,active_action FROM "bench61_20261019".run')).rows[0];
const ageCompletion = () => pool!.query('UPDATE "bench61_20261019".run SET last_query_at=clock_timestamp()-interval \'7 minutes\'');
const cleanup = async () => {expect(await executeBenchmark("cleanup")).toMatchObject({schemaAbsent:true});};

describe.skipIf(!local)("local PostgreSQL regressions",()=>{
  it("runs target concurrency and makes a later catalog query restart idle eligibility",async()=>{
    useLocalAdapter();
    expect(await executeBenchmark("setup")).toMatchObject({setup:true});
    try {
      const result=await executeBenchmark("run");
      expect(result).toMatchObject({correctness:{attempts:1000,concurrency:20,admitted:26,collected:7,remaining:1}});
      if("statements" in result) expect(result.statements).toBeLessThan(14400);
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
      await pool!.query('INSERT INTO "bench61_20261019".budgets VALUES(\'cold\',10000,20,clock_timestamp(),true)');
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

  it("retries cleanup after interruption or lost commit reply, and refuses a different current owner",async()=>{
    const adapter=useLocalAdapter();
    for(const fault of ["before-drop","after-drop","after-commit"] as const) {
      await executeBenchmark("setup");adapter.failNext(fault);
      await expect(executeBenchmark("cleanup")).rejects.toThrow("injected");
      const absent=(await pool!.query("SELECT to_regnamespace('bench61_20261019') IS NULL AS absent")).rows[0].absent;
      expect(absent).toBe(fault==="after-commit");
      if(!absent) {
        expect(await control()).toMatchObject({last_query_at:null,active_action:"cleanup"});
        await expect(executeBenchmark("cold1")).rejects.toThrow("known six-minute idle");
      }
      await cleanup();await cleanup();
    }
    await executeBenchmark("setup");
    const original=(await pool!.query('SELECT owner FROM "bench61_20261019".run')).rows[0].owner;
    try {
      await pool!.query('UPDATE "bench61_20261019".run SET owner=\'different-owner\'');
      await expect(executeBenchmark("cleanup")).rejects.toThrow("ownership mismatch");
      expect((await pool!.query("SELECT to_regnamespace('bench61_20261019') IS NOT NULL AS present")).rows[0].present).toBe(true);
    }finally{
      await pool!.query('UPDATE "bench61_20261019".run SET owner=$1',[original]);await cleanup();
    }
  });
});
