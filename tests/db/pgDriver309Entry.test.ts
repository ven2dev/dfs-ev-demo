import { readFile } from "node:fs/promises";
import { inspect } from "node:util";
import { Pool, type PoolConfig, type QueryConfig } from "pg";
import { neon, neonConfig } from "@neondatabase/serverless";
import { expect, it, vi } from "vitest";
import { withMigratedDatabase, type ScratchConfig } from "@dfs-ev/db-tooling/test-support/migrated";
import type { createPgSqlOwner } from "../../apps/web/src/lib/pgPool.server";

const binding = vi.hoisted(() => ({
  createPool: undefined as ((config: PoolConfig) => Pool) | undefined,
  owners: [] as ReturnType<typeof createPgSqlOwner>[], weather: vi.fn(), sdk: vi.fn(),
}));
// Keep db.ts, its actual owner, configuration policy, adapter and pg transport.
// Only replace the socket destination with the harness-verified local fixture.
vi.mock("../../apps/web/src/lib/pgPool.server", async original => {
  const actual = await original<typeof import("../../apps/web/src/lib/pgPool.server")>();
  return { ...actual, createPgSqlOwner: (options: Parameters<typeof createPgSqlOwner>[0]) => {
    const owner = actual.createPgSqlOwner({ ...options, createPool: config => {
      if (!binding.createPool) throw new Error("Local entry transport is not bound.");
      return binding.createPool(config);
    } });
    binding.owners.push(owner);
    return owner;
  } };
});
vi.mock("../../apps/web/src/lib/weather", () => ({ fetchGameWeather: binding.weather }));
vi.mock("../../apps/web/src/lib/firebaseAdmin", () => ({ getAdminAuth: binding.sdk }));

const sport = "americanfootball_nfl", event = "synthetic-entry-309", market = "player_pass_yds";
const context = { startTime: "2030-01-01T00:00:00Z", homeTeam: "Synthetic home", awayTeam: "Synthetic away", venueLat: 0, venueLon: 0 };
const providerEvent = (bookmakers: unknown[] = []) => ({ id: event, sport_key: sport,
  commence_time: context.startTime, home_team: context.homeTeam, away_team: context.awayTeam, bookmakers });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json", "x-requests-remaining": "10000", "x-requests-used": "1", "x-requests-last": "1" },
});

function transport(target: ScratchConfig) {
  const trace: { text: string; values?: unknown[] }[] = [];
  const counts = { pools: 0, connections: 0, checkouts: 0, releases: 0, discards: 0 };
  const pools: Pool[] = [];
  binding.createPool = config => {
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.max).toBe(2);
    expect(config).not.toHaveProperty("connectionString");
    // Plaintext loopback is a test-only factory injection, never URL policy or
    // a runtime TEST_DATABASE_URL fallback. The harness validates this target.
    const pool = new Pool({ ...config, host: target.host, port: target.port, user: target.user,
      password: target.password, database: target.database, ssl: false });
    pools.push(pool); counts.pools++;
    pool.on("connect", client => {
      counts.connections++;
      const query = client.query.bind(client);
      client.query = ((input: QueryConfig) => {
        trace.push({ text: input.text, values: input.values });
        return query(input);
      }) as typeof client.query;
    });
    pool.on("acquire", () => counts.checkouts++);
    pool.on("release", error => { counts.releases++; if (error) counts.discards++; });
    return pool;
  };
  return { trace, counts, pools };
}

async function withEntry(run: (admin: import("pg").Client, t: ReturnType<typeof transport>) => Promise<void>, proposals = false) {
  await withMigratedDatabase(process.env, async (admin, target) => {
    target.assertTarget(target.expected);
    if (proposals) for (const file of ["221_shared_odds_cache.sql", "223_paid_leader_gcra.sql"]) {
      await admin.query(await readFile(new URL("../../packages/db/proposals/" + file, import.meta.url), "utf8"));
    }
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", "postgres://synthetic:synthetic-server-marker-309@database.invalid/synthetic?sslmode=require");
    vi.stubEnv("VERCEL_ENV", "production"); // Synthetic identity, no hosted command.
    vi.stubEnv("ODDS_DATA_SOURCE", "live");
    vi.stubEnv("ODDS_API_KEY", "synthetic-provider-marker-309");
    vi.stubEnv("ODDS_SUBJECT_HMAC_KEYS", JSON.stringify([{ version: "v1", keyHex: "11".repeat(32) }]));
    vi.stubEnv("ODDS_SUBJECT_POLICIES", JSON.stringify({ anonymousNetwork: { intervalMs: 1000, burst: 100 },
      signedNetwork: { intervalMs: 1000, burst: 100 }, user: { intervalMs: 1000, burst: 100 } }));
    binding.weather.mockReset().mockResolvedValue({ temperatureF: 60, windSpeedMph: 0, precipitationMm: 0 });
    binding.sdk.mockReset().mockImplementation(() => { throw new Error("Synthetic entry must not initialize an SDK."); });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unbound synthetic fetch refused."));
    const t = transport(target.expected);
    try {
      if (proposals) {
        const { initializeOddsCache } = await import("../../apps/web/src/lib/oddsCacheStartup");
        const { initializePaidOdds } = await import("../../apps/web/src/lib/paidOddsBoundary");
        expect(await initializeOddsCache()).toBe("shared");
        expect(await initializePaidOdds()).toBe("ready");
        expect(t.trace).toHaveLength(2); // Explicit startup work, outside warm counts.
        t.trace.length = 0;
      }
      await run(admin, t);
      expect(t.counts.checkouts).toBe(t.counts.releases);
      expect(binding.sdk).not.toHaveBeenCalled();
    } finally {
      await Promise.all(binding.owners.splice(0).map(owner => owner.end()));
      expect(t.pools.every(pool => pool.totalCount === 0)).toBe(true);
      binding.createPool = undefined;
      vi.unstubAllEnvs(); vi.restoreAllMocks();
    }
  });
}

