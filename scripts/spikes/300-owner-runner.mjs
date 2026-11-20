// Never-merge #300 operator wiring. Importing performs no I/O or hosted work.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { createOwnerSession, verifyMeasuredSources, TIMEOUT_GATE } from './300-paired-controller.mjs';
import { initialization, prepareGroup, roleGrants } from './220-hosted/setup.mjs';
import { runGroup, verifyPreview } from './220-hosted/load.mjs';
import { validateBinding } from '../../apps/web/src/lib/qualification220-core.mjs';

const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const armNames = ['single-node', 'ha'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = object => sha256(JSON.stringify(object));
const fixedFailure = 'STOP: owner step refused or failed; no retry/resume. Preserve evidence and perform owner teardown.';
const tables = ['catalog', 'resources', 'subjects', 'budget', 'attempts', 'quota_probe', 'hosted_run', 'hosted_tickets', 'restore_sentinel'];
const recoverySample = { stage: 'warmup', workers: 1, round: 0, mode: 'path', index: 0 };
const isOutside = path => { const rel = relative(root, realpathSync(path)); return rel.startsWith('../') || isAbsolute(rel); };

export function privateJson(path) {
  assert(isAbsolute(path) && isOutside(path), 'private input must be outside repository');
  assert.equal(realpathSync(path), path, 'private input cannot use symlinks');
  const parent = statSync(dirname(path));
  assert.equal(parent.mode & 0o777, 0o700, 'private input directory mode must be 700');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600 && stat.size < 128_000,
      'private input must be owned, regular, bounded and mode 600');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

function privateReceipt(dir, label, value) {
  assert(/^[a-z0-9-]+$/.test(label));
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const fd = openSync(resolve(dir, `${label}.json`), 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  return sha256(bytes);
}

function delivery(dir, label, arm, approval, issuedAt) {
  assert(/^[a-f0-9]{64}$/.test(arm.credentials?.bearer ?? '') && arm.credentials?.bypass?.length >= 16);
  // Private delivery payload is never printed, hashed into public output or
  // copied into evidence. Owner deletes it with the live credential inputs.
  return privateReceipt(dir, label, {
    SPIKE220_ENABLED: '1', SPIKE220_BINDING: JSON.stringify(arm.binding),
    SPIKE220_DATABASE_URL: arm.runnerUrl, SPIKE220_TOKEN_SHA256: sha256(arm.credentials.bearer),
    SPIKE220_ISSUED_AT: new Date(issuedAt).toISOString(), SPIKE220_EXPIRES_AT: approval.expiresAt,
  });
}

// Parse DSNs explicitly: pg's connection-string SSL parameters cannot override
// certificate verification. Neither DSNs nor errors are written to receipts.
export function connectionOptions(arm, kind) {
  const db = validateBinding(arm.binding).database;
  const url = new URL(arm[kind]);
  assert(url.protocol === 'postgresql:' && url.hostname === db.host &&
    [5432, 6432].includes(Number(url.port)) && url.pathname === `/${db.name}` &&
    url.search === '?sslmode=verify-full' && !url.hash && url.password, 'private SQL target refused');
  const user = decodeURIComponent(url.username);
  assert.equal(user, `${kind === 'runnerUrl' ? db.role : 'postgres'}.${db.branchId}`, 'SQL login refused');
  if (kind === 'runnerUrl') assert.equal(Number(url.port), 6432);
  return { host: url.hostname, port: Number(url.port), database: db.name, user,
    password: decodeURIComponent(url.password), ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 4000, query_timeout: 10_000 };
}

function clientFor(arm, kind) { return new pg.Client(connectionOptions(arm, kind)); }
async function connected(arm, operation, makeClient = clientFor) {
  const client = makeClient(arm, 'adminUrl');
  client.on('error', () => {});
  try { await client.connect(); return await operation(client); }
  finally { await client.end(); }
}

async function statements(client, items) {
  for (const item of items) {
    const result = await client.query(item.text, item.values);
    if (item.requireZero) assert.equal(result.rows[0]?.[item.requireZero], 0, 'fixture not quiescent');
    if (item.requireCount) assert.equal(result.rows[0]?.tickets, item.requireCount, 'fixture incomplete');
  }
}

export async function installFixture(arm, expiresAt, makeClient = clientFor) {
  const role = arm.binding.database.role;
  // roleGrants validates both interpolated SQL identifiers before use.
  const grants = roleGrants(role, arm.binding.database.name);
  const password = connectionOptions(arm, 'runnerUrl').password.replaceAll("'", "''");
  await connected(arm, async client => {
    assert.equal((await client.query("SELECT to_regnamespace('spike220') IS NULL AS absent")).rows[0].absent, true);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=$1', [role])).rows[0].n, 0);
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL standard_conforming_strings='on'");
      for (const file of ['220_atomic_leader_gcra.sql', '220_hosted_harness.sql'])
        await client.query(readFileSync(resolve(root, 'packages/db/proposals', file), 'utf8'));
      await client.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await client.query(grants);
      await statements(client, initialization(arm.binding, expiresAt));
      await client.query('COMMIT');
    } catch { await client.query('ROLLBACK'); throw new Error('fixture failed'); }
  }, makeClient);
}

export async function prepare(arm, group, makeClient = clientFor) {
  const items = prepareGroup(group, { remaining: 100000, used: 0 }, arm.binding.runId);
  await connected(arm, client => statements(client, items), makeClient);
  return { quiescent: true, sqlStatements: items.length };
}

// Exactly #220 package-2 step-3: concurrently held transactions pin a full pool
// of distinct backends. No pg_sleep/cancellation probes or replacement method.
export async function fullPoolTimeouts(arm, retired, makePool = options => new pg.Pool(options)) {
  assert(['reset', 'lifetime-wait'].includes(retired?.method) &&
    Number.isFinite(Date.parse(retired.atUtc)) && Date.parse(retired.atUtc) <= Date.now() &&
    typeof retired.evidence === 'string' && retired.evidence.length > 0, 'owner pool retirement evidence required');
  const size = retired.configuredSize;
  assert(Number.isSafeInteger(size) && size > 0 && size <= 100, 'configured full pool size required');
  const pool = makePool({ ...connectionOptions(arm, 'runnerUrl'), max: size });
  pool.on('error', () => {});
  const clients = [], rows = [];
  try {
    const pending = await Promise.allSettled(Array.from({ length: size }, async () => {
      const client = await pool.connect(); clients.push(client);
      await client.query('BEGIN');
      const result = await client.query(`SELECT pg_backend_pid() AS pid,
        current_setting('statement_timeout') AS statement_timeout,
        current_setting('lock_timeout') AS lock_timeout,
        current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout`);
      rows.push(result.rows[0]);
    }));
    assert(pending.every(result => result.status === 'fulfilled'), 'incomplete timeout inspection');
    assert.equal(new Set(rows.map(row => row.pid)).size, size, 'full distinct-backend coverage required');
    for (const row of rows) {
      assert(Number.isSafeInteger(row.pid) && row.pid > 0);
      assert.equal(row.statement_timeout, '5s'); assert.equal(row.lock_timeout, '2s');
      assert.equal(row.idle_in_transaction_session_timeout, '5s');
    }
    return { passed: true, method: TIMEOUT_GATE, configuredSize: size, distinctBackends: rows.length,
      retirement: { method: retired.method, atUtc: new Date(retired.atUtc).toISOString(),
        evidenceSha256: hash(retired.evidence) }, backends: rows.sort((a, b) => a.pid - b.pid) };
  } finally {
    const released = await Promise.allSettled(clients.map(async client => {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }));
    await pool.end();
    assert(released.every(result => result.status === 'fulfilled'), 'held transaction release failed');
  }
}

// Compact parity manifests contain no row payloads, passwords, or DSNs. Canonical
// JSON text is produced in PostgreSQL, sorted there, and hashed on the owner Mac.
export async function snapshot(arm, makeClient = clientFor) {
  return connected(arm, async client => {
    const role = arm.binding.database.role;
    const data = [];
    for (const table of tables) {
      const result = await client.query(`SELECT to_jsonb(t)::text AS row FROM spike220.${table} t ORDER BY to_jsonb(t)::text COLLATE "C"`);
      data.push({ table, rows: result.rows.length, sha256: hash(result.rows.map(row => row.row)) });
    }
    const definitions = (await client.query(`SELECT p.proname, pg_get_functiondef(p.oid) AS definition,
      pg_get_userbyid(p.proowner) AS owner, p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='spike220' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)`)).rows;
    const schema = (await client.query(`SELECT table_name,column_name,ordinal_position,data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema='spike220' ORDER BY table_name,ordinal_position`)).rows;
    const constraints = (await client.query(`SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='spike220' ORDER BY c.relname,k.conname`)).rows;
    const owners = (await client.query(`SELECT c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner,c.relacl
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='spike220' ORDER BY c.relname`)).rows;
    const namespace = (await client.query("SELECT pg_get_userbyid(nspowner) AS owner,nspacl FROM pg_namespace WHERE nspname='spike220'")).rows;
    const sequences = (await client.query("SELECT sequencename,sequenceowner,data_type,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value FROM pg_sequences WHERE schemaname='spike220' ORDER BY sequencename")).rows;
    const roles = (await client.query('SELECT rolname,rolcanlogin,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig FROM pg_roles WHERE rolname=$1', [role])).rows;
    const defaults = (await client.query(`SELECT d.setconfig FROM pg_db_role_setting d JOIN pg_roles r ON r.oid=d.setrole
      JOIN pg_database b ON b.oid=d.setdatabase WHERE r.rolname=$1 AND b.datname=current_database()`, [role])).rows;
    const permissions = (await client.query(`SELECT has_schema_privilege($1,'spike220','USAGE') AS schema_usage,
      has_table_privilege($1,'spike220.hosted_tickets','UPDATE') AS ticket_update,
      has_column_privilege($1,'spike220.hosted_run','max_tickets','SELECT') AS forbidden_column,
      has_database_privilege($1,current_database(),'TEMP') AS temp`, [role])).rows;
    const extensions = (await client.query('SELECT extname,extversion FROM pg_extension ORDER BY extname')).rows;
    const scale = (await client.query(`SELECT pg_database_size(current_database())::text AS database_bytes,
      (SELECT sum(pg_total_relation_size(c.oid))::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='spike220' AND c.relkind='r') AS relation_bytes,
      current_setting('server_version') AS postgres_version, clock_timestamp() AS observed_at`)).rows[0];
    return { parity: { data, definitions, schema, constraints, owners, namespace, sequences, roles, defaults, permissions, extensions },
      scale: { ...scale, walAmount: 'unavailable; not measured by this drill' } };
  }, makeClient);
}

function validateSources(config) {
  assert(/^[a-f0-9]{40}$/.test(config.expectedSha));
  for (const [index, name] of armNames.entries()) {
    const arm = config.arms[name], db = validateBinding(arm.binding).database;
    assert.equal(db.topology, name); assert.equal(db.organization, 'vernon-ven2dev');
    assert.equal(db.clusterName, `dfs-ev-300-${index === 0 ? 'single' : 'ha'}`);
    assert.equal(db.name, 'postgres'); assert.equal(arm.binding.reviewedSha, config.expectedSha);
    assert(/^[a-f0-9]{64}$/.test(arm.credentials?.bearer ?? '') && arm.credentials?.bypass?.length >= 16);
    connectionOptions(arm, 'runnerUrl'); connectionOptions(arm, 'adminUrl');
  }
  assert.notEqual(config.arms.ha.binding.database.branchId, config.arms['single-node'].binding.database.branchId);
  assert.notEqual(config.arms.ha.binding.runId, config.arms['single-node'].binding.runId);
}

function checkBudget(config, now) {
  const a = config.ownerApproval;
  assert(a?.syntheticOnly === true && a.resourcesVerified === true && a.matchedSettings === true);
  const start = Date.parse(a.windowStart), first = Date.parse(a.firstResourceCreatedAt);
  const deadline = Math.min(start + 6 * 3600_000, first + 6 * 3600_000);
  assert(Number.isFinite(deadline) && first >= start && now >= start && now < deadline - 3600_000,
    'work cutoff reached; teardown only');
  const expires = Date.parse(a.expiresAt);
  assert(Number.isFinite(expires) && expires > now && expires <= deadline, 'expiry exceeds resource deadline');
  // An approved qualification extension cannot consume the teardown hour.
  const cutoff = a.qualificationCutoffUtc === undefined ? start + 4 * 3600_000 : Date.parse(a.qualificationCutoffUtc);
  assert(Number.isFinite(cutoff) && cutoff > start && cutoff <= deadline - 3600_000,
    'qualification cutoff exceeds teardown cutoff');
  assert(now < cutoff, 'execution window finished');
  assert(a.totalProjectedUsd <= 3 && a.totalProjectedUsd >= 0 && a.cpuMemoryTransferHeadroom === true);
  assert(Number.isSafeInteger(a.invocationAllowance) && Number.isSafeInteger(a.invocationsUsed) &&
    Number.isSafeInteger(a.backgroundInvocations) && a.invocationsUsed >= 0 && a.backgroundInvocations >= 0 &&
    a.invocationsUsed + a.backgroundInvocations + 40000 <= a.invocationAllowance - 100000);
}

// Quote/quota observations are refreshed at owner checkpoints, not during a
// 45–50 minute paired matrix. Deadline/expiry checks remain on every dispatch.
function checkApprovalFreshness(config, now) {
  const observed = Date.parse(config.ownerApproval.checkedAt);
  assert(Number.isFinite(observed) && observed <= now && now - observed <= 15 * 60_000, 'refresh owner quote/quota/time check');
}

export function operator(configPath, outDir, { fetchImpl = globalThis.fetch, makeClient = clientFor,
  makePool = options => new pg.Pool(options), now = Date.now, clock = () => performance.now(), approved = false } = {}) {
  assert.equal(approved, true); assert.equal(Number(process.versions.node.split('.')[0]), 24);
  verifyMeasuredSources();
  let config = privateJson(configPath);
  validateSources(config); checkBudget(config, now()); checkApprovalFreshness(config, now());
  assert(isAbsolute(outDir) && isOutside(dirname(outDir)));
  mkdirSync(outDir, { mode: 0o700 }); // Refuse any existing directory.
  const deliveryDir = resolve(dirname(configPath), `${config.expectedSha}-delivery`);
  mkdirSync(deliveryDir, { mode: 0o700 });
  // Persistent claim is never removed automatically: a crash cannot be worked
  // around by choosing another output directory for the same private input.
  const claim = openSync(`${configPath}.session-claim`, 'wx', 0o600);
  try { writeFileSync(claim, hash(config.expectedSha)); fsyncSync(claim); } finally { closeSync(claim); }
  const session = createOwnerSession({ approved, ledgerPath: resolve(outDir, 'invocations.jsonl') });
  const stopSignal = new AbortController();
  const scheduleKeys = ['windowStart', 'firstResourceCreatedAt', 'qualificationCutoffUtc'];
  const schedule = hash(scheduleKeys.map(key => config.ownerApproval[key]));
  const sources = hash(Object.fromEntries(armNames.map(name => [name, {
    binding: config.arms[name].binding, adminUrl: config.arms[name].adminUrl, runnerUrl: config.arms[name].runnerUrl,
    credentials: config.arms[name].credentials,
  }])));
  const done = new Set();
  let failed = false, clean = false, manifest, incident, restore, restoredIdentity, deployments, closed = false;
  const fresh = (budget = true) => {
    const next = privateJson(configPath); validateSources(next);
    assert.equal(next.expectedSha, config.expectedSha);
    assert.equal(hash(scheduleKeys.map(key => next.ownerApproval?.[key])), schedule, 'approved schedule changed');
    assert.equal(hash(Object.fromEntries(armNames.map(name => [name, {
      binding: next.arms[name].binding, adminUrl: next.arms[name].adminUrl, runnerUrl: next.arms[name].runnerUrl,
      credentials: next.arms[name].credentials,
    }]))), sources, 'source binding or credential changed');
    if (deployments) assert.equal(hash(armNames.map(name => next.arms[name].deployment)), deployments, 'source deployment changed');
    if (budget) checkBudget(next, now());
    config = next; verifyMeasuredSources();
  };
  const mark = (label, value = {}) => {
    const data = { step: label, atUtc: new Date(now()).toISOString(), ...value };
    privateReceipt(outDir, label, data); session.record({ kind: 'owner-step', ...data });
  };
  const once = label => { assert(!done.has(label), 'step cannot retry'); done.add(label); };
  const verifyRecovery = () => {
    const arm = config.restore, source = config.arms.ha;
    const db = validateBinding(arm.binding).database, expected = source.binding.database;
    for (const key of ['organization', 'clusterName', 'role', 'name', 'region', 'sku', 'topology', 'postgresMajor'])
      assert.equal(db[key], expected[key]);
    assert.notEqual(db.branchId, expected.branchId); assert.notEqual(arm.binding.runId, source.binding.runId);
    assert(!armNames.some(name => config.arms[name].binding.runId === arm.binding.runId));
    assert.equal(arm.binding.reviewedSha, config.expectedSha);
    connectionOptions(arm, 'adminUrl'); connectionOptions(arm, 'runnerUrl'); return arm;
  };
  return {
    get used() { return session.used; },
    async command(command) {
      assert(!closed, 'session closed');
      const allowed = ['setup', 'delivery', 'matrix', 'source', 'incident', 'requested', 'ready', 'verify', 'restore-delivery', 'recovery', 'availability', 'close'];
      assert(allowed.includes(command), 'unknown owner command');
      if (command === 'close') {
        once(command); session.close(); closed = true; config = null; restore = null; return { status: 'closed' };
      }
      assert(!failed || command === 'availability', 'failed session; teardown only');
      try {
        assert(!stopSignal.signal.aborted || command === 'availability', 'owner stopped; teardown only');
        fresh(command !== 'availability'); once(command);
        if (command === 'matrix' || command === 'incident') checkApprovalFreshness(config, now());
        if (command === 'setup') {
          assert(!done.has('matrix'));
          for (const name of armNames) await installFixture(config.arms[name], config.ownerApproval.expiresAt, makeClient);
          mark(command, { arms: 2 });
        } else if (command === 'delivery') {
          assert(done.has('setup'));
          for (const name of armNames) delivery(deliveryDir, name, config.arms[name], config.ownerApproval, now());
          mark(command, { privateDeliveryFiles: 2 });
        } else if (command === 'matrix') {
          assert(done.has('setup'));
          for (const name of armNames) verifyPreview(config.arms[name].deployment, config.arms[name].binding, config.expectedSha);
          deployments = hash(armNames.map(name => config.arms[name].deployment));
          const result = await session.matrix({ expectedSha: config.expectedSha, arms: config.arms,
            fetchImpl: (url, options) => { checkBudget(config, now()); return fetchImpl(url, options); }, signal: stopSignal.signal,
            prepare: async ({ topology, group }) => { fresh(); return prepare(config.arms[topology], group, makeClient); },
            timeoutGate: async ({ topology, method }) => {
              assert.equal(method, TIMEOUT_GATE);
              const receipt = await fullPoolTimeouts(config.arms[topology], config.arms[topology].poolRetired, makePool);
              return { passed: receipt.passed, receiptSha256: privateReceipt(outDir, `timeout-${topology}`, receipt) };
            } });
          privateReceipt(outDir, 'matrix-summary', result); clean = result.status === 'complete';
          assert(clean, 'matrix stopped'); mark(command, { invocations: session.used, completedGroups: result.completedGroups });
        } else if (command === 'source') {
          assert(clean);
          await connected(config.arms.ha, async client => {
            assert.equal((await client.query('SELECT count(*)::int AS n FROM spike220.resources WHERE lease_until>clock_timestamp()')).rows[0].n, 0);
            await client.query("UPDATE spike220.hosted_run SET active_group='paused'");
            await client.query('CREATE TABLE spike220.restore_sentinel(id uuid PRIMARY KEY,payload text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp())');
            await client.query('INSERT INTO spike220.restore_sentinel(id,payload) VALUES($1,$2)', [randomUUID(), 'synthetic #300 restore sentinel']);
          }, makeClient);
          manifest = await snapshot(config.arms.ha, makeClient);
          privateReceipt(outDir, 'source-manifest', manifest); mark(command, { paritySha256: hash(manifest.parity) });
        } else if (command === 'incident') {
          assert(manifest);
          const point = Date.parse(config.providerRecoveryMetadata?.requestedPointUtc);
          assert(Number.isFinite(point) && point >= Date.parse(manifest.scale.observed_at) && point <= now(), 'clean point required');
          incident = { wall: now(), monotonic: clock() }; mark(command);
        } else if (command === 'requested' || command === 'ready') {
          assert(incident && (command !== 'ready' || done.has('requested'))); mark(command);
        } else if (command === 'verify') {
          assert(incident && done.has('ready')); restore = verifyRecovery();
          restoredIdentity = hash({ binding: restore.binding, adminUrl: restore.adminUrl, runnerUrl: restore.runnerUrl, credentials: restore.credentials });
          const before = await snapshot(config.arms.ha, makeClient), restored = await snapshot(restore, makeClient);
          const after = await snapshot(config.arms.ha, makeClient);
          for (const value of [before, restored, after]) assert.deepEqual(value.parity, manifest.parity, 'restore/source parity failed');
          privateReceipt(outDir, 'restore-parity', { passed: true, source: hash(manifest.parity), restored: hash(restored.parity),
            sourceBefore: hash(before.parity), sourceAfter: hash(after.parity), scale: restored.scale,
            providerRecoveryMetadata: Object.fromEntries(['requestedPointUtc', 'selectedPointUtc', 'acceptedAtUtc', 'readyAtUtc']
              .map(key => [key, Number.isFinite(Date.parse(config.providerRecoveryMetadata?.[key]))
                ? new Date(config.providerRecoveryMetadata[key]).toISOString() : null])) });
          // Fresh recovery run state is added only after restored-data parity.
          await connected(restore, client => statements(client, initialization(restore.binding, config.ownerApproval.expiresAt, { includeFixture: false })), makeClient);
          await prepare(restore, 'warmup:1:0:path', makeClient); mark(command);
        } else if (command === 'restore-delivery') {
          assert(restore && done.has('verify'));
          const current = verifyRecovery();
          assert.equal(hash({ binding: current.binding, adminUrl: current.adminUrl, runnerUrl: current.runnerUrl, credentials: current.credentials }), restoredIdentity);
          delivery(deliveryDir, 'restore', restore, config.ownerApproval, now()); mark(command, { privateDeliveryFiles: 1 });
        } else if (command === 'recovery') {
          assert(restore && done.has('verify'));
          const current = verifyRecovery(); assert.deepEqual(current.binding, restore.binding);
          assert.equal(hash({ binding: current.binding, adminUrl: current.adminUrl, runnerUrl: current.runnerUrl, credentials: current.credentials }), restoredIdentity);
          for (const name of armNames) assert.notEqual(current.deployment.id, config.arms[name].deployment.id);
          const result = await session.request('recovery', 'restore', async () => {
            const result = await runGroup({ ...current, expectedSha: config.expectedSha, credentials: current.credentials,
              samples: [recoverySample], approved: true, fetchImpl });
            assert(result.failures === 0 && result.passed); return result;
          });
          const elapsedMs = clock() - incident.monotonic;
          privateReceipt(outDir, 'recovery-service', { ...result, elapsedMs, rtoPassed: elapsedMs <= 4 * 3600_000,
            incidentAtUtc: new Date(incident.wall).toISOString(), verifiedAtUtc: new Date(now()).toISOString() });
          assert(elapsedMs <= 4 * 3600_000, 'recovery deadline missed'); mark(command, { elapsedMs });
        } else if (command === 'availability') {
          // A deletion attestation is required as well as HTTP unavailability;
          // HTTP alone cannot prove that billable resources have been removed.
          assert(config.ownerCleanup?.deploymentsDeleted === true && config.ownerCleanup?.backendQuiescence === true);
          const targets = [...armNames.map(name => [name, config.arms[name]]), ...(config.restore?.deployment ? [['restore', verifyRecovery()]] : [])];
          for (const [name, arm] of targets) {
            const url = verifyPreview(arm.deployment, arm.binding, config.expectedSha);
            await session.request('availability', name, async () => {
              const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(35_000),
                headers: { authorization: `Bearer ${arm.credentials.bearer}`, 'x-vercel-protection-bypass': arm.credentials.bypass } });
              assert([404, 410].includes(response.status), 'deployment unavailability unproven');
              await response.body?.cancel();
            });
          }
          mark(command, { targets: targets.length, invocations: session.used, controlPlaneAbsence: 'owner attested; see teardown inventory' });
        }
        return { status: 'passed', step: command, invocationsReserved: session.used };
      } catch (error) {
        failed = true; session.record({ kind: 'owner-step-failed', step: command,
          errorClass: ['Error', 'TypeError', 'RangeError', 'AggregateError'].includes(error?.name) ? error.name : 'unknown',
          code: /^[0-9A-Z]{5}$/.test(error?.code ?? '') ? error.code : 'unspecified' }); throw new Error(fixedFailure);
      }
    },
    stop() { stopSignal.abort(); },
    close() { if (!closed) { session.close(); closed = true; config = null; restore = null; } },
  };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--self-test') { await selfTest(); return; }
  if (args.length === 1 && args[0] === '--help') {
    console.log('Owner-only #300: --approved --private /ABS/inputs.json --out /ABS/NEW-DIRECTORY');
    console.log('Commands: setup, delivery, matrix, source, incident, requested, ready, verify, restore-delivery, recovery, availability, close.');
    console.log('Private input format and owner console steps: docs/300-owner-execution.md. No resume.'); return;
  }
  assert(args.length === 5 && args[0] === '--approved' && args[1] === '--private' && args[3] === '--out');
  const input = privateJson(args[2]);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), input.expectedSha);
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(), 'feature/dfsEV-300-ps5-ha-stage1');
  assert.equal(execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), '');
  const op = operator(args[2], args[4], { approved: true });
  // No echo of private inputs. Commands contain only fixed step names.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const interrupt = () => { op.stop(); process.exitCode = 1; console.error('STOP: draining the in-flight wave; owner teardown required.'); };
  rl.on('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);
  try {
    console.log('Session open. Commands are one-shot; EOF closes without resume. Owner console steps remain manual.');
    for await (const line of rl) {
      const command = line.trim();
      try { console.log(JSON.stringify(await op.command(command))); }
      catch { console.error(fixedFailure); process.exitCode = 1; }
      if (command === 'close') break;
    }
  } finally { rl.removeListener('SIGINT', interrupt); rl.close(); op.close(); process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt); }
}

async function selfTest() {
  const { runOwnerTests } = await import('./300-owner-runner.check.mjs');
  await runOwnerTests({ operator, privateJson, connectionOptions, fullPoolTimeouts, installFixture, snapshot });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch { console.error(fixedFailure); process.exitCode = 1; }
}
