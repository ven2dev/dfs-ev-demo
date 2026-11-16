import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSharedOddsBatch, type SharedOddsDependencies } from "@dfs-ev/db/runtime";
import { withTestClient } from "./harness";

const marketKeys = Array.from({ length: 12 }, (_, i) => `market-${i.toString().padStart(2, "0")}`);
const empty = { bookmakers: [] };
type Payload = typeof empty;

beforeAll(async () => {
  const sql = await readFile(new URL("../../proposals/221_shared_odds_cache.sql", import.meta.url), "utf8");
  await withTestClient(client => client.query(sql));
});
beforeEach(() => withTestClient(client => client.query("TRUNCATE public.event_market_odds_cache")));
afterAll(() => withTestClient(client => client.query(`
  DROP FUNCTION public.claim_shared_odds_batch(text,text[],text,integer,integer);
  DROP FUNCTION public.renew_shared_odds_batch(text,text[],text,integer);
  DROP FUNCTION public.publish_shared_odds_batch(text,text[],text,jsonb);
  DROP FUNCTION public.release_shared_odds_batch(text,text[],text);
  ALTER TABLE public.event_market_odds_cache DROP COLUMN refresh_owner,
    DROP COLUMN refresh_lease_until, DROP COLUMN refresh_claimed_at;
`)));

const withBatch = (run: (batch: (keys: string[], ttl?: number) => ReturnType<typeof getSharedOddsBatch<Payload>>,
  calls: string[][], sql: string[], client: Parameters<Parameters<typeof withTestClient>[0]>[0]) => Promise<void>) =>
  withTestClient(async client => {
    const calls: string[][] = [], sql: string[] = [];
    const deps: SharedOddsDependencies<Payload> = {
      query: async (text, params) => { sql.push(text); return (await client.query(text, params)).rows; },
      fetch: async (keys) => {
        // A separate connection observes the claim before the mock provider starts.
        await withTestClient(async observer => {
          const result = await observer.query(`SELECT count(*)::int AS n FROM public.event_market_odds_cache
            WHERE event_id='event' AND market_key=ANY($1) AND refresh_claimed_at IS NOT NULL
              AND refresh_owner IS NOT NULL`, [keys]);
          expect(result.rows[0].n).toBe(keys.length);
        });
        calls.push([...keys]);
        return Object.fromEntries(keys.map(key => [key, empty]));
      },
      makeOwnerId: randomUUID, monotonicNow: () => performance.now(),
      wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    };
    await run((keys, ttl = 300_000) => getSharedOddsBatch("event", keys, deps, { ttlMs: ttl }), calls, sql, client);
  });

const failPublication = (client: Parameters<Parameters<typeof withTestClient>[0]>[0]) => client.query(`
 CREATE FUNCTION public.reject_odds_publication() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.fetched_at <> OLD.fetched_at THEN RAISE EXCEPTION 'injected publication failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER reject_odds_publication BEFORE UPDATE ON public.event_market_odds_cache
 FOR EACH ROW EXECUTE FUNCTION public.reject_odds_publication();
`);
const allowPublication = (client: Parameters<Parameters<typeof withTestClient>[0]>[0]) => client.query(`
 DROP TRIGGER reject_odds_publication ON public.event_market_odds_cache;
 DROP FUNCTION public.reject_odds_publication();
`);

