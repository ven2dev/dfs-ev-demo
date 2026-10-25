import {beforeEach,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import {neon} from "@neondatabase/serverless";
vi.mock("@neondatabase/serverless",()=>({neon:vi.fn()}));
vi.mock("./bench61-config.json",()=>({default:{host:"fixture.neon.tech",database:"fixture"}}));
import {admissionRefusals,authorizeFunctional,executeFunctional,functionalIdentity} from "./bench61-functional";
import {executeProbe,plannedRunWork,probeCaps} from "./bench61-probe";
import {candidateRole} from "./bench61-candidate";
import {POST} from "@/app/api/bench61/route";
const token="a".repeat(64),hash=createHash("sha256").update(token).digest("hex");
const now=Date.parse("2026-10-22T22:00:00Z");
const env={VERCEL_ENV:"preview",VERCEL_REGION:"iad1",
  BENCH61_REVIEWED_SHA:"c".repeat(40),VERCEL_GIT_COMMIT_SHA:"c".repeat(40),
  DATABASE_URL:"postgres://operator:local@fixture.neon.tech/fixture",
  BENCH61_DATABASE_URL:"postgres://"+candidateRole+":"+"b".repeat(64)+"@fixture.neon.tech/fixture",
  BENCH61_TOKEN_HASH:hash,BENCH61_ISSUED_AT:"2026-10-22T21:00:00Z",BENCH61_EXPIRES_AT:"2026-10-23T21:00:00Z"};
beforeEach(()=>{vi.unstubAllEnvs();vi.mocked(neon).mockReset();});
it("requires the designated Preview, fixed action, credential identity and <=24h token window",()=>{
  for(const action of ["probe-setup","probe-qualify","probe-run","probe-cleanup"])expect(authorizeFunctional(token,action,env,now)).toBe(true);
  // This SHA admits only the probe; the earlier functional actions are refused.
  for(const action of ["setup","qualify","catalog","cleanup"])expect(admissionRefusals(token,action,env,now)).toEqual(["action_not_admitted"]);
  for(const action of ["run","cold1","cold2","cold3","DROP SCHEMA public"])expect(authorizeFunctional(token,action,env,now)).toBe(false);
  for(const changed of [{VERCEL_ENV:"production"},{VERCEL_REGION:"sfo1"},
    {BENCH61_REVIEWED_SHA:"d".repeat(40)},{VERCEL_GIT_COMMIT_SHA:"d".repeat(40)},
    {BENCH61_TOKEN_HASH:"invalid"},{BENCH61_EXPIRES_AT:"2026-10-24T21:00:00Z"},
    {BENCH61_ISSUED_AT:"2026-10-23T00:00:00Z"},
    {DATABASE_URL:env.DATABASE_URL.replace("fixture.neon.tech","wrong.invalid")},
    {BENCH61_DATABASE_URL:env.BENCH61_DATABASE_URL.replace("fixture.neon.tech","wrong.invalid")},
    {BENCH61_DATABASE_URL:env.BENCH61_DATABASE_URL.replace("/fixture","/other")},
    {BENCH61_DATABASE_URL:env.BENCH61_DATABASE_URL.replace(candidateRole,"operator")}]) {
    expect(authorizeFunctional(token,"probe-qualify",{...env,...changed},now)).toBe(false);
  }
  expect(authorizeFunctional(token,"probe-cleanup",env,Date.parse(env.BENCH61_EXPIRES_AT))).toBe(false);
  expect(authorizeFunctional("c".repeat(64),"probe-qualify",env,now)).toBe(false);
});
it("keeps cleanup available without a worker credential",()=>{
  const noWorker={...env,BENCH61_DATABASE_URL:undefined};
  expect(authorizeFunctional(token,"probe-cleanup",noWorker,now)).toBe(true);
  for(const action of ["probe-setup","probe-qualify","probe-run"])expect(authorizeFunctional(token,action,noWorker,now)).toBe(false);
  expect(()=>functionalIdentity({...env,BENCH61_DATABASE_URL:env.BENCH61_DATABASE_URL+"?options=unsafe"},true,candidateRole)).toThrow("connection options");
  expect(()=>functionalIdentity({...env,DATABASE_URL:env.DATABASE_URL+"?user=operator"},true,candidateRole)).toThrow("Unsupported operator");
});
it("rejects performance POSTs with fully valid functional credentials before SQL",async()=>{
  for(const [key,value] of Object.entries(env))vi.stubEnv(key,value);
  vi.useFakeTimers();vi.setSystemTime(now);
  try {
    expect(authorizeFunctional(token,"probe-qualify",process.env)).toBe(true);
    for(const action of ["run","cold1","cold2","cold3","setup","qualify","catalog","cleanup"]){
      const response=await POST(new Request("https://fixture.invalid/api/bench61",{method:"POST",body:JSON.stringify({token,action})}));
      expect(response.status).toBe(404);
    }
    expect(neon).not.toHaveBeenCalled();
  }finally{vi.useRealTimers();}
});
it("rejects a direct unrecognized action before constructing a client",async()=>{
  await expect(executeFunctional("run" as never)).rejects.toThrow("Unknown functional action");
  expect(neon).not.toHaveBeenCalled();
});
it("pins the reviewed database even when both URLs consistently name the same wrong database",async()=>{
  const wrong={...env,DATABASE_URL:env.DATABASE_URL.replace("/fixture","/ordinary_app_db"),
    BENCH61_DATABASE_URL:env.BENCH61_DATABASE_URL.replace("/fixture","/ordinary_app_db")};
  for(const action of ["probe-setup","probe-qualify","probe-run","probe-cleanup"])
    expect(authorizeFunctional(token,action,wrong,now)).toBe(false);
  for(const [key,value] of Object.entries(wrong))vi.stubEnv(key,value);
  await expect(executeFunctional("setup")).rejects.toThrow("Operator target mismatch");
  expect(neon).not.toHaveBeenCalled();
  expect(functionalIdentity({...env,DATABASE_URL:env.DATABASE_URL.replace("/fixture","/%66ixture")},true,candidateRole))
    .toEqual({host:"fixture.neon.tech",database:"fixture"});
});
it("names every failed admission condition with fixed codes",()=>{
  expect(admissionRefusals(token,"probe-qualify",env,now)).toEqual([]);
  const cases: [Record<string,string|undefined>,string[],string?][] = [
    [{VERCEL_ENV:"production"},["not_preview"]],[{VERCEL_REGION:"sfo1"},["region_not_iad1"]],
    [{VERCEL_GIT_COMMIT_SHA:undefined},["commit_sha_missing"]],[{VERCEL_GIT_COMMIT_SHA:"d".repeat(40)},["commit_sha_mismatch"]],
    [{BENCH61_REVIEWED_SHA:"not-a-sha"},["reviewed_sha_invalid","commit_sha_mismatch"]],
    [{BENCH61_EXPIRES_AT:"2026-10-24T21:00:00Z"},["token_window_invalid"]],[{BENCH61_ISSUED_AT:"2026-10-23T00:00:00Z"},["token_not_yet_valid"]],
    [{BENCH61_TOKEN_HASH:"invalid"},["token_hash_invalid"]],
    [{DATABASE_URL:env.DATABASE_URL.replace("fixture.neon.tech","wrong.invalid")},["operator_target_mismatch"]],
    [{DATABASE_URL:env.DATABASE_URL+"?user=operator"},["operator_options_unsupported"]],
    [{BENCH61_DATABASE_URL:env.BENCH61_DATABASE_URL.replace(candidateRole,"operator")},["worker_target_mismatch"]],
    [{BENCH61_DATABASE_URL:env.BENCH61_DATABASE_URL+"?sslmode=require"},["worker_options_differ"]],
    [{BENCH61_DATABASE_URL:"not a url"},["connection_url_invalid"]],[{DATABASE_URL:undefined},["operator_url_missing"]],
  ];
  for(const [changed,expected] of cases)expect(admissionRefusals(token,"probe-qualify",{...env,...changed},now)).toEqual(expected);
  expect(admissionRefusals(token,"probe-cleanup",env,Date.parse(env.BENCH61_EXPIRES_AT))).toEqual(["token_expired"]);
  expect(admissionRefusals("c".repeat(64),"probe-qualify",env,now)).toEqual(["token_mismatch"]);
  expect(admissionRefusals(undefined,"run",env,now)).toEqual(["action_not_admitted","token_malformed"]);
  // Runtime delivery failure: system variables present, none of the five experiment values.
  const undelivered={VERCEL_ENV:"preview",VERCEL_REGION:"iad1",VERCEL_GIT_COMMIT_SHA:"c".repeat(40),DATABASE_URL:env.DATABASE_URL};
  expect(admissionRefusals(token,"probe-qualify",undelivered,now))
    .toEqual(["reviewed_sha_missing","token_window_missing","token_hash_missing","worker_url_missing"]);
  expect(admissionRefusals(token,"probe-cleanup",undelivered,now)).toEqual(["reviewed_sha_missing","token_window_missing","token_hash_missing"]);
});
it("logs only fixed refusal codes and keeps the public 404 undifferentiated",async()=>{
  for(const [key,value] of Object.entries(env))vi.stubEnv(key,value);
  vi.useFakeTimers();vi.setSystemTime(now);
  const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
  try {
    const secrets=[token,"c".repeat(64),hash,"b".repeat(64),"operator:local",env.BENCH61_DATABASE_URL,env.DATABASE_URL];
    for(const [body,reasons] of [[JSON.stringify({token:"c".repeat(64),action:"probe-run"}),["token_mismatch"]],
      [JSON.stringify({token:token,action:token}),["action_not_admitted"]],["{"+token,["body_unparseable"]],
      ["5",["body_unparseable"]],["x".repeat(1025),["body_too_large"]]] as const) {
      warn.mockClear();
      const response=await POST(new Request("https://fixture.invalid/api/bench61",{method:"POST",body}));
      expect(response.status).toBe(404);expect(await response.text()).toBe("");
      expect(warn).toHaveBeenCalledTimes(1);
      const line=String(warn.mock.calls[0][0]);
      expect(JSON.parse(line)).toEqual({event:"bench61_admission_refused",reasons});
      for(const secret of secrets)expect(line).not.toContain(secret);
    }
    expect(neon).not.toHaveBeenCalled();
  }finally{warn.mockRestore();vi.useRealTimers();}
});
it("rejects a direct unrecognized probe action before constructing a client",async()=>{
  for(const action of ["setup","run","DROP SCHEMA public"])await expect(executeProbe(action as never)).rejects.toThrow("Unknown probe action");
  expect(neon).not.toHaveBeenCalled();
});
it("keeps the planned probe work inside its caps and the approved totals",()=>{
  expect(plannedRunWork()).toEqual({workloadTrips:750,workloadStatements:1750,trips:768,statements:1768});
  expect(plannedRunWork().trips).toBeLessThanOrEqual(probeCaps["probe-run"].trips);
  expect(plannedRunWork().statements).toBeLessThanOrEqual(probeCaps["probe-run"].statements);
  const total=Object.values(probeCaps).reduce((sum,cap)=>({trips:sum.trips+cap.trips,statements:sum.statements+cap.statements}),{trips:0,statements:0});
  expect(total).toEqual({trips:994,statements:2298});
  // Plan totals plus 5%: 990 round trips and 2,270 statements.
  expect(total.trips).toBeLessThanOrEqual(1040);expect(total.statements).toBeLessThanOrEqual(2384);
});
