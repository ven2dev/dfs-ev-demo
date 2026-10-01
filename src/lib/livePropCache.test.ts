import { afterEach, describe, expect, it, vi } from "vitest";
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
  fetchFresh?: (signal: AbortSignal) => Promise<LivePropInputs>;
  renew?: (ownerId: string, leaseMs: number) => Promise<boolean>;
  write?: (fresh: LivePropInputs) => Promise<void>;
  advanceClockOnWait?: boolean;
  clock?: () => number;
} = {}) => {
  let nowMs = options.now ?? 100_000;
  let entry = options.entry ?? null;
  let leaseOwner = options.leaseOwner ?? null;
  let leaseUntilMs = options.leaseUntilMs ?? 0;
  let ownerSequence = 0;
  const currentTime = options.clock ?? (() => nowMs);

  const deps: LivePropCacheDeps = {
    read: async () => entry,
    tryAcquireRefresh: async (_key, ownerId, freshAfterMs, leaseMs) => {
      if (entry && entry.fetchedAtMs > freshAfterMs) return false;
      if (leaseOwner && leaseUntilMs > currentTime()) return false;
      leaseOwner = ownerId;
      leaseUntilMs = currentTime() + leaseMs;
      return true;
    },
    renew: async (_key, ownerId, leaseMs) => {
      if (options.renew) return options.renew(ownerId, leaseMs);
      if (leaseOwner !== ownerId) return false;
      leaseUntilMs = currentTime() + leaseMs;
      return true;
    },
    write: async (_key, ownerId, fresh) => {
      if (leaseOwner !== ownerId) throw new Error("lease lost");
      if (options.write) await options.write(fresh);
      entry = { payload: fresh, fetchedAtMs: currentTime() };
      leaseOwner = null;
      leaseUntilMs = 0;
    },
    release: async (_key, ownerId) => {
      if (leaseOwner === ownerId) {
        leaseOwner = null;
        leaseUntilMs = 0;
      }
    },
    fetchFresh: (_key, signal) =>
      options.fetchFresh ? options.fetchFresh(signal) : Promise.resolve(payload),
    makeOwnerId: () => `owner-${++ownerSequence}`,
    now: currentTime,
    wait: async (ms) => {
      if (options.advanceClockOnWait) nowMs += ms;
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };

  return {
    deps,
    getEntry: () => entry,
    getLeaseOwner: () => leaseOwner,
    getLeaseUntilMs: () => leaseUntilMs,
  };
};

afterEach(() => {
  vi.useRealTimers();
});

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
        renewIntervalMs: 5,
        refreshTimeoutMs: 10,
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

  it("renews through a slow cache write so another viewer cannot take its lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolveWrite!: () => void;
    const fetchFresh = vi.fn(async () => payload);
    const state = createMemoryDeps({
      clock: Date.now,
      fetchFresh,
      write: () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    });
    const renew = vi.spyOn(state.deps, "renew");

    const firstViewer = getOrRefreshLivePropInputs(key, state.deps, {
      ttlMs: 90_000,
      leaseMs: 30,
      renewIntervalMs: 10,
      refreshTimeoutMs: 20,
      waitIntervalMs: 1,
      maxWaitMs: 100,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(35);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(state.getLeaseUntilMs()).toBe(60);

    const secondViewer = getOrRefreshLivePropInputs(key, state.deps, {
      ttlMs: 90_000,
      leaseMs: 30,
      renewIntervalMs: 10,
      refreshTimeoutMs: 20,
      waitIntervalMs: 1,
      maxWaitMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFresh).toHaveBeenCalledTimes(1);

    resolveWrite();
    await vi.advanceTimersByTimeAsync(2);
    await expect(Promise.all([firstViewer, secondViewer])).resolves.toEqual([
      payload,
      payload,
    ]);
    expect(fetchFresh).toHaveBeenCalledTimes(1);
  });

  it("aborts a timed-out refresh and releases its lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchFresh = vi.fn(
      (signal: AbortSignal) =>
        new Promise<LivePropInputs>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );
    const state = createMemoryDeps({ clock: Date.now, fetchFresh });

    const refresh = getOrRefreshLivePropInputs(key, state.deps, {
      ttlMs: 90_000,
      leaseMs: 30,
      renewIntervalMs: 10,
      refreshTimeoutMs: 20,
    });
    const rejection = expect(refresh).rejects.toThrow("Shared live-prop refresh timed out");
    await vi.advanceTimersByTimeAsync(21);

    await rejection;
    expect(state.getLeaseOwner()).toBeNull();
    expect(fetchFresh.mock.calls[0][0].aborted).toBe(true);
  });

  it("aborts and releases when it can no longer renew its lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchFresh = vi.fn(
      (signal: AbortSignal) =>
        new Promise<LivePropInputs>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );
    const state = createMemoryDeps({
      clock: Date.now,
      fetchFresh,
      renew: async () => false,
    });

    const refresh = getOrRefreshLivePropInputs(key, state.deps, {
      ttlMs: 90_000,
      leaseMs: 30,
      renewIntervalMs: 10,
      refreshTimeoutMs: 20,
    });
    const rejection = expect(refresh).rejects.toThrow(
      "Shared live-prop refresh lease was lost"
    );
    await vi.advanceTimersByTimeAsync(11);

    await rejection;
    expect(state.getLeaseOwner()).toBeNull();
    expect(fetchFresh.mock.calls[0][0].aborted).toBe(true);
  });
});
