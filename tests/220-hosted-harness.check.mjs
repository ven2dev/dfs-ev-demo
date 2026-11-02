import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, chmod, rm, symlink, mkdir, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorize, createHandler, sampleKey, validateSample, PROJECT_ID, NEON_PROJECT_ID } from '../apps/web/src/lib/qualification220-core.mjs';
import { createBranchPayload, environmentPayload, verifyEnvironmentMetadata, schedule, armSchedule, createPrivateRun, readPrivate, verifyCleanup } from '../scripts/spikes/220-hosted/plan.mjs';
import { runGroup, verifyPreview, distribution, summarizeArm, verifyArmReceipts, verifyRegionOnlyChange, verifyRegionProof, readRegionCommitProof } from '../scripts/spikes/220-hosted/load.mjs';
import { tickets, prepareGroup, initialization, markets } from '../scripts/spikes/220-hosted/setup.mjs';
const now=Date.now(),bearer='a'.repeat(64),sha='b'.repeat(40),host='qualification-test.vercel.app';
const expectedShaByArm={iad1:sha,pdx1:'c'.repeat(40)};
const production={verified:true,region:'iad1',nodeMajor:24,driverVersion:'1.2.0',neonBranchId:'br-production',neonEndpointId:'ep-production',neonRegion:'aws-us-east-1',minCu:.25,maxCu:2,suspendSeconds:300,database:'neondb',connectionProtocol:'postgresql:',connectionParams:[['sslmode','require']]};
const binding={arm:'iad1',projectId:PROJECT_ID,production,neon:{projectId:NEON_PROJECT_ID,verified:true,schemaOnly:true,parentId:'br-production',branchId:'br-test',endpointId:'ep-test',host:'ep-test-pooler.us-east-1.aws.neon.tech',role:'spike220_runner_123456abcdef',database:'neondb',neonRegion:'aws-us-east-1',minCu:.25,maxCu:2,suspendSeconds:300},gates:{automationBypass:true,branchScopedSensitive:true,previewProtection:true},gitBranch:'feature/dfsEV-220-hosted-harness',reviewedSha:sha,runId:'12345678-1234-1234-1234-123456789abc'};
const env={SPIKE220_ENABLED:'1',VERCEL_ENV:'preview',VERCEL_REGION:'iad1',VERCEL_PROJECT_ID:PROJECT_ID,VERCEL_GIT_COMMIT_REF:binding.gitBranch,VERCEL_GIT_COMMIT_SHA:sha,VERCEL_URL:host,SPIKE220_BINDING:JSON.stringify(binding),SPIKE220_ISSUED_AT:new Date(now-1000).toISOString(),SPIKE220_EXPIRES_AT:new Date(now+10000).toISOString(),SPIKE220_TOKEN_SHA256:createHash('sha256').update(bearer).digest('hex'),SPIKE220_DATABASE_URL:`postgresql://${binding.neon.role}:${'x'.repeat(40)}@${binding.neon.host}/neondb?sslmode=require`};
const sample={stage:'warm',workers:20,round:0,mode:'path',index:0};
const request=(body=sample,url=`https://${host}/api/qualification220`,token=bearer)=>new Request(url,{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body)});
const deployment={source:'git',id:'dpl_test',functionMetadata:{source:'deployment-function-metadata',deploymentId:'dpl_test',path:'/api/qualification220',regions:['iad1']},projectId:PROJECT_ID,target:'preview',readyState:'READY',sha,gitBranch:binding.gitBranch,protectionVerified:true,url:`https://${host}`};
const regionProof={source:'local-git',fromSha:sha,toSha:expectedShaByArm.pdx1,parents:[sha],changedPaths:['apps/web/vercel.json'],beforeConfig:{regions:['iad1']},afterConfig:{regions:['pdx1']}};
const otherBinding={...binding,arm:'pdx1',reviewedSha:expectedShaByArm.pdx1,runId:'22345678-1234-1234-1234-123456789abc'};
const otherDeployment={...deployment,id:'dpl_pdx',sha:expectedShaByArm.pdx1,url:'https://qualification-pdx.vercel.app',functionMetadata:{...deployment.functionMetadata,deploymentId:'dpl_pdx',regions:['pdx1']}};
const armReceipts=[{binding,deployment},{binding:otherBinding,deployment:otherDeployment}];
test('valid binding is accepted; Production, wrong SHA/branch/project/region/host and expired configurations fail before DB factory',async()=>{
 assert.ok(authorize(request(),env,now));
 for(const patch of [{VERCEL_ENV:'production'},{VERCEL_REGION:'sfo1'},{VERCEL_PROJECT_ID:'other'},{VERCEL_GIT_COMMIT_SHA:'c'.repeat(40)},{VERCEL_GIT_COMMIT_REF:'main'},{VERCEL_URL:'other.vercel.app'},{SPIKE220_EXPIRES_AT:new Date(now).toISOString()},{SPIKE220_ENABLED:'0'},{SPIKE220_BINDING:JSON.stringify({...binding,production:{...production,verified:false}})},{SPIKE220_DATABASE_URL:env.SPIKE220_DATABASE_URL.replace('ep-test-pooler','ep-production-pooler')}]){
 let calls=0;const handler=createHandler({env:{...env,...patch},now:()=>now,queryFactory:()=>{calls++;throw Error('never');}});
 assert.equal((await handler(request())).status,404);assert.equal(calls,0);
 }
});
test('bearer and direct deployment URL checks reject query, custom host and invalid token',()=>{
 for(const req of [request(sample,`https://${host}/api/qualification220?secret=bad`),request(sample,'https://example.com/api/qualification220'),request(sample,undefined,'bad')])assert.equal(authorize(req,env,now),null);
});
test('sample allowlist rejects loops, extra fields and unsupported cold paths',async()=>{
 for(const x of [{...sample,workers:21},{...sample,index:1000},{...sample,sql:'SELECT 1'},{...sample,stage:'cold',mode:'admission'}])assert.throws(()=>validateSample(x));
 let calls=0;const handler=createHandler({env,now:()=>now,queryFactory:()=>{calls++;}});
 assert.equal((await handler(request('x'.repeat(2000)))).status,404);assert.equal(calls,0);
});
test('one invocation runs one cache read, one admission and post-boundary release',async()=>{
 const calls=[];let tick=0;
 const handler=createHandler({env,now:()=>now,clock:()=>++tick,queryFactory:()=>async (sql,args)=>{assert.equal(args.length,2);assert.ok(!args.includes(env.SPIKE220_TOKEN_SHA256));calls.push(sql);return [{outcome:sql.includes('hosted_begin')?'claimed':'leader',owner:'owner'}];}});
 const body=await (await handler(request())).json();
 assert.equal(body.outcome,'leader');assert.equal(body.preProviderQueries,2);assert.equal(body.sqlQueries,3);assert.equal(calls.length,3);assert.ok(body.inFunctionTotalMs>body.inFunctionPreProviderMs);
});
test('free-probe followers return immediately without polling or external call',async()=>{
 let probes=0;const calls=[];
 const handler=createHandler({env,now:()=>now,queryFactory:()=>async sql=>{calls.push(sql);return [{outcome:sql.includes('hosted_begin')?'claimed':sql.includes('claim_probe')?'follower':'quota-stale',owner:'owner'}];},freeEvents:async()=>{probes++;}});
 const body=await (await handler(request({...sample,stage:'stale'}))).json();
 assert.equal(body.outcome,'probe-follower-stale');assert.equal(body.sqlQueries,3);assert.equal(probes,0);assert.equal(calls.length,3);
});
test('probe leader observes outside SQL and retries admission once',async()=>{
 const calls=[];let admissions=0;
 const handler=createHandler({env,now:()=>now,queryFactory:()=>async sql=>{calls.push(sql);return [{outcome:sql.includes('hosted_begin')?'claimed':sql.includes('claim_probe')?'leader':sql.includes('finish_probe')?'accepted':sql.includes('hosted_sample')?(++admissions===1?'quota-stale':'leader'):'released',owner:'owner'}];},freeEvents:async()=>{assert.ok(calls.at(-1).includes('claim_probe'));return {remaining:100,used:0,last:0,observed:new Date(now).toISOString()};}});
 const body=await (await handler(request({...sample,stage:'stale'}))).json();assert.equal(body.freeProbe,true);assert.equal(body.preProviderQueries,5);assert.equal(body.sqlQueries,6);assert.equal(admissions,2);
});
test('database errors return generic failure without credential content',async()=>{
 const handler=createHandler({env,now:()=>now,queryFactory:()=>async()=>{throw Error(env.SPIKE220_DATABASE_URL+bearer);}});
 const response=await handler(request());assert.equal(response.status,503);assert.ok(!(await response.text()).includes(bearer));
});
test('schedule is bounded, unique and pairs each warm group with preceding warmup',()=>{
 const all=schedule();assert.equal(new Set(all.map(sampleKey)).size,all.length);assert.ok(all.length<=20000);
 const groups=all.filter((x,i)=>i===0||all[i-1].stage!==x.stage||all[i-1].mode!==x.mode||all[i-1].round!==x.round||all[i-1].workers!==x.workers);
 groups.forEach((x,i)=>{if(x.stage==='warm'){assert.equal(groups[i-1].stage,'warmup');assert.equal(groups[i-1].mode,x.mode);}});
 assert.equal(tickets().length,all.length);assert.equal(prepareGroup('next-tick:20:0:path',{},binding.runId).length,1);
});
test('schema-only payload and exact-branch Secret variable metadata fail closed',()=>{
 assert.throws(()=>createBranchPayload({},'spike220-123456abcdef',new Date().toISOString()));
 const p=createBranchPayload({verified:true,projectId:NEON_PROJECT_ID,branchId:'br-production',minCu:.25,maxCu:2,suspendSeconds:300},'spike220-123456abcdef',new Date(now+10000).toISOString());assert.equal(p.branch.init_source,'schema-only');
 const values=environmentPayload(binding,{bearer,issuedAt:env.SPIKE220_ISSUED_AT,expiresAt:env.SPIKE220_EXPIRES_AT},env.SPIKE220_DATABASE_URL);
 const metadata=values.map((x,i)=>({...x,value:undefined,id:String(i)}));
 assert.equal(verifyEnvironmentMetadata(metadata,binding.gitBranch,values.map(x=>x.key)).length,values.length);
 assert.throws(()=>verifyEnvironmentMetadata(metadata.map(x=>({...x,gitBranch:undefined})),binding.gitBranch,values.map(x=>x.key)));
});
test('private file is exclusive 0600, outside Git, and rejects symlinks/permissions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spike220-unit-'));
 try{
 const path=join(dir,'run.json');await createPrivateRun(path,now);assert.equal((await readPrivate(path)).bearer.length,64);await assert.rejects(createPrivateRun(path,now));
 await symlink(path,join(dir,'link'));await assert.rejects(readPrivate(join(dir,'link')));
 await chmod(path,0o644);await assert.rejects(readPrivate(path));
 await mkdir(join(dir,'.git'));await assert.rejects(createPrivateRun(join(dir,'other.json')));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('external generator runs distinct waves of 20 and uses in-function timing',async()=>{
 let active=0,max=0,calls=0;
 const samples=Array.from({length:40},(_,index)=>({...sample,index}));
 const result=await runGroup({deployment,binding,expectedShaByArm,armReceipts,regionProof,credentials:{bearer,bypass:'z'.repeat(32)},samples,approved:true,fetchImpl:async(url,options)=>{
 assert.equal(url,`https://${host}/api/qualification220`);assert.equal(options.redirect,'error');assert.equal(options.headers['x-vercel-protection-bypass'],'z'.repeat(32));
 active++;max=Math.max(max,active);calls++;await new Promise(resolve=>setImmediate(resolve));active--;
 return Response.json({sample:JSON.parse(options.body),runId:binding.runId,sha,region:'iad1',arm:'iad1',queryTimings:Array.from({length:3},()=>({operation:'hosted_sample',elapsedMs:10})),outcome:'leader',inFunctionPreProviderMs:141,preProviderSqlMs:100,preProviderQueries:2,inFunctionTotalMs:160,sqlQueries:3});
 }});
 assert.equal(max,20);assert.equal(calls,40);assert.equal(result.passed,false);assert.equal(result.timing.p95Ms,141);
});
test('no approval, wrong Preview or unproven suspension prevents requests',async()=>{
 await assert.rejects(runGroup({deployment,binding,expectedShaByArm,armReceipts,regionProof,credentials:{},samples:[sample]}));
 assert.throws(()=>verifyPreview({...deployment,target:'production'},binding,expectedShaByArm));
 await assert.rejects(runGroup({deployment,binding,expectedShaByArm,armReceipts,regionProof,credentials:{bearer,bypass:'z'.repeat(32)},samples:[{...sample,stage:'cold',mode:'baseline',workers:1}],approved:true}));
});
test('lost responses count as failures and are never retried',async()=>{
 let calls=0;const result=await runGroup({deployment,binding,expectedShaByArm,armReceipts,regionProof,credentials:{bearer,bypass:'z'.repeat(32)},samples:[sample],approved:true,fetchImpl:async()=>{calls++;throw Error(bearer);}});
 assert.equal(calls,1);assert.equal(result.failures,1);assert.equal(result.passed,false);assert.ok(!JSON.stringify(result).includes(bearer));
 assert.deepEqual(distribution([1,2,3]),{samples:3,p50Ms:2,p95Ms:3,p99Ms:3,maxMs:3});
});
test('cleanup receipt requires every independent absence check',()=>{
 assert.throws(()=>verifyCleanup({branchAbsent:true}));assert.ok(verifyCleanup(Object.fromEntries(['branchAbsent','roleAbsent','variablesAbsent','deploymentUnavailable','secretFileAbsent'].map(k=>[k,true]))));
});

test('setup preallocates bounded unique tickets, full 240-key catalog and no shared run counter',()=>{
 const setup=initialization(binding,new Date(now+10000).toISOString());
 assert.equal(markets.length*20,240);
 const rows=JSON.parse(setup[3].values[1]);assert.equal(rows.length,schedule().length);assert.ok(rows.length<=20000);
 assert.equal(new Set(rows.map(x=>x.owner)).size,rows.length);
 assert.equal(setup.at(-1).requireCount,rows.length);
 assert.throws(()=>prepareGroup('stale:20:0:path',{remaining:19,used:0},binding.runId));
});
test('unverified compute and unsupported protections block configuration',()=>{
 for(const mutate of [c=>{c.neon.minCu=1;},c=>{c.gates.branchScopedSensitive=false;},c=>{c.gates.automationBypass=false;},c=>{c.neon.schemaOnly=false;}]){
 const copy=structuredClone(binding);mutate(copy);assert.equal(authorize(request(),{...env,SPIKE220_BINDING:JSON.stringify(copy)},now),null);
 }
});
test('probe errors return typed unavailable and do not retry admission or poll',async()=>{
 let count=0;const handler=createHandler({env,now:()=>now,queryFactory:()=>async sql=>{count++;return [{outcome:sql.includes('hosted_begin')?'claimed':sql.includes('claim_probe')?'leader':sql.includes('finish_probe')?'invalid':'quota-stale',owner:'owner'}];},freeEvents:async()=>{throw Error(bearer);}});
 const body=await(await handler(request({...sample,stage:'stale'}))).json();assert.equal(body.outcome,'observation-unavailable');assert.equal(count,4);assert.ok(!JSON.stringify(body).includes(bearer));
});

test('both arms authenticate only in their bound region; Production profile remains iad1',()=>{
 const pdx={...binding,arm:'pdx1',reviewedSha:expectedShaByArm.pdx1};
 assert.ok(authorize(request(),{...env,VERCEL_REGION:'pdx1',VERCEL_GIT_COMMIT_SHA:expectedShaByArm.pdx1,SPIKE220_BINDING:JSON.stringify(pdx)},now));
 assert.equal(authorize(request(),{...env,VERCEL_REGION:'pdx1',SPIKE220_BINDING:JSON.stringify(pdx)},now),null);
 assert.equal(authorize(request(),{...env,SPIKE220_BINDING:JSON.stringify(pdx)},now),null);
 assert.equal(authorize(request(),{...env,SPIKE220_BINDING:JSON.stringify({...binding,arm:'sfo1'})},now),null);
 assert.throws(()=>verifyPreview({...deployment,functionMetadata:{...deployment.functionMetadata,regions:['pdx1']}},binding,expectedShaByArm));
 assert.throws(()=>verifyPreview({...deployment,functionMetadata:undefined},binding,expectedShaByArm));
});
test('arm blocks alternate AB/BA with the same complete matrix and paired warmup',()=>{
 const plan=armSchedule();assert.equal(plan[0].arm,'iad1');assert.equal(plan[1].arm,'pdx1');assert.equal(plan[2].arm,'pdx1');assert.equal(plan[3].arm,'iad1');
 for(const arm of ['iad1','pdx1'])assert.deepEqual(plan.filter(x=>x.arm===arm).flatMap(x=>x.samples),schedule());
 for(const block of plan){if(block.samples[0].stage==='warmup'){assert.equal(block.samples[19].stage,'warmup');assert.equal(block.samples[20].stage,'warm');}}
 const activation=prepareGroup('warm:20:0:path',{remaining:100000,used:0},binding.runId).at(-1);
 assert.ok(activation.text.includes("ELSE 'paused'"));assert.equal(activation.values[1],binding.runId);
 assert.equal(initialization({...binding,arm:'pdx1'},new Date(now+10000).toISOString(),{includeFixture:false}).length,3);
});
test('baseline emits a separate SELECT 1 timing after the measured boundary',async()=>{
 let tick=0;const calls=[];
 const handler=createHandler({env,now:()=>now,clock:()=>++tick,queryFactory:()=>async(sql,args)=>{calls.push({sql,args});return [{outcome:'baseline'}];}});
 const body=await(await handler(request({...sample,mode:'baseline'}))).json();
 assert.equal(body.arm,'iad1');assert.equal(body.preProviderQueries,1);assert.equal(body.sqlQueries,2);assert.equal(calls[1].sql,'SELECT 1');assert.deepEqual(calls[1].args,[]);
 assert.equal(body.queryTimings.at(-1).operation,'transport');assert.ok(body.transportRoundTripMs>=0);assert.ok(body.inFunctionTotalMs>body.inFunctionPreProviderMs);
});
test('p95 gates allow outlier maxima and overall warm assessment never pools arms',async()=>{
 const samples=Array.from({length:100},(_,index)=>({...sample,index}));
 const result=await runGroup({deployment,binding,expectedShaByArm,armReceipts,regionProof,credentials:{bearer,bypass:'z'.repeat(32)},samples,approved:true,fetchImpl:async(_,options)=>{
 const s=JSON.parse(options.body);return Response.json({sample:s,runId:binding.runId,sha,region:'iad1',arm:'iad1',outcome:'leader',inFunctionPreProviderMs:s.index===99?500:100,preProviderSqlMs:50,preProviderQueries:2,inFunctionTotalMs:600,sqlQueries:3,queryTimings:Array.from({length:3},()=>({operation:'hosted_sample',elapsedMs:10}))});
 }});
 assert.ok(result.passed);assert.equal(result.timing.p95Ms,100);assert.equal(result.timing.maxMs,500);assert.equal(result.timing.p99Ms,100);
 const groups=[];
 for(const mode of ['baseline','admission','path'])for(const workers of [1,20])for(let round=0;round<3;round++)groups.push({arm:'iad1',sha,group:`warm:${workers}:${round}:${mode}`,failures:0,passed:true,timing:distribution([100]),rows:Array.from({length:1000},()=>({inFunctionPreProviderMs:100,transportRoundTripMs:10}))});
 assert.ok(summarizeArm(groups,'iad1',expectedShaByArm).passed);
 assert.throws(()=>summarizeArm([...groups,{...groups[0],arm:'pdx1'}],'iad1',expectedShaByArm));
 assert.throws(()=>summarizeArm(groups.slice(1),'iad1',expectedShaByArm));
 const slow=structuredClone(groups);for(const g of slow)for(const row of g.rows)row.inFunctionPreProviderMs=201;
 assert.equal(summarizeArm(slow,'iad1',expectedShaByArm).passed,false);
});

test('Git deployment config selects one arm and no CLI-only alternate config exists',async()=>{
 const iad=JSON.parse(await readFile(new URL('../apps/web/vercel.json',import.meta.url),'utf8'));
 assert.equal(iad.regions.length,1);assert.ok(['iad1','pdx1'].includes(iad.regions[0]));
 await assert.rejects(access(new URL('../apps/web/vercel.harness-pdx1.json',import.meta.url)),e=>e.code==='ENOENT');
});
test('immutable Git arm receipts pin distinct expected SHAs and reject swapped or CLI deployments',()=>{
 const pdxBinding={...binding,arm:'pdx1',reviewedSha:expectedShaByArm.pdx1,runId:'22345678-1234-1234-1234-123456789abc'};
 const pdxDeployment={...deployment,id:'dpl_pdx',sha:expectedShaByArm.pdx1,url:'https://qualification-pdx.vercel.app',functionMetadata:{...deployment.functionMetadata,deploymentId:'dpl_pdx',regions:['pdx1']}};
 const receipts=[{binding,deployment},{binding:pdxBinding,deployment:pdxDeployment}];
 const pinned=verifyArmReceipts(receipts,expectedShaByArm,regionProof);
 assert.equal(pinned.iad1.expectedSha,sha);assert.equal(pinned.pdx1.expectedSha,expectedShaByArm.pdx1);
 assert.throws(()=>verifyArmReceipts(receipts,{iad1:sha,pdx1:sha},regionProof));
 assert.throws(()=>verifyArmReceipts(receipts,{iad1:null,pdx1:null},regionProof));
 assert.throws(()=>verifyArmReceipts(receipts,{iad1:expectedShaByArm.pdx1,pdx1:sha},regionProof));
 assert.throws(()=>verifyPreview({...deployment,source:'cli'},binding,expectedShaByArm));
 assert.throws(()=>verifyPreview({...pdxDeployment,sha},pdxBinding,expectedShaByArm));
 assert.throws(()=>verifyArmReceipts([receipts[0],{...receipts[1],binding:{...pdxBinding,runId:binding.runId}}],expectedShaByArm,regionProof));
});

test('second planned Git commit changes only vercel.json region, preserving harness and cron settings',()=>{
 const beforeConfig={regions:['iad1'],crons:[{path:'/api/cron/sync-player-stats',schedule:'0 13 * * *'}]};
 const afterConfig={...beforeConfig,regions:['pdx1']};
 assert.ok(verifyRegionOnlyChange({changedPaths:['apps/web/vercel.json'],beforeConfig,afterConfig}));
 assert.throws(()=>verifyRegionOnlyChange({changedPaths:['apps/web/vercel.json','apps/web/src/proxy.ts'],beforeConfig,afterConfig}));
 assert.throws(()=>verifyRegionOnlyChange({changedPaths:['apps/web/vercel.json'],beforeConfig,afterConfig:{...afterConfig,crons:[]}}));
});

test('request execution cannot skip paired receipts or direct region-only lineage proof',async()=>{
 let calls=0;const options={deployment,binding,expectedShaByArm,armReceipts,regionProof,credentials:{bearer,bypass:'z'.repeat(32)},samples:[sample],approved:true,fetchImpl:async()=>{calls++;throw Error('must not fetch');}};
 for(const patch of [{armReceipts:undefined},{regionProof:undefined},{regionProof:{...regionProof,parents:['d'.repeat(40)]}},{regionProof:{...regionProof,parents:[sha,'d'.repeat(40)]}},{regionProof:{...regionProof,changedPaths:['apps/web/vercel.json','extra.mjs']}},{regionProof:{...regionProof,fromSha:'d'.repeat(40)}},{deployment:{...deployment,id:'dpl_unpinned'}}])await assert.rejects(runGroup({...options,...patch}));
 assert.equal(calls,0);
 assert.throws(()=>verifyRegionProof({...regionProof,afterConfig:{regions:['pdx1'],extra:true}},expectedShaByArm));
});
test('read-only Git proof reader refuses an unavailable B without changing the checkout',async()=>{
 const repo=new URL('../',import.meta.url).pathname;
 await assert.rejects(readRegionCommitProof(repo,{iad1:'89673a3ff4cb3c258c4f7e0d9995403b1bfc1c33',pdx1:'0'.repeat(40)}));
});

test('Git proof reader derives lineage, changed paths and configs from read-only commands',async()=>{
 const calls=[];const readGit=async args=>{
  calls.push(args);
  if(args[0]==='rev-list')return `${expectedShaByArm.pdx1} ${sha}\n`;
  if(args[0]==='diff')return 'apps/web/vercel.json\0';
  if(args[0]==='show')return JSON.stringify({regions:[args[1].startsWith(sha)?'iad1':'pdx1']});
  throw Error('unexpected Git command');
 };
 const proof=await readRegionCommitProof('/unused-mocked-path',expectedShaByArm,{readGit});
 assert.ok(verifyRegionProof(proof,expectedShaByArm));assert.equal(calls.length,4);
 assert.deepEqual(calls.map(x=>x[0]),['rev-list','diff','show','show']);
 await assert.rejects(readRegionCommitProof('/unused-mocked-path',expectedShaByArm,{readGit:async args=>args[0]==='rev-list'?`${expectedShaByArm.pdx1} ${'d'.repeat(40)}\n`:readGit(args)}));
});

test('raw samples own p95 gates even when cached summaries claim a pass',()=>{
 const groups=[];
 for(const mode of ['baseline','admission','path'])for(const workers of [1,20])for(let round=0;round<3;round++)groups.push({arm:'iad1',sha,group:`warm:${workers}:${round}:${mode}`,failures:0,passed:true,timing:distribution([100]),rows:Array.from({length:1000},()=>({inFunctionPreProviderMs:workers===20?150:100,transportRoundTripMs:10}))});
 const result=summarizeArm(groups,'iad1',expectedShaByArm);
 assert.equal(result.passed,false);assert.equal(result.reports.path.rounds[0].timing.p95Ms,150);
 assert.equal(result.reports.path.rounds[0].passed,false);assert.equal(result.reports.path.overallWarm.p95Ms,150);
 const failed=structuredClone(groups);failed[0].rows[0]={failed:true};
 assert.equal(summarizeArm(failed,'iad1',expectedShaByArm).passed,false);
 const malformed=structuredClone(groups);malformed[0].rows[0].inFunctionPreProviderMs=NaN;
 assert.throws(()=>summarizeArm(malformed,'iad1',expectedShaByArm));
});

test('claim and finish retain needs-init/backoff outcomes without retry or polling',async()=>{
 for(const outcome of ['needs-init','backoff'])for(const phase of ['claim_probe','finish_probe']){
  let probes=0,admissions=0;
  const handler=createHandler({env,now:()=>now,queryFactory:()=>async sql=>{
   if(sql.includes('hosted_sample'))admissions++;
   return [{outcome:sql.includes('hosted_begin')?'claimed':sql.includes(phase)?outcome:sql.includes('claim_probe')?'leader':'quota-stale',owner:'owner'}];
  },freeEvents:async()=>{probes++;return {remaining:100,used:0,last:0,observed:new Date(now).toISOString()};}});
  const body=await(await handler(request({...sample,stage:'stale'}))).json();
  assert.equal(body.outcome,outcome);assert.equal(admissions,1);assert.equal(probes,phase==='finish_probe'?1:0);
 }
});
