// Imported explicitly by an owner-approved runner. Importing never makes requests.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import { ROUTE, sampleKey, validateBinding, validateSample } from '../../../apps/web/src/lib/qualification220-core.mjs';
const assert=(ok,why)=>{if(!ok)throw new Error(why);};
export function validateExpectedShas(expectedShaByArm) {
  assert(expectedShaByArm && Object.keys(expectedShaByArm).sort().join(',')==='iad1,pdx1'
    && ['iad1','pdx1'].every(arm=>/^[a-f0-9]{40}$/.test(expectedShaByArm[arm]??''))
    && expectedShaByArm.iad1!==expectedShaByArm.pdx1,'two distinct approved commit SHAs required');
  return expectedShaByArm;
}
export function verifyPreview(deployment,binding,expectedShaByArm) {
  validateBinding(binding);
  validateExpectedShas(expectedShaByArm);
  assert(binding.reviewedSha===expectedShaByArm[binding.arm],'arm binding has wrong expected SHA');
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
export async function runGroup({deployment,binding,expectedShaByArm,armReceipts,regionProof,credentials,samples,fetchImpl=fetch,clock=()=>performance.now(),approved=false,coldEvidence}) {
  assert(approved===true,'hosted run requires fresh owner approval');
  const pinned=verifyArmReceipts(armReceipts,expectedShaByArm,regionProof);
  assert(pinned[binding.arm]?.deploymentId===deployment.id && pinned[binding.arm]?.runId===binding.runId && pinned[binding.arm]?.url===deployment.url,'selected deployment differs from paired receipts');
  const url=verifyPreview(deployment,binding,expectedShaByArm);
  assert(/^[a-f0-9]{64}$/.test(credentials.bearer) && typeof credentials.bypass==='string' && credentials.bypass.length>=16,'missing private credentials');
  assert(samples.length>0 && samples.length<=1000,'bounded group required');
  const first=validateSample(samples[0]),group=[first.stage,first.workers,first.round,first.mode].join(':');
  assert(samples.every(s=>{validateSample(s);return [s.stage,s.workers,s.round,s.mode].join(':')===group;}),'mixed trial group');
  assert(new Set(samples.map(sampleKey)).size===samples.length,'duplicate tickets');
  if(first.stage==='cold')assert(coldEvidence?.endpointId===binding.neon.endpointId && coldEvidence.suspended===true && Number.isFinite(Date.parse(coldEvidence.observedAt)),'independent suspension proof required');
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
        for(const k of ['inFunctionPreProviderMs','preProviderSqlMs','preProviderQueries','inFunctionTotalMs','sqlQueries'])assert(Number.isFinite(body[k])&&body[k]>=0,'missing in-function measurement');
        const expected=first.mode==='baseline'?['baseline']:first.stage==='stale'?['leader','probe-follower-stale','observation-unavailable','needs-init','backoff']:['leader'];
        assert(expected.includes(body.outcome),'unexpected admission outcome');
        const warmQueries=first.mode==='path'?2:1;
        const cap=first.stage==='stale'?(body.outcome==='leader'?5:['observation-unavailable','needs-init','backoff'].includes(body.outcome)?4:3):warmQueries;
        const transportProbe=first.mode==='baseline' && first.stage!=='cold';
        assert(body.preProviderQueries>=warmQueries && body.preProviderQueries<=cap && body.sqlQueries<=cap+(body.outcome==='leader'||transportProbe?1:0),'SQL work budget exceeded');
        assert(Array.isArray(body.queryTimings) && body.queryTimings.length===body.sqlQueries && body.queryTimings.every(x=>typeof x.operation==='string'&&Number.isFinite(x.elapsedMs)&&x.elapsedMs>=0),'missing per-query timing');
        if(transportProbe)assert(Number.isFinite(body.transportRoundTripMs)&&body.transportRoundTripMs>=0&&body.queryTimings.filter(x=>x.operation==='transport').length===1,'missing trivial SELECT 1 timing');
        result={sample:samples[index],arm:binding.arm,outcome:body.outcome,freeProbe:body.freeProbe,
          inFunctionPreProviderMs:body.inFunctionPreProviderMs,preProviderSqlMs:body.preProviderSqlMs,
          queryTimings:body.queryTimings,transportRoundTripMs:body.transportRoundTripMs,
          preProviderQueries:body.preProviderQueries,inFunctionTotalMs:body.inFunctionTotalMs,sqlQueries:body.sqlQueries};
      }catch{result={sample:samples[index],failed:true,reason:'request, identity, outcome or budget failed; no automatic retry'};}
      rows[index]={...result,clientRoundTripMs:clock()-started};
    }));
  }
  const failures=rows.filter(x=>x.failed).length,valid=rows.filter(x=>!x.failed);
  const timing=valid.length?distribution(valid.map(x=>x.inFunctionPreProviderMs)):null;
  const warm=first.stage==='warm';
  return {arm:binding.arm,runId:binding.runId,deploymentId:deployment.id,sha:binding.reviewedSha,regionProof:{...regionProof},expectedShaByArm:{...expectedShaByArm},group,rows,failures,timing,clientRoundTripContext:distribution(rows.map(x=>x.clientRoundTripMs)),
    passed:failures===0 && (!warm || first.workers!==20 || timing.p95Ms<=140),
    interpretation:first.stage==='cold'?'database activation baseline only; not paid admission':first.stage==='stale'?'separate stale-quota measurement; no approved elapsed target':'in-function pre-provider measurement'};
}

