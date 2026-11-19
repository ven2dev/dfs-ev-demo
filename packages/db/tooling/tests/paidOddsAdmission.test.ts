import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { admitPaidOdds, paidAdmissionCapabilitySql, type SubjectDimension } from "@dfs-ev/db/runtime";
import { withTestClient } from "./harness";
const key = (kind: string, name: string, version = "v1") => version + ":" + kind + ":" + createHash("sha256").update(name).digest("hex");
const dimension = (kind: string, name: string, burst = 1): SubjectDimension => {
  const subject = key(kind, name);return { keys: [subject], report: subject, intervalMs: 60_000, burst, traffic: kind === "anonymous-network" ? "anonymous" : "signed-in" };
};
const anon = (name = "a", burst = 1) => [dimension("anonymous-network", name, burst)];
const user = (name: string) => [dimension("signed-network", "net", 100), dimension("user", name)];
const admit = (dims = anon(), enforce = true) => withTestClient(c => admitPaidOdds(async (t, p) => (await c.query(t, p)).rows, dims, { enforce, reserve: 100, batch: 9 }));
const snapshot = () => withTestClient(c => c.query("SELECT subject,tat::text FROM public.odds_subject_limits ORDER BY subject").then(r => r.rows));
const quota = (remaining: number) => withTestClient(c => c.query(`INSERT INTO public.odds_api_request_log
 (id,request_kind,source,sport_key,requested_at,response_received_at,outcome,http_status,quota_remaining,quota_used)
 VALUES('fixture','events','slate','americanfootball_nfl',clock_timestamp(),clock_timestamp(),'success',200,$1,0)`, [remaining]));
beforeAll(async () => withTestClient(async c => {
  await c.query(await readFile(new URL("../../proposals/223_paid_leader_gcra.sql", import.meta.url), "utf8"));
}));
beforeEach(async () => {
  await withTestClient(c => c.query("TRUNCATE public.odds_subject_limits,public.odds_subject_buckets,public.odds_api_request_log"));
  await quota(10000);
});
afterAll(() => withTestClient(c => c.query(`DROP FUNCTION public.admit_paid_odds(jsonb,boolean,integer,integer);
 DROP TABLE public.odds_subject_buckets,public.odds_subject_limits;
 DROP INDEX public.odds_admission_latest_quota;`)));
const fault = (table: string) => withTestClient(c => c.query(`CREATE FUNCTION public.reject_admission_write() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'synthetic private details'; END $$;
 CREATE TRIGGER reject_admission_write BEFORE INSERT OR UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.reject_admission_write();`));
const clearFault = (table: string) => withTestClient(c => c.query(`DROP TRIGGER reject_admission_write ON public.${table}; DROP FUNCTION public.reject_admission_write();`));

