// Synthetic probes only; all network and PostgreSQL work is injected.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOwnerSession, verifyMeasuredSources, TIMEOUT_GATE } from './300-paired-controller.mjs';

const sha = 'b'.repeat(40);
const marker = 'SYNTHETIC_SECRET_DO_NOT_LOG';
const now = Date.now();
function fixture() {
  const arms = {};
  for (const [i, topology] of ['single-node', 'ha'].entries()) {
    const binding = { arm: 'iad1', projectId: 'prj_GLXDEeScMKPAeDAUoYIoiNknwKJd', nodeMajor: 24,
      database: { provider: 'planetscale', verified: true, disposable: true, syntheticOnly: true,
        organization: 'vernon-ven2dev', clusterName: `dfs-ev-300-${i ? 'ha' : 'single'}`, branchId: `synthetic-${i}`,
        host: `synthetic-${i}.pg.psdb.cloud`, port: 6432, role: `spike220_runner_30000000000${i + 1}`,
        name: 'postgres', region: 'us-east-1', sku: 'PS-5', topology, postgresMajor: 18 },
      gates: { automationBypass: true, branchScopedSensitive: true, previewProtection: true },
      gitBranch: 'feature/dfsEV-300-ps5-ha-stage1', reviewedSha: sha,
      runId: `12345678-1234-1234-1234-123456789ab${i}` };
    const arm = { binding, credentials: { bearer: 'a'.repeat(64), bypass: marker },
      poolRetired: { method: 'reset', atUtc: new Date(now - 1000).toISOString(), configuredSize: 3, evidence: marker },
      deployment: { source: 'git', id: `dpl_synthetic${i}`, projectId: binding.projectId,
        target: 'preview', readyState: 'READY', sha, gitBranch: binding.gitBranch,
        protectionVerified: true, url: `https://synthetic-${i}.vercel.app`,
        functionMetadata: { source: 'deployment-function-metadata', deploymentId: `dpl_synthetic${i}`,
          path: '/api/qualification220', regions: ['iad1'] } } };
    arm.adminUrl = `postgresql://postgres.${binding.database.branchId}:${marker}@${binding.database.host}:5432/postgres?sslmode=verify-full`;
    arm.runnerUrl = `postgresql://${binding.database.role}.${binding.database.branchId}:${marker}@${binding.database.host}:6432/postgres?sslmode=verify-full`;
    arms[topology] = arm;
  }
  const restore = structuredClone(arms.ha);
  restore.binding.database.branchId = 'synthetic-restore';
  restore.binding.database.host = 'synthetic-restore.pg.psdb.cloud';
  restore.binding.runId = '12345678-1234-1234-1234-123456789ab2';
  for (const key of ['adminUrl', 'runnerUrl']) restore[key] = restore[key].replaceAll('synthetic-1', 'synthetic-restore');
  restore.deployment.id = 'dpl_syntheticrestore'; restore.deployment.url = 'https://synthetic-restore.vercel.app';
  restore.deployment.functionMetadata.deploymentId = restore.deployment.id;
  return { expectedSha: sha, arms, restore, ownerApproval: { syntheticOnly: true, resourcesVerified: true,
    matchedSettings: true, windowStart: new Date(now - 10_000).toISOString(), firstResourceCreatedAt: new Date(now - 5000).toISOString(),
    expiresAt: new Date(now + 4 * 3600_000).toISOString(), checkedAt: new Date(now).toISOString(),
    totalProjectedUsd: 1, invocationAllowance: 1_000_000, invocationsUsed: 0, backgroundInvocations: 0, cpuMemoryTransferHeadroom: true },
    providerRecoveryMetadata: { requestedPointUtc: new Date(now).toISOString() },
    ownerCleanup: { deploymentsDeleted: true, backendQuiescence: true } };
}
function disk(config = fixture()) {
  const dir = mkdtempSync('/private/tmp/dfs300-owner-'); chmodSync(dir, 0o700);
  const input = resolve(dir, 'input.json'), out = resolve(dir, 'evidence');
  const save = () => writeFileSync(input, JSON.stringify(config), { mode: 0o600 }); save();
  return { dir, input, out, config, save, cleanup: () => rmSync(dir, { recursive: true }) };
}
function sqlHarness({ corruptTable = false, failure = false } = {}) {
  const queries = []; let clients = 0, ended = 0;
  const makeClient = () => ({
    on() {}, async connect() { clients++; }, async end() { ended++; },
    async query(text, values = []) {
      queries.push(text);
      if (failure) throw new Error(marker);
      if (text.includes('to_regnamespace')) return { rows: [{ absent: true }] };
      if (text.includes(' AS tickets')) return { rows: [{ tickets: 18503 }] };
      if (text.includes(' AS active')) return { rows: [{ active: 0 }] };
      if (text.startsWith('SELECT count(*)')) return { rows: [{ n: 0 }] };
      if (text.startsWith('SELECT to_jsonb')) return { rows: [{ row: corruptTable ? 'different' : 'synthetic-row' }] };
      if (text.includes('database_bytes')) return { rows: [{ database_bytes: '1', relation_bytes: '1', observed_at: new Date(now).toISOString(), postgres_version: '18' }] };
      if (values.length && text.includes('INSERT INTO spike220.hosted_tickets')) assert(!values.join('').includes(marker));
      return { rows: [] };
    },
  });
  return { makeClient, queries, counts: () => ({ clients, ended }) };
}
function poolHarness({ bad = false, duplicate = false, missing = false, releaseFail = false } = {}) {
  let started = 0, rolled = 0, released = 0, ended = 0, inspected = 0;
  const makePool = options => { let opened = 0; return { on() {}, async connect() {
    const id = ++started; opened++;
    if (missing && opened === options.max) throw new Error(marker);
    return { async query(text) {
      if (text === 'ROLLBACK') { rolled++; if (releaseFail) throw new Error(marker); return { rows: [] }; }
      if (text === 'BEGIN') return { rows: [] };
      assert.equal(opened, options.max, 'full pool concurrently opened before inspection');
      inspected++;
      return { rows: [{ pid: duplicate ? 1 : id, statement_timeout: bad ? '0' : '5s', lock_timeout: '2s', idle_in_transaction_session_timeout: '5s' }] };
    }, release() { released++; } };
  }, async end() { ended++; } }; };
  return { makePool, counts: () => ({ started, inspected, rolled, released, ended }) };
}
function transport(config, observed) {
  return async (url, options) => {
    observed.push(options.method);
    if (options.method === 'GET') return new Response(null, { status: 404 });
    const arm = [...Object.values(config.arms), config.restore].find(arm => url.startsWith(arm.deployment.url));
    const sample = JSON.parse(options.body);
    const before = sample.mode === 'path' ? 2 : 1;
    const probe = sample.mode === 'baseline' && sample.stage !== 'cold';
    const total = before + Number(probe || sample.mode !== 'baseline');
    return Response.json({ sample, arm: 'iad1', region: 'iad1', sha, runId: arm.binding.runId,
      outcome: sample.mode === 'baseline' ? 'baseline' : 'leader', inFunctionPreProviderMs: 50,
      preProviderSqlMs: 5, preProviderCheckoutMs: 1, preProviderQueries: before, sqlQueries: total,
      inFunctionTotalMs: 51, transportRoundTripMs: probe ? 1 : null,
      connectionDiagnostic: sample.stage === 'cold' ? 'fresh-client-to-warm-pooler' : null,
      queryTimings: Array.from({ length: total }, (_, i) => ({ operation: probe && i === total - 1 ? 'transport' : 'hosted_sample', elapsedMs: 1, checkoutMs: 0 })) });
  };
}

