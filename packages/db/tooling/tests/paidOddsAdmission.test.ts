import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { getSharedOddsBatch, admitPaidOdds, readOddsSubjectReport, oddsSubjectReportSql, pruneOddsSubjectHistory, paidAdmissionSql, paidAdmissionCapabilitySql, type SubjectDimension } from "@dfs-ev/db/runtime";
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
 DROP FUNCTION public.report_odds_subjects();
 DROP FUNCTION public.release_shared_odds_limiter_denial(text,text[],text);
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
  it("real kernel releases rate-denied owner, cached repeats only read, and another subject publishes fresh", async () => {
    await withTestClient(async c => {
      await c.query(await readFile(new URL("../../proposals/221_shared_odds_cache.sql", import.meta.url), "utf8"));
      try {
        await c.query("DELETE FROM public.event_market_odds_cache WHERE event_id IN ('handoff','late')");
        await admit(anon("blocked"));
        let blocked = false, providerCalls = 0;const sql: string[] = [];
        class Refusal extends Error { readonly reason = "subject-rate-limit" as const; }
        const batch = (subject: string) => getSharedOddsBatch("handoff", ["player_pass_yds"], {
          query: async (text, params) => { sql.push(text);return (await c.query(text, params)).rows; },
          shouldDenyRefresh: async () => subject === "blocked" && blocked,
          fetch: async keys => {
            const result = await admitPaidOdds(async (text, params) => { sql.push(text);return (await c.query(text, params)).rows; }, anon(subject), { enforce: true, reserve: 100, batch: 9 });
            if (result.outcome === "subject-rate-limit") { blocked = true;throw new Refusal(); }
            providerCalls++;return Object.fromEntries(keys.map(k => [k, { bookmakers: [] }]));
          },
          isFetchUnavailable: e => e instanceof Refusal, refusalReason: e => e instanceof Refusal ? e.reason : undefined,
          makeOwnerId: () => crypto.randomUUID(), monotonicNow: () => performance.now(), wait: async () => {},
        }, { ttlMs: 90000 });
        expect((await batch("blocked")).player_pass_yds.state).toBe("unavailable");
        expect(sql).toHaveLength(4);expect(sql.at(-1)).toContain("release_shared_odds_limiter_denial");
        expect((await c.query("SELECT refresh_claimed_at,fetched_at='epoch'::timestamptz unchanged FROM public.event_market_odds_cache WHERE event_id='handoff'")).rows[0]).toEqual({ refresh_claimed_at: null, unchanged: true });
        sql.length = 0;expect((await batch("blocked")).player_pass_yds.state).toBe("unavailable");
        expect(sql).toHaveLength(1);expect(sql[0]).toContain("SELECT market_key");
        expect((await batch("eligible")).player_pass_yds.state).toBe("upstream");expect(providerCalls).toBe(1);
        sql.length = 0;expect((await batch("blocked")).player_pass_yds.state).toBe("fresh");expect(sql).toHaveLength(1);
        await c.query("SELECT * FROM public.claim_shared_odds_batch('late',ARRAY['player_pass_yds'],'new-owner',90000,30000)");
        await c.query("SELECT public.release_shared_odds_limiter_denial('late',ARRAY['player_pass_yds'],'old-owner')");
        expect((await c.query("SELECT refresh_owner FROM public.event_market_odds_cache WHERE event_id='late'")).rows[0].refresh_owner).toBe("new-owner");
      } finally {
        await c.query("DELETE FROM public.event_market_odds_cache WHERE event_id IN ('handoff','late')");
        await c.query(`DROP FUNCTION public.claim_shared_odds_batch(text,text[],text,integer,integer);
          DROP FUNCTION public.renew_shared_odds_batch(text,text[],text,integer);
          DROP FUNCTION public.publish_shared_odds_batch(text,text[],text,jsonb);
          DROP FUNCTION public.release_shared_odds_batch(text,text[],text);
          ALTER TABLE public.event_market_odds_cache DROP COLUMN refresh_owner,DROP COLUMN refresh_lease_until,DROP COLUMN refresh_claimed_at;`);
      }
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
        await c.query("GRANT EXECUTE ON FUNCTION public.admit_paid_odds(jsonb,boolean,integer,integer), public.release_shared_odds_limiter_denial(text,text[],text), public.report_odds_subjects() TO odds223_test_web");
        await c.query("BEGIN");await c.query("SET LOCAL ROLE odds223_test_web");
        expect((await c.query(paidAdmissionCapabilitySql)).rows).toEqual([{ ready: true }]);
        const r = await admitPaidOdds(async (t, p) => (await c.query(t, p)).rows, anon(), { enforce: true, reserve: 100, batch: 9 });
        expect(r).toMatchObject({ outcome: "allow", warning: null });await c.query("ROLLBACK");
      } finally {
        await c.query("ROLLBACK");await c.query("REVOKE EXECUTE ON FUNCTION public.admit_paid_odds(jsonb,boolean,integer,integer), public.release_shared_odds_limiter_denial(text,text[],text), public.report_odds_subjects() FROM odds223_test_web");
        await c.query("DROP ROLE odds223_test_web");
      }
    });
  });
});