describe("shared raw odds SQL proposal and actual adapter", () => {
  it.each([false, true])("failed key does not block the other 11; prior payload=%s", async prior => {
    await withBatch(async (batch, calls, sql, client) => {
      if (prior) await client.query(`INSERT INTO public.event_market_odds_cache(event_id,market_key,payload,fetched_at)
        VALUES('event',$1,$2,clock_timestamp()-interval '10 minutes')`, [marketKeys[0], empty]);
      await failPublication(client);
      try { await batch([marketKeys[0]]); }
      finally { await allowPublication(client); }
      expect(calls).toEqual([[marketKeys[0]]]);
      const result = await batch([...marketKeys].reverse());
      expect(calls).toEqual([[marketKeys[0]], marketKeys.slice(1)]);
      expect(result[marketKeys[0]].state).toBe(prior ? "stale" : "unavailable");
      expect(result[marketKeys[0]].payload).toEqual(prior ? empty : null);
      expect(marketKeys.slice(1).every(key => result[key].state === "upstream")).toBe(true);
      expect(sql.filter(text => text.includes("claim_shared_odds_batch"))).toHaveLength(2);
      // Successful empty slices are real publications, not cold placeholders.
      const published = await client.query(`SELECT count(*)::int AS n FROM public.event_market_odds_cache
        WHERE event_id='event' AND fetched_at>'epoch' AND market_key=ANY($1)`, [marketKeys.slice(1)]);
      expect(published.rows[0].n).toBe(11);
    });
  });

  it("failed force refresh stays marked stale during cooldown even for a longer caller TTL", async () => {
    await withBatch(async (batch, calls, _sql, client) => {
      await client.query(`INSERT INTO public.event_market_odds_cache(event_id,market_key,payload,fetched_at)
        VALUES('event',$1,$2,clock_timestamp()-interval '30 seconds')`, [marketKeys[0], empty]);
      await failPublication(client);
      try { await batch([marketKeys[0]], 20_000); }
      finally { await allowPublication(client); }
      expect((await batch([marketKeys[0]], 300_000))[marketKeys[0]].state).toBe("stale");
      expect(calls).toHaveLength(1);
      await client.query(`UPDATE public.event_market_odds_cache SET refresh_claimed_at=clock_timestamp()-interval '21 seconds'`);
      expect((await batch([marketKeys[0]], 300_000))[marketKeys[0]].state).toBe("fresh");
      expect(calls).toHaveLength(1); // TTL still applies to the original publication only.
    });
  });

  it.each([20_000, 90_000, 300_000])("attempt cooldown stays 20 seconds with payload TTL %i", async ttl => {
    await withBatch(async (batch, calls, _sql, client) => {
      await failPublication(client);
      try { await batch([marketKeys[0]], ttl); }
      finally { await allowPublication(client); }
      await client.query(`UPDATE public.event_market_odds_cache SET refresh_claimed_at=clock_timestamp()-interval '19 seconds'`);
      expect((await batch([marketKeys[0]], ttl))[marketKeys[0]].state).toBe("unavailable");
      expect(calls).toHaveLength(1);
      await client.query(`UPDATE public.event_market_odds_cache SET refresh_claimed_at=clock_timestamp()-interval '21 seconds'`);
      expect((await batch([marketKeys[0]], ttl))[marketKeys[0]].state).toBe("upstream");
      expect(calls).toHaveLength(2);
    });
  });

  it("uses three SQL for a leader and one SELECT for a fresh hit; empty uses zero", async () => {
    await withBatch(async (batch, calls, sql) => {
      await batch([marketKeys[0]]);
      expect(sql).toHaveLength(3);
      sql.length = 0;
      const hit = await batch([marketKeys[0]]);
      expect(hit[marketKeys[0]].state).toBe("fresh");
      expect(sql).toHaveLength(1);
      expect(calls).toHaveLength(1);
      sql.length = 0;
      expect(await batch([])).toEqual({});
      expect(sql).toHaveLength(0);
    });
  });

  it("fences expired and replaced owners for publish, renew and release", async () => {
    await withBatch(async (_batch, _calls, _sql, client) => {
      const args = ['event', [marketKeys[0]], 'old', 20_000, 30_000];
      await client.query('SELECT * FROM public.claim_shared_odds_batch($1,$2,$3,$4,$5)', args);
      await client.query(`UPDATE public.event_market_odds_cache SET refresh_lease_until=clock_timestamp()-interval '1 second',
        refresh_claimed_at=clock_timestamp()-interval '21 seconds'`);
      await client.query('SELECT * FROM public.claim_shared_odds_batch($1,$2,$3,$4,$5)', [...args.slice(0,2), 'new', ...args.slice(3)]);
      await expect(client.query('SELECT public.publish_shared_odds_batch($1,$2,$3,$4)',
        ['event', [marketKeys[0]], 'old', { [marketKeys[0]]: empty }])).rejects.toThrow('lost owner');
      expect((await client.query('SELECT public.renew_shared_odds_batch($1,$2,$3,$4) AS ok',
        ['event', [marketKeys[0]], 'old', 30_000])).rows[0].ok).toBe(false);
      await client.query('SELECT public.release_shared_odds_batch($1,$2,$3)', ['event', [marketKeys[0]], 'old']);
      expect((await client.query('SELECT refresh_owner FROM public.event_market_odds_cache')).rows[0].refresh_owner).toBe('new');
    });
  });
  it.each([false, true])("independent clients serialize identical/overlapping batches; partial=%s", async partial => {
    await withTestClient(async first => withTestClient(async second => {
      const ids = await Promise.all([first.query('SELECT pg_backend_pid() AS pid'), second.query('SELECT pg_backend_pid() AS pid')]);
      expect(ids[0].rows[0].pid).not.toBe(ids[1].rows[0].pid);
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), follower = Promise.withResolvers<void>();
      const sends: string[][] = [], active = new Set<string>();
      let overlap = 0;
      const actor = (client: typeof first, hold: boolean): SharedOddsDependencies<Payload> => ({
        query: async (text, params) => (await client.query(text, params)).rows,
        fetch: async keys => {
          sends.push([...keys]);
          keys.forEach(key => { if (active.has(key)) overlap++; active.add(key); });
          if (hold) { entered.resolve(); await release.promise; }
          keys.forEach(key => active.delete(key));
          return Object.fromEntries(keys.map(key => [key, empty]));
        },
        makeOwnerId: randomUUID, monotonicNow: () => performance.now(),
        wait: async ms => { expect(ms).toBe(250); follower.resolve(); await new Promise(resolve => setTimeout(resolve, ms)); },
      });
      const owner = getSharedOddsBatch('event', marketKeys.slice(0,2), actor(first, true), { ttlMs: 90_000 });
      await entered.promise;
      const requested = partial ? marketKeys.slice(1,3) : marketKeys.slice(0,2).reverse();
      const waiting = getSharedOddsBatch('event', requested, actor(second, false), { ttlMs: 90_000 });
      try { await follower.promise; expect(sends).toHaveLength(1); }
      finally { release.resolve(); }
      await owner;
      const result = await waiting;
      expect(sends).toEqual(partial ? [marketKeys.slice(0,2), [marketKeys[2]]] : [marketKeys.slice(0,2)]);
      expect(overlap).toBe(0);
      expect(Object.keys(result).sort()).toEqual(requested.sort());
    }));
  });

  it.each([20_000, 90_000, 300_000])("checks caller TTL %i only against publication time", async ttl => {
    await withBatch(async (batch, calls, _sql, client) => {
      await batch([marketKeys[0]], ttl);
      await client.query(`UPDATE public.event_market_odds_cache
        SET fetched_at=clock_timestamp()-($1::int-1000)*interval '1 millisecond',
            refresh_claimed_at=clock_timestamp()-$1::int*interval '1 millisecond'`, [ttl]);
      expect((await batch([marketKeys[0]], ttl))[marketKeys[0]].state).toBe('fresh');
      expect(calls).toHaveLength(1);
      await client.query(`UPDATE public.event_market_odds_cache
        SET fetched_at=clock_timestamp()-($1::int+1000)*interval '1 millisecond',
            refresh_claimed_at=clock_timestamp()-($1::int+2000)*interval '1 millisecond'`, [ttl]);
      expect((await batch([marketKeys[0]], ttl))[marketKeys[0]].state).toBe('upstream');
      expect(calls).toHaveLength(2);
    });
  });

  it("preserves a fresh slice while claiming only the missing subset", async () => {
    await withBatch(async (batch, calls) => {
      await batch([marketKeys[0]]);
      const result = await batch(marketKeys.slice(0,2));
      expect(calls).toEqual([[marketKeys[0]], [marketKeys[1]]]);
      expect(result[marketKeys[0]].state).toBe('fresh');
      expect(result[marketKeys[1]].state).toBe('upstream');
    });
  });

  it("persists the attempt after an ambiguous provider failure without automatic resend", async () => {
    await withTestClient(async client => {
      let sends = 0;
      const deps: SharedOddsDependencies<Payload> = {
        query: async (text, params) => (await client.query(text, params)).rows,
        fetch: async () => { sends++; throw new Error('ambiguous mock outcome'); },
        makeOwnerId: randomUUID, monotonicNow: () => performance.now(),
        wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
      };
      const run = () => getSharedOddsBatch('event', [marketKeys[0]], deps, { ttlMs: 300_000 });
      await expect(run()).rejects.toThrow('ambiguous mock outcome');
      expect((await run())[marketKeys[0]].state).toBe('unavailable');
      expect(sends).toBe(1);
      const state = await client.query('SELECT refresh_owner,refresh_claimed_at IS NOT NULL AS claimed FROM public.event_market_odds_cache');
      expect(state.rows).toEqual([{ refresh_owner: null, claimed: true }]);
    });
  });

});
