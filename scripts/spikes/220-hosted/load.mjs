// Imported explicitly by an owner-approved runner. Importing never makes requests.
import { performance } from 'node:perf_hooks';
import { REGION, ROUTE, sampleKey, validateBinding, validateSample } from '../../../apps/web/src/lib/qualification220-core.mjs';
const assert=(ok,why)=>{if(!ok)throw new Error(why);};
export function verifyPreview(deployment,binding,expectedSha) {
  validateBinding(binding);
  assert(binding.reviewedSha===expectedSha,'binding has wrong expected SHA');
  assert(deployment.source==='git','Git-push Preview deployment required');
  assert(deployment.projectId===binding.projectId && deployment.target==='preview' && deployment.readyState==='READY','wrong deployment');
  assert(deployment.sha===binding.reviewedSha && deployment.gitBranch===binding.gitBranch && deployment.protectionVerified===true,'unverified deployment protection/identity');
  const meta=deployment.functionMetadata;
  assert(typeof deployment.id==='string' && deployment.id.startsWith('dpl_'),'missing deployment ID');
  assert(meta?.source==='deployment-function-metadata' && meta.deploymentId===deployment.id && meta.path===ROUTE && meta.regions?.length===1 && meta.regions[0]===binding.arm,'function region not proven by deployment metadata');
  const url=new URL(deployment.url);
  assert(url.protocol==='https:' && url.hostname.endsWith('.vercel.app') && !url.username && !url.password && !url.port && url.pathname==='/' && !url.search && !url.hash,'use exact deployment URL');
  return new URL(ROUTE,url).href;
}
export function distribution(values) {
  assert(values.length>0 && values.every(x=>Number.isFinite(x)&&x>=0),'invalid timing sample');
  const sorted=[...values].sort((a,b)=>a-b);
  return {samples:sorted.length,p50Ms:sorted[Math.ceil(sorted.length*.5)-1],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],p99Ms:sorted[Math.ceil(sorted.length*.99)-1],maxMs:sorted.at(-1)};
}
export async function runGroup({deployment,binding,expectedSha,credentials,samples,fetchImpl=fetch,clock=()=>performance.now(),approved=false}) {
  assert(approved===true,'hosted run requires fresh owner approval');
  const url=verifyPreview(deployment,binding,expectedSha);
  assert(/^[a-f0-9]{64}$/.test(credentials.bearer) && typeof credentials.bypass==='string' && credentials.bypass.length>=16,'missing private credentials');
  assert(samples.length>0 && samples.length<=1000,'bounded group required');
  const first=validateSample(samples[0]),group=[first.stage,first.workers,first.round,first.mode].join(':');
  assert(samples.every(s=>{validateSample(s);return [s.stage,s.workers,s.round,s.mode].join(':')===group;}),'mixed trial group');
  assert(new Set(samples.map(sampleKey)).size===samples.length,'duplicate tickets');
  const rows=new Array(samples.length);
  // Concurrency exists on the Mac only: one HTTP request -> one function sample.
  for(let offset=0;offset<samples.length;offset+=first.workers) {
    await Promise.all(samples.slice(offset,offset+first.workers).map(async(_,lane)=>{
      const index=offset+lane;
      const started=clock();let result;
      try {
        const response=await fetchImpl(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(35_000),
          headers:{'content-type':'application/json',authorization:`Bearer ${credentials.bearer}`,'x-vercel-protection-bypass':credentials.bypass},body:JSON.stringify(samples[index])});
        assert(response.ok,'sample request failed');
        const body=await response.json();
        assert(body.runId===binding.runId && body.sha===binding.reviewedSha && body.region===binding.arm && body.arm===binding.arm && sampleKey(body.sample)===sampleKey(samples[index]),'sample identity mismatch');
        for(const k of ['inFunctionPreProviderMs','preProviderSqlMs','preProviderCheckoutMs','preProviderQueries','inFunctionTotalMs','sqlQueries'])assert(Number.isFinite(body[k])&&body[k]>=0,'missing in-function measurement');
        if(first.stage==='cold')assert(body.connectionDiagnostic==='fresh-client-to-warm-pooler','missing fresh-connection diagnostic');
        const expected=first.mode==='baseline'?['baseline']:first.stage==='stale'?['leader','probe-follower-stale','observation-unavailable','needs-init','backoff']:['leader'];
        assert(expected.includes(body.outcome),'unexpected admission outcome');
        const warmQueries=first.mode==='path'?2:1;
        const cap=first.stage==='stale'?(body.outcome==='leader'?5:['observation-unavailable','needs-init','backoff'].includes(body.outcome)?4:3):warmQueries;
        const transportProbe=first.mode==='baseline' && first.stage!=='cold';
        const extra=Number(body.outcome==='leader'||transportProbe);
        assert(body.preProviderQueries>=warmQueries && body.preProviderQueries<=cap
          && body.sqlQueries===body.preProviderQueries+extra,'SQL work budget exceeded');
        assert(Array.isArray(body.queryTimings) && body.queryTimings.length===body.sqlQueries && body.queryTimings.every(x=>typeof x.operation==='string'&&Number.isFinite(x.elapsedMs)&&x.elapsedMs>=0&&Number.isFinite(x.checkoutMs)&&x.checkoutMs>=0&&x.checkoutMs<=x.elapsedMs),'missing per-query timing');
        if(transportProbe)assert(Number.isFinite(body.transportRoundTripMs)&&body.transportRoundTripMs>=0&&body.queryTimings.filter(x=>x.operation==='transport').length===1,'missing trivial SELECT 1 timing');
        result={sample:samples[index],arm:binding.arm,outcome:body.outcome,freeProbe:body.freeProbe,
          inFunctionPreProviderMs:body.inFunctionPreProviderMs,preProviderSqlMs:body.preProviderSqlMs,preProviderCheckoutMs:body.preProviderCheckoutMs,
          queryTimings:body.queryTimings,transportRoundTripMs:body.transportRoundTripMs,
          preProviderQueries:body.preProviderQueries,inFunctionTotalMs:body.inFunctionTotalMs,sqlQueries:body.sqlQueries};
      }catch{result={sample:samples[index],failed:true,reason:'request, identity, outcome or budget failed; no automatic retry'};}
      rows[index]={...result,clientRoundTripMs:clock()-started};
    }));
  }
  const failures=rows.filter(x=>x.failed).length,valid=rows.filter(x=>!x.failed);
  const timing=valid.length?distribution(valid.map(x=>x.inFunctionPreProviderMs)):null;
  const warm=first.stage==='warm';
  return {arm:binding.arm,runId:binding.runId,deploymentId:deployment.id,sha:binding.reviewedSha,expectedSha,group,rows,failures,timing,clientRoundTripContext:distribution(rows.map(x=>x.clientRoundTripMs)),
    passed:failures===0 && (!warm || first.workers!==20 || timing.p95Ms<=140),
    interpretation:first.stage==='same-subject'?'separate 20-leader same-subject control':first.stage==='cold'?'fresh client connection to a running pooler; not database activation':first.stage==='stale'?'separate synthetic stale-quota measurement; no approved elapsed target':'in-function pre-provider measurement'};
}

