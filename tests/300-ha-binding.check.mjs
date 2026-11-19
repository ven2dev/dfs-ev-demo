import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { authorize, createHandler, PROJECT_ID, validateBinding } from '../apps/web/src/lib/qualification220-core.mjs';

const branch = 'feature/dfsEV-300-ps5-ha-stage1';
const now = Date.UTC(2026, 10, 18, 12);
const sha = 'b'.repeat(40);
const bearer = 'a'.repeat(64);
const host = 'synthetic-stage1.vercel.app';
const sample = { stage: 'warm', workers: 20, round: 0, mode: 'path', index: 0 };

function fixture(topology = 'single-node') {
  const binding = {
    projectId: PROJECT_ID, arm: 'iad1', nodeMajor: 24,
    database: {
      provider: 'planetscale', verified: true, disposable: true, syntheticOnly: true,
      organization: 'synthetic-org', clusterName: 'synthetic-cluster', branchId: 'synthetic-branch',
      region: 'us-east-1', sku: 'PS-5', topology, postgresMajor: 18,
      host: 'synthetic-stage1.pg.psdb.cloud', port: 6432, name: 'synthetic',
      role: 'spike220_runner_123456abcdef',
    },
    gates: { automationBypass: true, branchScopedSensitive: true, previewProtection: true },
    gitBranch: branch, reviewedSha: sha, runId: '12345678-1234-1234-1234-123456789abc',
  };
  const env = {
    SPIKE220_ENABLED: '1', VERCEL_ENV: 'preview', VERCEL_REGION: 'iad1',
    VERCEL_PROJECT_ID: PROJECT_ID, VERCEL_GIT_COMMIT_REF: branch, VERCEL_GIT_COMMIT_SHA: sha,
    VERCEL_URL: host, SPIKE220_BINDING: JSON.stringify(binding),
    SPIKE220_ISSUED_AT: new Date(now - 1000).toISOString(),
    SPIKE220_EXPIRES_AT: new Date(now + 10_000).toISOString(),
    SPIKE220_TOKEN_SHA256: createHash('sha256').update(bearer).digest('hex'),
    SPIKE220_DATABASE_URL: `postgresql://${binding.database.role}.${binding.database.branchId}:synthetic@${binding.database.host}:6432/synthetic?sslmode=verify-full`,
  };
  return { binding, env };
}

const request = () => new Request(`https://${host}/api/qualification220`, {
  method: 'POST', headers: { authorization: `Bearer ${bearer}` }, body: JSON.stringify(sample),
});

for (const topology of ['single-node', 'ha']) {
  test(`#300 ${topology} accepts the exact branch and preserves 2 pre-provider / 3 total SQL`, async t => {
    const { binding, env } = fixture(topology);
    const calls = { factory: 0, sql: [], provider: 0, network: 0 };
    t.mock.method(globalThis, 'fetch', async () => { calls.network++; throw new Error('unexpected network'); });
    assert.equal(validateBinding(binding), binding);
    assert.deepEqual(authorize(request(), env, now), binding);
    let tick = 0;
    const handler = createHandler({
      env, now: () => now, clock: () => ++tick,
      queryFactory: () => {
        calls.factory++;
        return async sql => {
          calls.sql.push(sql);
          return { rows: [{ outcome: sql.includes('hosted_begin') ? 'claimed' : 'leader' }], checkoutMs: 0 };
        };
      },
      freeEvents: async () => { calls.provider++; throw new Error('unexpected provider'); },
    });
    const response = await handler(request());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.outcome, 'leader');
    assert.equal(body.preProviderQueries, 2);
    assert.equal(body.sqlQueries, 3);
    assert.deepEqual(calls.sql, [
      'SELECT * FROM spike220.hosted_begin($1,$2,false)',
      'SELECT * FROM spike220.hosted_sample($1,$2,true)',
      'SELECT spike220.hosted_release($1,$2)',
    ]);
    assert.equal(calls.factory, 1);
    assert.equal(calls.provider, 0);
    assert.equal(calls.network, 0);
  });
}

