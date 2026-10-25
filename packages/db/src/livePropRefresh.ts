import type { LivePropCacheEntry, LivePropCacheKey, LivePropCacheStore } from "./livePropCache.ts";

export type LivePropCacheDeps<T> = LivePropCacheStore<T> & {
  fetchFresh: (
    key: LivePropCacheKey,
    signal: AbortSignal
  ) => Promise<T>;
  makeOwnerId: () => string;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  onCacheWriteError?: (error: unknown) => void;
};

export type LivePropCacheOptions = {
  ttlMs: number;
  leaseMs?: number;
  renewIntervalMs?: number;
  refreshTimeoutMs?: number;
  waitIntervalMs?: number;
  maxWaitMs?: number;
};

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RENEW_INTERVAL_MS = 10_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 20_000;
const DEFAULT_WAIT_INTERVAL_MS = 250;
const DEFAULT_MAX_WAIT_MS = 45_000;

const isFresh = <T>(
  entry: LivePropCacheEntry<T> | null,
  freshAfterMs: number
): entry is LivePropCacheEntry<T> => entry !== null && entry.fetchedAtMs > freshAfterMs;

// Cross-instance singleflight. Postgres owns the refresh lease, so two
// serverless instances racing on the same prop cannot both call the
// upstream fetch function. Followers wait for the lease holder's
// cache write and then consume that same observation.
export const getOrRefresh = async <T>(
  key: LivePropCacheKey,
  deps: LivePropCacheDeps<T>,
  options: LivePropCacheOptions
): Promise<T> => {
  const startedAtMs = deps.now();
  const freshAfterMs = startedAtMs - options.ttlMs;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const renewIntervalMs = options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
  const refreshTimeoutMs = options.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
  const waitIntervalMs = options.waitIntervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  if (refreshTimeoutMs >= leaseMs) {
    throw new Error("Live-prop refresh timeout must be shorter than its lease");
  }
  if (renewIntervalMs >= leaseMs) {
    throw new Error("Live-prop lease renewal interval must be shorter than its lease");
  }

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

  const controller = new AbortController();
  let renewalInFlight = false;
  const abortRefresh = (error: Error) => {
    if (!controller.signal.aborted) controller.abort(error);
  };
  const timeout = setTimeout(
    () => abortRefresh(new Error("Shared live-prop refresh timed out")),
    refreshTimeoutMs
  );
  const renewal = setInterval(async () => {
    if (renewalInFlight || controller.signal.aborted) return;
    renewalInFlight = true;
    try {
      const renewed = await deps.renew(key, ownerId, leaseMs);
      if (!renewed) {
        abortRefresh(new Error("Shared live-prop refresh lease was lost"));
      }
    } catch {
      abortRefresh(new Error("Failed to renew shared live-prop refresh lease"));
    } finally {
      renewalInFlight = false;
    }
  }, renewIntervalMs);

  try {
    let fresh: T;
    try {
      fresh = await deps.fetchFresh(key, controller.signal);
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) {
        throw controller.signal.reason;
      }
      throw error;
    }
    if (controller.signal.aborted && controller.signal.reason instanceof Error) {
      throw controller.signal.reason;
    }
    // The deadline bounds only the external requests. Keep renewing through
    // the owner-guarded cache write, which may itself be delayed by Postgres.
    clearTimeout(timeout);
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
  } finally {
    clearTimeout(timeout);
    clearInterval(renewal);
  }
};
