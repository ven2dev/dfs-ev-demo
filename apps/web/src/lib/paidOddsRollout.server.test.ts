import type * as ConfigModule from './config.server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { getSharedOddsBatch, paidAdmissionSql, type AdmissionQuery, type SubjectDimension } from '@dfs-ev/db/runtime';
const m = vi.hoisted(() => ({ database: vi.fn(), verify: vi.fn(), adminLoads: vi.fn() }));
vi.mock('./db', () => ({ getSql: () => { m.database();throw Error('real query forbidden'); } }));
vi.mock('./firebaseAdmin', () => ({ getAdminAuth: () => { m.adminLoads();return { verifyIdToken: m.verify }; } }));
vi.mock('./config.server', async original => ({ ...await original<typeof ConfigModule>(), serverConfig: {
  paidOddsMode: () => 'log-only', environment: () => 'production', databaseConfigured: () => false,
  collectorHealth: () => ({ quotaReserve: 100 }),
  paidOdds: () => ({ keyring: [{ version: 'v1', keyHex: '11'.repeat(32) }], policies: {
    anonymousNetwork: { intervalMs: 1000, burst: 1 }, signedNetwork: { intervalMs: 1000, burst: 100 }, user: { intervalMs: 1000, burst: 2 },
  } }),
} }));
vi.mock('./oddsCacheStartup', () => ({ initializeOddsCache: vi.fn(async () => 'shared'), oddsCacheStatus: () => 'shared' }));
import { createOddsSubjectResolver } from './oddsSubject';
import { createPaidOddsMode } from './paidOddsMode';
import { createPaidOddsBoundary } from './paidOddsBoundary';
import { createServerConfig } from './config.server';
import type { PaidOddsCapability } from './paidOddsStartup';
import type { OddsCacheStatus } from './oddsCacheStartup';
type State = { capability: PaidOddsCapability; shared: OddsCacheStatus };
import { createPaidRefreshRequest } from './paidOddsBoundary';
const subject = (name: string): SubjectDimension[] => [{ keys: [`v1:anonymous-network:${name.repeat(64)}`],
  report: `v1:anonymous-network:${name.repeat(64)}`, intervalMs: 1000, burst: 1, traffic: 'anonymous' }];
const metrics: Record<string, unknown>[] = [];
const anonymous = { resolveSubject: vi.fn(async () => subject('a')) };
const setup = (raw: unknown = undefined, patch: Partial<State> = {}, deny = false) => {
  const state: State = { capability: 'ready', shared: 'shared', ...patch };
  const floor = vi.fn(async () => {}), warn = vi.fn();
  const query = vi.fn<AdmissionQuery>().mockImplementation(async (_text, params) => [{
    outcome: deny && params[1] ? 'subject-rate-limit' : 'allow', retry_after_ms: deny ? '1000' : '0',
    denied_subjects: deny ? JSON.parse(params[0] as string).flatMap((d: SubjectDimension) => d.keys) : [],
    warning: null, quota_remaining: 1000, would_deny: deny && !params[1],
  }]);
  const config = createServerConfig(name => name === 'ODDS_SUBJECT_MODE' ? raw as string | undefined : undefined);
  const mode = createPaidOddsMode({ read: () => config.paidOddsMode(), capability: () => state.capability,
    sharedCache: () => state.shared, warn });
  const boundary = createPaidOddsBoundary({ initialize: async () => state.capability, query, fallbackFloor: floor,
    reserve: () => 100, enforce: () => mode.requested() === 'enforce',
    sharedCacheReady: async () => state.capability === 'ready' && state.shared === 'shared', warn, now: () => 0 });
  const instance = { ...boundary, health: mode.health };
  return { instance, query, floor, warn, state };
};
const signed = () => createPaidRefreshRequest({ headers: new Headers({ authorization: 'Bearer synthetic',
  'x-vercel-forwarded-for': '203.0.113.7' }) } as NextRequest);
