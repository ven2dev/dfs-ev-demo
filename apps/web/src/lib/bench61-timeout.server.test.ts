import {beforeEach,expect,it,vi} from "vitest";
import {neon} from "@neondatabase/serverless";
import {proveServerCancellation,proveServerLockCancellation,qualifyHttpTimeout,timeoutRole} from "./bench61-timeout";
vi.mock("@neondatabase/serverless",()=>({neon:vi.fn()}));
const host="fixture.neon.tech",database="fixture";
const url=`postgres://${timeoutRole}:test-only@${host}/${database}`;
const context={schema:'"bench61_206_20261022"',owner:"owner",request:"request"};
beforeEach(()=>vi.resetAllMocks());
it("requires a server statement-timeout error, not client or user cancellation",async()=>{
  for(const error of [{code:"57014",message:"canceling statement due to user request"},
    {name:"AbortError",message:"client aborted"},{code:"08006",message:"connection lost"}]) {
    await expect(proveServerCancellation(vi.fn().mockRejectedValue(error),"SELECT pg_sleep(6)"))
      .rejects.toThrow("Expected PostgreSQL statement timeout");
  }
  await expect(proveServerCancellation(vi.fn().mockResolvedValue([]),"SELECT pg_sleep(6)"))
    .rejects.toThrow("failed to cancel");
  await expect(proveServerCancellation(vi.fn().mockRejectedValue({code:"57014",message:"canceling statement due to statement timeout"}),"SELECT pg_sleep(6)"))
    .resolves.toBeUndefined();
});
it("rejects a wrong host, database, role or schema before creating an HTTP client",async()=>{
  for(const wrong of [url.replace(host,"wrong.invalid"),url.replace(database,"other"),url.replace(timeoutRole,"neondb_owner")]) {
    await expect(qualifyHttpTimeout(wrong,host,database,context,vi.fn())).rejects.toThrow("identity mismatch");
  }
  await expect(qualifyHttpTimeout(url,host,database,{...context,schema:"public"},vi.fn())).rejects.toThrow("Unexpected synthetic schema");
  expect(neon).not.toHaveBeenCalled();
});
const identity={session_user:timeoutRole,current_user:timeoutRole,database,statement:"5s",lock:"2s",isolation:"read committed",pid:123};
const client = (settings=identity) => {
  const query=vi.fn(async(text:string)=>{
    if(text.includes("pg_sleep(6)"))throw {code:"57014",message:"canceling statement due to statement timeout"};
    return [settings];
  });
  vi.mocked(neon).mockReturnValue({query} as unknown as ReturnType<typeof neon>);
  return query;
};
it("stops on ineffective defaults before attempting a debit",async()=>{
  const query=client({...identity,statement:"0"});
  await expect(qualifyHttpTimeout(url,host,database,context,vi.fn())).rejects.toThrow("Effective login defaults");
  expect(query).toHaveBeenCalledTimes(1);
});
it("uses single HTTP statements with no in-command timeout SET and reports partial qualification",async()=>{
  const query=client(),observe=vi.fn().mockResolvedValue([{balance:100}]);
  const result=await qualifyHttpTimeout(url,host,database,context,observe);
  expect(result).toMatchObject({serverStatementCancellation:true,debitRolledBack:true,roundTrips:8,statements:8,performanceEnabled:false});
  expect(observe).toHaveBeenCalledTimes(2);
  expect(query.mock.calls.some(([text])=>/set_config|SET statement_timeout/i.test(text))).toBe(false);
  expect(query.mock.calls.filter(([text])=>text.includes("UPDATE"))).toHaveLength(1);
});
it("fails rather than accepting a changed balance after cancellation",async()=>{
  client();const observe=vi.fn().mockResolvedValueOnce([{balance:100}]).mockResolvedValueOnce([{balance:97}]);
  await expect(qualifyHttpTimeout(url,host,database,context,observe)).rejects.toThrow("changed the balance");
});

it("requires the server lock-timeout reason rather than another lock or cancellation error",async()=>{
  for(const error of [{code:"55P03",message:"could not obtain lock on row in relation budgets"},
    {code:"57014",message:"canceling statement due to statement timeout"},
    {name:"AbortError",message:"client aborted"}]) {
    await expect(proveServerLockCancellation(vi.fn().mockRejectedValue(error),"blocked debit"))
      .rejects.toThrow("Expected PostgreSQL lock timeout");
  }
  await expect(proveServerLockCancellation(vi.fn().mockResolvedValue([]),"blocked debit"))
    .rejects.toThrow("failed to cancel blocked statement");
  await expect(proveServerLockCancellation(vi.fn().mockRejectedValue({code:"55P03",message:"canceling statement due to lock timeout"}),"blocked debit"))
    .resolves.toBeUndefined();
});

it("drains already-started identity requests before reporting a concurrent failure",async()=>{
  let calls=0,release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const query=vi.fn(async()=>{
    const call=++calls;
    if(call===3)throw new Error("injected concurrent failure");
    if(call===4){entered();await held;}
    return [identity];
  });
  vi.mocked(neon).mockReturnValue({query} as unknown as ReturnType<typeof neon>);
  let settled=false;
  const result=qualifyHttpTimeout(url,host,database,context,vi.fn())
    .then(value=>({value}),error=>({error})).finally(()=>{settled=true;});
  try {
    await started;
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {release();}
  expect(await result).toMatchObject({error:expect.objectContaining({message:"injected concurrent failure"})});
  expect(calls).toBe(5);
});
