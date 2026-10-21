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
  it("refuses cleanup without an acknowledged ownership claim",async()=>{
    const query=vi.fn((text:string)=>text), transaction=vi.fn().mockResolvedValue([[],[]]);
    vi.mocked(neon).mockReturnValue({query,transaction} as unknown as ReturnType<typeof neon>);
    await expect(executeBenchmark("cleanup")).rejects.toThrow("owned run");
    expect(query.mock.calls.flat().join(" ")).not.toContain("DROP SCHEMA");
    expect(transaction).toHaveBeenCalledTimes(1);
  });

});

// Opt-in local SQL behavior proof. Never run against a supplied/hosted DATABASE_URL.
const local = process.env.BENCH61_LOCAL_TEST === "1";
const pool = local ? new Pool({host:"127.0.0.1",port:54361,user:"bench61",password:"disposable-local-only",database:"bench61",max:20}) : undefined;
afterAll(async()=>{await pool?.end();});
it.skipIf(!local)("executes the exact harness SQL at target concurrency, bounds replay, and removes only its owned schema",async()=>{
  const query=(text:string,params:unknown[]=[])=>({text,params});
  const transaction=async (queries:ReturnType<typeof query>[])=>{
    const client=await pool!.connect();
    try {
      await client.query("BEGIN");
      const results=[];
      for(const q of queries) results.push((await client.query(q.text,q.params)).rows);
      await client.query("COMMIT");return results;
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  };
  vi.mocked(neon).mockReturnValue({query,transaction} as unknown as ReturnType<typeof neon>);
  const setup=await executeBenchmark("setup");expect(setup).toMatchObject({setup:true});
  try {
    await expect(executeBenchmark("setup")).rejects.toThrow();
    const result=await executeBenchmark("run");
    expect(result).toMatchObject({correctness:{attempts:1000,concurrency:20,admitted:26,collected:7,remaining:1}});
    expect(result).toHaveProperty("statements",expect.any(Number));
    if ("statements" in result) expect(result.statements).toBeLessThan(14400);
    await expect(executeBenchmark("run")).rejects.toThrow("owned run");
    await expect(executeBenchmark("cold1")).rejects.toThrow("six-minute idle");
    await pool!.query('UPDATE "bench61_20261019".run SET last_query_at=clock_timestamp()-interval \'7 minutes\'');
    const cold=await executeBenchmark("cold1");expect(cold).toMatchObject({roundTrips:1,statements:2});
    await expect(executeBenchmark("cold1")).rejects.toThrow();
    const inventory=await executeBenchmark("catalog");expect(inventory).toHaveProperty("inventory");
  }finally{
    expect(await executeBenchmark("cleanup")).toMatchObject({schemaAbsent:true});
  }
},120000);