beforeEach(() => {
  vi.clearAllMocks();m.verify.mockResolvedValue({ uid: 'synthetic-user', exp: Math.floor(Date.now() / 1000) + 3600 });
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('network forbidden'); }));
});
afterEach(() => { expect(m.database).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();vi.restoreAllMocks(); });
describe('224-rollout-two-instances-20-leaders', () => {
  it('missing and explicit log-only preserve shadow despite a would-deny result', async () => {
    for (const raw of [undefined, 'log-only']) {
      const s = setup(raw, {}, true);await s.instance.check(anonymous);
      expect(s.instance.health()).toMatchObject({ requestedMode: 'log-only', effectiveMode: 'log-only' });
      expect(s.query.mock.calls).toHaveLength(1);expect(s.query.mock.calls[0][1][1]).toBe(false);
      expect(s.instance.deniedSize()).toBe(0);
    }
  });
  it.each([
    { capability: 'not-installed' as const }, { capability: 'unavailable' as const },
    { shared: 'legacy' as const }, { shared: 'not-initialized' as const },
  ])('enforce request with %j downgrades without a health-only readiness probe', async patch => {
    const s = setup('enforce', patch, true);
    for (let i = 0; i < 10; i++) expect(s.instance.health().effectiveMode).toBe('log-only');
    expect(s.query).not.toHaveBeenCalled();expect(s.floor).not.toHaveBeenCalled();
    await s.instance.check(anonymous);
    expect(s.query.mock.calls.length + s.floor.mock.calls.length).toBe(1);
    if (s.query.mock.calls.length) expect(s.query.mock.calls[0][1][1]).toBe(false);
  });
  it('twenty eligible leaders across two owners use exactly one existing admission each', async () => {
    const owners = [setup('enforce'), setup('enforce')];
    await Promise.all(Array.from({ length: 20 }, (_, i) => owners[i % 2].instance.check(anonymous)));
    expect(owners.reduce((n, s) => n + s.query.mock.calls.length, 0)).toBe(20);
    metrics.push({ name: 'twenty-leaders', leaders: 20, owners: owners.length, admissionStatements: owners.reduce((n,s)=>n+s.query.mock.calls.length,0), extraModeStatements: owners.reduce((n,s)=>n+s.query.mock.calls.length,0)-20 });
    for (const s of owners) {
      expect(s.query.mock.calls.every(([text, params]) => text === paidAdmissionSql && params[1] === true)).toBe(true);
      for (let i = 0; i < 10; i++) expect(s.instance.health().effectiveMode).toBe('enforce');
      expect(s.query).toHaveBeenCalledTimes(10);expect(s.floor).not.toHaveBeenCalled();
    }
  });
  it('compatible log-only replacement ignores old denial state and sends no reset SQL', async () => {
    const old = setup('enforce', {}, true);
    await expect(old.instance.check(anonymous)).rejects.toMatchObject({ reason: 'subject-rate-limit' });
    expect(await old.instance.beforeClaim(anonymous)).toBe(true);
    const replacement = setup('log-only', {}, true);
    expect(await replacement.instance.beforeClaim(anonymous)).toBe(false);
    await replacement.instance.check(anonymous);
    expect(replacement.instance.health().effectiveMode).toBe('log-only');
    expect(replacement.query.mock.calls.every(([text, p]) => text === paidAdmissionSql && p[1] === false)).toBe(true);
    // Old reachable instances can still refuse; operational drain remains necessary.
    expect(await old.instance.beforeClaim(anonymous)).toBe(true);
    expect(old.query).toHaveBeenCalledTimes(1);expect(replacement.query).toHaveBeenCalledTimes(1);
    metrics.push({ name: 'rollback', oldAdmissionStatements: old.query.mock.calls.length, replacementAdmissionStatements: replacement.query.mock.calls.length, resetStatements: replacement.query.mock.calls.filter(([text])=>text!==paidAdmissionSql).length, oldCachedDenialStillRequiresDrain: await old.instance.beforeClaim(anonymous) });
  });
  it('storage failure stays allow-on-error with one reason warning in either mode', async () => {
    for (const mode of ['log-only', 'enforce']) {
      const s = setup(mode);s.query.mockRejectedValue(new Error('synthetic private database detail'));
      await s.instance.check(anonymous);
      expect(s.query).toHaveBeenCalledTimes(1);expect(s.warn.mock.calls).toEqual([['limiter-storage-failed']]);
      expect(s.floor).not.toHaveBeenCalled();
    }
  });
  it('a known floor refusal survives counter failure and never populates subject deny cache', async () => {
    const s = setup('enforce');s.query.mockResolvedValue([{ outcome: 'quota-floor', retry_after_ms: '0', denied_subjects: [],
      warning: 'limiter-counter-failed', quota_remaining: 10, would_deny: false }]);
    await expect(s.instance.check(anonymous)).rejects.toMatchObject({ reason: 'quota-floor' });
    expect(s.instance.deniedSize()).toBe(0);expect(s.warn.mock.calls).toEqual([['limiter-counter-failed']]);
  });
  it('fresh hit does only its existing read and zero verification even with enforce denial cache primed', async () => {
    const s = setup('enforce', {}, true);
    await expect(s.instance.check(anonymous)).rejects.toBeDefined();s.query.mockClear();
    const context = signed();const read = vi.fn(async () => [{ market_key: 'player_pass_yds', fresh: true,
      payload: { bookmakers: [] }, fetched_at: new Date().toISOString() }]);
    await getSharedOddsBatch('fixture', ['player_pass_yds'], {
      query: read, shouldDenyRefresh: () => s.instance.beforeClaim(context),
      fetch: vi.fn(async () => { throw Error('fresh hit must not send'); }),
      makeOwnerId: () => 'owner', monotonicNow: () => performance.now(), wait: vi.fn(),
    }, { ttlMs: 90000 });
    expect(read).toHaveBeenCalledTimes(1);expect(s.query).not.toHaveBeenCalled();expect(m.verify).not.toHaveBeenCalled();
    metrics.push({ name: 'fresh-hit', existingReads: read.mock.calls.length, admissionStatements: s.query.mock.calls.length, verifications: m.verify.mock.calls.length });
  });
  it('pre-claim identity coalesces once for a later follower with zero admission SQL', async () => {
    const s = setup('enforce', {}, true);
    await expect(s.instance.check(anonymous)).rejects.toBeDefined();s.query.mockClear();
    const context = signed();let reads = 0, claims = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT market_key')) { reads++;return reads > 1 ? [{ market_key: 'player_pass_yds', fresh: true,
        payload: { bookmakers: [] }, fetched_at: new Date().toISOString() }] : []; }
      if (sql.includes('claim_shared_odds_batch')) { claims++;return [{ outcome: 'follower', owned_keys: [], resources: {} }]; }
      throw Error('unexpected SQL');
    });
    await getSharedOddsBatch('fixture', ['player_pass_yds'], {
      query, shouldDenyRefresh: () => s.instance.beforeClaim(context),
      fetch: vi.fn(async () => { throw Error('follower must not send'); }),
      makeOwnerId: () => 'owner', monotonicNow: () => performance.now(), wait: vi.fn(async () => {}),
    }, { ttlMs: 90000 });
    await Promise.all([context.resolveSubject(), context.resolveSubject()]);
    expect(m.verify.mock.calls).toEqual([['synthetic', false]]);
    expect(s.query).not.toHaveBeenCalled();expect({ reads, claims }).toEqual({ reads: 2, claims: 1 });
    metrics.push({ name: 'eventual-follower', existingReads: reads, existingClaims: claims, extraFollowerStatements: query.mock.calls.length-reads-claims, admissionStatements: s.query.mock.calls.length, verifications: m.verify.mock.calls.length });
  });
  it('readiness loss bypasses an existing denial cache without extra queries', async () => {
    const s = setup('enforce', {}, true);
    await expect(s.instance.check(anonymous)).rejects.toBeDefined();s.query.mockClear();
    s.state.capability = 'unavailable';
    expect(s.instance.health()).toMatchObject({ requestedMode: 'enforce', effectiveMode: 'log-only' });
    expect(await s.instance.beforeClaim(anonymous)).toBe(false);
    expect(s.query).not.toHaveBeenCalled();expect(s.floor).not.toHaveBeenCalled();
  });
  it('the pre-claim memo expires without a second SDK check or a signed allowance', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100000);
    m.verify.mockResolvedValue({ uid: 'synthetic-user', exp: 101 });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = setup('enforce', {}, true);
    await expect(s.instance.check(anonymous)).rejects.toBeDefined();s.query.mockClear();
    const context = signed();
    await Promise.all([s.instance.beforeClaim(context), context.resolveSubject()]);
    clock.mockReturnValue(101000);
    await s.instance.beforeClaim(context);
    expect((await context.resolveSubject())![0].traffic).toBe('anonymous');
    expect(m.verify).toHaveBeenCalledTimes(1);expect(s.query).not.toHaveBeenCalled();
    expect(warning.mock.calls).toEqual([['[paid-odds] invalid-token']]);
  });
  it('repeat cached subject denial adds zero claim/admission/release statements after the freshness read', async () => {
    const s = setup('enforce', {}, true);
    await expect(s.instance.check(anonymous)).rejects.toBeDefined();s.query.mockClear();
    const query = vi.fn(async (sql: string) => { expect(sql).toContain('SELECT market_key');return []; });
    for (let i = 0; i < 5; i++) {
      const result = await getSharedOddsBatch('fixture', ['player_pass_yds'], {
        query, shouldDenyRefresh: () => s.instance.beforeClaim(anonymous), fetch: vi.fn(),
        makeOwnerId: () => 'owner', monotonicNow: () => performance.now(), wait: vi.fn(),
      }, { ttlMs: 90000 });
      expect(result.player_pass_yds.state).toBe('unavailable');
    }
    expect(query).toHaveBeenCalledTimes(5);expect(s.query).not.toHaveBeenCalled();
    metrics.push({ name: 'repeat-cached-denial', requests: 5, existingFreshnessReads: query.mock.calls.length, addedClaimAdmissionReleaseStatements: query.mock.calls.length-5+s.query.mock.calls.length });
  });
  it.each(['log-only', 'enforce'])('counter failure allows in %s with one sanitized warning', async mode => {
    const s = setup(mode);
    s.query.mockResolvedValue([{ outcome: 'allow', retry_after_ms: '0', denied_subjects: [],
      warning: 'limiter-counter-failed', quota_remaining: 500, would_deny: false }]);
    await s.instance.check(anonymous);
    expect(s.warn.mock.calls).toEqual([['limiter-counter-failed']]);
    expect(s.query).toHaveBeenCalledTimes(1);expect(s.instance.deniedSize()).toBe(0);
  });
  it('a previously denied subject receives a newly fresh payload before any denial check', async () => {
    const s = setup('enforce', {}, true);
    await expect(s.instance.check(anonymous)).rejects.toBeDefined();s.query.mockClear();
    const beforeClaim = vi.fn(() => s.instance.beforeClaim(anonymous));
    const query = vi.fn(async () => [{ market_key: 'player_pass_yds', fresh: true,
      payload: { bookmakers: [] }, fetched_at: new Date().toISOString() }]);
    const result = await getSharedOddsBatch('fixture', ['player_pass_yds'], { query,
      shouldDenyRefresh: beforeClaim, fetch: vi.fn(), makeOwnerId: () => 'owner',
      monotonicNow: () => performance.now(), wait: vi.fn() }, { ttlMs: 90000 });
    expect(result.player_pass_yds.state).toBe('fresh');expect(query).toHaveBeenCalledTimes(1);
    expect(beforeClaim).not.toHaveBeenCalled();expect(s.query).not.toHaveBeenCalled();
  });
  it('rotation overlap and rollback submit both versions and report only the newest without reset SQL', async () => {
    const resolveSubject = createOddsSubjectResolver({
      headers: new Headers({ 'x-vercel-forwarded-for': '203.0.113.7', authorization: 'Bearer synthetic' }),
      platform: 'vercel', verifiedUid: async () => 'synthetic-user', warn: vi.fn(),
      keyring: [{ version: 'v1', keyHex: '11'.repeat(32) }, { version: 'v2', keyHex: '22'.repeat(32) }],
      policies: { anonymousNetwork: { intervalMs: 1000, burst: 1 },
        signedNetwork: { intervalMs: 1000, burst: 100 }, user: { intervalMs: 1000, burst: 2 } },
    });
    const request = { resolveSubject }, old = setup('enforce'), replacement = setup('log-only');
    await old.instance.check(request);await replacement.instance.check(request);
    for (const [instance, enforce] of [[old, true], [replacement, false]] as const) {
      expect(instance.query).toHaveBeenCalledTimes(1);
      const [text, params] = instance.query.mock.calls[0];
      expect(text).toBe(paidAdmissionSql);expect(params[1]).toBe(enforce);
      const dimensions = JSON.parse(params[0] as string) as SubjectDimension[];
      expect(dimensions).toHaveLength(2);
      for (const d of dimensions) {
        expect(d.keys).toHaveLength(2);expect(d.keys[0]).toMatch(/^v1:/);
        expect(d.keys[1]).toMatch(/^v2:/);expect(d.report).toBe(d.keys[1]);
      }
      expect(JSON.stringify(params)).not.toMatch(/203\.0\.113|synthetic-user|synthetic-token/);
    }
  });

});
