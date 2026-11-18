import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createProviderCreditStore, getSharedOddsBatch, type ProviderCreditReservationInput } from "@dfs-ev/db/runtime";
import { withTestClient } from "./harness";
import { parseTestDatabaseUrl } from "./target.mts";

declare module "vitest" {
  interface ProvidedContext { credit222PoolPort?: number; credit222PoolSize?: number }
}

const keys = ["market-00", "market-01", "market-02"];
const periodEnd = "2099-01-01T00:00:00.000Z";
const roles = { runtime: "credit222_runtime", operator: "credit222_operator", owner: "credit222_owner" } as const;
const signatures = {
  reserve: "provider_credit.reserve(text,text,text,text,text,text,text[],integer,text)",
  reconcile: "provider_credit.reconcile(text,bigint,bigint,bigint,text)",
  health: "provider_credit.health(text)",
  initialize: "provider_credit.initialize(text,text,bigint,bigint,text,timestamptz,bigint,integer,text)",
  resolve: "provider_credit.resolve_unknown(text,text,text,jsonb)",
};

const withRole = async <T>(role: "runtime" | "operator", run: (store: ReturnType<typeof createProviderCreditStore>, sql: string[], client: Client) => Promise<T>) => {
  const base = parseTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  // Only the two locally created test roles on the guarded disposable target.
  const poolPort = inject("credit222PoolPort");
  if (poolPort !== undefined && (!Number.isInteger(poolPort) || poolPort < 1024 || poolPort > 65535)) {
    throw new Error("Invalid local credit-test pool port");
  }
  // PgBouncer does not accept the direct fixture's statement_timeout startup
  // parameter. The isolated roles have server defaults before any pool backend
  // opens; production getSql/driver configuration is deliberately untouched.
  const client = new Client({ ...base, port: poolPort ?? base.port, user: roles[role],
    statement_timeout: poolPort === undefined ? base.statement_timeout : undefined });
  const sql: string[] = [];
  await client.connect();
  try {
    const store = createProviderCreditStore(async (text, params) => {
      sql.push(text); return (await client.query(text, params)).rows;
    });
    return await run(store, sql, client);
  } finally { await client.end(); }
};
const input = (id = "attempt-0", extra: Partial<ProviderCreditReservationInput> = {}): ProviderCreditReservationInput => ({
  id, mode: "enforce", kind: "raw", resourceId: "event-0", ownerId: "owner-0",
  sportKey: "americanfootball_nfl", marketKeys: keys, expectedCost: 3, period: "period-one", ...extra,
});
const initialize = (remaining = 1000, extra: Partial<Parameters<ReturnType<typeof createProviderCreditStore>["initialize"]>[0]> = {}) =>
  withRole("operator", store => store.initialize({
    operationId: "init-one", actor: "test-operator", remaining, used: 1000 - remaining,
    period: "period-one", periodEndsAt: periodEnd, collectorFloor: 100, quotaFreshnessMs: 300_000,
    evidenceReference: "synthetic-observation", ...extra,
  }));
const evidence = { kind: "covered-terminal-send" as const, reference: "synthetic-terminal-cover", sendCannotResume: true as const, period: "period-one" };
const invariant = () => withTestClient(async client => {
  const { rows: [row] } = await client.query(`SELECT pending_liability,pending_count,
    (SELECT coalesce(sum(liability),0) FROM provider_credit.attempts WHERE admitted AND NOT settled) AS expected,
    (SELECT count(*) FROM provider_credit.attempts WHERE admitted AND NOT settled) AS expected_count
    FROM provider_credit.account`);
  expect(row.pending_liability).toBe(row.expected);
  expect(row.pending_count).toBe(row.expected_count);
});