const rejectedBindings = [
  ['project', c => { c.projectId = 'synthetic-other'; }],
  ['function region', c => { c.arm = 'pdx1'; }],
  ['Node major', c => { c.nodeMajor = 22; }],
  ['provider', c => { c.database.provider = 'neon'; }],
  ['database region', c => { c.database.region = 'us-west-2'; }],
  ['SKU', c => { c.database.sku = 'PS-10'; }],
  ['PostgreSQL major', c => { c.database.postgresMajor = 17; }],
  ['unverified resource', c => { c.database.verified = false; }],
  ['nondisposable resource', c => { c.database.disposable = false; }],
  ['non-synthetic resource', c => { c.database.syntheticOnly = false; }],
  ['missing organization', c => { delete c.database.organization; }],
  ['missing cluster', c => { delete c.database.clusterName; }],
  ['missing database branch', c => { delete c.database.branchId; }],
  ['endpoint suffix', c => { c.database.host = 'synthetic.invalid'; }],
  ['endpoint suffix extension', c => { c.database.host += '.invalid'; }],
  ['port', c => { c.database.port = 5432; }],
  ['role', c => { c.database.role = 'synthetic_owner'; }],
  ['database name', c => { c.database.name = 'synthetic-name'; }],
  ['automation bypass gate', c => { c.gates.automationBypass = false; }],
  ['sensitive scope gate', c => { c.gates.branchScopedSensitive = false; }],
  ['Preview protection gate', c => { c.gates.previewProtection = false; }],
  ['missing protection gates', c => { delete c.gates; }],
  ['unreviewed SHA', c => { c.reviewedSha = 'synthetic'; }],
  ['run ID', c => { c.runId = 'synthetic'; }],
  ...['main', 'feature/dfsEV-220-planetscale-harness', 'feature/dfsEV-300-other', `${branch}-other`]
    .map(value => ['branch ' + value, c => { c.gitBranch = value; }]),
  ...['HA', 'single', 'replica', '', null, undefined, true, {}, ['ha']]
    .map((value, index) => [`topology variant ${index}`, c => { c.database.topology = value; }]),
];

for (const [name, mutate] of rejectedBindings) {
  test(`#300 refuses ${name} before any client, SQL, provider or network work`, async t => {
    const { binding, env } = fixture('ha');
    mutate(binding);
    env.SPIKE220_BINDING = JSON.stringify(binding);
    assert.throws(() => validateBinding(binding));
    const calls = { factory: 0, sql: 0, provider: 0, network: 0 };
    t.mock.method(globalThis, 'fetch', async () => { calls.network++; throw new Error('unexpected network'); });
    const handler = createHandler({
      env, now: () => now,
      queryFactory: () => { calls.factory++; return async () => { calls.sql++; throw new Error('unexpected SQL'); }; },
      freeEvents: async () => { calls.provider++; throw new Error('unexpected provider'); },
    });
    const response = await handler(request());
    assert.equal(response.status, 404);
    assert.equal(await response.text(), '');
    assert.deepEqual(calls, { factory: 0, sql: 0, provider: 0, network: 0 });
  });
}

test('#300 an HA binding still requires the exact deployment, TLS and scoped login', async t => {
  const { env } = fixture('ha');
  const patches = [
    { VERCEL_ENV: 'production' },
    { VERCEL_PROJECT_ID: 'synthetic-other' },
    { VERCEL_REGION: 'pdx1' },
    { VERCEL_GIT_COMMIT_REF: 'main' },
    { VERCEL_GIT_COMMIT_SHA: 'c'.repeat(40) },
    { VERCEL_URL: 'synthetic-other.vercel.app' },
    { SPIKE220_DATABASE_URL: env.SPIKE220_DATABASE_URL.replace('sslmode=verify-full', 'sslmode=require') },
    { SPIKE220_DATABASE_URL: env.SPIKE220_DATABASE_URL.replace('.synthetic-branch:', '.synthetic-other:') },
    { SPIKE220_EXPIRES_AT: new Date(now).toISOString() },
    { SPIKE220_EXPIRES_AT: new Date(now + 6 * 3600_000).toISOString() },
  ];
  let network = 0;
  t.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('unexpected network'); });
  for (const patch of patches) {
    let factory = 0;
    const handler = createHandler({
      env: { ...env, ...patch }, now: () => now,
      queryFactory: () => { factory++; throw new Error('unexpected client'); },
    });
    const response = await handler(request());
    assert.equal(response.status, 404);
    assert.equal(await response.text(), '');
    assert.equal(factory, 0);
  }
  assert.equal(network, 0);
});
