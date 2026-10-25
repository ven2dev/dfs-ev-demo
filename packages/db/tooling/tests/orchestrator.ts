import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { getOrRefresh, type LivePropCacheKey, type LivePropCacheStore } from "@dfs-ev/db/runtime";

// The DB-owned integration adapter supplies generic infrastructure fixtures.
// This scenario verifies lease-backed refresh behavior without a web, driver or
// provider dependency.
type OrchestratorFixtures<Client, Payload> = {
  openTestClient: () => Promise<Client>;
  cacheState: (client: Client) => Promise<{ refresh_owner: string | null } | undefined>;
  freshAfter: (client: Client) => Promise<number>;
  key: LivePropCacheKey;
  leaseMs: number;
  openContenders: () => Promise<{ store: LivePropCacheStore<Payload>; owner: string }[]>;
  payload: Payload;
  testStore: (client: Client) => LivePropCacheStore<Payload>;
};

export const registerOrchestratorDatabaseTest = <Client, Payload>({
  openTestClient, cacheState, freshAfter, key, leaseMs, openContenders, payload, testStore,
}: OrchestratorFixtures<Client, Payload>) => {

  it("25 database-backed consumers wait for one fetch and receive the same persisted payload", async () => {
    const monitor = await openTestClient();
    const consumers = await openContenders();
    // Align the application clock with the DB clock; actual lifecycle timers
    // remain real. No explicit transaction wraps the orchestration.
    const startedAt = (await freshAfter(monitor)) + 90_000;
    const fetchResult = Promise.withResolvers<Payload>();
    const followersCanRead = Promise.withResolvers<void>();
    const allFirstAttempts = Promise.withResolvers<void>();
    const allFollowersWaiting = Promise.withResolvers<void>();
    const start = Promise.withResolvers<void>();
    const attempted = new Set<number>();
    const waiting = new Set<number>();
    const writeErrors: unknown[] = [];
    const fetchFresh = vi.fn(async (_key, signal: AbortSignal) => {
      const aborted = Promise.withResolvers<never>();
      const onAbort = () => aborted.reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await Promise.race([fetchResult.promise, aborted.promise]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    });
    const results = Promise.allSettled(consumers.map(async ({ store, owner }, index) => {
      await start.promise;
      return getOrRefresh(key, {
        ...store,
        tryAcquireRefresh: async (...args) => {
          const acquired = await store.tryAcquireRefresh(...args);
          attempted.add(index);
          if (attempted.size === 25) allFirstAttempts.resolve();
          return acquired;
        },
        fetchFresh,
        makeOwnerId: () => owner,
        now: () => startedAt + (performance.now() - launchedAt),
        wait: async () => {
          waiting.add(index);
          if (waiting.size === 24) allFollowersWaiting.resolve();
          await followersCanRead.promise;
        },
        onCacheWriteError: (error) => writeErrors.push(error),
      }, {
        ttlMs: 90_000,
        leaseMs,
        renewIntervalMs: 10_000,
        refreshTimeoutMs: 20_000,
        maxWaitMs: 25_000,
      });
    }));
    const launchedAt = performance.now();
    start.resolve();
    try {
      const deadline = new AbortController();
      try {
        await Promise.race([
          Promise.all([allFirstAttempts.promise, allFollowersWaiting.promise]),
          delay(7_500, undefined, { signal: deadline.signal }).then(() => { throw new Error("Consumers did not reach the first-attempt/wait barrier."); }),
        ]);
      } finally {
        deadline.abort();
      }
      expect(attempted.size).toBe(25);
      expect(waiting.size).toBe(24);
      expect(fetchFresh).toHaveBeenCalledTimes(1);
      const refreshing = await cacheState(monitor);
      expect(refreshing).toMatchObject({ payload: null, fetched_at: null, lease_active: true });
      const ownerIndex = consumers.findIndex((consumer) => consumer.owner === refreshing!.refresh_owner);
      expect(ownerIndex).toBeGreaterThanOrEqual(0);

      // Followers stay parked until the real owner-guarded write commits.
      fetchResult.resolve(payload);
      // Observe persisted freshness before allowing followers to resume reads.
      await vi.waitFor(async () => {
        expect(await cacheState(monitor)).toMatchObject({ payload, refresh_owner: null, refresh_lease_until: null });
      }, { timeout: 7_500, interval: 10 });
      followersCanRead.resolve();
      expect(await results).toEqual(consumers.map(() => ({ status: "fulfilled", value: payload })));
      expect(fetchFresh).toHaveBeenCalledTimes(1);
      expect(writeErrors).toEqual([]);
      expect(await testStore(monitor).read(key)).toEqual({ payload, fetchedAtMs: expect.any(Number) });
    } finally {
      fetchResult.resolve(payload);
      followersCanRead.resolve();
      await results;
    }
  });
};
