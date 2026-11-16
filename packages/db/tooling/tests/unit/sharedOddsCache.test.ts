import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSharedOddsBatch, type SharedOddsDependencies } from "@dfs-ev/db/runtime";

afterEach(() => vi.useRealTimers());
const depsFor = (query: SharedOddsDependencies<object>["query"]): SharedOddsDependencies<object> => ({
  query, fetch: vi.fn(async () => ({ a: {} })), makeOwnerId: randomUUID,
  now: Date.now, monotonicNow: () => performance.now(),
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
});

describe("shared odds lifecycle work budgets at production settings", () => {
  it("counts 181 reads and 181 failed claims through the real 250ms / 45s policy", async () => {
    vi.useFakeTimers();
    const query = vi.fn(async (text: string) => text.includes('claim_shared')
      ? [{ outcome: 'follower', resources: {}, owned_keys: [] }] : []);
    const deps = depsFor(query);
    const result = getSharedOddsBatch('event', ['a'], deps, { ttlMs: 90_000 });
    const rejection = expect(result).rejects.toThrow('Timed out waiting');
    await vi.advanceTimersByTimeAsync(45_000);
    await rejection;
    expect(query.mock.calls.filter(([text]) => text.includes('SELECT market_key'))).toHaveLength(181);
    expect(query.mock.calls.filter(([text]) => text.includes('claim_shared'))).toHaveLength(181);
    expect(query).toHaveBeenCalledTimes(362);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("renews at 10 seconds and bounds an abort-aware provider at 20 seconds", async () => {
    vi.useFakeTimers();
    const query = vi.fn(async (text: string) => {
      if (text.includes('claim_shared')) return [{ outcome: 'leader', resources: {}, owned_keys: ['a'] }];
      if (text.includes('renew_shared')) return [{ renewed: true }];
      return [];
    });
    const deps = depsFor(query);
    deps.fetch = vi.fn((_keys, signal) => new Promise<Record<string, object>>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const result = getSharedOddsBatch('event', ['a'], deps, { ttlMs: 90_000 });
    const rejection = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
    expect(query.mock.calls.filter(([text]) => text.includes('renew_shared'))).toHaveLength(1);
    expect(query.mock.calls.filter(([text]) => text.includes('release_shared'))).toHaveLength(1);
    expect(query.mock.calls.filter(([text]) => text.includes('publish_shared'))).toHaveLength(0);
    expect(deps.fetch).toHaveBeenCalledOnce();
  });

  it("does not begin a provider call if claim response arrives after lease expiry", async () => {
    let monotonic = 0;
    const query = vi.fn(async (text: string) => {
      if (text.includes('claim_shared')) {
        monotonic = 30_001;
        return [{ outcome: 'leader', resources: {}, owned_keys: ['a'] }];
      }
      return [];
    });
    const deps = { ...depsFor(query), monotonicNow: () => monotonic };
    await expect(getSharedOddsBatch('event', ['a'], deps, { ttlMs: 90_000 })).rejects.toThrow('expired before provider');
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(query.mock.calls.filter(([text]) => text.includes('release_shared'))).toHaveLength(1);
  });
});
