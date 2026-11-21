// Explicit local-only qualification. --work records cold IO but makes no speed
// assertion; --timing is opt-in and requires a separately clear timing window.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Client } from 'pg';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createTemplateRun, getTemplateReference } from '@dfs-ev/db-tooling/test-support/templates';
import { createScratchHarness } from '@dfs-ev/db-tooling/test-support/scratch';
import { assertNoApplicationCredentials } from '@dfs-ev/db-tooling/test-support/target';
import { paidAdmissionSql } from '../../src/paidOddsAdmission.ts';
import { latestProviderQuotaSql } from '../../src/providerQuota.ts';

const [mode, destination] = process.argv.slice(2);
assert(['--work','--timing'].includes(mode) && destination && process.argv.length === 4,
  'Usage: production-requalification.mjs --work|--timing PRIVATE_OUTPUT_DIRECTORY');
assert(process.env.DB_TEST_LANE === 'lane-2' && process.env.DB_TEST_TIER === 'standard');
assertNoApplicationCredentials(process.env);
const output = resolve(destination);
const repository = await realpath(new URL('../../../..',import.meta.url));
await mkdir(output,{recursive:true,mode:0o700});
const actualOutput = await realpath(output);
assert(actualOutput !== repository && !actualOutput.startsWith(repository+sep),'Receipt must remain outside Git');
const directory = await mkdtemp(join(tmpdir(),'dfs223-production-requalification-'));
const proposals = [new URL('../223_paid_leader_gcra.sql',import.meta.url)];
const templateRun = await createTemplateRun(process.env,directory,undefined,proposals);
const environment = {...process.env,TEST_DATABASE_TEMPLATE_MANIFEST:templateRun.manifestPath};
let harness;
const samples=[];
const statsSql = `SELECT CASE WHEN schemaname='pg_catalog' THEN 'catalog' ELSE 'user' END kind,
 sum(coalesce(heap_blks_hit,0)+coalesce(idx_blks_hit,0)+coalesce(toast_blks_hit,0)+coalesce(tidx_blks_hit,0))::bigint hits,
 sum(coalesce(heap_blks_read,0)+coalesce(idx_blks_read,0)+coalesce(toast_blks_read,0)+coalesce(tidx_blks_read,0))::bigint reads
 FROM pg_statio_all_tables WHERE schemaname IN('public','pg_catalog') GROUP BY 1`;
const readStats = async c => {
 await c.query('SELECT pg_stat_clear_snapshot()');
 return Object.fromEntries((await c.query(statsSql)).rows.map(r=>[r.kind,{hits:Number(r.hits??0),reads:Number(r.reads??0)}]));
};
const delta = (a,b) => Object.fromEntries(['catalog','user'].map(k=>[k,{
 hits:(b[k]?.hits??0)-(a[k]?.hits??0),reads:(b[k]?.reads??0)-(a[k]?.reads??0)}]));
const dimensions = (name,burst=1) => [{keys:['v1:anonymous-network:'+createHash('sha256').update(name).digest('hex')],
 report:'v1:anonymous-network:'+createHash('sha256').update(name).digest('hex'),intervalMs:60000,burst,traffic:'anonymous'}];
try {
 harness=await createScratchHarness(environment);
 const reference=await getTemplateReference(environment,undefined,proposals);
 await harness.withDatabase(async (setup,config)=>{
  await setup.query(`INSERT INTO public.odds_api_request_log
   (id,request_kind,source,sport_key,requested_at,response_received_at,outcome,http_status,quota_remaining)
   VALUES('qualification','events','slate','americanfootball_nfl',clock_timestamp(),clock_timestamp(),'success',200,1000000)`);
  for(let round=0;round<5;round++) {
   const backend=new Client(config);await backend.connect();
   const baseline=mode==='--timing'?new Client(config):null;
   const measureBaseline=async()=>{
    const start=performance.now();await baseline.query(latestProviderQuotaSql,[]);
    samples.push({round:round+1,backendPid:baseline.processID,phase:'floor-only-baseline',elapsedMs:performance.now()-start});
   };
   try {
    if(baseline) {
     await baseline.connect();await baseline.query(latestProviderQuotaSql,[]);
     // Interleave the former floor-only baseline around admission trials. Use
     // a separate backend so the baseline cannot warm the cold branch backend.
     if(round%2===0)await measureBaseline();
    }
    // Flush instrumentation occurs outside the measured admission statement.
    await backend.query('SELECT pg_stat_force_next_flush()');
    const dims=dimensions('cold-'+round);
    for(const phase of ['cold-allow','first-denial','warm-denial','warm-allow']) {
     const selected=phase==='warm-allow'?dimensions('warm-allow-'+round):dims;
     const before=await readStats(setup);
     let result,elapsedMs;
     if(mode==='--timing') {
      const start=performance.now();result=await backend.query(paidAdmissionSql,[JSON.stringify(selected),true,100,9]);elapsedMs=performance.now()-start;
     } else {
      result=await backend.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+paidAdmissionSql,[JSON.stringify(selected),true,100,9]);
     }
     await backend.query('SELECT pg_stat_force_next_flush()');
     const after=await readStats(setup);
     const plan=mode==='--work'?result.rows[0]['QUERY PLAN'][0].Plan:null;
     samples.push({round:round+1,backendPid:backend.processID,phase,tableIoDelta:delta(before,after),
      ...(plan?{shared:(plan['Shared Hit Blocks']??0)+(plan['Shared Read Blocks']??0),tempRead:plan['Temp Read Blocks']??0,tempWritten:plan['Temp Written Blocks']??0}: {elapsedMs,outcome:result.rows[0].outcome})});
    }
    if(baseline && round%2===1)await measureBaseline();
   } finally {try{await baseline?.end();}finally{await backend.end();}}
  }
 },reference);
 const summary = mode==='--timing'?Object.fromEntries(['cold-allow','first-denial','warm-denial','warm-allow','floor-only-baseline'].map(phase=>{
  const values=samples.filter(s=>s.phase===phase).map(s=>s.elapsedMs).toSorted((a,b)=>a-b);
  return [phase,{n:values.length,p95Ms:values[Math.ceil(values.length*.95)-1],maxMs:values.at(-1)}];
 })):null;
 const passed=summary?Object.values(summary).every(s=>s.p95Ms<=53*.7):null;
 const sourceSha256=Object.fromEntries(await Promise.all([['script',new URL('./production-requalification.mjs',import.meta.url)],['proposal',proposals[0]],['admissionRuntime',new URL('../../src/paidOddsAdmission.ts',import.meta.url)]].map(async([name,url])=>[name,createHash('sha256').update(await readFile(url)).digest('hex')])));
 const receipt={sourceSha256,fixture:'223-production-first-use-five-backends',mode,createdAt:new Date().toISOString(),samples,summary,
  localAdmissionSliceMs:53,screenWith30PercentHeadroomMs:37.1,passed,
  limitations:['Local pg TCP comparator only; no hosted/Neon HTTP speed claim.','Catalog/user pg_statio deltas include statistics-flush/observer instrumentation and cumulative-statistics publication effects; they are evidence, not an exact partition of EXPLAIN buffer totals.','First-use compile/catalog work is not a warmed CI buffer ceiling.','No provider calls or application credentials.']};
 await writeFile(join(output,mode==='--work'?'cold-work.json':'speed.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({mode,samples:samples.length,summary,passed}));
 if(mode==='--timing')assert(passed,'Local admission speed screen failed; report to owner');
} finally {try{await harness?.close();}finally{await templateRun.close();}}
