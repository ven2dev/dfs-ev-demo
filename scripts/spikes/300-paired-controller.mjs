// Never-merge #300 owner-run orchestration. Importing performs no I/O or requests.
// The measured #220 sources are read/hashed, never rewritten by this controller.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runSchedule, sameSubjectControl } from './220-hosted/plan.mjs';
import { distribution, runGroup, summarizeRun, verifyPreview } from './220-hosted/load.mjs';
import { sampleKey } from '../../apps/web/src/lib/qualification220-core.mjs';

export const INVOCATION_CAP = 40_000;
export const TIMEOUT_GATE = '6f3ea1a:docs/220-hosted-qualification-plan.md#package-2-step-3';
const root = fileURLToPath(new URL('../../', import.meta.url));
const topologies = ['single-node', 'ha'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const measured = Object.freeze({
  'apps/web/src/lib/qualification220-core.mjs': 'bfdf1e48cd5cbb1604246d8b49d7a96afa7aa32f227ec56a37ce6bb6d82b4695',
  'apps/web/src/lib/qualification220-pg.mjs': '685c1e4aa59e8df03b90eb251676c314fbd8a247e59249a552df4805370183eb',
  'apps/web/src/app/api/qualification220/route.ts': '7620b4d9cee437c19125f434b6e6c9e69d12ff0719b371d04c839b75b586a41d',
  'apps/web/src/proxy.ts': '9f276559573f147b4d3d66d58727f1d40894f195473c830a50320e4f7511cc85',
  'apps/web/vercel.json': '79f4050686a395b131cf1e8d78b9323db4a35c4157e9530cb6181bb2190d80cd',
  'scripts/spikes/220-hosted/plan.mjs': 'df8bdaacc51ddb1f6adfc6ed222894fd090662e31b5ee13522b8144b3d22c22f',
  'scripts/spikes/220-hosted/load.mjs': 'c75f8dae7bb4869d3904f771c50137decf7de21ee4390a5fb9b5ca3366608be3',
  'scripts/spikes/220-hosted/setup.mjs': '6ce116c23ebcb4130c900fbfbc8edd38936cc477d2148852fed3a8947f98efba',
  'packages/db/proposals/220_atomic_leader_gcra.sql': '425c36415fd2cb4eeebd9de59fd07b024d0ba5d92da6a97e37d3874da96bf208',
  'packages/db/proposals/220_hosted_harness.sql': '009d75e313aad8af0b98d81e9af93860e721311fef054776fcb2bd705230ec89',
  'tests/220-hosted-harness.check.mjs': 'd297aa0b90965d1af59c7848a8bcd23cf83bc8a7b62ddad233beea697391010d',
});

export function verifyMeasuredSources() {
  for (const [file, sha256] of Object.entries(measured))
    assert.equal(digest(readFileSync(resolve(root, file))), sha256, 'measured source changed; stop for review');
  return { ...measured };
}

export function pairedManifest() {
  // Keep each arm's inherited ordering; only interleave matching arm blocks.
  return [...runSchedule(), sameSubjectControl()].map(samples => ({
    order: samples[0].round === 1 ? ['ha', 'single-node'] : ['single-node', 'ha'],
    samples,
  }));
}

class Ledger {
  used = 0;
  sequence = 0;
  closed = false;
  constructor(path) {
    // Exclusive creation prevents both overwrite and automatic crash resume.
    this.fd = openSync(path, 'wx', 0o600);
  }
  record(event) {
    assert(!this.closed, 'ledger closed; no resume');
    writeFileSync(this.fd, JSON.stringify({ sequence: this.sequence++, ...event }) + '\n');
    fsyncSync(this.fd);
  }
  reserve(count, context) {
    assert(Number.isSafeInteger(count) && count > 0 && this.used + count <= INVOCATION_CAP,
      'invocation cap; refuse whole wave');
    this.record({ kind: 'reserve', ...context, count, total: this.used + count });
    this.used += count; // Never refund an ambiguous or failed dispatch.
  }
  close() {
    if (!this.closed) { this.closed = true; closeSync(this.fd); }
  }
}

function context(options, ledger) {
  assert.equal(options.approved, true, 'fresh owner-run approval required');
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Node 24 required');
  for (const key of ['fetchImpl', 'prepare', 'timeoutGate'])
    assert.equal(typeof options[key], 'function', 'explicit transport and owner gates required');
  const arms = structuredClone(options.arms);
  const urls = {};
  for (const topology of topologies) {
    const arm = arms?.[topology];
    assert.equal(arm?.binding?.database?.topology, topology, 'wrong topology association');
    urls[topology] = verifyPreview(arm.deployment, arm.binding, options.expectedSha);
    assert(/^[a-f0-9]{64}$/.test(arm.credentials?.bearer ?? '') &&
      typeof arm.credentials?.bypass === 'string' && arm.credentials.bypass.length >= 16, 'private credentials required');
  }
  for (const get of [a => a.binding.runId, a => a.deployment.id, a => a.deployment.url,
    a => a.binding.database.host])
    assert.notEqual(get(arms['single-node']), get(arms.ha), 'arms require distinct resources and deployments');
  return { ...options, arms, urls, ledger, active: new Set(), stopped: false, reason: null,
    gated: new Set(), groups: { 'single-node': [], ha: [] }, historical: {}, trials: [] };
}

function stop(ctx, reason) {
  if (!ctx.stopped) {
    ctx.stopped = true;
    ctx.reason = reason;
    ctx.ledger.record({ kind: 'stop', reason, used: ctx.ledger.used,
      backendQuiescence: 'owner verification required after failed or ambiguous requests' });
  }
}

async function transport(ctx, url, options) {
  // Reservation is persisted before entering this function, avoiding per-send
  // disk work that could serialize the 20 concurrent requests being measured.
  const pending = Promise.resolve().then(() => ctx.fetchImpl(url, options));
  ctx.active.add(pending);
  try { return await pending; } finally { ctx.active.delete(pending); }
}

async function timeoutGate(ctx, topology) {
  if (ctx.gated.has(topology)) return;
  let open = true;
  const pending = [];
  try {
    const result = await ctx.timeoutGate({ topology, method: TIMEOUT_GATE,
      // Every extra FUNCTION invocation uses the same ledger. Direct pooled SQL
      // is operator work, not a Vercel invocation; the accepted gate is unchanged.
      invoke: options => {
        assert(open && !ctx.stopped, 'preflight closed; no late invocation');
        try { ctx.ledger.reserve(1, { topology, purpose: 'timeout-gate' }); }
        catch { stop(ctx, 'timeout gate invocation cap or ledger failed'); throw new Error('preflight refused'); }
        const arm = ctx.arms[topology];
        const task = transport(ctx, ctx.urls[topology], { ...options, redirect: 'error',
          signal: AbortSignal.timeout(35_000), headers: { ...options?.headers,
            authorization: `Bearer ${arm.credentials.bearer}`,
            'x-vercel-protection-bypass': arm.credentials.bypass } });
        // Observe immediately even if the owner gate awaits other pool work.
        task.catch(() => {});
        pending.push(task);
        return task;
      } });
    open = false;
    const settled = await Promise.allSettled(pending);
    assert(!ctx.stopped, 'preflight stopped');
    assert(settled.every(item => item.status === 'fulfilled'), 'preflight request failed');
    assert(result?.passed === true && /^[a-f0-9]{64}$/.test(result.receiptSha256 ?? ''),
      'accepted timeout gate not verified');
    ctx.ledger.record({ kind: 'timeout-gate', topology, method: TIMEOUT_GATE,
      receiptSha256: result.receiptSha256, invocations: pending.length });
    ctx.gated.add(topology);
  } catch {
    open = false;
    await Promise.allSettled(pending);
    stop(ctx, 'timeout gate or invocation cap failed');
  }
}

function trialReport(topology, group) {
  return { topology, group: group.group, samples: group.rows.length,
    preProvider: distribution(group.rows.map(row => row.inFunctionPreProviderMs)),
    sql: distribution(group.rows.map(row => row.preProviderSqlMs)),
    checkout: distribution(group.rows.map(row => row.preProviderCheckoutMs)) };
}

async function runBlock(ctx, topology, samples) {
  if (ctx.stopped) return;
  if (ctx.signal?.aborted) { stop(ctx, 'owner stopped scheduling'); return; }
  await timeoutGate(ctx, topology);
  if (ctx.stopped) return;
  // Split warmup/warm and stale/next-tick without changing any sample identity.
  const stages = [...new Set(samples.map(sample => sample.stage))];
  for (const stage of stages) {
    const groupSamples = samples.filter(sample => sample.stage === stage);
    const first = groupSamples[0];
    const groupKey = [stage, first.workers, first.round, first.mode].join(':');
    try {
      assert.equal(ctx.active.size, 0, 'requests not drained');
      if (ctx.signal?.aborted) { stop(ctx, 'owner stopped scheduling'); return; }
      const prepared = await ctx.prepare({ topology, group: groupKey });
      assert(prepared?.quiescent === true && Number.isSafeInteger(prepared.sqlStatements) &&
        prepared.sqlStatements >= 0, 'fixture preparation or quiescence unverified');
      ctx.ledger.record({ kind: 'prepare', topology, group: groupKey, sqlStatements: prepared.sqlStatements });
    } catch { stop(ctx, 'fixture preparation or quiescence failed'); return; }
    const rows = [];
    let group;
    for (let offset = 0; offset < groupSamples.length; offset += first.workers) {
      if (ctx.signal?.aborted) { stop(ctx, 'owner stopped scheduling'); return; }
      const wave = groupSamples.slice(offset, offset + first.workers);
      try {
        assert.equal(wave.length, first.workers, 'partial concurrency wave refused');
        ctx.ledger.reserve(wave.length, { topology, group: groupKey, offset, purpose: 'matrix' });
        group = await runGroup({ ...ctx.arms[topology], expectedSha: ctx.expectedSha,
          samples: wave, approved: true,
          fetchImpl: (url, options) => transport(ctx, url, options) });
        rows.push(...group.rows);
        ctx.ledger.record({ kind: 'wave', topology, group: groupKey, offset,
          dispatched: wave.length, rows: group.rows });
        assert.equal(ctx.active.size, 0, 'requests not drained');
        if (group.failures) { stop(ctx, 'sample failed; no retry'); return; }
        // The inherited per-wave .passed flag is deliberately not a trial gate.
      } catch {
        await Promise.allSettled([...ctx.active]);
        stop(ctx, 'wave or invocation cap failed; no retry');
        return;
      }
    }
    group = { ...group, rows, failures: 0, timing: distribution(rows.map(row => row.inFunctionPreProviderMs)) };
    group.passed = stage !== 'warm' || first.workers !== 20 || group.timing.p95Ms <= 140;
    ctx.groups[topology].push(group);
    const report = trialReport(topology, group);
    report.legacyPassed = group.passed;
    report.screenPassed = stage === 'warm' && first.workers === 20 && first.mode === 'path'
      ? rows.length === 1000 && group.timing.p95Ms <= 63 : null;
    ctx.trials.push(report);
    ctx.ledger.record({ kind: 'group', ...report });
    if (!group.passed || report.screenPassed === false) {
      stop(ctx, 'complete-trial latency gate failed'); return;
    }
    if (stage === 'warm' && ctx.groups[topology].filter(g => g.group.startsWith('warm:')).length === 18) {
      ctx.historical[topology] = summarizeRun(ctx.groups[topology], ctx.expectedSha);
      if (!ctx.historical[topology].passed) { stop(ctx, 'complete-arm legacy gate failed'); return; }
    }
  }
}

async function execute(ctx, manifest) {
  ctx.ledger.record({ kind: 'start', expectedSha: ctx.expectedSha, cap: INVOCATION_CAP,
    sourceHashes: verifyMeasuredSources(), timeoutGate: TIMEOUT_GATE,
    controllerSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    armHashes: Object.fromEntries(topologies.map(topology => [topology, {
      binding: digest(JSON.stringify(ctx.arms[topology].binding)),
      deployment: digest(JSON.stringify(ctx.arms[topology].deployment)),
    }])) });
  for (const block of manifest) {
    for (const topology of block.order) {
      await runBlock(ctx, topology, block.samples);
      if (ctx.stopped) break;
    }
    if (ctx.stopped) break;
  }
  const pairedDeltas = [];
  for (const single of ctx.trials.filter(g => g.topology === 'single-node' && g.group.startsWith('warm:'))) {
    const ha = ctx.trials.find(g => g.topology === 'ha' && g.group === single.group);
    if (ha) pairedDeltas.push({ group: single.group, singleP95Ms: single.preProvider.p95Ms,
      haP95Ms: ha.preProvider.p95Ms, haMinusSingleP95Ms: ha.preProvider.p95Ms - single.preProvider.p95Ms });
  }
  const result = { status: ctx.stopped ? 'stopped' : 'complete', reason: ctx.reason,
    invocationsReserved: ctx.ledger.used, completedGroups: ctx.trials.length,
    timeoutGates: [...ctx.gated], trials: ctx.trials, pairedDeltas,
    historical: ctx.historical, sourceHashes: verifyMeasuredSources() };
  ctx.ledger.record({ kind: 'result', ...result });
  return result;
}

/** Explicit owner hooks are required; there is no CLI that can start hosted work.
 * timeoutGate runs the unchanged archived held-transaction procedure once/arm.
 * prepare confirms backend quiescence and performs existing between-group setup.
 * Actual credentials stay only in the supplied private in-memory arm objects.
 */
export async function runPaired(options) {
  let ledger;
  try {
    verifyMeasuredSources();
    assert.equal(options.approved, true, 'fresh owner-run approval required');
    ledger = new Ledger(options.ledgerPath);
    const ctx = context(options, ledger);
    return await execute(ctx, pairedManifest());
  } catch {
    // SDK/transport/configuration errors can contain private endpoint values.
    throw new Error('paired controller refused or failed; no retry/resume');
  } finally { ledger?.close(); }
}

// All durable probes live in this one approved script. No production network is
// enabled by this mode; missing injection fails rather than falling back to fetch.
async function selfTest() {
  const { test } = await import('node:test');
  const { mkdtempSync, statSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  class MemoryLedger {
    used = 0; events = [];
    record(event) { this.events.push(event.kind === 'wave' ? { ...event, rows: undefined } : event); }
    reserve = Ledger.prototype.reserve;
  }
  const sha = 'b'.repeat(40);
  const fixture = () => {
    const arms = {};
    for (const [i, topology] of topologies.entries()) {
      const binding = { arm: 'iad1', projectId: 'prj_GLXDEeScMKPAeDAUoYIoiNknwKJd', nodeMajor: 24,
        database: { provider: 'planetscale', verified: true, disposable: true, syntheticOnly: true,
          organization: 'synthetic', clusterName: `synthetic-${i}`, branchId: `synthetic-${i}`,
          host: `synthetic-${i}.pg.psdb.cloud`, port: 6432, role: 'spike220_runner_123456abcdef',
          name: 'synthetic', region: 'us-east-1', sku: 'PS-5', topology, postgresMajor: 18 },
        gates: { automationBypass: true, branchScopedSensitive: true, previewProtection: true },
        gitBranch: 'feature/dfsEV-300-ps5-ha-stage1', reviewedSha: sha,
        runId: `12345678-1234-1234-1234-123456789ab${i}` };
      arms[topology] = { binding, credentials: { bearer: 'a'.repeat(64), bypass: 'synthetic-bypass-not-a-real-credential' },
        deployment: { source: 'git', id: `dpl_synthetic${i}`, projectId: binding.projectId,
          target: 'preview', readyState: 'READY', sha, gitBranch: binding.gitBranch,
          protectionVerified: true, url: `https://synthetic-${i}.vercel.app`,
          functionMetadata: { source: 'deployment-function-metadata', deploymentId: `dpl_synthetic${i}`,
            path: '/api/qualification220', regions: ['iad1'] } } };
    }
    return arms;
  };
  const goodResponse = (arms, url, options, ms = 50) => {
    const arm = Object.values(arms).find(a => url.startsWith(a.deployment.url));
    const sample = JSON.parse(options.body);
    const preProviderQueries = sample.mode === 'path' ? 2 : 1;
    const transportProbe = sample.mode === 'baseline' && sample.stage !== 'cold';
    const sqlQueries = preProviderQueries + Number(transportProbe || sample.mode !== 'baseline');
    return Response.json({ sample, arm: 'iad1', region: 'iad1', sha, runId: arm.binding.runId,
      outcome: sample.mode === 'baseline' ? 'baseline' : 'leader', inFunctionPreProviderMs: ms,
      preProviderSqlMs: 5, preProviderCheckoutMs: 1, preProviderQueries, sqlQueries,
      inFunctionTotalMs: ms + 1, transportRoundTripMs: transportProbe ? 1 : null,
      connectionDiagnostic: sample.stage === 'cold' ? 'fresh-client-to-warm-pooler' : null,
      queryTimings: Array.from({ length: sqlQueries }, (_, i) => ({
        operation: transportProbe && i === sqlQueries - 1 ? 'transport' : 'hosted_sample', elapsedMs: 1, checkoutMs: 0 })) });
  };
  const make = (patch = {}) => {
    const arms = fixture(), ledger = new MemoryLedger();
    const ctx = context({ arms, expectedSha: sha, approved: true,
      fetchImpl: (url, options) => goodResponse(arms, url, options),
      prepare: async () => ({ quiescent: true, sqlStatements: 5 }),
      timeoutGate: async () => ({ passed: true, receiptSha256: 'c'.repeat(64) }), ...patch }, ledger);
    return ctx;
  };
  const block20 = () => pairedManifest().find(block => block.samples[0].workers === 20);
  const path20 = () => pairedManifest().find(block => block.samples[0].workers === 20 && block.samples[0].mode === 'path');
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkCalls++; throw new Error('unexpected real network'); };
  process.once('beforeExit', () => { globalThis.fetch = originalFetch; assert.equal(networkCalls, 0); });

  test('measured hashes and all paired sample identities/order stay unchanged', () => {
    assert.equal(Object.keys(verifyMeasuredSources()).length, 11);
    const manifest = pairedManifest();
    assert.equal(manifest.length, 25);
    const samples = manifest.flatMap(block => block.samples);
    assert.equal(samples.length, 18503);
    assert.equal(new Set(samples.map(sampleKey)).size, samples.length);
    assert.deepEqual(samples, [...runSchedule().flat(), ...sameSubjectControl()]);
    for (const block of manifest) assert.deepEqual(block.order,
      block.samples[0].round === 1 ? ['ha', 'single-node'] : ['single-node', 'ha']);
  });
  test('exclusive durable ledger retains ambiguous reservations and refuses resume/cap overflow', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'dfs300-ledger-'));
    const path = resolve(dir, 'ledger.jsonl');
    const ledger = new Ledger(path);
    try {
      ledger.reserve(39980, { purpose: 'synthetic-ambiguous-reservations' });
      ledger.reserve(20, { purpose: 'synthetic-full-wave' });
      assert.equal(ledger.used, 40000);
      assert.throws(() => ledger.reserve(1, {}), /invocation cap/);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)).total, 40000);
      assert.throws(() => new Ledger(path), /EEXIST/);
      ledger.close();
      assert.throws(() => ledger.reserve(1, {}));
      assert.throws(() => new Ledger(path), /EEXIST/);
    } finally { ledger.close(); rmSync(dir, { recursive: true }); }
  });
  test('one-worker failure sends one request and no fixture reset or retry follows', async () => {
    let calls = 0, prepares = 0;
    const ctx = make({ fetchImpl: async () => { calls++; throw new Error('synthetic transport failure'); },
      prepare: async () => { prepares++; return { quiescent: true, sqlStatements: 5 }; } });
    const result = await execute(ctx, pairedManifest());
    assert.equal(result.status, 'stopped'); assert.equal(calls, 1); assert.equal(prepares, 1);
    assert.equal(result.invocationsReserved, 1); assert.equal(result.completedGroups, 0);
    // Exercise the public entry point with a real private, durable ledger too.
    const dir = mkdtempSync(resolve(tmpdir(), 'dfs300-public-'));
    const options = { approved: true, arms: fixture(), expectedSha: sha,
      ledgerPath: resolve(dir, 'ledger.jsonl'), fetchImpl: async () => new Response(null, { status: 503 }),
      prepare: async () => ({ quiescent: true, sqlStatements: 5 }),
      timeoutGate: async () => ({ passed: true, receiptSha256: 'c'.repeat(64) }) };
    try {
      const durable = await runPaired(options);
      assert.equal(durable.invocationsReserved, 1); assert.equal(durable.status, 'stopped');
      const events = readFileSync(options.ledgerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(events.at(-1).kind, 'result');
      assert.equal(events.filter(event => event.kind === 'reserve').length, 1);
      assert.equal(statSync(options.ledgerPath).mode & 0o777, 0o600);
      await assert.rejects(runPaired(options), /no retry\/resume/);
    } finally { rmSync(dir, { recursive: true }); }
  });
  test('20-worker failure drains a deferred sibling before returning and sends no next wave', async () => {
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const deferred = new Promise(resolve => { release = resolve; });
    let calls = 0, finished = false;
    const ctx = make({ fetchImpl: async () => {
      const index = calls++;
      if (index === 19) { entered(); await deferred; }
      return new Response(null, { status: 503 });
    } });
    const pending = runBlock(ctx, 'single-node', block20().samples).then(() => { finished = true; });
    await waiting;
    await new Promise(resolve => setImmediate(resolve));
    try {
      assert.equal(calls, 20); assert.equal(finished, false); assert.equal(ctx.active.size, 1);
    } finally { release(); await pending; }
    assert.equal(ctx.stopped, true); assert.equal(calls, 20); assert.equal(ctx.active.size, 0);
    assert.equal(ctx.trials.length, 0); assert.equal(ctx.ledger.used, 20);
    await runBlock(ctx, 'ha', block20().samples); assert.equal(calls, 20);
  });
  test('protocol, timeout, identity, outcome and work-budget failures stop the first full wave', async () => {
    for (const failure of ['protocol', 'timeout', 'identity', 'outcome', 'budget']) {
      let calls = 0;
      const ctx = make();
      ctx.fetchImpl = async (url, options) => {
        calls++;
        if (failure === 'protocol') return new Response('not-json', { status: 200 });
        if (failure === 'timeout') throw new DOMException('synthetic', 'TimeoutError');
        const body = await goodResponse(ctx.arms, url, options).json();
        if (failure === 'identity') body.runId = 'synthetic-wrong-run';
        if (failure === 'outcome') body.outcome = 'synthetic-invalid';
        if (failure === 'budget') body.sqlQueries++;
        return Response.json(body);
      };
      await runBlock(ctx, 'single-node', block20().samples);
      assert.equal(calls, 20, failure); assert.equal(ctx.stopped, true, failure);
      assert.equal(ctx.ledger.used, 20, failure); assert.equal(ctx.trials.length, 0, failure);
    }
  });
  test('whole-wave cap refuses without sending or shrinking contention; extras share its slots', async () => {
    let calls = 0;
    const ctx = make({ fetchImpl: async () => { calls++; return new Response(null, { status: 404 }); },
      timeoutGate: async ({ invoke }) => {
        await invoke({ method: 'GET' });
        return { passed: true, receiptSha256: 'c'.repeat(64) };
      } });
    ctx.ledger.reserve(39980, { purpose: 'synthetic-prior-ambiguous' });
    await runBlock(ctx, 'single-node', block20().samples);
    assert.equal(calls, 1); assert.equal(ctx.ledger.used, 39981); assert.equal(ctx.stopped, true);
    const fits = make();
    let fittingCalls = 0;
    fits.ledger.reserve(39980, { purpose: 'synthetic-prior-ambiguous' });
    fits.fetchImpl = (url, options) => { fittingCalls++; return goodResponse(fits.arms, url, options); };
    await runBlock(fits, 'single-node', block20().samples);
    assert.equal(fittingCalls, 20); assert.equal(fits.ledger.used, 40000);
    assert.equal(fits.trials.length, 1); // warmup completes; warm wave is refused.
    assert.equal(fits.stopped, true);
    const diskFailure = make();
    let unexpectedSends = 0;
    diskFailure.fetchImpl = async () => { unexpectedSends++; };
    diskFailure.ledger.record = event => {
      if (event.kind === 'reserve') throw new Error('synthetic durability failure');
    };
    await runBlock(diskFailure, 'single-node', block20().samples);
    assert.equal(unexpectedSends, 0); assert.equal(diskFailure.ledger.used, 0);
    assert.equal(diskFailure.stopped, true);
    const caughtCap = make();
    caughtCap.ledger.reserve(40000, { purpose: 'synthetic-prior-ambiguous' });
    caughtCap.timeoutGate = async ({ invoke }) => {
      assert.throws(() => invoke({ method: 'GET' }), /preflight refused/);
      return { passed: true, receiptSha256: 'c'.repeat(64) };
    };
    await runBlock(caughtCap, 'single-node', block20().samples);
    assert.equal(caughtCap.stopped, true); assert.equal(caughtCap.gated.size, 0);
  });
  test('full-trial percentiles ignore wave flags and enforce 63 ms separately from legacy flags', async () => {
    for (const [kind, expected] of [['boundary', true], ['miss', false], ['slow-wave', true]]) {
      const ctx = make();
      ctx.fetchImpl = (url, options) => {
        const sample = JSON.parse(options.body);
        const ms = kind === 'miss' ? 63.001 : kind === 'slow-wave' && sample.index < 20 ? 150 : 63;
        return goodResponse(ctx.arms, url, options, ms);
      };
      await runBlock(ctx, 'single-node', path20().samples);
      const trial = ctx.trials.find(g => g.group.startsWith('warm:'));
      assert.equal(trial.samples, 1000); assert.equal(trial.screenPassed, expected, kind);
      assert.equal(trial.legacyPassed, true, kind); assert.equal(ctx.stopped, !expected, kind);
      assert.equal(ctx.ledger.used, 1020);
    }
  });
  test('accepted timeout gate runs once per arm, drains extras and refuses failure before matrix', async () => {
    const ctx = make();
    let gates = 0, sends = 0;
    ctx.timeoutGate = async ({ invoke, method }) => {
      assert.equal(method, TIMEOUT_GATE); gates++;
      await invoke({ method: 'GET' });
      return { passed: false, receiptSha256: 'c'.repeat(64) };
    };
    ctx.fetchImpl = async () => { sends++; return new Response(null, { status: 404 }); };
    await runBlock(ctx, 'single-node', block20().samples);
    assert.equal(gates, 1); assert.equal(sends, 1); assert.equal(ctx.stopped, true);
    assert.equal(ctx.ledger.used, 1); assert.equal(ctx.trials.length, 0);
  });
  test('complete synthetic pair preserves all 37006 tickets, arm separation, gates and deltas', async () => {
    const ctx = make();
    const gates = [], observed = { 'single-node': [], ha: [] };
    ctx.timeoutGate = async ({ topology, invoke }) => {
      gates.push(topology); await invoke({ method: 'GET' });
      return { passed: true, receiptSha256: 'c'.repeat(64) };
    };
    ctx.fetchImpl = (url, options) => {
      if (options.method === 'GET') return Promise.resolve(new Response(null, { status: 404 }));
      const topology = url.startsWith(ctx.arms.ha.deployment.url) ? 'ha' : 'single-node';
      observed[topology].push(sampleKey(JSON.parse(options.body)));
      return Promise.resolve(goodResponse(ctx.arms, url, options, topology === 'ha' ? 51 : 50));
    };
    const result = await execute(ctx, pairedManifest());
    assert.equal(result.status, 'complete'); assert.equal(result.invocationsReserved, 37008);
    assert.equal(result.completedGroups, 92); assert.equal(result.pairedDeltas.length, 18);
    assert.deepEqual(gates, ['single-node', 'ha']);
    assert(result.pairedDeltas.every(row => row.haMinusSingleP95Ms === 1));
    assert(result.historical.ha.passed && result.historical['single-node'].passed);
    const expected = pairedManifest().flatMap(block => block.samples).map(sampleKey);
    for (const topology of topologies) assert.deepEqual(observed[topology], expected);
    assert.equal(ctx.active.size, 0); assert.equal(networkCalls, 0);
    const journal = JSON.stringify(ctx.ledger.events);
    assert(!journal.includes(ctx.arms.ha.credentials.bearer));
    assert(!journal.includes(ctx.arms.ha.credentials.bypass));
    assert(!journal.includes(ctx.arms.ha.deployment.url));
    assert.equal(ctx.ledger.events[0].armHashes.ha.deployment.length, 64);
  });
  test('no approval, wrong arm/SHA, missing transport and owner stop refuse before requests', async () => {
    await assert.rejects(runPaired({ approved: false }), /no retry\/resume/);
    for (const patch of [{ approved: false }, { expectedSha: 'c'.repeat(40) }, { fetchImpl: undefined }])
      assert.throws(() => make(patch));
    const arms = fixture(); arms.ha.binding.database.topology = 'single-node';
    assert.throws(() => make({ arms }));
    let calls = 0, gates = 0;
    const ctx = make({ signal: AbortSignal.abort(),
      fetchImpl: async () => { calls++; }, timeoutGate: async () => { gates++; } });
    await runBlock(ctx, 'single-node', block20().samples);
    assert.equal(calls, 0); assert.equal(gates, 0); assert.equal(ctx.ledger.used, 0);
    assert.equal(ctx.stopped, true);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') await selfTest();
  else {
    console.error('Import runPaired with explicit owner gates/transport; only --self-test runs from the CLI.');
    process.exitCode = 2;
  }
}
