import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync } from 'node:fs';
const args=process.argv.slice(2);
const outputArg=args.find(a=>a.startsWith('--outputFile.json='));
if(!outputArg)throw Error('Missing report destination');
const report=outputArg.slice('--outputFile.json='.length);
const bin='node_modules/vitest/vitest.mjs';
for(const [config,path,filters] of [
 ['vitest.db.config.mts',report+'.serial',['--exclude=tests/db/predictive.test.ts','--exclude=tests/db/sourceClaims.spike*.test.ts']],
 ['vitest.spike.config.mts',report+'.parallel',[]]
]){
 const r=spawnSync(process.execPath,[bin,'run','--config',config,'--reporter=default','--reporter=json','--outputFile.json='+path,...filters],{stdio:'inherit',env:process.env});
 if(r.status!==0)process.exit(r.status??1);
}
const a=JSON.parse(readFileSync(report+'.serial')),b=JSON.parse(readFileSync(report+'.parallel'));
const result={...a,success:a.success&&b.success,testResults:[...a.testResults,...b.testResults]};
for(const k of ['numTotalTests','numPassedTests','numFailedTests','numPendingTests','numTodoTests','numTotalTestSuites','numPassedTestSuites','numFailedTestSuites','numPendingTestSuites'])result[k]=(a[k]??0)+(b[k]??0);
writeFileSync(report,JSON.stringify(result));
writeFileSync(process.env.SPIKE_PROFILE_PATH+'.report.json',JSON.stringify(result));