describe("#223 report, retention and fixed-fixture buffer budgets", () => {
  it("empty fixed windows stay zero and only HMAC subjects are exposed", async () => {
    await withTestClient(async c => {
      const windows = await readOddsSubjectReport(async (t,p) => (await c.query(t,p)).rows);
      expect(windows.map(w => w.window)).toEqual(["1h", "24h"]);
      expect(windows.every(w => w.totals.admitted === 0 && w.topAdmitted.length === 0)).toBe(true);
    });
    await admit(anon(), false);await admit(anon(), false);
    const windows = await withTestClient(c => readOddsSubjectReport(async (t,p) => (await c.query(t,p)).rows));
    expect(windows[0].topAdmitted[0]).toMatchObject({ subject: key("anonymous-network", "a"), admitted: 2, wouldDeny: 1 });
    expect(windows[0].totals.anonymous).toBe(2);
  });
  it("100000-row report remains one query, top-20 and <=1024 shared blocks without temp IO", async () => {
    await withTestClient(async c => {
      await c.query(`INSERT INTO public.odds_subject_limits(subject)
        SELECT 'v1:anonymous-network:'||md5(i::text)||md5(i::text) FROM generate_series(0,9999) i`);
      await c.query(`INSERT INTO public.odds_subject_buckets(subject,minute,admitted,denied,would_deny,anonymous)
        SELECT 'v1:anonymous-network:'||md5((i%10000)::text)||md5((i%10000)::text),
        date_trunc('minute',statement_timestamp())-(i/10000)*interval '13 hours',1+(i%13),i%7,i%5,1
        FROM generate_series(0,99999) i`);
      await c.query("ANALYZE public.odds_subject_buckets");
      expect((await c.query("SELECT count(*)::int n FROM public.odds_subject_buckets")).rows[0].n).toBe(100000);
      let statements = 0;
      const windows = await readOddsSubjectReport(async (t,p) => { statements++;return (await c.query(t,p)).rows; });
      expect(statements).toBe(1);
      expect(windows.every(w => w.topAdmitted.length === 20 && w.topDenied.length === 20 && w.topWouldDeny.length === 20)).toBe(true);
      expect(windows[0].totals.anonymous).toBe(10000);expect(windows[1].totals.anonymous).toBe(20000);
      const plan = (await c.query("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) " + oddsSubjectReportSql)).rows[0]["QUERY PLAN"][0].Plan;
      const shared = (plan["Shared Hit Blocks"] ?? 0)+(plan["Shared Read Blocks"] ?? 0);
      console.info("223_REPORT_BUDGET", JSON.stringify({ rows: 100000, shared, tempRead: plan["Temp Read Blocks"] ?? 0, tempWritten: plan["Temp Written Blocks"] ?? 0 }));
      expect(shared).toBeLessThanOrEqual(1024);expect(plan["Temp Read Blocks"] ?? 0).toBe(0);expect(plan["Temp Written Blocks"] ?? 0).toBe(0);
      const body = (await c.query("SELECT prosrc FROM pg_proc WHERE oid='public.report_odds_subjects()'::regprocedure")).rows[0].prosrc as string;
      const select = body.split("RETURN QUERY")[1].split(";\nEND")[0];
      const detail = (await c.query("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) "+select)).rows[0]["QUERY PLAN"][0].Plan;
      const nodes: Record<string,unknown>[] = [];
      const walk = (node: Record<string,unknown>) => { nodes.push(node);for (const child of (node.Plans??[]) as Record<string,unknown>[]) walk(child); };walk(detail);
      const scans=nodes.filter(n => n["Relation Name"] === "odds_subject_buckets");
      expect(scans).toHaveLength(1);expect(scans[0]["Actual Loops"]).toBe(1);
      expect(nodes.some(n => n["Node Type"] === "WindowAgg")).toBe(false);
      expect(nodes.filter(n => n["Sort Method"] === "top-N heapsort")).toHaveLength(3);
      console.info("223_REPORT_PLAN",JSON.stringify({ sourceScans:scans.length,sourceLoops:scans[0]["Actual Loops"],
        topNSorts:nodes.filter(n => n["Sort Method"] === "top-N heapsort").length,plan:detail }));
    });
  });
  it("minute windows include partial cutoff but exclude older and future minutes", async () => {
    await withTestClient(async c => {
      const subject = key("anonymous-network", "cutoff");await c.query("INSERT INTO public.odds_subject_limits(subject) VALUES($1)",[subject]);
      await c.query(`INSERT INTO public.odds_subject_buckets(subject,minute,admitted) VALUES
        ($1,date_trunc('minute',statement_timestamp()-interval '1 hour'),7),
        ($1,date_trunc('minute',statement_timestamp()-interval '1 hour')-interval '1 minute',3),
        ($1,date_trunc('minute',statement_timestamp())+interval '1 minute',99)`,[subject]);
      const windows = await readOddsSubjectReport(async (t,p) => (await c.query(t,p)).rows);
      expect(windows[0].totals.admitted).toBe(7);expect(windows[1].totals.admitted).toBe(10);
    });
  });
  it("bounded retention preserves future debt, recent rotation state and referenced subjects", async () => {
    await withTestClient(async c => {
      const future = key("user","future"), old = key("user","old"), recent = key("user","recent"), referenced = key("user","referenced");
      await c.query(`INSERT INTO public.odds_subject_limits(subject,tat) VALUES
        ($1,statement_timestamp()+interval '1 hour'),($2,statement_timestamp()-interval '2 days'),
        ($3,statement_timestamp()-interval '1 hour'),($4,statement_timestamp()-interval '2 days')`, [future,old,recent,referenced]);
      await c.query(`INSERT INTO public.odds_subject_buckets(subject,minute,admitted)
        SELECT $1,date_trunc('minute',statement_timestamp()-interval '8 days')-i*interval '1 minute',1 FROM generate_series(1,1200) i`,[future]);
      await c.query("INSERT INTO public.odds_subject_buckets(subject,minute) VALUES($1,date_trunc('minute',statement_timestamp()))",[referenced]);
      const run = () => pruneOddsSubjectHistory(async (t,p) => (await c.query(t,p)).rows);
      expect(await run()).toEqual({ bucketsDeleted: 1000, limitsDeleted: 1 });
      expect(await run()).toEqual({ bucketsDeleted: 200, limitsDeleted: 0 });
      expect((await c.query("SELECT subject FROM public.odds_subject_limits ORDER BY subject")).rows.map(r => r.subject).sort()).toEqual([future,recent,referenced].sort());
    });
  });
  it("warmed allow, first denial, repeat denial, rotation and overlap use <=80 shared blocks and zero temp", async () => {
    await withTestClient(async c => {
      await c.query(`INSERT INTO public.odds_subject_limits(subject)
        SELECT 'v1:user:'||md5(i::text)||md5(i::text) FROM generate_series(1,10000) i`);
      await c.query("ANALYZE public.odds_subject_limits");
      const call = (dims: SubjectDimension[], enforce = true) => c.query(paidAdmissionSql,[JSON.stringify(dims),enforce,100,9]);
      const overlap = (name: string) => user(name).map(d => ({ ...d, keys: [d.report.replace("v1:","v0:"),d.report] }));
      // Warm each branch on disposable subjects, never on a measured subject.
      // Compilation/catalog cache fills are recorded separately, not CI work.
      for (const dims of [anon("warm-anon"), user("warm-user"), overlap("warm-overlap")]) {
        await call(dims);await call(dims);await call(dims,false);
      }
      const measured = [
        { label: "allow", dims: user("measured-allow"), times: 1 },
        { label: "first-and-repeat-denial", dims: user("measured-denial"), times: 3 },
        { label: "overlap", dims: overlap("measured-overlap"), times: 3 },
      ];
      const samples: { label: string; shared: number; tempRead: number; tempWritten: number }[] = [];
      const measure = async (label: string, dims: SubjectDimension[]) => {
        const p = (await c.query("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) " + paidAdmissionSql,[JSON.stringify(dims),true,100,9])).rows[0]["QUERY PLAN"][0].Plan;
        const sample = { label, shared: (p["Shared Hit Blocks"]??0)+(p["Shared Read Blocks"]??0),
          tempRead: p["Temp Read Blocks"]??0,tempWritten: p["Temp Written Blocks"]??0 };
        samples.push(sample);
      };
      for (const entry of measured) for (let i=0;i<entry.times;i++) await measure(entry.label+":"+i,entry.dims);
      const rotated = overlap("measured-rotation");
      await call(rotated.map(d => ({ ...d, keys: [d.keys[0]], report: d.keys[0] })));
      await measure("rotation-existing-debt",rotated);
      console.info("223_WARM_ADMISSION_BUDGET",JSON.stringify(samples));
      for (const sample of samples) { expect(sample.shared).toBeLessThanOrEqual(80);expect(sample.tempRead).toBe(0);expect(sample.tempWritten).toBe(0); }
    });
  });
  it("production lookup plans use the subject PK and partial quota index without sequential scans", async () => {
    await withTestClient(async c => {
      await c.query(`INSERT INTO public.odds_subject_limits(subject)
        SELECT 'v1:user:'||md5(i::text)||md5(i::text) FROM generate_series(1,10000) i`);
      await c.query(`INSERT INTO public.odds_api_request_log
        (id,request_kind,source,sport_key,requested_at,response_received_at,outcome,http_status)
        SELECT 'plan-headerless-'||i,'events','slate','americanfootball_nfl',clock_timestamp(),clock_timestamp(),'http-error',503
        FROM generate_series(1,10000) i`);
      await c.query("ANALYZE public.odds_subject_limits; ANALYZE public.odds_api_request_log");
      const body = (await c.query("SELECT prosrc FROM pg_proc WHERE oid='public.admit_paid_odds(jsonb,boolean,integer,integer)'::regprocedure")).rows[0].prosrc as string;
      // Extract real production statements; do not prove a hand-written proxy.
      const lock = body.match(/SELECT subject,tat FROM public.odds_subject_limits[\s\S]*?FOR UPDATE/)?.[0].replace("ANY(keys)","ANY($1)");
      const update = body.match(/UPDATE public.odds_subject_limits s SET tat[\s\S]*?;/)?.[0].replace("next_tats","$2::jsonb").replace("ANY(keys)","ANY($1)");
      const quotaSql = body.match(/SELECT q.quota_remaining INTO rem[\s\S]*?LIMIT 1;/)?.[0].replace(" INTO rem","");
      expect(lock).toBeDefined();expect(update).toBeDefined();expect(quotaSql).toBeDefined();
      const plans = [];
      for (const [name,text,params,index] of [
        ["update",update!,[[key("user","probe")],JSON.stringify({[key("user","probe")]: "2026-11-20T00:00:00Z"})],"odds_subject_limits_pkey"],
        ["lock",lock!,[[key("user","probe")]],"odds_subject_limits_pkey"],
        ["quota",quotaSql!,[],"odds_admission_latest_quota"],
      ] as const) {
        const plan = (await c.query("EXPLAIN(FORMAT JSON) "+text,[...params])).rows[0]["QUERY PLAN"][0].Plan;
        const encoded=JSON.stringify(plan);expect(encoded).toContain(index);expect(encoded).not.toContain('"Seq Scan"');
        plans.push({ name,plan });
      }
      console.info("223_LOOKUP_PLANS",JSON.stringify(plans));
    });
  });
});
