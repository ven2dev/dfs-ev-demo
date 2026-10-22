import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {Pool} from "pg";
import {neon} from "@neondatabase/serverless";
vi.mock("@neondatabase/serverless",()=>({neon:vi.fn()}));
vi.mock("@/lib/bench61-config.json",()=>({default:{host:"fixture.neon.tech",database:"bench61"}}));
import {executeFunctional,functionalSchema} from "@/lib/bench61-functional";
import {timeoutRole} from "@/lib/bench61-timeout";
const local=process.env.BENCH61_LOCAL_TEST==="1";
// Fixed fixture only. Never consume an external DATABASE_URL for connections.
const target={host:"127.0.0.1",port:54361,database:"bench61",user:"bench61",password:"disposable-local-only",connectionTimeoutMillis:3000};
const operator=local?new Pool({...target,max:6}):undefined;
const password="local-only-functional-role-password-20261022";
const owner=createHash("sha256").update("local-functional-fixture").digest("hex");
let workers:Pool|undefined,owned=false,lostCleanupReply=false,rollbackCleanup=false,workerQueries=0;
afterAll(async()=>{await operator?.end();});
beforeEach(async()=>{
  if(!local)return;
  workerQueries=0;
  vi.stubEnv("DATABASE_URL","postgres://operator:local@fixture.neon.tech/bench61");
  vi.stubEnv("BENCH61_DATABASE_URL",`postgres://${timeoutRole}:${password}@fixture.neon.tech/bench61`);
  vi.stubEnv("BENCH61_TOKEN_HASH",owner);
  const absent=(await operator!.query("SELECT to_regnamespace($1) IS NULL AS schema_absent,NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) AS role_absent",[functionalSchema,timeoutRole])).rows[0];
  expect(absent).toEqual({schema_absent:true,role_absent:true});
  workers=new Pool({...target,user:timeoutRole,password,max:3});
  vi.mocked(neon).mockImplementation(((url:string)=>{
    const pool=new URL(url).username===timeoutRole?workers!:operator!;
    const query=(text:string,params:unknown[]=[])=>({
      text,params,
      then:(resolve:(value:unknown)=>unknown,reject:(error:unknown)=>unknown)=>{
        if(pool===workers)workerQueries++;
        return pool.query(text,params).then(result=>result.rows).then(resolve,reject);
      },
    });
    const transaction=async(queries:ReturnType<typeof query>[])=>{
      const c=await pool.connect();
      const cleanup=queries.some(q=>q.text.includes("DROP SCHEMA"));
      try {
        await c.query("BEGIN");
        const rows=[];
        for(const q of queries)rows.push((await c.query(q.text,q.params)).rows);
        if(cleanup && rollbackCleanup){rollbackCleanup=false;throw new Error("injected rollback before cleanup commit");}
        await c.query("COMMIT");
        if(cleanup && lostCleanupReply){lostCleanupReply=false;throw new Error("injected lost cleanup commit response");}
        return rows;
      }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
    };
    return {query,transaction};
  }) as unknown as typeof neon);
});
afterEach(async()=>{
  if(!local)return;
  await workers?.end();workers=undefined;
  if(owned){
    // Fixture-only recovery, after the action and every worker have drained.
    await operator!.query(`DO $$ BEGIN IF to_regnamespace('${functionalSchema}') IS NOT NULL THEN
      UPDATE "${functionalSchema}".run SET lease_until=clock_timestamp()-interval '1 second'; END IF; END $$`);
    await executeFunctional("cleanup");
    const absent=(await operator!.query("SELECT to_regnamespace($1) IS NULL AS schema_absent,NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) AS role_absent",[functionalSchema,timeoutRole])).rows[0];
    expect(absent).toEqual({schema_absent:true,role_absent:true});
  }
  owned=false;lostCleanupReply=false;rollbackCleanup=false;vi.unstubAllEnvs();
});
const setup=async()=>{const result=await executeFunctional("setup");owned=true;return result;};

