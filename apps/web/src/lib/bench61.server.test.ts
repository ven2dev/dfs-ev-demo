import { beforeEach, describe, expect, it, vi } from "vitest";
import { neon } from "@neondatabase/serverless";
const fixture = vi.hoisted(() => ({ token: "a".repeat(64), host: "fixture.neon.tech" }));
vi.mock("./bench61-config.json", async () => {
  const { createHash } = await import("node:crypto");
  return { default: { tokenHash:createHash("sha256").update(fixture.token).digest("hex"),
    expiresAt:"2099-01-01T00:00:00Z",host:fixture.host,schema:"bench61_206_20261022",maxStatements:16040,maxRoundTrips:8020 } };
});
vi.mock("@neondatabase/serverless",()=>({neon:vi.fn()}));
import { authorizeBenchmark, executeBenchmark } from "./bench61";
import benchmarkConfig from "./bench61-config.json";
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
  it("refuses the workload before SQL when the approved statement reservation cannot fit",async()=>{
    const transaction=vi.fn();
    vi.mocked(neon).mockReturnValue({transaction} as unknown as ReturnType<typeof neon>);
    const previous=benchmarkConfig.maxStatements;
    try {
      benchmarkConfig.maxStatements=15799;
      expect(await executeBenchmark("run")).toMatchObject({requiredStatementReservation:15800,configuredCap:15799});
      expect(transaction).not.toHaveBeenCalled();
    }finally{benchmarkConfig.maxStatements=previous;}
  });
  it("never adopts or drops a schema after an ambiguous setup error",async()=>{
    const transaction=vi.fn().mockRejectedValue(new Error("schema exists"));
    const query=vi.fn((text:string)=>text);
    vi.mocked(neon).mockReturnValue({query,transaction} as unknown as ReturnType<typeof neon>);
    await expect(executeBenchmark("setup")).rejects.toThrow("schema exists");
    expect(query.mock.calls.flat().join(" ")).not.toContain("DROP SCHEMA");
  });

});
