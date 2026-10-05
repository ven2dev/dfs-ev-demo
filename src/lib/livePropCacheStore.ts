import type {
  LivePropCacheDeps,
  LivePropCacheEntry,
  LivePropCacheKey,
  LivePropInputs,
} from "./livePropCache";

export type LivePropCacheQuery = (
  text: string,
  params: (string | number)[]
) => Promise<Record<string, unknown>[]>;

export type LivePropCacheStore = Pick<
  LivePropCacheDeps,
  "read" | "tryAcquireRefresh" | "renew" | "write" | "release"
>;

type CacheRow = {
  payload: LivePropInputs | null;
  fetched_at: string | Date | null;
};

// Both production and integration tests execute these same statements.
// The caller owns driver initialization and the connection lifecycle.
export const createLivePropCacheStore = (
  query: LivePropCacheQuery
): LivePropCacheStore => {
  const keyParams = (key: LivePropCacheKey) => [
    key.sportKey,
    key.eventId,
    key.marketKey,
    key.playerName,
  ];

  const read = async (key: LivePropCacheKey): Promise<LivePropCacheEntry | null> => {
    const rows = (await query(
      `SELECT payload, fetched_at
       FROM live_prop_inputs_cache
       WHERE sport_key = $1 AND event_id = $2 AND market_key = $3 AND player_name = $4`,
      keyParams(key)
    )) as CacheRow[];
    const row = rows[0];
    if (!row?.payload || !row.fetched_at) return null;
    return {
      payload: row.payload,
      fetchedAtMs:
        row.fetched_at instanceof Date
          ? row.fetched_at.getTime()
          : new Date(row.fetched_at).getTime(),
    };
  };

  const tryAcquireRefresh = async (
    key: LivePropCacheKey,
    ownerId: string,
    freshAfterMs: number,
    leaseMs: number
  ): Promise<boolean> => {
    const rows = await query(
      `INSERT INTO live_prop_inputs_cache (
         sport_key, event_id, market_key, player_name, refresh_owner, refresh_lease_until
       )
       VALUES ($1, $2, $3, $4, $5, now() + ($7 * interval '1 millisecond'))
       ON CONFLICT (sport_key, event_id, market_key, player_name)
       DO UPDATE SET
         refresh_owner = EXCLUDED.refresh_owner,
         refresh_lease_until = EXCLUDED.refresh_lease_until
       WHERE (live_prop_inputs_cache.fetched_at IS NULL OR live_prop_inputs_cache.fetched_at <= $6)
         AND (
           live_prop_inputs_cache.refresh_lease_until IS NULL
           OR live_prop_inputs_cache.refresh_lease_until <= now()
         )
       RETURNING refresh_owner`,
      [
        ...keyParams(key),
        ownerId,
        new Date(freshAfterMs).toISOString(),
        leaseMs,
      ]
    );
    return rows.length > 0;
  };

  const renew = async (
    key: LivePropCacheKey,
    ownerId: string,
    leaseMs: number
  ): Promise<boolean> => {
    const rows = await query(
      `UPDATE live_prop_inputs_cache
       SET refresh_lease_until = now() + ($6 * interval '1 millisecond')
       WHERE sport_key = $1 AND event_id = $2 AND market_key = $3 AND player_name = $4
         AND refresh_owner = $5
       RETURNING refresh_owner`,
      [...keyParams(key), ownerId, leaseMs]
    );
    return rows.length > 0;
  };

  const write = async (
    key: LivePropCacheKey,
    ownerId: string,
    payload: LivePropInputs
  ): Promise<void> => {
    const rows = await query(
      `UPDATE live_prop_inputs_cache
       SET payload = $6, fetched_at = now(), refresh_owner = NULL, refresh_lease_until = NULL
       WHERE sport_key = $1 AND event_id = $2 AND market_key = $3 AND player_name = $4
         AND refresh_owner = $5
       RETURNING event_id`,
      [...keyParams(key), ownerId, JSON.stringify(payload)]
    );
    if (rows.length === 0) throw new Error("Live-prop refresh lease was lost before cache write");
  };

  const release = async (key: LivePropCacheKey, ownerId: string): Promise<void> => {
    await query(
      `UPDATE live_prop_inputs_cache
       SET refresh_owner = NULL, refresh_lease_until = NULL
       WHERE sport_key = $1 AND event_id = $2 AND market_key = $3 AND player_name = $4
         AND refresh_owner = $5`,
      [...keyParams(key), ownerId]
    );
  };

  return { read, tryAcquireRefresh, renew, write, release };
};
