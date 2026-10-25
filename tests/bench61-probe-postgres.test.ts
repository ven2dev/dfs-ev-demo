import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import {Pool} from "pg";
import {neon} from "@neondatabase/serverless";
vi.mock("@neondatabase/serverless",()=>({neon:vi.fn()}));
vi.mock("@/lib/bench61-config.json",()=>({default:{host:"fixture.neon.tech",database:"bench61"}}));
import {candidateRole,candidateSchema} from "@/lib/bench61-candidate";
import {executeProbe,probeCaps,probeShapes} from "@/lib/bench61-probe";
import {local,target} from "./bench61-candidate-fixture";

// Fixed local fixture only, through a local stand-in for the Neon HTTP driver.
// This proves orchestration and SQL behavior, not managed Neon HTTP timing.
const operator=local?new Pool({...target,max:6}):undefined;
const password="local-only-probe-role-password-20261024";
const owner=createHash("sha256").update("local-probe-fixture").digest("hex");
let workers:Pool|undefined;
const absent=async()=>(await operator!.query("SELECT to_regnamespace($1) IS NULL AS schema_absent,NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) AS role_absent",
  [candidateSchema,candidateRole])).rows[0];
afterAll(async()=>{await operator?.end();});
beforeEach(async()=>{
  if(!local)return;
  vi.stubEnv("DATABASE_URL","postgres://operator:local@fixture.neon.tech/bench61");
  vi.stubEnv("BENCH61_DATABASE_URL",`postgres://${candidateRole}:${password}@fixture.neon.tech/bench61`);
  vi.stubEnv("BENCH61_TOKEN_HASH",owner);
  vi.stubEnv("VERCEL_DEPLOYMENT_ID","dpl_localfixture");
  expect(await absent()).toEqual({schema_absent:true,role_absent:true});
  workers=new Pool({...target,user:candidateRole,password,max:20});
  vi.mocked(neon).mockImplementation(((url:string)=>{
    const pool=new URL(url).username===candidateRole?workers!:operator!;
    const query=(text:string,params:unknown[]=[])=>({
      text,params,
      then:(resolve:(value:unknown)=>unknown,reject:(error:unknown)=>unknown)=>pool.query(text,params).then(result=>result.rows).then(resolve,reject),
    });
    const transaction=async(queries:ReturnType<typeof query>[])=>{
      const c=await pool.connect();
      try {
        await c.query("BEGIN");
        const rows=[];
        for(const q of queries)rows.push((await c.query(q.text,q.params)).rows);
        await c.query("COMMIT");
        return rows;
      }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
    };
    return {query,transaction};
  }) as unknown as typeof neon);
});
afterEach(async()=>{
  if(!local)return;
  await workers?.end();workers=undefined;
  // Cleanup does not depend on the lease or an active action, so it always recovers.
  const state=await absent();
  if(!state.schema_absent||!state.role_absent)await executeProbe("probe-cleanup");
  expect(await absent()).toEqual({schema_absent:true,role_absent:true});
  vi.unstubAllEnvs();
});

describe.skipIf(!local)("local hold probe orchestration",()=>{
  it("runs setup, qualify, run and cleanup within caps, refusing replays",async()=>{
    expect(await executeProbe("probe-setup")).toMatchObject({setup:true,role:candidateRole,deploymentId:"dpl_localfixture"});
    // A second setup refuses existing objects instead of reusing them.
    await expect(executeProbe("probe-setup")).rejects.toThrow("refuse existing candidate schema or role");

    const qualify=await executeProbe("probe-qualify");
    expect(qualify).toMatchObject({statementTimeout:true,rollback:true,lockTimeout:true,cleanupFence:true,
      mismatchedIdentityRefused:true,asyncSupported:true,performanceEnabled:false});
    if(!("identities" in qualify))throw new Error("qualify result missing identities");
    expect(qualify.identities).toHaveLength(5);
    expect(qualify.roundTrips).toBeLessThanOrEqual(probeCaps["probe-qualify"].trips);
    expect(qualify.statements).toBeLessThanOrEqual(probeCaps["probe-qualify"].statements);
    await expect(executeProbe("probe-qualify")).rejects.toThrow("replay");

    const completed=(await operator!.query(`SELECT active_action,operations FROM "${candidateSchema}".run`)).rows[0];
    expect(completed.active_action).toBeNull();
    expect(completed.operations).toContain("probe-qualified");
    const run=await executeProbe("probe-run");
    if(!("runs" in run))throw new Error("run result missing runs");
    expect(run.asyncSupported).toBe(true);
    expect(run.runs.map(r=>[r.shape,r.workers,r.count])).toEqual(probeShapes.flatMap(shape=>[[shape,20,200],[shape,1,50]]));
    for(const r of run.runs){
      expect(r.admitted).toBe(r.count);
      expect(r.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      if(r.workers===20){expect(r.backends).toBeGreaterThan(1);expect(r.activeSnapshot).not.toBeNull();expect(r.impliedHoldMs).toBeGreaterThan(0);}
      else {expect(r.backends).toBe(1);expect(r.impliedHoldMs).toBeNull();}
    }
    expect(run).toMatchObject({roundTrips:768,statements:1768});
    await expect(executeProbe("probe-run")).rejects.toThrow("replay");

    const cleanup=await executeProbe("probe-cleanup");
    expect(cleanup).toMatchObject({schemaAbsent:true,roleAbsent:true,sessionsTerminated:false});
    // A lost cleanup reply is safe to retry: absence is confirmed, not an error.
    expect(await executeProbe("probe-cleanup")).toMatchObject({alreadyAbsent:true});
  },120000);
  it("refuses run before qualification without consuming its claim or constructing a worker",async()=>{
    await executeProbe("probe-setup");
    vi.mocked(neon).mockClear();
    await expect(executeProbe("probe-run")).rejects.toThrow("successful qualification required");
    expect(vi.mocked(neon).mock.calls).toHaveLength(1);
    const state=(await operator!.query(`SELECT active_action,operations FROM "${candidateSchema}".run`)).rows[0];
    expect(state.active_action).toBeNull();
    expect(state.operations).not.toContain("probe-run");
    expect(state.operations).not.toContain("probe-qualified");
  });
  it("refuses run after failed qualification and leaves cleanup available",async()=>{
    await executeProbe("probe-setup");
    await operator!.query(`ALTER ROLE "${candidateRole}" IN DATABASE bench61 SET statement_timeout='4s'`);
    await expect(executeProbe("probe-qualify")).rejects.toThrow("Effective login defaults");
    const state=(await operator!.query(`SELECT active_action,operations FROM "${candidateSchema}".run`)).rows[0];
    expect(state.active_action).toBe("probe-qualify");
    expect(state.operations).toContain("probe-qualify");
    expect(state.operations).not.toContain("probe-qualified");
    vi.mocked(neon).mockClear();
    await expect(executeProbe("probe-run")).rejects.toThrow("successful qualification required");
    expect(vi.mocked(neon).mock.calls).toHaveLength(1);
    expect(await executeProbe("probe-cleanup")).toMatchObject({schemaAbsent:true,roleAbsent:true});
  });
  it("refuses overlapping actions while one is active, and cleanup still recovers",async()=>{
    await executeProbe("probe-setup");
    await operator!.query(`UPDATE "${candidateSchema}".run SET active_action='probe-qualify'`);
    await expect(executeProbe("probe-run")).rejects.toThrow("active workload refused");
    expect(await executeProbe("probe-cleanup")).toMatchObject({schemaAbsent:true,roleAbsent:true});
  },30000);
});
