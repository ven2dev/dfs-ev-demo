import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "pg";
import { expect } from "vitest";
import type { LivePropCacheKey, LivePropInputs } from "../../src/lib/livePropCache";
import { createLivePropCacheStore } from "../../src/lib/livePropCacheStore";
import { openTestClient } from "./harness";

export const key: LivePropCacheKey = {
  sportKey: "americanfootball_nfl",
  eventId: "fixture-lease-contention",
  marketKey: "player_pass_yds",
  playerName: "Fixture Player",
};
export const keyValues = [key.sportKey, key.eventId, key.marketKey, key.playerName];
export const leaseMs = 60_000;
export const payload: LivePropInputs = {
  oddsByBookmaker: [{ bookmakerKey: "fixture-book", overPrice: 1.91, underPrice: 1.89, point: 214.5 }],
  oddsObservation: {
    origin: "upstream",
    observationId: "fixture-observation",
    persisted: true,
    capturedAt: "2026-10-04T12:00:00.000Z",
    quota: { remaining: 479, used: 21, last: 1 },
  },
  weather: { temperatureF: 62, windSpeedMph: 8, precipitationMm: 0 },
};

export function testStore(client: Client) {
  return createLivePropCacheStore(async (text, params) => (await client.query(text, params)).rows);
}

export async function backendPid(client: Client): Promise<number> {
  return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
}

export async function openContenders(count = 25) {
  const participants = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const client = await openTestClient();
    return { client, store: testStore(client), pid: await backendPid(client), owner: `contender-${index}` };
  }));
  expect(new Set(participants.map((participant) => participant.pid)).size).toBe(count);
  return participants;
}

export async function freshAfter(client: Client): Promise<number> {
  const result = await client.query<{ threshold: Date }>(
    "SELECT now() - interval '90 seconds' AS threshold"
  );
  return result.rows[0].threshold.getTime();
}

export async function expireLease(client: Client) {
  const result = await client.query(
    `UPDATE live_prop_inputs_cache SET refresh_lease_until = now() - interval '1 second'
     WHERE sport_key = $1 AND event_id = $2 AND market_key = $3 AND player_name = $4`,
    keyValues
  );
  expect(result.rowCount).toBe(1);
}

export async function seedStaleRow(client: Client) {
  const store = testStore(client);
  expect(await store.tryAcquireRefresh(key, "former-owner", await freshAfter(client), leaseMs)).toBe(true);
  await store.write(key, "former-owner", payload);
  await client.query(
    `UPDATE live_prop_inputs_cache
     SET fetched_at = now() - interval '10 minutes', refresh_owner = 'former-owner',
         refresh_lease_until = now() - interval '1 second'
     WHERE sport_key = $1 AND event_id = $2 AND market_key = $3 AND player_name = $4`,
    keyValues
  );
}

export type CacheState = {
  payload: LivePropInputs | null;
  fetched_at: Date | null;
  refresh_owner: string | null;
  refresh_lease_until: Date | null;
  lease_active: boolean | null;
};

export async function cacheState(client: Client): Promise<CacheState | undefined> {
  const result = await client.query<CacheState>(
    `SELECT payload, fetched_at, refresh_owner, refresh_lease_until,
            refresh_lease_until > now() AS lease_active
     FROM live_prop_inputs_cache
     WHERE sport_key = $1 AND event_id = $2 AND market_key = $3 AND player_name = $4`,
    keyValues
  );
  expect(result.rows.length).toBeLessThanOrEqual(1);
  return result.rows[0];
}

type LockState = {
  pid: number;
  state: string;
  wait_event_type: string | null;
  wait_event: string | null;
  waiting_lock: boolean;
  blockers: number[];
};

export async function waitForBlocked(monitor: Client, pids: number[], holderPid: number) {
  const deadline = performance.now() + 7_500;
  let snapshot: LockState[] = [];
  const reachesHolder = (pid: number, visited = new Set<number>()): boolean => {
    if (pid === holderPid) return true;
    if (visited.has(pid)) return false;
    visited.add(pid);
    return snapshot.find((row) => row.pid === pid)?.blockers.some(
      (blocker) => reachesHolder(blocker, new Set(visited))
    ) ?? false;
  };
  while (performance.now() < deadline) {
    snapshot = (await monitor.query<LockState>(
      `SELECT a.pid, a.state, a.wait_event_type, a.wait_event,
              EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted) AS waiting_lock,
              pg_blocking_pids(a.pid) AS blockers
       FROM pg_stat_activity a WHERE a.pid = ANY($1::integer[]) ORDER BY a.pid`,
      [pids]
    )).rows;
    if (snapshot.length === pids.length && snapshot.every(
      (row) => row.state === "active" && row.wait_event_type === "Lock" && row.waiting_lock && reachesHolder(row.pid)
    )) return;
    await delay(10);
  }
  throw new Error(`Expected ${pids.length} DB backends blocked behind ${holderPid}; observed ${JSON.stringify(snapshot)}`);
}
