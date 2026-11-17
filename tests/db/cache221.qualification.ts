import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertNoApplicationCredentials, parseTestDatabaseUrl } from "@dfs-ev/db-tooling/test-support/target";
import { PLAYER_PROP_MARKETS } from "../../apps/web/src/lib/playerPropMarkets";

const m = vi.hoisted(() => ({ query: vi.fn(), event: vi.fn(), legacy: vi.fn(), weather: vi.fn(), persist: vi.fn() }));
vi.mock("../../apps/web/src/lib/db", () => ({ getSql: () => ({ query: m.query }) }));
vi.mock("../../apps/web/src/lib/oddsApi", () => ({ fetchEventOdds: m.event, fetchPlayerPropMarketOdds: m.legacy }));
vi.mock("../../apps/web/src/lib/weather", () => ({ fetchGameWeather: m.weather }));
vi.mock("../../apps/web/src/lib/oddsSnapshotRepo", () => ({ persistOddsObservation: m.persist }));

type Sample = { start: number; sql: number; beforeSend?: number; elapsed?: number; client: number; connection?: PoolClient; queryMs?: number[] };
const samples = new AsyncLocalStorage<Sample>();
let admin: Client, pools: Pool[], proposal: string;
const context = { startTime: "2027-10-05T17:00:00Z", homeTeam: "Synthetic Home", awayTeam: "Synthetic Away", venueLat: 0, venueLon: 0 };
const player = "Synthetic Player 0", market = "player_pass_yds";
const rawData = (event: string, keys: string[], full = false) => ({
  id: event, sport_key: "americanfootball_nfl", commence_time: context.startTime,
  home_team: context.homeTeam, away_team: context.awayTeam,
  bookmakers: Array.from({ length: full ? 4 : 1 }, (_, b) => ({
    key: `synthetic-book-${b}`, markets: keys.map(key => ({ key, outcomes:
      Array.from({ length: full ? 32 : 1 }, (_, p) =>
        PLAYER_PROP_MARKETS.find(m => m.key === key)?.outcomeShape === "yes-only"
          ? [{ name: "Yes", description: `Synthetic Player ${p}`, price: 2.1 }]
          : [{ name: "Over", description: `Synthetic Player ${p}`, price: 1.91, point: 100 + p },
            { name: "Under", description: `Synthetic Player ${p}`, price: 1.95, point: 100 + p }]).flat(),
    })),
  })),
});
const quota = { remaining: null, used: null, last: null };
const capture = (event: string, keys: string[], full = false) => {
  const sample = samples.getStore();
  if (sample) { sample.beforeSend = sample.sql; sample.elapsed = performance.now() - sample.start; }
  return { data: rawData(event, keys, full), capturedAt: new Date().toISOString(), quota };
};
const dist = (values: number[]) => {
  const sorted = [...values].sort((a,b) => a-b);
  return { samples: sorted.length, p50Ms: sorted[Math.ceil(sorted.length*.5)-1],
    p95Ms: sorted[Math.ceil(sorted.length*.95)-1], maxMs: sorted.at(-1) };
};

beforeAll(async () => {
  assertNoApplicationCredentials(process.env);
  const config = parseTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DB_TEST_LANE);
  admin = new Client(config); await admin.connect();
  pools = [new Pool({ ...config, max: 20 }), new Pool({ ...config, max: 20 })];
  proposal = await readFile(new URL("../../packages/db/proposals/221_shared_odds_cache.sql", import.meta.url), "utf8");
  await admin.query(proposal);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  try {
    await admin.query(`DROP FUNCTION public.claim_shared_odds_batch(text,text[],text,integer,integer);
      DROP FUNCTION public.renew_shared_odds_batch(text,text[],text,integer);
      DROP FUNCTION public.publish_shared_odds_batch(text,text[],text,jsonb);
      DROP FUNCTION public.release_shared_odds_batch(text,text[],text);
      ALTER TABLE public.event_market_odds_cache DROP COLUMN refresh_owner,
        DROP COLUMN refresh_lease_until, DROP COLUMN refresh_claimed_at;`);
  } finally { await Promise.allSettled([admin.end(), ...pools.map(pool => pool.end())]); }
});

