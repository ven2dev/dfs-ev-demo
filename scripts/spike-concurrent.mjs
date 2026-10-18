// Disposable feasibility runner: two independent execution lanes, existing gates.
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,appendFile} from 'node:fs/promises';
import {tmpdir,availableParallelism} from 'node:os'; import {join} from 'node:path';
import {NODE_REQUIRED_CASES,validateNodeDbReport,validateLeaseDbReport,validateReadinessDbReport,validatePredictiveDbReport,validateCorpusDbReport} from './db-test-contract.mjs';
import {assertNoApplicationCredentials,parseTestDatabaseUrl} from '../tests/db/target.mts';
assertNoApplicationCredentials(process.env);parseTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const spikeStarted=performance.now();
const cpus=availableParallelism(); const nodeWorkers=Math.max(1,Math.floor(cpus/4)); const scratchWorkers=Math.min(3,Math.max(1,cpus-nodeWorkers));
console.log(JSON.stringify({hostedSpike:true,availableCPUs:cpus,nodeWorkers,scratchWorkers}));
const dir=await mkdtemp(join(tmpdir(),'dfs153-lanes-'));const active=new Set();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{for(const c of active)c.kill('SIGTERM');});
const run=(args)=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,args,{stdio:'inherit',env:process.env});active.add(c);c.on('error',reject);c.on('close',code=>{active.delete(c);code===0?resolve():reject(Error('Child exit '+code));});});
async function vitest(config,path,extra=[]){await run(['node_modules/vitest/vitest.mjs','run','--config',config,'--reporter=default','--reporter=json','--outputFile.json='+path,...extra]);}
try{
 await run(['scripts/db-migration-artifacts.mjs','check']);await run(['scripts/db-readiness-manifest.mjs','check']);
 let nodeRequiredCases;
 await Promise.all([
  (async()=>{
   await run(['--test','--test-concurrency='+nodeWorkers,'--test-timeout=60000','--test-reporter=spec','--test-reporter=./scripts/db-test-reporter.mjs','--test-reporter-destination=stdout','--test-reporter-destination='+join(dir,'node.json'),...Object.keys(NODE_REQUIRED_CASES)]);
   nodeRequiredCases=validateNodeDbReport(JSON.parse(await readFile(join(dir,'node.json'),'utf8')));
   await run(['scripts/db-catalog-contracts.mjs','check']);
   await vitest('vitest.db.config.mts',join(dir,'serial.json'),['--exclude=tests/db/predictive.test.ts','--exclude=tests/db/sourceClaims.spike*.test.ts']);
  })(),
  vitest('vitest.spike.config.mts',join(dir,'parallel.json'))
 ]);
 const a=JSON.parse(await readFile(join(dir,'serial.json'),'utf8')),b=JSON.parse(await readFile(join(dir,'parallel.json'),'utf8'));
 const report={...a,success:a.success&&b.success,testResults:[...a.testResults,...b.testResults]};
 for(const k of ['numTotalTests','numPassedTests','numFailedTests','numPendingTests','numTodoTests'])report[k]=(a[k]??0)+(b[k]??0);
 const counts={nodeRequiredCases,leaseRequiredCases:validateLeaseDbReport(report),readinessRequiredCases:validateReadinessDbReport(report),predictiveRequiredCases:validatePredictiveDbReport(report),corpusRequiredCases:validateCorpusDbReport(report),result:'verified'};
 await writeFile(process.env.SPIKE_PROFILE_PATH+'.report.json',JSON.stringify(report));console.log(JSON.stringify(counts)); await appendFile(process.env.SPIKE_PROFILE_PATH+'.runs.jsonl',JSON.stringify({...counts,seconds:(performance.now()-spikeStarted)/1000})+'\n');
}finally{for(const c of active)c.kill('SIGTERM');await rm(dir,{recursive:true,force:true});}