let sharedProposalApplied = false;
let creditProposalApplied = false;
let rolesApplied = false;
beforeAll(async () => {
  await withTestClient(async client => {
    await client.query(await readFile(new URL("../../proposals/221_shared_odds_cache.sql", import.meta.url), "utf8"));
    sharedProposalApplied = true;
    await client.query(await readFile(new URL("../../proposals/222_provider_credit_reservations.sql", import.meta.url), "utf8"));
    creditProposalApplied = true;
    // Public disposable passwords only; these roles never exist on a hosted DB.
    await client.query(`CREATE ROLE credit222_runtime LOGIN PASSWORD 'dfs_ev_test';
      CREATE ROLE credit222_operator LOGIN PASSWORD 'dfs_ev_test'; CREATE ROLE credit222_owner NOLOGIN;
      GRANT USAGE,CREATE ON SCHEMA provider_credit TO credit222_owner;
      GRANT USAGE ON SCHEMA public TO credit222_owner;
      GRANT ALL ON ALL TABLES IN SCHEMA provider_credit TO credit222_owner;
      GRANT SELECT ON public.event_market_odds_cache,public.odds_collection_checkpoints TO credit222_owner;
      GRANT USAGE ON SCHEMA provider_credit TO credit222_runtime,credit222_operator;
      ALTER ROLE credit222_runtime SET statement_timeout='5s';
      ALTER ROLE credit222_runtime SET lock_timeout='2s';
      ALTER ROLE credit222_runtime SET idle_in_transaction_session_timeout='5s';
      ALTER ROLE credit222_operator SET statement_timeout='5s';
      ALTER ROLE credit222_operator SET lock_timeout='2s';
      ALTER ROLE credit222_operator SET idle_in_transaction_session_timeout='5s';`);
    rolesApplied = true;
    for (const signature of Object.values(signatures)) {
      await client.query(`ALTER FUNCTION ${signature} OWNER TO credit222_owner`);
    }
    for (const key of ["reserve", "reconcile", "health"] as const) {
      await client.query(`GRANT EXECUTE ON FUNCTION ${signatures[key]} TO credit222_runtime`);
    }
    for (const key of ["initialize", "resolve"] as const) {
      await client.query(`GRANT EXECUTE ON FUNCTION ${signatures[key]} TO credit222_operator`);
    }
  });
});
beforeEach(() => withTestClient(async client => {
  await client.query(`TRUNCATE provider_credit.attempts,provider_credit.operations,provider_credit.account;
    INSERT INTO provider_credit.account(id) VALUES(1);
    TRUNCATE public.event_market_odds_cache;
    DELETE FROM public.odds_collection_checkpoints WHERE id LIKE 'credit222-%';
    INSERT INTO public.event_market_odds_cache(event_id,market_key,payload,fetched_at,refresh_owner,refresh_lease_until,refresh_claimed_at)
      SELECT 'event-'||e,'market-'||lpad(m::text,2,'0'),'{}'::jsonb,'epoch','owner-'||e,
        clock_timestamp()+interval '30 seconds',clock_timestamp()
      FROM generate_series(0,19)e CROSS JOIN generate_series(0,11)m;
    INSERT INTO public.odds_collection_checkpoints(id,kind,collection_profile,sport_key,event_id,
      home_team,away_team,event_start_time,market_keys,checkpoint_key,due_at,due_window_end,
      priority_rank,status,claim_owner,claim_expires_at,schedule_reason)
    VALUES('credit222-checkpoint','baseline','paid-baseline','americanfootball_nfl','event-0',
      'HOME','AWAY',clock_timestamp()+interval '1 day',ARRAY['market-02','market-00','market-01','market-00'],
      'synthetic',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour',
      1,'claimed','collector-owner',clock_timestamp()+interval '30 seconds','synthetic');`);
}));
afterAll(() => withTestClient(async client => {
  if (creditProposalApplied) await client.query("DROP SCHEMA provider_credit CASCADE");
  if (rolesApplied) await client.query(`DROP OWNED BY credit222_runtime,credit222_operator,credit222_owner;
    DROP ROLE credit222_runtime,credit222_operator,credit222_owner;`);
  await client.query("DELETE FROM public.odds_collection_checkpoints WHERE id LIKE 'credit222-%'");
  if (sharedProposalApplied) await client.query(`
    DROP FUNCTION public.claim_shared_odds_batch(text,text[],text,integer,integer);
    DROP FUNCTION public.renew_shared_odds_batch(text,text[],text,integer);
    DROP FUNCTION public.publish_shared_odds_batch(text,text[],text,jsonb);
    DROP FUNCTION public.release_shared_odds_batch(text,text[],text);
    ALTER TABLE public.event_market_odds_cache DROP COLUMN refresh_owner,
      DROP COLUMN refresh_lease_until,DROP COLUMN refresh_claimed_at;`);
}));

