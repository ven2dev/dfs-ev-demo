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
let client: Awaited<ReturnType<typeof openTestClient>>;
beforeAll(async () => {
  const proposal = await readFile(new URL('../../packages/db/proposals/221_shared_odds_cache.sql', import.meta.url), 'utf8');
  await withTestClient(c => c.query(proposal));
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