export async function runOwnerTests({ operator, privateJson, connectionOptions, fullPoolTimeouts, installFixture, snapshot }) {
  let actualNetwork = 0;
  const prior = globalThis.fetch;
  globalThis.fetch = async () => { actualNetwork++; throw new Error('real transport forbidden'); };
  process.once('beforeExit', () => { globalThis.fetch = prior; assert.equal(actualNetwork, 0); });
  test('private loader refuses readable files, symlinks and malformed inputs; CLI errors never echo values', () => {
    const d = disk();
    try {
      assert.equal(privateJson(d.input).expectedSha, sha);
      chmodSync(d.input, 0o644); assert.throws(() => privateJson(d.input)); chmodSync(d.input, 0o600);
      const link = resolve(d.dir, 'link'); symlinkSync(d.input, link); assert.throws(() => privateJson(link));
      chmodSync(d.dir, 0o755); assert.throws(() => privateJson(d.input)); chmodSync(d.dir, 0o700);
      writeFileSync(d.input, marker);
      const cli = spawnSync(process.execPath, [fileURLToPath(new URL('./300-owner-runner.mjs', import.meta.url)), '--approved', '--private', d.input, '--out', d.out], { encoding: 'utf8' });
      assert.equal(cli.status, 1); assert(!`${cli.stdout}${cli.stderr}`.includes(marker)); assert(cli.stderr.includes('STOP'));
    } finally { d.cleanup(); }
  });
  test('SQL bindings require exact branch/login/database/pool port and verified TLS', () => {
    const arm = fixture().arms.ha;
    assert.deepEqual(connectionOptions(arm, 'runnerUrl').ssl, { rejectUnauthorized: true });
    for (const edit of [s => s.replace('6432', '5432'), s => s.replace('verify-full', 'disable'),
      s => s.replace('synthetic-1.pg', 'wrong.pg'), s => s.replace('/postgres?', '/wrong?'), s => s.replace('runner_300', 'runner_400')])
      assert.throws(() => connectionOptions({ ...arm, runnerUrl: edit(arm.runnerUrl) }, 'runnerUrl'));
  });
  test('accepted full-pool gate holds distinct transactions, records 5s/2s/5s and drains on every refusal', async () => {
    const arm = fixture().arms.ha;
    const good = poolHarness();
    const receipt = await fullPoolTimeouts(arm, arm.poolRetired, good.makePool);
    assert.equal(receipt.method, TIMEOUT_GATE); assert.equal(receipt.distinctBackends, 3);
    assert(!JSON.stringify(receipt).includes(marker));
    assert.deepEqual(good.counts(), { started: 3, inspected: 3, rolled: 3, released: 3, ended: 1 });
    for (const option of [{ bad: true }, { duplicate: true }, { missing: true }, { releaseFail: true }]) {
      const mock = poolHarness(option);
      await assert.rejects(fullPoolTimeouts(arm, arm.poolRetired, mock.makePool));
      assert.equal(mock.counts().released, option.missing ? 2 : 3); assert.equal(mock.counts().ended, 1);
    }
    await assert.rejects(fullPoolTimeouts(arm, {}, good.makePool));
  });
  test('existing SQL setup is reused transactionally; driver failures close connections without logging', async () => {
    const arm = fixture().arms.ha, sql = sqlHarness();
    await installFixture(arm, new Date(now + 10000).toISOString(), sql.makeClient);
    assert(sql.queries.some(q => q.includes('CREATE SCHEMA spike220')));
    assert(sql.queries.some(q => q.includes("SET statement_timeout='5s'")));
    assert.equal(sql.queries.at(-1), 'COMMIT'); assert.deepEqual(sql.counts(), { clients: 1, ended: 1 });
    const bad = sqlHarness({ failure: true });
    await assert.rejects(installFixture(arm, new Date(now + 10000).toISOString(), bad.makeClient));
    assert.equal(bad.counts().ended, 1);
  });
  test('snapshot covers row hashes and schema/function/role/default/ACL/ownership/extension/sequence parity', async () => {
    const a = await snapshot(fixture().arms.ha, sqlHarness().makeClient);
    const b = await snapshot(fixture().restore, sqlHarness().makeClient);
    assert.deepEqual(a.parity, b.parity); assert.equal(a.parity.data.length, 9);
    assert(!JSON.stringify(a).includes('synthetic-row'));
    const changed = await snapshot(fixture().restore, sqlHarness({ corruptTable: true }).makeClient);
    assert.notDeepEqual(a.parity, changed.parity);
    assert.deepEqual(Object.keys(a.parity).sort(), ['constraints','data','defaults','definitions','extensions','namespace','owners','permissions','roles','schema','sequences'].sort());
  });
  test('shared session cap reserves recovery/availability failures, refuses repeats and does not reopen', async () => {
    const d = disk(); const ledgerPath = resolve(d.dir, 'extras.jsonl');
    const session = createOwnerSession({ approved: true, ledgerPath }); let sends = 0;
    try {
      await assert.rejects(session.request('recovery', 'restore', async () => sends++)); assert.equal(sends, 0);
      await session.request('availability', 'ha', async () => sends++);
      await assert.rejects(session.request('availability', 'ha', async () => sends++)); assert.equal(sends, 1);
      await assert.rejects(session.request('availability', 'single-node', async () => { sends++; throw new Error(marker); }));
      assert.equal(session.used, 2);
      await assert.rejects(session.request('availability', 'restore', async () => sends++)); assert.equal(sends, 2);
      const rows = readFileSync(ledgerPath, 'utf8'); assert(!rows.includes(marker));
      assert.equal(rows.split('\n').filter(line => line.includes('"kind":"reserve"')).length, 2);
    } finally { session.close(); d.cleanup(); }
  });
  test('session refuses changed binding, stale quota approval, cap headroom miss and restart in another directory', async () => {
    for (const mutate of [c => c.ownerApproval.invocationsUsed = 860001,
      c => c.ownerApproval.checkedAt = new Date(now - 16 * 60000).toISOString(),
      c => c.ownerApproval.expiresAt = new Date(now + 7 * 3600000).toISOString()]) {
      const d = disk(); mutate(d.config); d.save();
      try { assert.throws(() => operator(d.input, d.out, { approved: true, now: () => now })); } finally { d.cleanup(); }
    }
    const d = disk(); const sql = sqlHarness(); const op = operator(d.input, d.out, { approved: true, now: () => now, makeClient: sql.makeClient });
    try {
      d.config.arms.ha.binding.runId = '12345678-1234-1234-1234-123456789ab9'; d.save();
      await assert.rejects(op.command('setup')); assert.equal(sql.counts().clients, 0);
      d.config = fixture(); d.save();
      assert.throws(() => operator(d.input, resolve(d.dir, 'other'), { approved: true, now: () => now }));
      assert.equal(statSync(d.out).mode & 0o777, 0o700);
    } finally { op.close(); d.cleanup(); }
    // Session-open approval can age during owner setup. Refuse a stale matrix
    // before any gate, fixture reset or transport; no mid-matrix edits needed.
    const stale = disk(), staleSql = sqlHarness(); let elapsed = 0, sends = 0;
    const opened = operator(stale.input, stale.out, { approved: true, now: () => now + elapsed,
      makeClient: staleSql.makeClient, fetchImpl: async () => { sends++; } });
    try {
      await opened.command('setup'); elapsed = 16 * 60000;
      const priorQueries = staleSql.queries.length;
      await assert.rejects(opened.command('matrix'));
      assert.equal(sends, 0); assert.equal(staleSql.queries.length, priorQueries);
    } finally { opened.close(); stale.cleanup(); }
  });
  test('50-minute matrix needs no approval edits; incident refresh, parity, recovery and availability share one ledger', async () => {
    const d = disk(), sql = sqlHarness(), pool = poolHarness(), sent = [];
    let elapsed = 0;
    const send = transport(d.config, sent);
    const op = operator(d.input, d.out, { approved: true,
      fetchImpl: (url, options) => { if (options.method === 'POST') elapsed += 50 * 60000 / 37006; return send(url, options); },
      makeClient: sql.makeClient, makePool: pool.makePool, now: () => now + elapsed, clock: () => elapsed });
    try {
      for (const command of ['setup', 'delivery', 'matrix', 'source', 'incident', 'requested', 'ready', 'verify', 'restore-delivery', 'recovery', 'availability']) {
        if (command === 'incident') {
          assert(elapsed >= 49 * 60000);
          assert.equal(d.config.ownerApproval.checkedAt, new Date(now).toISOString(), 'matrix did not require credential-file edits');
          d.config.ownerApproval.checkedAt = new Date(now + elapsed).toISOString(); d.save();
        }
        let result;
        try { result = await op.command(command); }
        catch { assert.fail(`synthetic command failed: ${command}; ${readFileSync(resolve(d.out, 'invocations.jsonl'), 'utf8').trim().split('\n').filter(line => line.includes('"kind":"stop"') || line.includes('"kind":"owner-step-failed"')).join('\n')}`); }
        assert.equal(result.status, 'passed', command);
      }
      assert.equal(sent.filter(x => x === 'POST').length, 37007); assert.equal(sent.filter(x => x === 'GET').length, 3);
      assert.equal(op.used, 37010); assert.equal(pool.counts().started, 6);
      const delivery = JSON.parse(readFileSync(resolve(d.dir, `${sha}-delivery`, 'ha.json')));
      assert.equal(delivery.SPIKE220_DATABASE_URL, d.config.arms.ha.runnerUrl);
      assert.equal(Object.keys(delivery).length, 6);
      await assert.rejects(op.command('matrix')); assert.equal(sent.length, 37010);
      await op.command('close');
      const ledger = readFileSync(resolve(d.out, 'invocations.jsonl'), 'utf8');
      for (const secret of [marker, d.config.arms.ha.adminUrl, d.config.arms.ha.deployment.url, 'a'.repeat(64)]) assert(!ledger.includes(secret));
      const rows = ledger.trim().split('\n').map(line => JSON.parse(line));
      assert.equal(rows.at(-1).total, 37010);
      assert.equal(rows.filter(row => row.kind === 'timeout-gate').length, 2);
      assert.equal(rows.filter(row => row.purpose === 'recovery' && row.kind === 'reserve').length, 1);
      assert.equal(rows.filter(row => row.purpose === 'availability' && row.kind === 'reserve').length, 3);
      assert(rows.every((row, index) => row.sequence === index));
      assert.equal(JSON.parse(readFileSync(resolve(d.out, 'matrix-summary.json'))).completedGroups, 92);
      assert.equal(JSON.parse(readFileSync(resolve(d.out, 'recovery-service.json'))).rtoPassed, true);
    } finally { op.close(); d.cleanup(); }
    assert.equal(Object.keys(verifyMeasuredSources()).length, 11); assert.equal(actualNetwork, 0);
  });
  test('timeout gate miss sends no matrix traffic; owner stop and redacted SQL error cannot resume', async () => {
    for (const kind of ['gate', 'stop', 'sql']) {
      const d = disk(), sent = [], sql = sqlHarness({ failure: kind === 'sql' });
      const op = operator(d.input, d.out, { approved: true, now: () => now, fetchImpl: transport(d.config, sent),
        makeClient: sql.makeClient, makePool: poolHarness({ bad: true }).makePool });
      try {
        if (kind === 'sql') await assert.rejects(op.command('setup'), error => error.message === 'STOP: owner step refused or failed; no retry/resume. Preserve evidence and perform owner teardown.');
        else { await op.command('setup'); if (kind === 'stop') op.stop(); await assert.rejects(op.command('matrix')); }
        await assert.rejects(op.command('recovery')); assert.equal(sent.length, 0);
        assert(!readFileSync(resolve(d.out, 'invocations.jsonl'), 'utf8').includes(marker));
      } finally { op.close(); d.cleanup(); }
    }
  });
  test('deadline, expiry and window cutoff still refuse subsequent matrix sends while approval is allowed to age', async () => {
    for (const kind of ['expiry', 'deadline', 'window']) {
      const d = disk(), sql = sqlHarness(), sent = [];
      let elapsed = 0;
      if (kind === 'expiry') d.config.ownerApproval.expiresAt = new Date(now + 10 * 60000).toISOString();
      if (kind !== 'expiry') d.config.ownerApproval.expiresAt = new Date(now + 5.9 * 3600000).toISOString();
      d.save();
      const send = transport(d.config, sent);
      const op = operator(d.input, d.out, { approved: true, now: () => now + elapsed,
        makeClient: sql.makeClient, makePool: poolHarness().makePool, fetchImpl: (url, options) => {
          const result = send(url, options);
          elapsed = kind === 'expiry' ? 11 * 60000 : kind === 'deadline' ? 5.1 * 3600000 : 4.1 * 3600000;
          return result;
        } });
      try {
        await op.command('setup'); await assert.rejects(op.command('matrix'));
        assert.equal(sent.length, 1, kind);
      } finally { op.close(); d.cleanup(); }
    }
  });
  test('HTTP unavailability needs owner control-plane deletion and quiescence; no redirect or retry fallback', async () => {
    for (const kind of ['attestation', 'status', 'transport']) {
      const d = disk(); let sends = 0;
      if (kind === 'attestation') d.config.ownerCleanup.deploymentsDeleted = false;
      d.save();
      const op = operator(d.input, d.out, { approved: true, now: () => now, fetchImpl: async (_url, options) => {
        sends++; assert.equal(options.redirect, 'error');
        if (kind === 'transport') throw new Error(marker);
        return new Response(null, { status: 200 });
      } });
      try {
        await assert.rejects(op.command('availability'));
        assert.equal(sends, kind === 'attestation' ? 0 : 1);
        assert.equal(op.used, sends);
        await assert.rejects(op.command('availability')); assert.equal(op.used, sends);
        assert(!readFileSync(resolve(d.out, 'invocations.jsonl'), 'utf8').includes(marker));
      } finally { op.close(); d.cleanup(); }
    }
  });
}
