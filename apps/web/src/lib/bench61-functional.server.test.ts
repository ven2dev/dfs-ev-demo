import {beforeEach,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import {neon} from "@neondatabase/serverless";
vi.mock("@neondatabase/serverless",()=>({neon:vi.fn()}));
vi.mock("./bench61-config.json",()=>({default:{host:"fixture.neon.tech",database:"fixture"}}));
import {authorizeFunctional,executeFunctional,functionalIdentity} from "./bench61-functional";
import {POST} from "@/app/api/bench61/route";
const token="a".repeat(64),hash=createHash("sha256").update(token).digest("hex");
const now=Date.parse("2026-10-22T22:00:00Z");
const env={VERCEL_ENV:"preview",VERCEL_REGION:"iad1",
  BENCH61_REVIEWED_SHA:"c".repeat(40),VERCEL_GIT_COMMIT_SHA:"c".repeat(40),
  DATABASE_URL:"postgres://operator:local@fixture.neon.tech/fixture",
  BENCH61_DATABASE_URL:"postgres://bench61_http_timeout_20261022:"+"b".repeat(64)+"@fixture.neon.tech/fixture",
  BENCH61_TOKEN_HASH:hash,BENCH61_ISSUED_AT:"2026-10-22T21:00:00Z",BENCH61_EXPIRES_AT:"2026-10-23T21:00:00Z"};
beforeEach(()=>{vi.unstubAllEnvs();vi.mocked(neon).mockReset();});
it("requires the designated Preview, fixed action, credential identity and <=24h token window",()=>{
  for(const action of ["setup","qualify","catalog","cleanup"])expect(authorizeFunctional(token,action,env,now)).toBe(true);
  for(const action of ["run","cold1","cold2","cold3","DROP SCHEMA public"])expect(authorizeFunctional(token,action,env,now)).toBe(false);
  for(const changed of [{VERCEL_ENV:"production"},{VERCEL_REGION:"sfo1"},
    {BENCH61_REVIEWED_SHA:"d".repeat(40)},{VERCEL_GIT_COMMIT_SHA:"d".repeat(40)},
    {BENCH61_TOKEN_HASH:"invalid"},{BENCH61_EXPIRES_AT:"2026-10-24T21:00:00Z"},
    {BENCH61_ISSUED_AT:"2026-10-23T00:00:00Z"},
    {DATABASE_URL:env.DATABASE_URL.replace("fixture.neon.tech","wrong.invalid")},
    {BENCH61_DATABASE_URL:env.BENCH61_DATABASE_URL.replace("fixture.neon.tech","wrong.invalid")},
    {BENCH61_DATABASE_URL:env.BENCH61_DATABASE_URL.replace("/fixture","/other")},
    {BENCH61_DATABASE_URL:env.BENCH61_DATABASE_URL.replace("bench61_http_timeout_20261022","operator")}]) {
    expect(authorizeFunctional(token,"qualify",{...env,...changed},now)).toBe(false);
  }
  expect(authorizeFunctional(token,"cleanup",env,Date.parse(env.BENCH61_EXPIRES_AT))).toBe(false);
  expect(authorizeFunctional("c".repeat(64),"qualify",env,now)).toBe(false);
});
it("keeps cleanup available without a worker credential",()=>{
  const noWorker={...env,BENCH61_DATABASE_URL:undefined};
  expect(authorizeFunctional(token,"cleanup",noWorker,now)).toBe(true);
  expect(authorizeFunctional(token,"qualify",noWorker,now)).toBe(false);
  expect(()=>functionalIdentity({...env,BENCH61_DATABASE_URL:env.BENCH61_DATABASE_URL+"?options=unsafe"},true)).toThrow("connection options");
  expect(()=>functionalIdentity({...env,DATABASE_URL:env.DATABASE_URL+"?user=operator"},true)).toThrow("Unsupported operator");
});
it("rejects performance POSTs with fully valid functional credentials before SQL",async()=>{
  for(const [key,value] of Object.entries(env))vi.stubEnv(key,value);
  vi.useFakeTimers();vi.setSystemTime(now);
  try {
    expect(authorizeFunctional(token,"qualify",process.env)).toBe(true);
    for(const action of ["run","cold1","cold2","cold3"]){
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
  for(const action of ["setup","qualify","catalog","cleanup"])
    expect(authorizeFunctional(token,action,wrong,now)).toBe(false);
  for(const [key,value] of Object.entries(wrong))vi.stubEnv(key,value);
  await expect(executeFunctional("setup")).rejects.toThrow("Operator target mismatch");
  expect(neon).not.toHaveBeenCalled();
  expect(functionalIdentity({...env,DATABASE_URL:env.DATABASE_URL.replace("/fixture","/%66ixture")},true))
    .toEqual({host:"fixture.neon.tech",database:"fixture"});
});
