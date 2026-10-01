import { describe, expect, it, vi } from "vitest";
import {
  getOrRefreshLivePropInputs,
  type LivePropCacheDeps,
  type LivePropCacheEntry,
  type LivePropCacheKey,
  type LivePropInputs,
} from "./livePropCache";

const key: LivePropCacheKey = {
  sportKey: "americanfootball_nfl",
  eventId: "evt-1",
  marketKey: "player_pass_yds",
  playerName: "Jalen Hurts",
};

const payload: LivePropInputs = {
  oddsByBookmaker: [
    {
      bookmakerKey: "draftkings",
      overPrice: 1.91,
      underPrice: 1.89,
      point: 214.5,
    },
  ],
  weather: { temperatureF: 62, windSpeedMph: 8, precipitationMm: 0 },
};

const createMemoryDeps = (options: {
  now?: number;
  entry?: LivePropCacheEntry | null;
  leaseOwner?: string | null;
  leaseUntilMs?: number;
  fetchFresh?: () => Promise<LivePropInputs>;
  write?: (fresh: LivePropInputs) => Promise<void>;
  advanceClockOnWait?: boolean;
} = {}) => {
  let nowMs = options.now ?? 100_000;
  let entry = options.entry ?? null;
  let leaseOwner = options.leaseOwner ?? null;
  let leaseUntilMs = options.leaseUntilMs ?? 0;
  let ownerSequence = 0;

  const deps: LivePropCacheDeps = {
    read: async () => entry,
    tryAcquireRefresh: async (_key, ownerId, freshAfterMs, leaseMs) => {
      if (entry && entry.fetchedAtMs > freshAfterMs) return false;
      if (leaseOwner && leaseUntilMs > nowMs) return false;
      leaseOwner = ownerId;
      leaseUntilMs = nowMs + leaseMs;
      return true;
    },
    write: async (_key, ownerId, fresh) => {
      if (leaseOwner !== ownerId) throw new Error("lease lost");
      if (options.write) await options.write(fresh);
      entry = { payload: fresh, fetchedAtMs: nowMs };
      leaseOwner = null;
      leaseUntilMs = 0;
    },
    release: async (_key, ownerId) => {
      if (leaseOwner === ownerId) {
        leaseOwner = null;
        leaseUntilMs = 0;
      }
    },
    fetchFresh: options.fetchFresh ?? (async () => payload),
    makeOwnerId: () => `owner-${++ownerSequence}`,
    now: () => nowMs,
    wait: async (ms) => {
      if (options.advanceClockOnWait) nowMs += ms;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };

  return { deps, getEntry: () => entry, getLeaseOwner: () => leaseOwner };
};

describe("getOrRefreshLivePropInputs", () => {
  it("returns a fresh shared entry without calling upstream", async () => {
    const fetchFresh = vi.fn(async () => payload);
    const { deps } = createMemoryDeps({
      entry: { payload, fetchedAtMs: 99_500 },
      fetchFresh,
    });

    await expect(
      getOrRefreshLivePropInputs(key, deps, { ttlMs: 1_000 })
    ).resolves.toEqual(payload);
    expect(fetchFresh).not.toHaveBeenCalled();
  });

  it("collapses concurrent viewers of one prop into one upstream refresh", async () => {
    let resolveFetch!: (value: LivePropInputs) => void;
    const fetchFresh = vi.fn(
      () =>
        new Promise<LivePropInputs>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const { deps } = createMemoryDeps({ fetchFresh });

    const viewers = Array.from({ length: 25 }, () =>
      getOrRefreshLivePropInputs(key, deps, {
        ttlMs: 90_000,
        waitIntervalMs: 1,
        maxWaitMs: 1_000,
      })
    );
    await vi.waitFor(() => expect(fetchFresh).toHaveBeenCalledTimes(1));
    resolveFetch(payload);

    const results = await Promise.all(viewers);
    expect(results).toEqual(Array.from({ length: 25 }, () => payload));
    expect(fetchFresh).toHaveBeenCalledTimes(1);
  });

  it("takes over an abandoned refresh after its database lease expires", async () => {
    const fetchFresh = vi.fn(async () => payload);
    const { deps } = createMemoryDeps({
      leaseOwner: "crashed-instance",
      leaseUntilMs: 100_010,
      fetchFresh,
      advanceClockOnWait: true,
    });

    await expect(
      getOrRefreshLivePropInputs(key, deps, {
        ttlMs: 90_000,
        leaseMs: 20,
        waitIntervalMs: 5,
        maxWaitMs: 100,
      })
    ).resolves.toEqual(payload);
    expect(fetchFresh).toHaveBeenCalledTimes(1);
  });

  it("returns freshly fetched inputs even when the cache write fails", async () => {
    const writeError = new Error("database write failed");
    const onCacheWriteError = vi.fn();
    const state = createMemoryDeps({
      write: async () => {
        throw writeError;
      },
    });
    state.deps.onCacheWriteError = onCacheWriteError;

    await expect(
      getOrRefreshLivePropInputs(key, state.deps, { ttlMs: 90_000 })
    ).resolves.toEqual(payload);
    expect(onCacheWriteError).toHaveBeenCalledWith(writeError);
    expect(state.getLeaseOwner()).toBeNull();
  });

  it("releases its lease when the upstream refresh fails", async () => {
    const state = createMemoryDeps({
      fetchFresh: async () => {
        throw new Error("upstream unavailable");
      },
    });

    await expect(
      getOrRefreshLivePropInputs(key, state.deps, { ttlMs: 90_000 })
    ).rejects.toThrow("upstream unavailable");
    expect(state.getLeaseOwner()).toBeNull();
    expect(state.getEntry()).toBeNull();
  });
});
