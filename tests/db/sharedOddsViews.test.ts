import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { openTestClient, withTestClient } from "@dfs-ev/db-tooling/test-support/clients";

const m = vi.hoisted(() => ({ query: vi.fn(), event: vi.fn(), legacy: vi.fn(), weather: vi.fn(), persist: vi.fn() }));
vi.mock("../../apps/web/src/lib/db", () => ({ getSql: () => ({ query: m.query }) }));
vi.mock("../../apps/web/src/lib/oddsApi", () => ({ fetchEventOdds: m.event, fetchPlayerPropMarketOdds: m.legacy }));
vi.mock("../../apps/web/src/lib/weather", () => ({ fetchGameWeather: m.weather }));
vi.mock("../../apps/web/src/lib/oddsSnapshotRepo", () => ({ persistOddsObservation: m.persist }));

const key = { sportKey: "americanfootball_nfl", eventId: "event", marketKey: "player_pass_yds", playerName: "Player A" };
const context = { startTime: "2027-10-05T17:00:00Z", homeTeam: "Home", awayTeam: "Away", venueLat: 0, venueLon: 0 };
const bookmakers = [{ key: "book", markets: [{ key: key.marketKey, outcomes: [
  { name: "Over", description: key.playerName, point: 200, price: 1.9 },
  { name: "Under", description: key.playerName, point: 200, price: 1.8 },
] }] }];
let proposalSql: string;
let client: Awaited<ReturnType<typeof openTestClient>>;
beforeAll(async () => {
  proposalSql = await readFile(new URL('../../packages/db/proposals/221_shared_odds_cache.sql', import.meta.url), 'utf8');
  await withTestClient(c => c.query(proposalSql));
});
beforeEach(async () => {
  vi.resetModules();
  Object.values(m).forEach(mock => mock.mockReset());
  client = await openTestClient();
  await client.query('TRUNCATE public.event_market_odds_cache');
  m.query.mockImplementation(async (text, params) => (await client.query(text, params)).rows);
  m.weather.mockResolvedValue({ temperatureF: 62, windSpeedMph: 8, precipitationMm: 0 });
  m.persist.mockResolvedValue({ inserted: true });
  // The driver is mocked to the guarded fixture client; this is never a URL.
  vi.stubEnv('DATABASE_URL', 'configured-mocked-driver');
  const { initializeOddsCache } = await import('../../apps/web/src/lib/oddsCacheStartup');
  expect(await initializeOddsCache()).toBe('shared');
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => withTestClient(c => c.query(`
  DROP FUNCTION public.claim_shared_odds_batch(text,text[],text,integer,integer);
  DROP FUNCTION public.renew_shared_odds_batch(text,text[],text,integer);
  DROP FUNCTION public.publish_shared_odds_batch(text,text[],text,jsonb);
  DROP FUNCTION public.release_shared_odds_batch(text,text[],text);
  ALTER TABLE public.event_market_odds_cache DROP COLUMN refresh_owner,
    DROP COLUMN refresh_lease_until, DROP COLUMN refresh_claimed_at;
`)));

it('copies raw publication time into the actual outer view without restarting its TTL', async () => {
  const capturedAt = new Date().toISOString();
  await client.query(`INSERT INTO public.event_market_odds_cache(event_id,market_key,payload,fetched_at)
    VALUES($1,$2,$3,clock_timestamp()-interval '89 seconds')`, [key.eventId, key.marketKey, {
      bookmakers, observation: { id: 'original', capturedAt, persisted: true, quota: { remaining: 10, used: 1, last: 1 } },
    }]);
  const { getSharedLivePropInputs } = await import('../../apps/web/src/lib/livePropCacheRepo');
  const result = await getSharedLivePropInputs(key, context);
  expect(result.oddsObservation).toMatchObject({ origin: 'cache', observationId: 'original' });
  const times = await client.query(`SELECT v.fetched_at=r.fetched_at AS same,
    v.fetched_at<clock_timestamp()-interval '88 seconds' AS old
    FROM public.live_prop_inputs_cache v JOIN public.event_market_odds_cache r USING(event_id,market_key)`);
  expect(times.rows).toEqual([{ same: true, old: true }]);
  expect(m.event).not.toHaveBeenCalled();
  expect(m.weather).toHaveBeenCalledOnce();
  expect(m.persist).not.toHaveBeenCalled();
});

it('failed raw publication cannot create a fresh outer view or another paid send', async () => {
  await client.query(`CREATE FUNCTION public.reject_odds_publication() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.fetched_at<>OLD.fetched_at THEN RAISE EXCEPTION 'injected publication failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_odds_publication BEFORE UPDATE ON public.event_market_odds_cache
    FOR EACH ROW EXECUTE FUNCTION public.reject_odds_publication();`);
  m.event.mockResolvedValue({ data: { id: key.eventId, bookmakers, commence_time: context.startTime, home_team: 'Home', away_team: 'Away' },
    capturedAt: new Date().toISOString(), quota: { remaining: 10, used: 1, last: 1 } });
  const { getSharedLivePropInputs } = await import('../../apps/web/src/lib/livePropCacheRepo');
  try {
    expect((await getSharedLivePropInputs(key, context)).oddsByBookmaker[0].point).toBe(200);
    const row = await client.query("SELECT fetched_at='epoch'::timestamptz AS unpublished FROM public.live_prop_inputs_cache");
    expect(row.rows).toEqual([{ unpublished: true }]);
    await expect(getSharedLivePropInputs(key, context)).rejects.toThrow('unavailable during refresh cooldown');
    expect(m.event).toHaveBeenCalledOnce();
  } finally {
    await client.query('DROP TRIGGER reject_odds_publication ON public.event_market_odds_cache; DROP FUNCTION public.reject_odds_publication();');
  }
});


it.each(['live-cold','live-hit','discovery-cold','forced-cooldown','forced-stale','provider-failure'])(
  'actual current-schema routing preserves main behavior: %s', async kind => {
    await client.query(`DROP FUNCTION public.claim_shared_odds_batch(text,text[],text,integer,integer);
      DROP FUNCTION public.renew_shared_odds_batch(text,text[],text,integer);
      DROP FUNCTION public.publish_shared_odds_batch(text,text[],text,jsonb);
      DROP FUNCTION public.release_shared_odds_batch(text,text[],text);
      ALTER TABLE public.event_market_odds_cache DROP COLUMN refresh_owner,
        DROP COLUMN refresh_lease_until, DROP COLUMN refresh_claimed_at;`);
    try {
      vi.resetModules();
      const { initializeOddsCache } = await import('../../apps/web/src/lib/oddsCacheStartup');
      expect(await initializeOddsCache()).toBe('legacy');
      const capture = new Date().toISOString();
      const lines = [{ bookmakerKey: 'book', point: 200, overPrice: 1.9, underPrice: 1.8 }];
      const view = { oddsByBookmaker: lines, weather: { temperatureF: 62, windSpeedMph: 8, precipitationMm: 0 } };
      if (kind === 'live-hit') await client.query(`INSERT INTO public.live_prop_inputs_cache
        (sport_key,event_id,market_key,player_name,payload,fetched_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())`,
        [key.sportKey,key.eventId,key.marketKey,key.playerName,view]);
      if (kind.startsWith('forced')) await client.query(`INSERT INTO public.event_market_odds_cache
        (event_id,market_key,payload,fetched_at) VALUES($1,$2,$3,clock_timestamp()-$4::int*interval '1 second')`,
        [key.eventId,key.marketKey,{bookmakers},kind === 'forced-cooldown' ? 10 : 30]);
      m.query.mockClear();
      if (kind.startsWith('live')) {
        m.legacy.mockResolvedValue({ data: { response: null, oddsByBookmaker: lines }, capturedAt: capture,
          quota: { remaining: null, used: null, last: null } });
        const { getSharedLivePropInputs } = await import('../../apps/web/src/lib/livePropCacheRepo');
        const result = await getSharedLivePropInputs(key, context);
        expect(result).toMatchObject(view);
        expect(m.legacy).toHaveBeenCalledTimes(kind === 'live-hit' ? 0 : 1);
        expect(m.weather).toHaveBeenCalledTimes(kind === 'live-hit' ? 0 : 1);
        expect(m.query).toHaveBeenCalledTimes(kind === 'live-hit' ? 1 : 3);
        expect(result.oddsObservation?.status).toBeUndefined();
      } else {
        if (kind === 'provider-failure') m.event.mockRejectedValue(new Error('synthetic unavailable'));
        else m.event.mockResolvedValue({ data: { id: key.eventId, bookmakers, commence_time: context.startTime,
          home_team: context.homeTeam, away_team: context.awayTeam }, capturedAt: capture,
          quota: { remaining: 10, used: 1, last: 1 } });
        const { getOrFetchMarketOdds } = await import('../../apps/web/src/lib/oddsCacheRepo');
        const markets = kind === 'discovery-cold' ? [key.marketKey,'player_receptions'] : [key.marketKey];
        const run = getOrFetchMarketOdds(key.sportKey,key.eventId,markets,{forceRefresh:kind.startsWith('forced')});
        if (kind === 'provider-failure') await expect(run).rejects.toThrow('synthetic unavailable');
        else {
          const result = await run;
          expect(result.odds).toEqual({id:key.eventId,bookmakers});
          expect(result.origins[key.marketKey].origin).toBe(kind === 'forced-cooldown' ? 'cache' : 'upstream');
          expect(result.origins[key.marketKey].status).toBeUndefined();
        }
        expect(m.event).toHaveBeenCalledTimes(kind === 'forced-cooldown' ? 0 : 1);
        expect(m.query).toHaveBeenCalledTimes(kind === 'provider-failure' || kind === 'forced-cooldown' ? 1 : kind === 'discovery-cold' ? 3 : 2);
        expect(m.weather).not.toHaveBeenCalled();
      }
      expect(m.query.mock.calls.some(([text]) => text.includes('shared_odds'))).toBe(false);
    } finally { await client.query(proposalSql); }
  }
);

it.each(['missing-function','not-null-column','wrong-type','missing-column'])(
  'actual partial schema stays legacy until a new startup: %s', async variant => {
    await client.query('BEGIN');
    try {
      if (variant === 'missing-function') await client.query('DROP FUNCTION public.renew_shared_odds_batch(text,text[],text,integer)');
      if (variant === 'not-null-column') await client.query('ALTER TABLE public.event_market_odds_cache ALTER COLUMN refresh_owner SET NOT NULL');
      if (variant === 'wrong-type') await client.query('ALTER TABLE public.event_market_odds_cache ALTER COLUMN refresh_owner TYPE varchar');
      if (variant === 'missing-column') await client.query('ALTER TABLE public.event_market_odds_cache DROP COLUMN refresh_claimed_at');
      vi.resetModules();
      const { initializeOddsCache } = await import('../../apps/web/src/lib/oddsCacheStartup');
      expect(await initializeOddsCache()).toBe('legacy');
      await client.query('ROLLBACK');
      expect(await initializeOddsCache()).toBe('legacy');
      vi.resetModules();
      expect(await (await import('../../apps/web/src/lib/oddsCacheStartup')).initializeOddsCache()).toBe('shared');
    } finally { await client.query('ROLLBACK'); }
  }
);

it('two player views and discovery share one real raw publication with distinct projections', async () => {
  const allPlayers = [{ key: 'book', markets: [{ key: key.marketKey, outcomes: [
    ...bookmakers[0].markets[0].outcomes,
    { name: 'Over', description: 'Player B', point: 250, price: 1.7 },
    { name: 'Under', description: 'Player B', point: 250, price: 2.0 },
  ] }] }];
  m.event.mockResolvedValue({ data: { id: key.eventId, bookmakers: allPlayers,
    commence_time: context.startTime, home_team: context.homeTeam, away_team: context.awayTeam },
    capturedAt: new Date().toISOString(), quota: { remaining: 10, used: 1, last: 1 } });
  const { getSharedLivePropInputs } = await import('../../apps/web/src/lib/livePropCacheRepo');
  const [a,b] = await Promise.all([
    getSharedLivePropInputs(key,context),
    getSharedLivePropInputs({...key,playerName:'Player B'},context),
  ]);
  expect(a.oddsByBookmaker[0].point).toBe(200);
  expect(b.oddsByBookmaker[0].point).toBe(250);
  expect(a.oddsObservation!.observationId).toBe(b.oddsObservation!.observationId);
  expect(m.event).toHaveBeenCalledOnce();
  expect(m.persist).toHaveBeenCalledOnce();
  expect(m.weather).toHaveBeenCalledTimes(2);
  expect((await getSharedLivePropInputs(key,context)).oddsByBookmaker[0].point).toBe(200);
  const { getOrFetchMarketOdds } = await import('../../apps/web/src/lib/oddsCacheRepo');
  const discovery = await getOrFetchMarketOdds(key.sportKey,key.eventId,[key.marketKey]);
  expect(discovery.odds.bookmakers).toEqual(allPlayers);
  expect(discovery.origins[key.marketKey]).toMatchObject({origin:'cache',status:'fresh'});
  expect(m.event).toHaveBeenCalledOnce();
  expect(m.persist).toHaveBeenCalledOnce();
  expect(m.weather).toHaveBeenCalledTimes(2);
});