// Assess the complete iad1 warm matrix with separate modes.
export function summarizeRun(groups,expectedSha) {
  assert(/^[a-f0-9]{40}$/.test(expectedSha??'') && groups.length>0 && groups.every(g=>g.arm===REGION && g.sha===expectedSha),'wrong region or expected SHA');
  const reports={};let passed=groups.every(g=>Array.isArray(g.rows)&&g.rows.length>0&&g.rows.every(x=>!x.failed));
  for(const mode of ['baseline','admission','path']){
    const warm=groups.filter(g=>g.group.startsWith('warm:')&&g.group.split(':')[3]===mode);
    assert(warm.length===6 && new Set(warm.map(g=>g.group)).size===6 && warm.every(g=>g.rows.length===1000),'incomplete warm matrix');
    const valid=warm.flatMap(g=>g.rows.filter(x=>!x.failed));
    const overallWarm=valid.length?distribution(valid.map(x=>x.inFunctionPreProviderMs)):null;
    const rounds=warm.filter(g=>g.group.split(':')[1]==='20').map(g=>{
      const rows=g.rows.filter(x=>!x.failed);
      const timing=rows.length?distribution(rows.map(x=>x.inFunctionPreProviderMs)):null;
      return {group:g.group,timing,passed:rows.length===1000&&timing.p95Ms<=140};
    });
    const modePassed=valid.length===6000&&overallWarm.p95Ms<=200&&rounds.every(x=>x.passed);
    reports[mode]={overallWarm,rounds,passed:modePassed};passed&&=modePassed;
  }
  const transport=groups.filter(g=>g.group.startsWith('warm:')&&g.group.endsWith(':baseline')).flatMap(g=>g.rows.filter(x=>!x.failed).map(x=>x.transportRoundTripMs));
  return {region:REGION,expectedSha,passed,reports,transport:transport.length?distribution(transport):null,transportRounds:groups.filter(g=>g.group.startsWith('warm:')&&g.group.endsWith(':baseline')).map(g=>({group:g.group,timing:g.rows.some(x=>!x.failed)?distribution(g.rows.filter(x=>!x.failed).map(x=>x.transportRoundTripMs)):null})),
    p99AndMax:'informational only; no maximum gate'};
}
