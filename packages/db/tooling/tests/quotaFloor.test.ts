import { beforeEach, describe, expect, it } from "vitest";
import { latestProviderQuotaSql, readLatestProviderQuota } from "@dfs-ev/db/runtime";
import { withTestClient } from "./harness";
beforeEach(() => withTestClient(c => c.query("TRUNCATE public.odds_api_request_log")));
const insert = (remaining: number | null, used = 0, age = 0) => withTestClient(c => c.query(`INSERT INTO public.odds_api_request_log
 (id,request_kind,source,sport_key,requested_at,response_received_at,outcome,http_status,quota_remaining,quota_used,created_at)
 VALUES('reading','events','slate','americanfootball_nfl',clock_timestamp(),clock_timestamp(),'success',200,$1,$2,clock_timestamp()-$3*interval '1 second')`, [remaining, used, age]));
describe("#222 existing indexed provider quota observation", () => {
  it("missing reading is null with one SELECT; legitimate zero remains zero", async () => {
    await withTestClient(async c => {
      let statements = 0;
      const query = async (text: string, params: unknown[]) => { statements++; return (await c.query(text, params)).rows; };
      expect(await readLatestProviderQuota(query)).toBeNull(); expect(statements).toBe(1);
    });
    await insert(0, 500);
    await withTestClient(async c => expect(await readLatestProviderQuota(async (text, params) => (await c.query(text, params)).rows)).toMatchObject({ remaining: 0, used: 500 }));
  });
  it("age uses the DB receipt clock, with no subtraction of provider/host capture time", async () => {
    await insert(500, 10, 90);
    await withTestClient(async c => {
      await c.query("UPDATE public.odds_api_request_log SET requested_at='2099-01-01',response_received_at='2099-01-01'");
      const reading = await readLatestProviderQuota(async (text, params) => (await c.query(text, params)).rows);
      expect(reading?.ageSeconds).toBeGreaterThanOrEqual(90); expect(reading?.ageSeconds).toBeLessThan(150);
    });
  });
  it("10,000 historical rows use the existing descending index and a bounded one-row lookup", async () => {
    await withTestClient(async c => {
      await c.query(`INSERT INTO public.odds_api_request_log
        (id,request_kind,source,sport_key,requested_at,response_received_at,outcome,http_status,quota_remaining,quota_used)
        SELECT 'history-'||n,'events','slate','americanfootball_nfl',clock_timestamp()-n*interval '1 minute',clock_timestamp(),
          'success',200,1000,0 FROM generate_series(1,10000)n`);
    });
    await insert(109, 891);
    await withTestClient(async c => {
      await c.query("ANALYZE public.odds_api_request_log");
      const plan = (await c.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + latestProviderQuotaSql)).rows[0]["QUERY PLAN"][0].Plan;
      expect(JSON.stringify(plan)).toContain("idx_odds_api_request_log_requested");
      expect(plan["Actual Rows"]).toBe(1);
      expect((plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0)).toBeLessThanOrEqual(16);
      expect(await readLatestProviderQuota(async (text, params) => (await c.query(text, params)).rows)).toMatchObject({ remaining: 109, used: 891 });
    });
  });
});
