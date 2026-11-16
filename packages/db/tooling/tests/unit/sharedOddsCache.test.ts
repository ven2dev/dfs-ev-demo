import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSharedOddsBatch, type SharedOddsDependencies } from "@dfs-ev/db/runtime";

afterEach(() => vi.useRealTimers());
const depsFor = (query: SharedOddsDependencies<object>["query"]): SharedOddsDependencies<object> => ({
  query, fetch: vi.fn(async () => ({ a: {} })), makeOwnerId: randomUUID,
  monotonicNow: () => performance.now(),
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
  it.each([false, true])("aborts on failed/thrown renewal without publishing or retrying; thrown=%s", async thrown => {
    vi.useFakeTimers();
    const query = vi.fn(async (text: string) => {
      if (text.includes('claim_shared')) return [{ outcome: 'leader', resources: {}, owned_keys: ['a'] }];
      if (text.includes('renew_shared')) {
        if (thrown) throw new Error('database unavailable');
        return [{ renewed: false }];
      }
      return [];
    });
    const deps = depsFor(query);
    deps.fetch = vi.fn((_keys, signal) => new Promise<Record<string, object>>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const result = getSharedOddsBatch('event', ['a'], deps, { ttlMs: 90_000 });
    const rejection = expect(result).rejects.toThrow(thrown ? 'Failed to renew' : 'lease was lost');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(deps.fetch).toHaveBeenCalledOnce();
    expect(query.mock.calls.filter(([text]) => text.includes('publish_shared'))).toHaveLength(0);
    expect(query.mock.calls.filter(([text]) => text.includes('release_shared'))).toHaveLength(1);
  });

  it("keeps renewing during a 25-second publication after the provider completed", async () => {
    vi.useFakeTimers();
    const publication = Promise.withResolvers<Record<string, unknown>[]>();
    const query = vi.fn(async (text: string) => {
      if (text.includes('claim_shared')) return [{ outcome: 'leader', resources: {}, owned_keys: ['a'] }];
      if (text.includes('renew_shared')) return [{ renewed: true }];
      if (text.includes('publish_shared')) return publication.promise;
      return [];
    });
    const deps = depsFor(query);
    const result = getSharedOddsBatch('event', ['a'], deps, { ttlMs: 90_000 });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(query.mock.calls.filter(([text]) => text.includes('renew_shared'))).toHaveLength(2);
    expect(query.mock.calls.filter(([text]) => text.includes('release_shared'))).toHaveLength(0);
    publication.resolve([]);
    expect((await result).a.state).toBe('upstream');
    expect(query).toHaveBeenCalledTimes(5); // read, claim, publish, two renewals
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['before-read', 'after-claim', 'while-waiting'])("respects caller cancellation %s", async phase => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const query = vi.fn(async (text: string) => {
      if (text.includes('claim_shared')) {
        if (phase === 'after-claim') controller.abort(new Error('caller stopped'));
        return [{ outcome: phase === 'while-waiting' ? 'follower' : 'leader', resources: {}, owned_keys: ['a'] }];
      }
      return [];
    });
    const deps = { ...depsFor(query), signal: controller.signal };
    if (phase === 'before-read') controller.abort(new Error('caller stopped'));
    const result = getSharedOddsBatch('event', ['a'], deps, { ttlMs: 90_000 });
    const rejection = expect(result).rejects.toThrow('caller stopped');
    await vi.advanceTimersByTimeAsync(0);
    if (phase === 'while-waiting') {
      controller.abort(new Error('caller stopped'));
      await vi.advanceTimersByTimeAsync(250);
    }
    await rejection;
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(phase === 'before-read' ? 0 : phase === 'after-claim' ? 3 : 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never retries an ambiguous outcome and releases only its own batch", async () => {
    const query = vi.fn(async (text: string) => text.includes('claim_shared')
      ? [{ outcome: 'leader', resources: {}, owned_keys: ['a'] }] : []);
    const deps = depsFor(query);
    deps.fetch = vi.fn(async () => { throw new Error('ambiguous outcome'); });
    await expect(getSharedOddsBatch('event', ['a'], deps, { ttlMs: 90_000 })).rejects.toThrow('ambiguous outcome');
    expect(deps.fetch).toHaveBeenCalledOnce();
    expect(query.mock.calls.filter(([text]) => text.includes('publish_shared'))).toHaveLength(0);
    expect(query.mock.calls.filter(([text]) => text.includes('release_shared'))).toHaveLength(1);
  });

  it("requires explicit empty slices rather than silently omitting an owned market", async () => {
    const query = vi.fn(async (text: string) => text.includes('claim_shared')
      ? [{ outcome: 'leader', resources: {}, owned_keys: ['a'] }] : []);
    const deps = depsFor(query);
    deps.fetch = vi.fn(async () => ({}));
    await expect(getSharedOddsBatch('event', ['a'], deps, { ttlMs: 90_000 })).rejects.toThrow('explicit empty slices');
    expect(query.mock.calls.filter(([text]) => text.includes('publish_shared'))).toHaveLength(0);
  });

  it("uses monotonic elapsed time so a host-clock rollback cannot extend follower work", async () => {
    vi.useFakeTimers();
    const query = vi.fn(async (text: string) => text.includes('claim_shared')
      ? [{ outcome: 'follower', resources: {}, owned_keys: [] }] : []);
    const deps = depsFor(query);
    const result = getSharedOddsBatch('event', ['a'], deps, { ttlMs: 90_000 });
    const rejection = expect(result).rejects.toThrow('Timed out waiting');
    await vi.advanceTimersByTimeAsync(22_500);
    vi.setSystemTime(Date.now() - 60_000);
    await vi.advanceTimersByTimeAsync(22_500);
    await rejection;
    expect(query).toHaveBeenCalledTimes(362);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

});