it("pg309 entry preserves creator and readiness rows with one bounded lazy owner", async () => {
  await withEntry(async (_admin, t) => {
    const { getSql } = await import("../../apps/web/src/lib/db");
    expect(t.counts.pools).toBe(0);
    const { insertSubmission, listSubmissions } = await import("../../apps/web/src/lib/creatorSubmissionsRepo");
    const { getDatabaseReadinessSnapshot } = await import("../../apps/web/src/lib/dbReadinessRepo");
    expect(t.counts.pools).toBe(0);
    const inserted = await insertSubmission({ channelName: "Synthetic entry", videoUrl: "https://synthetic.invalid/entry", transcriptText: "synthetic" });
    // The actual schema uses bigint IDs. Both drivers keep these as strings;
    // the repository's existing number annotation does not coerce runtime data.
    const previousFetch = neonConfig.fetchFunction;
    neonConfig.fetchFunction = async () => response({ fields: [{ name: "id", dataTypeID: 20 }], rows: [[String(inserted.id)]] });
    try {
      const [old] = await neon("postgres://synthetic:synthetic@comparison.invalid/synthetic").query("SELECT synthetic");
      expect(inserted).toEqual({ status: "inserted", id: old.id });
      expect(typeof inserted.id).toBe("string");
    } finally { neonConfig.fetchFunction = previousFetch; }
    const listed = await listSubmissions();
    expect(JSON.parse(JSON.stringify(listed))).toEqual([{ id: inserted.id, channelName: "Synthetic entry", videoUrl: "https://synthetic.invalid/entry",
      videoTitle: null, submittedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) }]);
    expect(await getDatabaseReadinessSnapshot()).toMatchObject({ ledgerPresent: true, requiredTablesPresent: true });
    expect(getSql()).toBe(getSql());
    expect(t.counts).toEqual({ pools: 1, connections: 1, checkouts: 4, releases: 4, discards: 0 });
    expect(t.trace.filter(q => /^(BEGIN|COMMIT)/.test(q.text)).map(q => q.text)).toEqual([
      "BEGIN", "COMMIT", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT",
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT",
    ]);
    expect(t.trace).toHaveLength(16); // 4 creator + 1 list + 2/3 readiness + 6 controls.
  });
});

it("pg309 entry composed leader and fresh hit preserve SQL and attribution budgets", async () => {
  await withEntry(async (_admin, t) => {
    const { getSharedLivePropInputs } = await import("../../apps/web/src/lib/livePropCacheRepo");
    const { createPaidRefreshRequest, paidOddsHealth } = await import("../../apps/web/src/lib/paidOddsBoundary");
    const request = createPaidRefreshRequest({ headers: new Headers({ "x-vercel-forwarded-for": "203.0.113.7" }) } as import("next/server").NextRequest);
    const subject = vi.spyOn(request, "resolveSubject");
    let beforeSend = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      beforeSend = t.trace.length;
      return response(providerEvent([{ key: "synthetic", markets: [{ key: market, outcomes: [
        { name: "Over", description: "Synthetic player", point: 10, price: 2 },
        { name: "Under", description: "Synthetic player", point: 10, price: 2 },
      ] }] }]));
    });
    const key = { sportKey: sport, eventId: event, marketKey: market, playerName: "Synthetic player" };
    const first = await getSharedLivePropInputs(key, { ...context, paidRequest: request });
    expect(first.oddsByBookmaker).toEqual([{ bookmakerKey: "synthetic", point: 10, overPrice: 2, underPrice: 2 }]);
    expect(first.oddsObservation).toMatchObject({ origin: "upstream", status: "upstream", persisted: true });
    expect(beforeSend).toBe(5); // Four cache statements + one indexed admission.
    expect(t.trace.slice(0, 4).every(q => /live_prop_inputs_cache|event_market_odds_cache|claim_shared_odds_batch/.test(q.text))).toBe(true);
    expect(t.trace[4].text).toContain("admit_paid_odds");
    expect(t.trace).toHaveLength(9); // Six cache + admission + telemetry + history.
    expect(fetch).toHaveBeenCalledOnce(); expect(subject).toHaveBeenCalledOnce();
    expect(binding.weather).toHaveBeenCalledOnce(); expect(paidOddsHealth().mode).toBe("log-only");
    t.trace.length = 0;
    const hit = await getSharedLivePropInputs(key, { ...context, paidRequest: request });
    expect(JSON.parse(JSON.stringify(hit))).toEqual(JSON.parse(JSON.stringify(first)));
    expect(t.trace).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce(); expect(subject).toHaveBeenCalledOnce(); expect(binding.weather).toHaveBeenCalledOnce();
    expect(JSON.stringify(hit)).not.toMatch(/synthetic-server-marker|synthetic-provider-marker/);
    console.info("PG309_ENTRY_WORK " + JSON.stringify({ beforeSend: 5, cacheBeforeSend: 4, cacheTotal: 6, admission: 1, telemetry: 1, history: 1, freshHit: 1, subjectResolutions: 1 }));
  }, true);
});