it("records interleaved final-application cache timing and the synthetic payload budget", async () => {
  const poolWarmup = [];
  for (const pool of pools) {
    const results = await Promise.all(Array.from({length:20}, () => pool.query("SELECT pg_backend_pid() AS pid,pg_sleep(0.01)")));
    const backends = new Set(results.map(result => result.rows[0].pid)).size;
    expect(backends).toBe(20); poolWarmup.push({ distinctBackends: backends });
  }
  const modes = new Map<string, (typeof import('../../apps/web/src/lib/livePropCacheRepo'))['getSharedLivePropInputs']>();
  for (const mode of ['legacy','shared']) {
    m.query.mockImplementation(async (text: string, params: unknown[]) => {
      if (text.includes('AS ready')) return [{ ready: mode === 'shared' }];
      const sample = samples.getStore();
      if (sample) sample.sql++;
      return (await (sample ? pools[sample.client] : admin).query(text, params)).rows;
    });
    // A schema result is injected only for baseline path selection. All measured
    // cache SQL below executes against the guarded, real PostgreSQL fixture.
    // The app URL is synthetic; the mocked driver above supplies the fixture connection.
    vi.stubEnv('DATABASE_URL','postgres://synthetic:synthetic@mocked-driver.invalid/synthetic');
    // Reset after stubbing so each mode receives fresh cached configuration.
    vi.resetModules();
    const { initializeOddsCache } = await import('../../apps/web/src/lib/oddsCacheStartup');
    expect(await initializeOddsCache()).toBe(mode);
    modes.set(mode,(await import('../../apps/web/src/lib/livePropCacheRepo')).getSharedLivePropInputs);
  }
  // Both loaded function closures use this stable driver and distinct latched modes.
  m.query.mockImplementation(async (text: string, params: unknown[]) => {
    const sample = samples.getStore(); if (sample) sample.sql++;
    const started = performance.now();
    const result = await (sample?.connection ?? (sample ? pools[sample.client] : admin)).query(text, params);
    sample?.queryMs?.push(performance.now() - started);
    return result.rows;
  });
  m.weather.mockResolvedValue({ temperatureF: 62, windSpeedMph: 8, precipitationMm: 0 });
  m.persist.mockResolvedValue({ inserted: true });
  m.event.mockImplementation(async (_sport, event, keys) => capture(event, keys));
  m.legacy.mockImplementation(async (_sport, event, key) => {
    const fetched = capture(event,[key]);
    return { ...fetched, data: { response: fetched.data,
      oddsByBookmaker: [{ bookmakerKey:'synthetic-book-0',point:100,overPrice:1.91,underPrice:1.95 }] } };
  });
  // Warm each backend's actual statement/function path, not just its socket.
  const applicationWarmup = [];
  for (let poolIndex=0;poolIndex<pools.length;poolIndex++) {
    const clients = await Promise.all(Array.from({length:20}, () => pools[poolIndex].connect()));
    try {
      for (const mode of ['legacy','shared']) {
        await Promise.all(clients.map(async (connection,index) => {
          const sample: Sample = {start:performance.now(),sql:0,client:poolIndex,connection};
          await samples.run(sample, () => modes.get(mode)!({sportKey:'americanfootball_nfl',
            eventId:`warm_${poolIndex}_${mode}_${index}`,marketKey:market,playerName:player},context));
          expect(sample.beforeSend).toBe(mode==='shared'?4:2);
        }));
        applicationWarmup.push({pool:poolIndex,mode,backends:clients.length});
      }
    } finally { clients.forEach(client=>client.release()); }
  }
  const trials = [];
  for (const workers of [1,20]) for (let round=0;round<3;round++) {
    for (const mode of round%2 ? ['shared','legacy'] : ['legacy','shared']) {
      const results: Sample[] = [];
      for (let offset=0;offset<100;offset+=workers) {
        await admin.query('TRUNCATE public.event_market_odds_cache,public.live_prop_inputs_cache');
        await Promise.all(Array.from({length:workers}, async (_,i) => {
          const sample: Sample = { start:performance.now(),sql:0,client:i%2,queryMs:[] };
          await samples.run(sample, () => modes.get(mode)!({sportKey:'americanfootball_nfl',eventId:`event${i}`,marketKey:market,playerName:player},context));
          results.push(sample);
        }));
      }
      expect(results).toHaveLength(100);
      expect(results.every(sample => sample.beforeSend === (mode==='shared'?4:2) && sample.sql === (mode==='shared'?6:3))).toBe(true);
      trials.push({mode,workers,round,preProvider:dist(results.map(result=>result.elapsed!)),
        queryTimeBeforeProvider:dist(results.map(result=>result.queryMs!.slice(0,result.beforeSend).reduce((sum,time)=>sum+time,0))),
        sqlBeforeSend:mode==='shared'?4:2,totalCacheSql:mode==='shared'?6:3,successfulLeaders:results.length});
    }
  }
  await admin.query('TRUNCATE public.event_market_odds_cache,public.live_prop_inputs_cache');
  m.event.mockImplementation(async (_sport,event,keys) => capture(event,keys,true));
  m.weather.mockClear();m.event.mockClear();
  const { getOrFetchMarketOdds } = await import('../../apps/web/src/lib/oddsCacheRepo');
  const keys=PLAYER_PROP_MARKETS.map(market=>market.key);
  for(let event=0;event<20;event++) await getOrFetchMarketOdds('americanfootball_nfl',`fixture${event}`,keys);
  expect(m.event).toHaveBeenCalledTimes(20);expect(m.weather).not.toHaveBeenCalled();
  const stored=(await admin.query('SELECT payload FROM public.event_market_odds_cache')).rows;
  const logicalBytes=stored.reduce((sum,row)=>sum+Buffer.byteLength(JSON.stringify(row.payload)),0);
  expect(stored).toHaveLength(240);expect(logicalBytes).toBeLessThanOrEqual(8*1024*1024);
  const physical=(await admin.query(`SELECT pg_relation_size('public.event_market_odds_cache') AS heap_bytes,
    pg_indexes_size('public.event_market_odds_cache') AS index_bytes,
    pg_total_relation_size('public.event_market_odds_cache') AS total_bytes`)).rows[0];
  const at=new Date().toISOString();
  const sourcePaths=['packages/db/src/sharedOddsCache.ts','packages/db/src/livePropRefresh.ts','packages/db/src/livePropCache.ts',
    'packages/db/proposals/221_shared_odds_cache.sql','apps/web/src/lib/livePropCacheRepo.ts','apps/web/src/lib/sharedOddsRepo.ts',
    'tests/db/cache221.qualification.ts','scripts/spikes/221-qualify-cache.mts','vitest.cache-221.config.mts'];
  const sources=await Promise.all(sourcePaths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})));
  const receipt={at,lane:process.env.DB_TEST_LANE,tier:'standard',parentSha:'bf3fe3257dba5d301dc1dd769b30da8d01ddf693',
    baseline:'legacy path on this branch, with current-schema compatibility separately verified; not a new hosted main baseline',
    measured:'actual live-view cache entry to mocked raw provider callback; excludes startup and admission',poolWarmup,applicationWarmup,trials,
    budget:{fullWarmPreProviderMs:90,fourCacheStatementsMs:10,admissionMs:53,headroomMs:27,
      cacheAllocationMetEvery20LeaderRound:trials.filter(trial=>trial.mode==='shared'&&trial.workers===20).every(trial=>trial.preProvider.p95Ms<=10),
      fullPathQualified:false},fixture:{events:20,markets:12,rows:stored.length,logicalPayloadBytes:logicalBytes,
      fixtureOnlyCeilingBytes:8*1024*1024,physical},sources,realProviderCalls:0,hostedActions:0};
  const path=`docs/evidence/cache-221/${at.replaceAll(':','-')}-final-local-qualification.json`;
  await writeFile(path,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({receipt:path,trials,budget:receipt.budget,fixture:receipt.fixture}));
  // Opt-in speed gate only: retain a failed receipt before returning failure.
  expect(receipt.budget.cacheAllocationMetEvery20LeaderRound,
    "20-leader cache allocation missed; inspect the retained receipt rather than relax the budget").toBe(true);
});
