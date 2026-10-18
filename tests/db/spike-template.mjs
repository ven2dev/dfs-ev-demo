// Disposable spike: verified immutable per-prefix templates, isolated clones.
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { Client } from 'pg';
import { checkConnectedTarget, runScratchMigrations } from '../../scripts/db-migrations/core.mjs';
import { checkMigrationArtifacts } from '../../scripts/db-migrations/files.mjs';
import { createCatalogVerifier, loadCatalogContracts } from '../../scripts/db-migrations/contracts.mjs';
import { ensurePredictiveRoles } from '../../scripts/predictive/harness.ts';
import { parseTestDatabaseUrl, assertNoApplicationCredentials } from './target.mts';
let loaded;
const templates = new Map();
const owned = new Set();
const base = () => { assertNoApplicationCredentials(process.env); return parseTestDatabaseUrl(process.env.TEST_DATABASE_URL); };
const log = (row) => appendFileSync(process.env.SPIKE_TEMPLATE_PATH, JSON.stringify(row)+'\n');
const name = () => 'dfs_ev_test_'+randomBytes(10).toString('hex');
export async function templateFor(prefix) {
  const t = performance.now();
  loaded ??= (async()=>{ const files=await checkMigrationArtifacts(); return {files, contracts: await loadCatalogContracts(files)}; })();
  const {files,contracts}=await loaded;
  const version=prefix??files.length;
  if (!templates.has(version)) templates.set(version,(async()=>{
    const config={...base(),database:name()};
    const admin=new Client(base()); await admin.connect();
    try { await checkConnectedTarget(admin,base()); await admin.query(`CREATE DATABASE "${config.database}"`); owned.add(config.database); }
    finally { await admin.end(); }
    const client=new Client(config);
    try {
      await client.connect(); await checkConnectedTarget(client,config); await ensurePredictiveRoles(client);
      await runScratchMigrations(client,{expected:config,files:files.slice(0,version),assertTarget:c=>{ if(c!==config||!owned.has(c.database)) throw Error('unowned'); },verify:createCatalogVerifier(contracts)});
    } finally { await client.end(); }
    log({event:'build',version,ms:performance.now()-t});
    return config.database;
  })());
  return templates.get(version);
}
export async function cleanupTemplates() {
  const admin=new Client(base()); await admin.connect();
  try { for(const n of owned) { await admin.query(`DROP DATABASE "${n}" WITH (FORCE)`); owned.delete(n); } }
  finally { await admin.end(); }
}