it("pg309 entry failed key stays in cooldown while eleven other markets publish empty slices", async () => {
  await withEntry(async (admin, t) => {
    const { getSharedMarketOdds } = await import("../../apps/web/src/lib/sharedOddsRepo");
    const { PLAYER_PROP_MARKETS } = await import("../../apps/web/src/lib/playerPropMarkets");
    const { createPaidRefreshRequest } = await import("../../apps/web/src/lib/paidOddsBoundary");
    const request = createPaidRefreshRequest({ headers: new Headers({ "x-vercel-forwarded-for": "203.0.113.7" }) } as import("next/server").NextRequest);
    const keys = PLAYER_PROP_MARKETS.map(definition => definition.key), failed = keys[0];
    expect(keys).toHaveLength(12);
    vi.mocked(fetch).mockResolvedValueOnce(response({}, 503));
    await expect(getSharedMarketOdds(sport, event, [failed], { paidRequest: request })).rejects.toMatchObject({ status: 503 });
    vi.mocked(fetch).mockResolvedValueOnce(response(providerEvent()));
    t.trace.length = 0;
    const result = await getSharedMarketOdds(sport, event, keys, { paidRequest: request });
    expect(fetch).toHaveBeenCalledTimes(2); // One failure, then one batch of eleven.
    const sent = new URL(String(vi.mocked(fetch).mock.calls[1][0])).searchParams.get("markets")!.split(",");
    expect(sent.sort()).toEqual(keys.filter(key => key !== failed).sort());
    expect(result.origins[failed].status).toBe("unavailable");
    for (const key of keys.filter(key => key !== failed)) expect(result.origins[key].status).toBe("upstream");
    const stored = await admin.query("SELECT market_key,payload->'bookmakers' AS bookmakers,fetched_at>'epoch'::timestamptz AS published FROM event_market_odds_cache ORDER BY market_key");
    expect(stored.rows).toHaveLength(12);
    expect(stored.rows.filter(row => row.published)).toHaveLength(11);
    expect(stored.rows.filter(row => row.published).every(row => JSON.stringify(row.bookmakers) === "[]")).toBe(true);
    expect(t.trace.filter(q => q.text.includes("admit_paid_odds("))).toHaveLength(1);
  }, true);
});

it("pg309 entry publication failure is sanitized and cannot trigger a second paid send", async () => {
  await withEntry(async (admin, t) => {
    await admin.query(`CREATE FUNCTION public.synthetic_entry_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.fetched_at<>OLD.fetched_at THEN RAISE EXCEPTION 'synthetic-server-marker-309'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_entry_refuse BEFORE UPDATE ON event_market_odds_cache FOR EACH ROW EXECUTE FUNCTION public.synthetic_entry_refuse()`);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getSharedMarketOdds } = await import("../../apps/web/src/lib/sharedOddsRepo");
    const { createPaidRefreshRequest } = await import("../../apps/web/src/lib/paidOddsBoundary");
    const request = createPaidRefreshRequest({ headers: new Headers({ "x-vercel-forwarded-for": "203.0.113.7" }) } as import("next/server").NextRequest);
    vi.mocked(fetch).mockResolvedValue(response(providerEvent()));
    expect((await getSharedMarketOdds(sport, event, [market], { paidRequest: request })).origins[market].status).toBe("upstream");
    expect(log).toHaveBeenCalledWith("[sharedOddsRepo] failed to publish odds:", expect.objectContaining({ code: "P0001", message: "Application dependency unavailable." }));
    expect(inspect(log.mock.calls, { depth: 10 })).not.toMatch(/synthetic-server-marker|synthetic-provider-marker/);
    expect(t.counts.connections).toBe(1);
    expect(t.counts.discards).toBe(0);
    t.trace.length = 0;
    const again = await getSharedMarketOdds(sport, event, [market], { paidRequest: request });
    expect(again.origins[market].status).toBe("unavailable");
    expect(fetch).toHaveBeenCalledOnce();
    expect(t.trace.some(q => q.text.includes("admit_paid_odds("))).toBe(false);
    expect(t.counts.connections).toBe(1); // The post-refusal read reuses the healthy client.
    expect(t.counts.discards).toBe(0);
    expect((await admin.query("SELECT fetched_at='epoch'::timestamptz AS unpublished FROM event_market_odds_cache")).rows).toEqual([{ unpublished: true }]);
  }, true);
});