describe.skipIf(!local)("local functional candidate",()=>{
  it("runs the complete finite orchestration with actual role defaults, rollback, lock timeout and expiry fencing",async()=>{
    expect(await setup()).toMatchObject({setup:true,performanceEnabled:false});
    const result=await executeFunctional("qualify");
    expect(result).toMatchObject({statementTimeout:true,rollback:true,lockTimeout:true,cleanupFence:true,
      lateAdmissionRefused:true,performanceEnabled:false,qualification:"functional probes passed; no performance acceptance"});
    expect(result.roundTrips).toBeLessThanOrEqual(220);
    expect(result.statements).toBeLessThanOrEqual(440);
    expect((await operator!.query(`SELECT balance FROM "${functionalSchema}".budgets`)).rows).toEqual([{balance:97}]);
    await expect(executeFunctional("qualify")).rejects.toThrow("Action replay");
    const cleanupProof=await executeFunctional("cleanup");
    expect(cleanupProof).toMatchObject({schemaAbsent:true,roleAbsent:true,sessionsTerminated:false,
      workerSessionsBeforeDrop:expect.any(Number),workerOidBeforeDrop:expect.any(Number)});
    const cleanupReplay=await executeFunctional("cleanup");
    expect(cleanupReplay).toMatchObject({schemaAbsent:true,roleAbsent:true,
      workerSessionsBeforeDrop:null,workerOidBeforeDrop:null});
    if(process.env.BENCH61_LOCAL_RECEIPT==="1")await writeFile("/private/tmp/dfs61-functional-candidate-receipt.json",
      JSON.stringify({scope:"Direct local PostgreSQL via transport adapter; not Neon HTTP evidence",result,cleanupProof,cleanupReplay},null,2)+"\n");
  },45000);
  it("refuses setup adoption, ownership mismatch and recovers cleanup rollback and lost commit response",async()=>{
    await setup();
    await expect(executeFunctional("setup")).rejects.toThrow("refuse existing");
    await operator!.query(`UPDATE "${functionalSchema}".run SET owner='foreign-owner'`);
    try{await expect(executeFunctional("cleanup")).rejects.toThrow("schema owner mismatch");}
    finally{await operator!.query(`UPDATE "${functionalSchema}".run SET owner=$1`,[owner]);}
    await operator!.query(`COMMENT ON ROLE ${timeoutRole} IS 'foreign-owner'`);
    try{await expect(executeFunctional("cleanup")).rejects.toThrow("role owner mismatch");}
    finally{await operator!.query(`COMMENT ON ROLE ${timeoutRole} IS '${owner}'`);}
    expect((await operator!.query("SELECT to_regnamespace($1) IS NOT NULL AS present",[functionalSchema])).rows[0].present).toBe(true);
    rollbackCleanup=true;
    await expect(executeFunctional("cleanup")).rejects.toThrow("injected rollback");
    expect((await operator!.query("SELECT to_regnamespace($1) IS NOT NULL AS present",[functionalSchema])).rows[0].present).toBe(true);
    lostCleanupReply=true;
    await expect(executeFunctional("cleanup")).rejects.toThrow("injected lost cleanup");
    expect(await executeFunctional("cleanup")).toMatchObject({schemaAbsent:true,roleAbsent:true});
  });
  it("fails the effective-privilege audit rather than modifying inherited PUBLIC grants",async()=>{
    const table="bench61_privilege_probe_20261022";
    expect((await operator!.query("SELECT to_regclass($1) IS NULL AS absent",["public."+table])).rows[0].absent).toBe(true);
    await setup();
    await operator!.query(`CREATE TABLE public.${table}(synthetic integer)`);
    try {
      await operator!.query(`GRANT SELECT ON public.${table} TO PUBLIC`);
      await expect(executeFunctional("qualify")).rejects.toThrow("Worker effective privileges exceed scope");
      expect((await operator!.query(`SELECT balance FROM "${functionalSchema}".budgets`)).rows).toEqual([{balance:100}]);
      expect((await operator!.query("SELECT has_table_privilege($1,$2,'SELECT') AS allowed",[timeoutRole,"public."+table])).rows[0].allowed).toBe(true);
    }finally{await operator!.query(`DROP TABLE public.${table}`);}
  });
  it("rejects a PUBLIC column-only grant before any worker probe",async()=>{
    const table="bench61_column_privilege_probe_20261022";
    expect((await operator!.query("SELECT to_regclass($1) IS NULL AS absent",["public."+table])).rows[0].absent).toBe(true);
    await setup();
    await operator!.query(`CREATE TABLE public.${table}(secret text,ungranted text)`);
    try {
      await operator!.query(`INSERT INTO public.${table} VALUES('synthetic-column-value','not-granted')`);
      await operator!.query(`GRANT SELECT(secret) ON public.${table} TO PUBLIC`);
      const access=(await operator!.query("SELECT has_table_privilege($1,$2,'SELECT') AS table_access,has_any_column_privilege($1,$2,'SELECT') AS column_access",
        [timeoutRole,"public."+table])).rows[0];
      expect(access).toEqual({table_access:false,column_access:true});
      // Direct diagnostic read proves the inherited access exists. It is not a
      // harness probe; the adapter counter below tracks only harness SQL.
      const diagnosticRead=(await workers!.query(`SELECT secret FROM public.${table}`)).rows;
      expect(diagnosticRead).toEqual([{secret:"synthetic-column-value"}]);
      await expect(executeFunctional("qualify")).rejects.toThrow("Worker effective privileges exceed scope");
      expect(workerQueries).toBe(0);
      const balance=(await operator!.query(`SELECT balance FROM "${functionalSchema}".budgets`)).rows;
      expect(balance).toEqual([{balance:100}]);
      const publicGrantRemains=(await operator!.query("SELECT has_any_column_privilege($1,$2,'SELECT') AS allowed",[timeoutRole,"public."+table])).rows[0].allowed;
      expect(publicGrantRemains).toBe(true);
      if(process.env.BENCH61_LOCAL_RECEIPT==="1")await writeFile("/private/tmp/dfs61-column-privilege-receipt.json",
        JSON.stringify({scope:"Synthetic local PostgreSQL column-only PUBLIC grant",access,diagnosticRead,
          qualificationRejected:true,workerProbeQueries:workerQueries,balance,publicGrantRemains},null,2)+"\n");
    }finally{await operator!.query(`DROP TABLE public.${table}`);}
  });
});