describe("#223 proposed database-clock GCRA", () => {
  it("ready check recognizes exact signature; missing schema has no implicit install", async () => {
    await withTestClient(async c => expect((await c.query(paidAdmissionCapabilitySql)).rows).toEqual([{ ready: true }]));
  });
  it("floor at reserve plus batch refuses with no TAT advance and missing observation allows", async () => {
    await withTestClient(c => c.query("UPDATE public.odds_api_request_log SET quota_remaining=109"));
    expect(await admit()).toMatchObject({ outcome: "quota-floor", remaining: 109 });
    expect((await snapshot()).every(s => s.tat === "-infinity")).toBe(true);
    await withTestClient(c => c.query("TRUNCATE public.odds_api_request_log"));
    expect(await admit()).toMatchObject({ outcome: "allow", remaining: null });
  });
  it("quota index stays bounded behind 10000 newer headerless observations", async () => {
    await withTestClient(async c => {
      await c.query("UPDATE public.odds_api_request_log SET requested_at=clock_timestamp()-interval '1 day'");
      await c.query(`INSERT INTO public.odds_api_request_log
       (id,request_kind,source,sport_key,requested_at,response_received_at,outcome,http_status)
       SELECT 'headerless-'||i,'events','slate','americanfootball_nfl',clock_timestamp()-i*interval '1 second',clock_timestamp(),'http-error',503
       FROM generate_series(1,10000) i`);
      await c.query("ANALYZE public.odds_api_request_log");
      const plan = (await c.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT q.quota_remaining FROM public.odds_api_request_log q
       WHERE q.quota_remaining IS NOT NULL ORDER BY q.requested_at DESC LIMIT 1`)).rows[0]["QUERY PLAN"][0].Plan;
      expect(JSON.stringify(plan)).toContain("odds_admission_latest_quota");
      expect((plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0)).toBeLessThanOrEqual(16);
    });
    expect(await admit()).toMatchObject({ outcome: "allow", remaining: 10000, warning: null });
  });
  it("user denial returns only failing HMAC keys and leaves network state untouched", async () => {
    expect((await admit(user("a"))).outcome).toBe("allow");const before = await snapshot();
    const denied = await admit(user("a"));expect(denied.outcome).toBe("subject-rate-limit");expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.deniedSubjects).toEqual([key("user", "a")]);expect(await snapshot()).toEqual(before);
    expect((await admit(user("b"))).outcome).toBe("allow");
  });
  it("twenty independent clients take sorted reverse-order dimensions without deadlock", async () => {
    const result = await Promise.all(Array.from({ length: 20 }, (_, i) => {
      const dims = user("parallel" + i);return admit(i % 2 ? dims : dims.reverse());
    }));
    expect(result.every(r => r.outcome === "allow" && r.warning === null)).toBe(true);
    await withTestClient(async c => expect((await c.query("SELECT sum(admitted)::int n FROM public.odds_subject_buckets")).rows[0].n).toBe(40));
  });
  it("hot anonymous burst counts actual denials in one minute row", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => admit(anon("hot", 5))));
    expect(results.filter(r => r.outcome === "allow")).toHaveLength(5);
    expect(results.filter(r => r.outcome === "subject-rate-limit")).toHaveLength(15);
    await withTestClient(async c => expect((await c.query("SELECT count(*)::int rows,sum(admitted)::int admitted,sum(denied)::int denied FROM public.odds_subject_buckets")).rows[0]).toEqual({ rows: 1, admitted: 5, denied: 15 }));
  });
  it("shadow would-deny still admits and counts without advancing denied TAT", async () => {
    await admit(anon(), false);const before = await snapshot();
    expect(await admit(anon(), false)).toMatchObject({ outcome: "allow", wouldDeny: true });expect(await snapshot()).toEqual(before);
    await withTestClient(async c => expect((await c.query("SELECT admitted::int,denied::int,would_deny::int FROM public.odds_subject_buckets")).rows[0]).toEqual({ admitted: 2, denied: 0, would_deny: 1 }));
  });
  it.each([true, false])("counter failure rolls all dimensions back and allows in enforce=%s", async enforce => {
    await fault("odds_subject_buckets");
    try { expect(await admit(user("fault"), enforce)).toMatchObject({ outcome: "allow", warning: "limiter-counter-failed" }); }
    finally { await clearFault("odds_subject_buckets"); }
    expect((await snapshot()).every(s => s.tat === "-infinity")).toBe(true);
    await withTestClient(async c => expect((await c.query("SELECT count(*)::int n FROM public.odds_subject_buckets")).rows[0].n).toBe(0));
  });
  it("known floor refusal survives counter failure and limiter failure still checks floor", async () => {
    await withTestClient(c => c.query("UPDATE public.odds_api_request_log SET quota_remaining=0"));
    for (const table of ["odds_subject_buckets", "odds_subject_limits"]) {
      await fault(table);try { expect((await admit()).outcome).toBe("quota-floor"); } finally { await clearFault(table); }
    }
  });
  it("counter failure after a GCRA denial still checks the quota floor", async () => {
    await admit(); // consume allowance before quota becomes low
    await withTestClient(c => c.query("UPDATE public.odds_api_request_log SET quota_remaining=0"));
    await fault("odds_subject_buckets");
    try { expect(await admit()).toMatchObject({ outcome: "quota-floor", remaining: 0, warning: "limiter-counter-failed" }); }
    finally { await clearFault("odds_subject_buckets"); }
  });
  it("rotation is stricter across versions, mirrors debt and writes reporting version only", async () => {
    const dims = anon();await admit(dims);
    const rotated = { ...dims[0], keys: [dims[0].keys[0], key("anonymous-network", "a", "v2")], report: key("anonymous-network", "a", "v2") };
    expect((await admit([rotated])).outcome).toBe("subject-rate-limit");
    await withTestClient(c => c.query("UPDATE public.odds_subject_limits SET tat=clock_timestamp()-interval '1 second'"));
    expect((await admit([rotated])).outcome).toBe("allow");
    await withTestClient(async c => {
      expect((await c.query("SELECT count(DISTINCT tat)::int n FROM public.odds_subject_limits")).rows[0].n).toBe(1);
      expect((await c.query("SELECT sum(admitted)::int n FROM public.odds_subject_buckets")).rows[0].n).toBe(2);
    });
    expect((await admit([{ ...rotated, keys: [rotated.report] }])).outcome).toBe("subject-rate-limit");
  });
  it.each([null, [], [{ ...dimension("anonymous-network", "bad"), keys: ["raw-ip-or-uid"] }],
    [{ ...dimension("anonymous-network", "bad"), intervalMs: null }],
    [{ ...dimension("anonymous-network", "bad"), traffic: null }], user("a").map(d => ({ ...d, burst: 1001 }))].map((input, i) => [i, input] as const))("invalid/unbounded input %i leaves no identity rows", async (_i, input) => {
    await withTestClient(async c => {
      await expect(c.query("SELECT * FROM public.admit_paid_odds($1::jsonb,true,100,9)", [JSON.stringify(input)])).rejects.toBeDefined();
      expect((await c.query("SELECT count(*)::int n FROM public.odds_subject_limits")).rows[0].n).toBe(0);
    });
  });
  it("PUBLIC has no execute/table writes; explicit execute grant works without direct table privileges", async () => {
    await withTestClient(async c => {
      await c.query("CREATE ROLE odds223_test_web NOLOGIN");
      try {
        await c.query("BEGIN");await c.query("SET LOCAL ROLE odds223_test_web");
        expect((await c.query(paidAdmissionCapabilitySql)).rows).toEqual([{ ready: false }]);
        await expect(c.query("SELECT * FROM public.odds_subject_limits")).rejects.toMatchObject({ code: "42501" });
        await c.query("ROLLBACK");
        await c.query("GRANT EXECUTE ON FUNCTION public.admit_paid_odds(jsonb,boolean,integer,integer) TO odds223_test_web");
        await c.query("BEGIN");await c.query("SET LOCAL ROLE odds223_test_web");
        expect((await c.query(paidAdmissionCapabilitySql)).rows).toEqual([{ ready: true }]);
        const r = await admitPaidOdds(async (t, p) => (await c.query(t, p)).rows, anon(), { enforce: true, reserve: 100, batch: 9 });
        expect(r).toMatchObject({ outcome: "allow", warning: null });await c.query("ROLLBACK");
      } finally {
        await c.query("ROLLBACK");await c.query("REVOKE EXECUTE ON FUNCTION public.admit_paid_odds(jsonb,boolean,integer,integer) FROM odds223_test_web");
        await c.query("DROP ROLE odds223_test_web");
      }
    });
  });
});