// Assess a complete warm matrix for exactly one arm. Never combine regions or modes.
export function summarizeArm(groups,arm,expectedShaByArm) {
  validateExpectedShas(expectedShaByArm);
  assert(['iad1','pdx1'].includes(arm) && groups.length>0 && groups.every(g=>g.arm===arm && g.sha===expectedShaByArm[arm]),'mixed arms or wrong expected SHA');
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
  return {arm,expectedSha:expectedShaByArm[arm],expectedShaByArm:{...expectedShaByArm},passed,reports,transport:transport.length?distribution(transport):null,transportRounds:groups.filter(g=>g.group.startsWith('warm:')&&g.group.endsWith(':baseline')).map(g=>({group:g.group,timing:g.rows.some(x=>!x.failed)?distribution(g.rows.filter(x=>!x.failed).map(x=>x.transportRoundTripMs)):null})),
    p99AndMax:'informational only; no maximum gate'};
}

// Offline validation of the two immutable Git deployment receipts before running.
export function verifyArmReceipts(receipts,expectedShaByArm,regionProof) {
  validateExpectedShas(expectedShaByArm);
  verifyRegionProof(regionProof,expectedShaByArm);
  assert(Array.isArray(receipts) && receipts.length===2 && new Set(receipts.map(x=>x.binding.arm)).size===2,'both arm receipts required');
  for(const {deployment,binding} of receipts)verifyPreview(deployment,binding,expectedShaByArm);
  const [a,b]=receipts;
  assert(a.binding.gitBranch===b.binding.gitBranch && a.binding.neon.branchId===b.binding.neon.branchId
    && a.binding.neon.endpointId===b.binding.neon.endpointId,'arms must use the same branch and database fixture');
  assert(a.deployment.id!==b.deployment.id && a.deployment.url!==b.deployment.url
    && a.binding.runId!==b.binding.runId,'arms require distinct immutable deployments and runs');
  return Object.fromEntries(receipts.map(({deployment,binding})=>[binding.arm,{expectedSha:expectedShaByArm[binding.arm],
    deploymentId:deployment.id,url:deployment.url,runId:binding.runId,region:binding.arm,source:'git'}]));
}

export function verifyRegionOnlyChange({changedPaths,beforeConfig,afterConfig}) {
  assert(changedPaths?.length===1 && changedPaths[0]==='apps/web/vercel.json','second commit must change only vercel.json');
  const {regions:before,...a}=beforeConfig,{regions:after,...b}=afterConfig;
  assert(isDeepStrictEqual(before,['iad1']) && isDeepStrictEqual(after,['pdx1']) && isDeepStrictEqual(a,b),'second commit must change only iad1 to pdx1');
  return true;
}

export function verifyRegionProof(proof,expectedShaByArm) {
  validateExpectedShas(expectedShaByArm);
  assert(proof?.source==='local-git' && proof.fromSha===expectedShaByArm.iad1 && proof.toSha===expectedShaByArm.pdx1,'missing or wrong commit diff proof');
  assert(isDeepStrictEqual(proof.parents,[expectedShaByArm.iad1]),'commit B must be a direct non-merge child of A');
  return verifyRegionOnlyChange(proof);
}
// Read-only Git inspection: no fetch, checkout, commit, push or network access.
export async function readRegionCommitProof(repoPath,expectedShaByArm,{readGit}={}) {
  validateExpectedShas(expectedShaByArm);
  const git=readGit??(async args=>(await promisify(execFile)('git',['-C',repoPath,...args],{encoding:'utf8',maxBuffer:1024*1024})).stdout);
  const a=expectedShaByArm.iad1,b=expectedShaByArm.pdx1;
  const lineage=(await git(['rev-list','--parents','-n','1',b])).trim().split(/\s+/);
  assert(lineage[0]===b,'unexpected commit identity');
  const changedPaths=(await git(['diff','--name-only','--no-renames','-z',a,b,'--'])).split('\0').filter(Boolean);
  const proof={source:'local-git',fromSha:a,toSha:b,parents:lineage.slice(1),changedPaths,
    beforeConfig:JSON.parse(await git(['show',`${a}:apps/web/vercel.json`])),
    afterConfig:JSON.parse(await git(['show',`${b}:apps/web/vercel.json`]))};
  verifyRegionProof(proof,expectedShaByArm);
  return proof;
}