describe("#222 provider-neutral credit authority on real cache/checkpoint tables", () => {
  it("fixture backend defaults and transaction-local function state are isolated", async () => {
    const poolSize = inject("credit222PoolSize");
    const expectedBackends = poolSize ?? 20;
    let entered = 0;
    let release: () => void = () => undefined;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const backends = await Promise.all(Array.from({ length: 20 }, () => withRole("runtime", async (_store, _sql, client) => {
      // Diagnostic-only control phase, separate from reservation SQL budgets.
      await client.query("BEGIN");
      try {
        entered++;
        if (entered >= expectedBackends) release();
        await barrier;
      const result = await client.query(`SELECT pg_backend_pid()::int pid, current_setting('statement_timeout') statement_timeout,
        current_setting('lock_timeout') lock_timeout,current_setting('idle_in_transaction_session_timeout') idle_timeout`);
      expect(result.rows[0].statement_timeout).toBe(poolSize === undefined ? "15s" : "5s");
      expect(result.rows[0].lock_timeout).toBe("2s"); expect(result.rows[0].idle_timeout).toBe("5s");
      return result.rows[0].pid;
      } finally { await client.query("ROLLBACK"); }
    })));
    expect(new Set(backends).size).toBe(expectedBackends);
    await withRole("runtime", async (store, _sql, client) => {
      const before = (await client.query("SHOW search_path")).rows[0].search_path;
      await store.health("period-one");
      expect((await client.query("SHOW search_path")).rows[0].search_path).toBe(before);
    });
  });

  it("starts uninitialized with typed null availability and no inferred period", async () => {
    await withRole("runtime", async (store, sql) => {
      expect(await store.health("period-one")).toMatchObject({ initialized: false, period: null,
        availableCredits: null, unresolvedLiabilityTotal: 0, unresolvedLiabilityCount: 0, reason: "uninitialized" });
      expect(await store.reserve(input())).toMatchObject({ allowed: false, outcome: "denied", reason: "uninitialized" });
      expect(sql).toHaveLength(2);
    });
    expect((await withTestClient(c => c.query("SELECT count(*)::int n FROM provider_credit.attempts"))).rows[0].n).toBe(1);
  });

  it("twenty eligible leaders use twenty statements, preserve one audit each and reserve 240 credits", async () => {
    await initialize();
    let calls = 0;
    const decisions = await Promise.all(Array.from({ length: 20 }, (_, i) => withRole("runtime", async (store, sql) => {
      const result = await store.reserve(input(`attempt-${i}`, { resourceId: `event-${i}`, ownerId: `owner-${i}`,
        marketKeys: Array.from({ length: 12 }, (_, n) => `market-${n.toString().padStart(2, "0")}`), expectedCost: 12 }));
      calls += sql.length; return result;
    })));
    expect(decisions.every(d => d.allowed)).toBe(true); expect(calls).toBe(20);
    await withRole("runtime", async store => expect(await store.health("period-one")).toMatchObject({
      availableCredits: 760, unresolvedLiabilityTotal: 240, unresolvedLiabilityCount: 20,
    }));
    expect((await withTestClient(c => c.query("SELECT count(*)::int n FROM provider_credit.attempts"))).rows[0].n).toBe(20);
    await invariant();
  });

  it("interactive work stops at the collector floor; collector cost comes from canonical checkpoint markets", async () => {
    await initialize(106);
    await withRole("runtime", async store => {
      expect((await store.reserve(input())).allowed).toBe(true);
      expect((await store.reserve(input("attempt-1"))).allowed).toBe(true);
      expect(await store.reserve(input("denied"))).toMatchObject({ allowed: false, reason: "insufficient-credit" });
      expect(await store.reserve(input("bad-collector", { kind: "collector", resourceId: "credit222-checkpoint",
        ownerId: "collector-owner", expectedCost: 1 }))).toMatchObject({ allowed: false, reason: "cost-mismatch", cost: 3 });
      expect(await store.reserve(input("collector", { kind: "collector", resourceId: "credit222-checkpoint",
        ownerId: "collector-owner" }))).toMatchObject({ allowed: true, cost: 3 });
      expect(await store.health("period-one")).toMatchObject({ availableCredits: 97, unresolvedLiabilityTotal: 9, unresolvedLiabilityCount: 3 });
    });
    await invariant();
  });

  it("mixed concurrent collector and interactive reservations cannot overspend or cross their class floor", async () => {
    await initialize(30, { collectorFloor: 10 });
    const decisions = await Promise.all(Array.from({ length: 40 }, (_, i) => withRole("runtime", async store => {
      const collector = i % 2 === 1;
      const decision = await store.reserve(input(`mixed-${i}`, collector ? {
        kind: "collector", resourceId: "credit222-checkpoint", ownerId: "collector-owner",
      } : { resourceId: `event-${i % 20}`, ownerId: `owner-${i % 20}` }));
      if (decision.allowed) expect(decision.availableCredits! - decision.cost).toBeGreaterThanOrEqual(collector ? 0 : 10);
      return decision;
    })));
    expect(decisions.filter(d => d.allowed).length).toBeLessThanOrEqual(10);
    await withRole("runtime", async store => expect((await store.health("period-one")).availableCredits).toBeGreaterThanOrEqual(0));
    await invariant();
  });

  it("lost committed reservation reply leaves one liability and retry returns no authority", async () => {
    await initialize();
    await withRole("runtime", async (store, _sql, client) => {
      const lost = createProviderCreditStore(async (text, params) => {
        await client.query(text, params); throw new Error("synthetic lost reply");
      });
      await expect(lost.reserve(input())).rejects.toThrow("authority unavailable");
      expect(await store.reserve(input())).toMatchObject({ outcome: "replay", allowed: false });
      expect(await store.health("period-one")).toMatchObject({ unresolvedLiabilityTotal: 3, unresolvedLiabilityCount: 1 });
    });
    await invariant();
  });

  it("a collector request cannot substitute an equally sized market set", async () => {
    await initialize();
    await withRole("runtime", async store => {
      expect(await store.reserve(input("collector", { kind: "collector", resourceId: "credit222-checkpoint",
        ownerId: "collector-owner", marketKeys: ["market-00", "market-01", "market-03"] }))).toMatchObject({ allowed: false, reason: "cost-mismatch" });
      expect(await store.health("period-one")).toMatchObject({ unresolvedLiabilityTotal: 0, unresolvedLiabilityCount: 0 });
    });
  });

  it("twenty same-ID retries reserve once; conflicting identity refuses without another audit", async () => {
    await initialize();
    const results = await Promise.all(Array.from({ length: 20 }, () => withRole("runtime", store => store.reserve(input()))));
    expect(results.filter(d => d.allowed)).toHaveLength(1);
    expect(results.filter(d => d.outcome === "replay")).toHaveLength(19);
    await withRole("runtime", async store => {
      await expect(store.reserve(input("attempt-0", { expectedCost: 1 }))).rejects.toThrow("authority unavailable");
      expect(await store.health("period-one")).toMatchObject({ unresolvedLiabilityTotal: 3, unresolvedLiabilityCount: 1 });
    });
    expect((await withTestClient(c => c.query("SELECT count(*)::int n FROM provider_credit.attempts"))).rows[0].n).toBe(1);
  });

  it("owner reads do not wait on a resource row lock", async () => {
    await initialize();
    await withTestClient(async holder => {
      await holder.query("BEGIN");
      try {
        await holder.query("SELECT * FROM public.event_market_odds_cache WHERE event_id='event-0' AND market_key='market-00' FOR UPDATE");
        await withRole("runtime", async store => expect((await store.reserve(input())).allowed).toBe(true));
      } finally { await holder.query("ROLLBACK"); }
    });
  });

  it("rechecks one replaced market owner after waiting for the account row", async () => {
    await initialize();
    await withTestClient(async holder => {
      await holder.query("BEGIN"); await holder.query("SELECT * FROM provider_credit.account FOR UPDATE");
      let pending: Promise<unknown> | undefined;
      try {
        await withRole("runtime", async store => {
          pending = store.reserve(input());
          let observed = false;
          for (let i = 0; i < 100; i++) {
            const r = await holder.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='credit222_runtime' AND wait_event_type='Lock'");
            if (r.rows[0].n > 0) { observed = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(observed).toBe(true);
          await holder.query("UPDATE public.event_market_odds_cache SET refresh_owner='successor' WHERE event_id='event-0' AND market_key='market-00'");
          await holder.query("COMMIT");
          expect(await pending).toMatchObject({ allowed: false, reason: "owner-expired" });
        });
      } finally { await holder.query("ROLLBACK"); await pending?.catch(() => undefined); }
    });
  });

  it("rolls back both debit and audit if audit insertion fails", async () => {
    await initialize();
    await withTestClient(c => c.query(`CREATE FUNCTION public.credit222_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected audit failure'; END $$;
      CREATE TRIGGER credit222_reject BEFORE INSERT ON provider_credit.attempts FOR EACH ROW EXECUTE FUNCTION public.credit222_reject_audit();`));
    try {
      await withRole("runtime", async store => {
        await expect(store.reserve(input())).rejects.toThrow("authority unavailable");
        expect(await store.health("period-one")).toMatchObject({ availableCredits: 1000, unresolvedLiabilityTotal: 0, unresolvedLiabilityCount: 0 });
      });
    } finally { await withTestClient(c => c.query("DROP TRIGGER credit222_reject ON provider_credit.attempts; DROP FUNCTION public.credit222_reject_audit()")); }
  });

  it("carries stranded old-period liability into a new operator-initialized period and resolves exactly once", async () => {
    await initialize();
    await withRole("runtime", async store => { await store.reserve(input()); });
    await withTestClient(c => c.query("UPDATE provider_credit.attempts SET reserved_at=clock_timestamp()-interval '1 day'"));
    expect(await initialize(500, { operationId: "init-two", period: "period-two", remaining: 500, used: 0 })).toMatchObject({ outcome: "initialized" });
    await withRole("runtime", async store => expect(await store.health("period-two")).toMatchObject({
      availableCredits: 497, unresolvedLiabilityTotal: 3, unresolvedLiabilityCount: 1,
    }));
    expect((await withTestClient(c => c.query("SELECT original_period FROM provider_credit.attempts"))).rows[0].original_period).toBe("period-one");
    await withRole("operator", async store => {
      const args = { operationId: "resolve-old", actor: "operator", attemptId: "attempt-0", evidence };
      expect(await store.resolveUnknown(args)).toMatchObject({ outcome: "resolved" });
      expect(await store.resolveUnknown(args)).toMatchObject({ outcome: "replay" });
    });
    await withRole("runtime", async store => expect(await store.health("period-two")).toMatchObject({
      availableCredits: 500, unresolvedLiabilityTotal: 0, unresolvedLiabilityCount: 0,
    }));
    await invariant();
  });

  it("old-period response cannot overwrite new quota or refund carried liability; mismatch health is critical", async () => {
    await initialize(); await withRole("runtime", store => store.reserve(input()));
    await initialize(500, { operationId: "init-two", period: "period-two", used: 0 });
    await withRole("runtime", async store => {
      expect(await store.reconcile({ id: "attempt-0", actualCost: 1, remaining: 999, used: 1, period: "period-one" }))
        .toMatchObject({ outcome: "unresolved", reason: "period-mismatch" });
      expect(await store.health("period-two")).toMatchObject({ reason: "period-mismatch", severity: "critical",
        availableCredits: 497, unresolvedLiabilityTotal: 3, unresolvedLiabilityCount: 1 });
    });
  });

  it("an ended period reports critical and refuses until explicit operator initialization", async () => {
    await initialize();
    await withTestClient(c => c.query("UPDATE provider_credit.account SET period_ends_at=clock_timestamp()-interval '1 second'"));
    await withRole("runtime", async store => {
      expect(await store.health("period-one")).toMatchObject({ reason: "period-mismatch", severity: "critical" });
      expect(await store.reserve(input())).toMatchObject({ allowed: false, reason: "period-mismatch" });
    });
    await initialize(500, { operationId: "init-two", period: "period-two", used: 0 });
    await withRole("runtime", async store => expect(await store.health("period-two")).toMatchObject({ reason: "ok", availableCredits: 500 }));
  });

  it("shuffled known responses reconcile once against the newest retained snapshot", async () => {
    await initialize();
    await withRole("runtime", async (store, sql) => {
      await store.reserve(input()); await store.reserve(input("attempt-1"));
      const before = sql.length;
      expect(await store.reconcile({ id: "attempt-1", actualCost: 1, remaining: 998, used: 2, period: "period-one" })).toMatchObject({ outcome: "settled" });
      expect(sql.length - before).toBe(1);
      const args = { id: "attempt-0", actualCost: 1, remaining: 999, used: 1, period: "period-one" };
      expect(await store.reconcile(args)).toMatchObject({ outcome: "settled" });
      expect(await store.reconcile(args)).toMatchObject({ outcome: "replay" });
      await expect(store.reconcile({ ...args, actualCost: 2 })).rejects.toThrow("authority unavailable");
      expect(await store.health("period-one")).toMatchObject({ availableCredits: 998, unresolvedLiabilityTotal: 0 });
    });
    await invariant();
  });

  it("missing response metadata and elapsed age retain worst-case liability", async () => {
    await initialize(); await withRole("runtime", store => store.reserve(input()));
    await withTestClient(c => c.query("UPDATE provider_credit.attempts SET reserved_at=clock_timestamp()-interval '1 day'"));
    await withRole("runtime", async store => {
      expect(await store.reconcile({ id: "attempt-0", actualCost: 1, remaining: null, used: null, period: "period-one" })).toMatchObject({ outcome: "unresolved" });
      expect(await store.health("period-one")).toMatchObject({ unresolvedLiabilityTotal: 3, unresolvedLiabilityCount: 1 });
    });
    await invariant();
  });

  it("least-privilege runtime cannot write tables or initialize/resolve, and operator cannot reserve", async () => {
    await withRole("runtime", async (store, _sql, client) => {
      await expect(client.query("UPDATE provider_credit.account SET pending_liability=0")).rejects.toThrow("permission denied");
      await expect(client.query("DELETE FROM provider_credit.attempts")).rejects.toThrow("permission denied");
      await expect(store.initialize({ operationId: "forged", actor: "runtime", remaining: 1000, used: 0,
        period: "period-one", periodEndsAt: periodEnd, collectorFloor: 100, quotaFreshnessMs: 300_000, evidenceReference: "fake" })).rejects.toThrow("authority unavailable");
      await expect(store.resolveUnknown({ operationId: "forged", actor: "runtime", attemptId: "attempt-0", evidence })).rejects.toThrow("authority unavailable");
    });
    await withRole("operator", async store => expect(store.reserve(input())).rejects.toThrow("authority unavailable"));
  });

  it("operator audit is immutable by operation identity; headers alone cannot resolve unknown debt", async () => {
    await initialize(); await withRole("runtime", store => store.reserve(input()));
    await withRole("operator", async store => {
      await expect(store.resolveUnknown({ operationId: "bad", actor: "operator", attemptId: "attempt-0",
        evidence: { ...evidence, kind: "quota-headers" } as unknown as typeof evidence })).rejects.toThrow("authority unavailable");
      const args = { operationId: "resolve", actor: "operator", attemptId: "attempt-0", evidence };
      await store.resolveUnknown(args);
      await expect(store.resolveUnknown({ ...args, evidence: { ...evidence, reference: "changed" } })).rejects.toThrow("authority unavailable");
    });
    await invariant();
  });

  it("operator initialization replays without changing carried liability and rejects changed identity", async () => {
    await initialize(); await withRole("runtime", store => store.reserve(input()));
    expect(await initialize()).toMatchObject({ outcome: "replay" });
    await expect(initialize(999)).rejects.toThrow("authority unavailable");
    await withRole("runtime", async store => expect(await store.health("period-one")).toMatchObject({
      availableCredits: 997, unresolvedLiabilityTotal: 3, unresolvedLiabilityCount: 1,
    }));
    const rows = await withTestClient(c => c.query("SELECT count(*)::int n FROM provider_credit.operations"));
    expect(rows.rows[0].n).toBe(1);
  });

  it("10000 settled audit rows do not add a reservation round trip or history scan", async () => {
    await initialize(); await withRole("runtime", store => store.reserve(input()));
    await withTestClient(c => c.query(`INSERT INTO provider_credit.attempts(id,mode,kind,resource_id,owner_id,sport_key,market_keys,
      expected_cost,derived_cost,original_period,admitted,decision_reason,liability,settled,decision,settled_at,settlement_kind)
      SELECT 'historical-'||n,mode,kind,resource_id,owner_id,sport_key,market_keys,
        expected_cost,derived_cost,original_period,true,decision_reason,0,true,decision,clock_timestamp(),'response'
      FROM provider_credit.attempts CROSS JOIN generate_series(1,10000)n WHERE id='attempt-0'`));
    await withRole("runtime", async (store, sql) => {
      expect((await store.reserve(input("new-attempt"))).allowed).toBe(true);
      expect(sql).toHaveLength(1);
    });
    const plan = await withTestClient(c => c.query("EXPLAIN (FORMAT JSON) SELECT * FROM provider_credit.attempts WHERE id='new-attempt'"));
    expect(JSON.stringify(plan.rows[0])).toContain("Index Scan");
    await invariant();
  });

  it("log-only remains usable before initialization without mutating authoritative liability", async () => {
    await withRole("runtime", async store => {
      expect(await store.reserve(input("shadow", { mode: "log-only" }))).toMatchObject({ outcome: "shadow", allowed: false, reason: "uninitialized" });
      expect(await store.reserve(input("shadow", { mode: "log-only" }))).toMatchObject({ outcome: "replay", allowed: false });
    });
    await initialize(); await withRole("runtime", store => store.reserve(input()));
    await withRole("runtime", async store => {
      expect(await store.reserve(input("rollback-shadow", { mode: "log-only" }))).toMatchObject({ outcome: "shadow", allowed: false });
      expect(await store.health("period-one")).toMatchObject({ unresolvedLiabilityTotal: 3, unresolvedLiabilityCount: 1 });
    });
  });

  it("current-schema shadow reservation does not need #221 lease columns", async () => {
    await withTestClient(c => c.query(`ALTER TABLE public.event_market_odds_cache DROP COLUMN refresh_owner,
      DROP COLUMN refresh_lease_until,DROP COLUMN refresh_claimed_at`));
    try {
      await withRole("runtime", async store => {
        expect(await store.reserve(input("legacy-shadow", { mode: "log-only" }))).toMatchObject({
          outcome: "shadow", allowed: false, reason: "uninitialized",
        });
        expect(await store.health("period-one")).toMatchObject({ initialized: false, unresolvedLiabilityTotal: 0 });
      });
    } finally {
      await withTestClient(c => c.query(`ALTER TABLE public.event_market_odds_cache ADD COLUMN refresh_owner text,
        ADD COLUMN refresh_lease_until timestamptz,ADD COLUMN refresh_claimed_at timestamptz`));
    }
  });

  it("denied audit stays counted once; #221 cooldown followers add zero reservation/audit work", async () => {
    await initialize(100);
    await withTestClient(c => c.query("UPDATE public.event_market_odds_cache SET refresh_owner=NULL,refresh_lease_until=NULL,refresh_claimed_at=NULL"));
    let reservations = 0;
    const callback = () => withTestClient(async client => getSharedOddsBatch("event-0", keys, {
      query: async (text, params) => (await client.query(text, params)).rows,
      makeOwnerId: () => "denied-owner", monotonicNow: () => performance.now(), wait: ms => new Promise(r => setTimeout(r, ms)),
      fetch: async () => {
        reservations++;
        await withRole("runtime", async store => expect(await store.reserve(input("denied", { ownerId: "denied-owner" }))).toMatchObject({ reason: "insufficient-credit", allowed: false }));
        throw new Error("typed budget denial");
      },
    }, { ttlMs: 90_000 }));
    await expect(callback()).rejects.toThrow("typed budget denial");
    const result = await callback();
    expect(Object.values(result).every(r => r.state === "unavailable")).toBe(true);
    expect(reservations).toBe(1);
    await withRole("runtime", async store => expect(await store.reserve(input("denied", { ownerId: "denied-owner" }))).toMatchObject({ outcome: "replay" }));
    const audit = await withTestClient(c => c.query("SELECT count(*)::int n FROM provider_credit.attempts WHERE NOT admitted"));
    expect(audit.rows[0].n).toBe(1);
    // A new eligible attempt after the DB-recorded floor gets one more audit.
    await withTestClient(c => c.query("UPDATE public.event_market_odds_cache SET refresh_claimed_at=clock_timestamp()-interval '21 seconds'"));
    const claim = await withTestClient(c => c.query("SELECT * FROM public.claim_shared_odds_batch($1,$2,$3,$4,$5)", ["event-0", keys, "new-owner", 90_000, 30_000]));
    expect(claim.rows[0].outcome).toBe("leader");
    await withRole("runtime", async store => expect(await store.reserve(input("denied-two", { ownerId: "new-owner" }))).toMatchObject({ allowed: false }));
    expect((await withTestClient(c => c.query("SELECT count(*)::int n FROM provider_credit.attempts"))).rows[0].n).toBe(2);
    await invariant();
  });
});
