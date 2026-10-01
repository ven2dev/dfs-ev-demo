import type { PlayerPropBookmakerLine } from "./oddsApi";
import type { WeatherSnapshot } from "./weather";

export type LivePropCacheKey = {
  sportKey: string;
  eventId: string;
  marketKey: string;
  playerName: string;
};

export type LivePropInputs = {
  oddsByBookmaker: PlayerPropBookmakerLine[];
  weather: WeatherSnapshot;
};

export type LivePropCacheEntry = {
  payload: LivePropInputs;
  fetchedAtMs: number;
};

export type LivePropCacheDeps = {
  read: (key: LivePropCacheKey) => Promise<LivePropCacheEntry | null>;
  tryAcquireRefresh: (
    key: LivePropCacheKey,
    ownerId: string,
    freshAfterMs: number,
    leaseMs: number
  ) => Promise<boolean>;
  write: (
    key: LivePropCacheKey,
    ownerId: string,
    payload: LivePropInputs
  ) => Promise<void>;
  release: (key: LivePropCacheKey, ownerId: string) => Promise<void>;
  fetchFresh: (key: LivePropCacheKey) => Promise<LivePropInputs>;
  makeOwnerId: () => string;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  onCacheWriteError?: (error: unknown) => void;
};

export type LivePropCacheOptions = {
  ttlMs: number;
  leaseMs?: number;
  waitIntervalMs?: number;
  maxWaitMs?: number;
};

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_WAIT_INTERVAL_MS = 250;
const DEFAULT_MAX_WAIT_MS = 45_000;

const isFresh = (
  entry: LivePropCacheEntry | null,
  freshAfterMs: number
): entry is LivePropCacheEntry => entry !== null && entry.fetchedAtMs > freshAfterMs;

// Cross-instance singleflight. Postgres owns the refresh lease, so two
// serverless instances racing on the same prop cannot both call the
// upstream odds/weather APIs. Followers wait for the lease holder's
// cache write and then consume that same observation.
export const getOrRefreshLivePropInputs = async (
  key: LivePropCacheKey,
  deps: LivePropCacheDeps,
  options: LivePropCacheOptions
): Promise<LivePropInputs> => {
  const startedAtMs = deps.now();
  const freshAfterMs = startedAtMs - options.ttlMs;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const waitIntervalMs = options.waitIntervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  const cached = await deps.read(key);
  if (isFresh(cached, freshAfterMs)) return cached.payload;

  const ownerId = deps.makeOwnerId();
  let acquired = await deps.tryAcquireRefresh(key, ownerId, freshAfterMs, leaseMs);

  while (!acquired) {
    if (deps.now() - startedAtMs >= maxWaitMs) {
      throw new Error("Timed out waiting for shared live-prop refresh");
    }

    await deps.wait(waitIntervalMs);
    const refreshed = await deps.read(key);
    if (isFresh(refreshed, freshAfterMs)) return refreshed.payload;

    acquired = await deps.tryAcquireRefresh(key, ownerId, freshAfterMs, leaseMs);
  }

  try {
    const fresh = await deps.fetchFresh(key);
    try {
      await deps.write(key, ownerId, fresh);
    } catch (error) {
      deps.onCacheWriteError?.(error);
      await deps.release(key, ownerId).catch(() => undefined);
    }
    return fresh;
  } catch (error) {
    await deps.release(key, ownerId).catch(() => undefined);
    throw error;
  }
};
