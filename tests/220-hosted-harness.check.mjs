import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { authorize, createHandler as handlerFactory, sampleKey, validateSample, PROJECT_ID } from '../apps/web/src/lib/qualification220-core.mjs';
import { createRunMetadata, verifyEnvironmentMetadata, schedule, sameSubjectControl, runSchedule, verifyCleanup } from '../scripts/spikes/220-hosted/plan.mjs';
import { runGroup, verifyPreview, distribution, summarizeRun } from '../scripts/spikes/220-hosted/load.mjs';
import { tickets, prepareGroup, initialization, markets } from '../scripts/spikes/220-hosted/setup.mjs';
const createHandler = ({queryFactory,...options}) => handlerFactory({
 ...options,queryFactory:(...args)=>{
  const query=queryFactory(...args);
  return async (...params)=>({rows:await query(...params),checkoutMs:0});
 },
});
const now=Date.now(),bearer='a'.repeat(64),sha='b'.repeat(40),host='qualification-test.vercel.app';
const binding={arm:'iad1',projectId:PROJECT_ID,nodeMajor:24,database:{provider:'planetscale',verified:true,disposable:true,syntheticOnly:true,organization:'test-org',clusterName:'test-cluster',branchId:'test-branch',host:'aws-us-east-1-test.pg.psdb.cloud',port:6432,role:'spike220_runner_123456abcdef',name:'postgres',region:'us-east-1',sku:'PS-5',topology:'single-node',postgresMajor:18},gates:{automationBypass:true,branchScopedSensitive:true,previewProtection:true},gitBranch:'feature/dfsEV-220-planetscale-harness',reviewedSha:sha,runId:'12345678-1234-1234-1234-123456789abc'};
const env={SPIKE220_ENABLED:'1',VERCEL_ENV:'preview',VERCEL_REGION:'iad1',VERCEL_PROJECT_ID:PROJECT_ID,VERCEL_GIT_COMMIT_REF:binding.gitBranch,VERCEL_GIT_COMMIT_SHA:sha,VERCEL_URL:host,SPIKE220_BINDING:JSON.stringify(binding),SPIKE220_ISSUED_AT:new Date(now-1000).toISOString(),SPIKE220_EXPIRES_AT:new Date(now+10000).toISOString(),SPIKE220_TOKEN_SHA256:createHash('sha256').update(bearer).digest('hex'),SPIKE220_DATABASE_URL:`postgresql://${binding.database.role}.${binding.database.branchId}:${'x'.repeat(40)}@${binding.database.host}:6432/postgres?sslmode=verify-full`};
const sample={stage:'warm',workers:20,round:0,mode:'path',index:0};
const request=(body=sample,url=`https://${host}/api/qualification220`,token=bearer)=>new Request(url,{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body)});
const deployment={source:'git',id:'dpl_test',functionMetadata:{source:'deployment-function-metadata',deploymentId:'dpl_test',path:'/api/qualification220',regions:['iad1']},projectId:PROJECT_ID,target:'preview',readyState:'READY',sha,gitBranch:binding.gitBranch,protectionVerified:true,url:`https://${host}`};
test('valid binding is accepted; Production, wrong SHA/branch/project/region/host and expired configurations fail before DB factory',async()=>{
 assert.ok(authorize(request(),env,now));
 for(const patch of [{VERCEL_ENV:'production'},{VERCEL_REGION:'sfo1'},{VERCEL_PROJECT_ID:'other'},{VERCEL_GIT_COMMIT_SHA:'c'.repeat(40)},{VERCEL_GIT_COMMIT_REF:'main'},{VERCEL_URL:'other.vercel.app'},{SPIKE220_EXPIRES_AT:new Date(now).toISOString()},{SPIKE220_ENABLED:'0'},{SPIKE220_BINDING:JSON.stringify({...binding,database:{...binding.database,verified:false}})},{SPIKE220_DATABASE_URL:env.SPIKE220_DATABASE_URL.replace('us-east-1-test','us-east-1-other')}]){
 let calls=0;const handler=createHandler({env:{...env,...patch},now:()=>now,queryFactory:()=>{calls++;throw Error('never');}});
 assert.equal((await handler(request())).status,404);assert.equal(calls,0);
 }
});
test('PlanetScale runner login must use the exact role and approved branch suffix',()=>{
 const {role,branchId}=binding.database;
 const login=`${role}.${branchId}`;
 for(const invalid of [role,`${role}.other-branch`,`postgres.${branchId}`]){
  const connection=env.SPIKE220_DATABASE_URL.replace(login,invalid);
  assert.equal(authorize(request(),{...env,SPIKE220_DATABASE_URL:connection},now),null);
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
 assert.equal(tickets().length,all.length+sameSubjectControl().length);assert.equal(prepareGroup('next-tick:20:0:path',{},binding.runId).length,1);
});
test('exact-branch Secret variable metadata fails closed',()=>{
 const keys=['SPIKE220_ENABLED','SPIKE220_BINDING','SPIKE220_DATABASE_URL',
  'SPIKE220_TOKEN_SHA256','SPIKE220_ISSUED_AT','SPIKE220_EXPIRES_AT'];
 const metadata=keys.map((key,i)=>({key,id:String(i),type:'sensitive',target:['preview'],gitBranch:binding.gitBranch}));
 assert.equal(verifyEnvironmentMetadata(metadata,binding.gitBranch).length,keys.length);
 assert.throws(()=>verifyEnvironmentMetadata(metadata.map(x=>({...x,gitBranch:undefined})),binding.gitBranch));
});
test('run metadata contains only identity and expiry',()=>{
 const meta=createRunMetadata(now);
 assert.match(meta.runId,/^[a-f0-9-]{36}$/);
 assert.equal(Date.parse(meta.issuedAt),now);
 assert.equal(Date.parse(meta.expiresAt)-now,4*3600_000);
 assert.deepEqual(Object.keys(meta).sort(),['expiresAt','issuedAt','runId']);
});
test('external generator runs distinct waves of 20 and uses in-function timing',async()=>{
 let active=0,max=0,calls=0;
 const samples=Array.from({length:40},(_,index)=>({...sample,index}));
 const result=await runGroup({deployment,binding,expectedSha:sha,credentials:{bearer,bypass:'z'.repeat(32)},samples,approved:true,fetchImpl:async(url,options)=>{
 assert.equal(url,`https://${host}/api/qualification220`);assert.equal(options.redirect,'error');assert.equal(options.headers['x-vercel-protection-bypass'],'z'.repeat(32));
 active++;max=Math.max(max,active);calls++;await new Promise(resolve=>setImmediate(resolve));active--;
 return Response.json({sample:JSON.parse(options.body),runId:binding.runId,sha,region:'iad1',arm:'iad1',queryTimings:Array.from({length:3},()=>({operation:'hosted_sample',elapsedMs:10,checkoutMs:1})),outcome:'leader',inFunctionPreProviderMs:141,preProviderCheckoutMs:2,preProviderSqlMs:100,preProviderQueries:2,inFunctionTotalMs:160,sqlQueries:3});
 }});
 assert.equal(max,20);assert.equal(calls,40);assert.equal(result.passed,false);assert.equal(result.timing.p95Ms,141);
});
test('no approval or wrong Preview prevents requests',async()=>{
 await assert.rejects(runGroup({deployment,binding,expectedSha:sha,credentials:{},samples:[sample]}));
 assert.throws(()=>verifyPreview({...deployment,target:'production'},binding,expectedShaByArm));
});
test('lost responses count as failures and are never retried',async()=>{
 let calls=0;const result=await runGroup({deployment,binding,expectedSha:sha,credentials:{bearer,bypass:'z'.repeat(32)},samples:[sample],approved:true,fetchImpl:async()=>{calls++;throw Error(bearer);}});
 assert.equal(calls,1);assert.equal(result.failures,1);assert.equal(result.passed,false);assert.ok(!JSON.stringify(result).includes(bearer));
 assert.deepEqual(distribution([1,2,3]),{samples:3,p50Ms:2,p95Ms:3,p99Ms:3,maxMs:3});
});
test('cleanup receipt requires every independent absence check',()=>{
 assert.throws(()=>verifyCleanup({branchAbsent:true}));assert.ok(verifyCleanup(Object.fromEntries(['branchAbsent','roleAbsent','variablesAbsent','deploymentUnavailable','runnerCredentialsCleared'].map(k=>[k,true]))));
});

test('setup preallocates bounded unique tickets, full 240-key catalog and no shared run counter',()=>{
 const setup=initialization(binding,new Date(now+10000).toISOString());
 assert.equal(markets.length*20,240);
 const rows=JSON.parse(setup[3].values[1]);assert.equal(rows.length,schedule().length+sameSubjectControl().length);assert.ok(rows.length<=20000);
 assert.equal(new Set(rows.map(x=>x.owner)).size,rows.length);
 assert.equal(setup.at(-1).requireCount,rows.length);
 const controls=rows.filter(x=>x.group==='same-subject:20:0:admission');
 assert.equal(controls.length,20);
 assert.equal(new Set(controls.map(x=>x.resource)).size,20);
 assert.equal(new Set(controls.map(x=>JSON.stringify(x.dimensions))).size,1);
 assert.throws(()=>prepareGroup('stale:20:0:path',{remaining:19,used:0},binding.runId));
});
test('unverified compute and unsupported protections block configuration',()=>{
 for(const mutate of [c=>{c.database.organization=undefined;},c=>{c.database.clusterName=undefined;},c=>{c.database.sku='PS-10';},c=>{c.gates.branchScopedSensitive=false;},c=>{c.gates.automationBypass=false;},c=>{c.database.syntheticOnly=false;}]){
 const copy=structuredClone(binding);mutate(copy);assert.equal(authorize(request(),{...env,SPIKE220_BINDING:JSON.stringify(copy)},now),null);
 }
});
test('probe errors return typed unavailable and do not retry admission or poll',async()=>{
 let count=0;const handler=createHandler({env,now:()=>now,queryFactory:()=>async sql=>{count++;return [{outcome:sql.includes('hosted_begin')?'claimed':sql.includes('claim_probe')?'leader':sql.includes('finish_probe')?'invalid':'quota-stale',owner:'owner'}];},freeEvents:async()=>{throw Error(bearer);}});
 const body=await(await handler(request({...sample,stage:'stale'}))).json();assert.equal(body.outcome,'observation-unavailable');assert.equal(count,4);assert.ok(!JSON.stringify(body).includes(bearer));
});

test('single-region schedule preserves every ticket and block ordering',()=>{
 const blocks=runSchedule();
 assert.deepEqual(blocks.flat(),schedule());
 assert.equal(blocks.flat().length,18483);
 assert.ok(blocks.every(x=>x.length===1020 || x.length===40 || x.length===1));
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
 const result=await runGroup({deployment,binding,expectedSha:sha,credentials:{bearer,bypass:'z'.repeat(32)},samples,approved:true,fetchImpl:async(_,options)=>{
 const s=JSON.parse(options.body);return Response.json({sample:s,runId:binding.runId,sha,region:'iad1',arm:'iad1',outcome:'leader',inFunctionPreProviderMs:s.index===99?500:100,preProviderCheckoutMs:2,preProviderSqlMs:50,preProviderQueries:2,inFunctionTotalMs:600,sqlQueries:3,queryTimings:Array.from({length:3},()=>({operation:'hosted_sample',elapsedMs:10,checkoutMs:1}))});
 }});
 assert.ok(result.passed);assert.equal(result.timing.p95Ms,100);assert.equal(result.timing.maxMs,500);assert.equal(result.timing.p99Ms,100);
 const groups=[];
 for(const mode of ['baseline','admission','path'])for(const workers of [1,20])for(let round=0;round<3;round++)groups.push({arm:'iad1',sha,group:`warm:${workers}:${round}:${mode}`,failures:0,passed:true,timing:distribution([100]),rows:Array.from({length:1000},()=>({inFunctionPreProviderMs:100,transportRoundTripMs:10}))});
 assert.ok(summarizeRun(groups,sha).passed);
 assert.throws(()=>summarizeRun([...groups,{...groups[0],arm:'pdx1'}],sha));
 assert.throws(()=>summarizeRun(groups.slice(1),sha));
 const slow=structuredClone(groups);for(const g of slow)for(const row of g.rows)row.inFunctionPreProviderMs=201;
 assert.equal(summarizeRun(slow,sha).passed,false);
});

test('prepared Preview config enables Git deployment in iad1',async()=>{
 const iad=JSON.parse(await readFile(new URL('../apps/web/vercel.json',import.meta.url),'utf8'));
 assert.deepEqual(iad,{regions:['iad1']});
 await assert.rejects(access(new URL('../apps/web/vercel.harness-pdx1.json',import.meta.url)),e=>e.code==='ENOENT');
});
test('immutable Preview binds the approved SHA, region metadata, Git branch and deployment ID',()=>{
 assert.equal(verifyPreview(deployment,binding,sha),`https://${host}/api/qualification220`);
 assert.throws(()=>verifyPreview(deployment,binding,'c'.repeat(40)));
 assert.throws(()=>verifyPreview({...deployment,source:'cli'},binding,sha));
 assert.throws(()=>verifyPreview({...deployment,id:'dpl_other'},binding,sha));
 assert.throws(()=>verifyPreview({...deployment,functionMetadata:{...deployment.functionMetadata,regions:['pdx1']}},binding,sha));
 assert.throws(()=>verifyPreview({...deployment,gitBranch:'other'},binding,sha));
});
test('raw samples own p95 gates even when cached summaries claim a pass',()=>{
 const groups=[];
 for(const mode of ['baseline','admission','path'])for(const workers of [1,20])for(let round=0;round<3;round++)groups.push({arm:'iad1',sha,group:`warm:${workers}:${round}:${mode}`,failures:0,passed:true,timing:distribution([100]),rows:Array.from({length:1000},()=>({inFunctionPreProviderMs:workers===20?150:100,transportRoundTripMs:10}))});
 const result=summarizeRun(groups,sha);
 assert.equal(result.passed,false);assert.equal(result.reports.path.rounds[0].timing.p95Ms,150);
 assert.equal(result.reports.path.rounds[0].passed,false);assert.equal(result.reports.path.overallWarm.p95Ms,150);
 const failed=structuredClone(groups);failed[0].rows[0]={failed:true};
 assert.equal(summarizeRun(failed,sha).passed,false);
 const malformed=structuredClone(groups);malformed[0].rows[0].inFunctionPreProviderMs=NaN;
 assert.throws(()=>summarizeRun(malformed,sha));
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

test('fresh connection diagnostic uses one new frontend and no warm transport query',async()=>{
 const calls=[];
 const handler=handlerFactory({env,now:()=>now,queryFactory:()=>async(sql,_args,options)=>{
  calls.push({sql,options});return {rows:[{outcome:'baseline'}],checkoutMs:1};
 }});
 const body=await(await handler(request({...sample,stage:'cold',mode:'baseline',workers:1}))).json();
 assert.equal(calls.length,1);
 assert.deepEqual(calls[0].options,{fresh:true});
 assert.equal(body.connectionDiagnostic,'fresh-client-to-warm-pooler');
 assert.equal(body.preProviderCheckoutMs,1);
 assert.equal(body.transportRoundTripMs,null);
});

test('benchmark path skips the proxy while ordinary APIs and cron still match',async()=>{
 const {unstable_doesMiddlewareMatch}=await import('next/experimental/testing/server.js');
 const source=await readFile(new URL('../apps/web/src/proxy.ts',import.meta.url),'utf8');
 const matcher=source.match(/matcher: "([^"]+)"/)[1];
 const matches=url=>unstable_doesMiddlewareMatch({config:{matcher},nextConfig:{},url});
 assert.equal(matches('/api/qualification220'),false);
 assert.equal(matches('/api/cron/sync-player-stats'),true);
 assert.equal(matches('/api/live/odds'),true);
});
