import { createHash, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const PROJECT_ID = 'prj_GLXDEeScMKPAeDAUoYIoiNknwKJd';
export const NEON_PROJECT_ID = 'wandering-tree-67967407';
export const ROUTE = '/api/qualification220';
const deny = () => new Response(null, {status:404,headers:{'Cache-Control':'no-store'}});
const validSha = value => typeof value==='string' && /^[a-f0-9]{40}$/.test(value);
const tokenDigest = token => createHash('sha256').update(token).digest();
const requireValue = (value, message) => { if(!value)throw new Error(message); };

// Fail closed until exact reviewed control-plane parity/protection receipts exist.
export function validateBinding(c) {
  requireValue(c?.projectId===PROJECT_ID && c?.production?.verified===true,'unverified Production profile');
  requireValue(['iad1','pdx1'].includes(c.arm),'unsupported qualification arm');
  requireValue(c.production.region==='iad1' && c.production.nodeMajor===24 && c.production.driverVersion==='1.2.0','runtime mismatch');
  requireValue(c.neon?.projectId===NEON_PROJECT_ID && c.neon.schemaOnly===true && c.neon.verified===true,'unverified schema-only branch');
  requireValue(/^br-/.test(c.neon.branchId) && c.neon.parentId===c.production.neonBranchId && c.neon.branchId!==c.neon.parentId,'branch mismatch');
  requireValue(/^ep-/.test(c.neon.endpointId) && c.neon.endpointId!==c.production.neonEndpointId,'endpoint mismatch');
  for(const k of ['neonRegion','minCu','maxCu','suspendSeconds']) requireValue(c.neon[k]===c.production[k],`compute mismatch: ${k}`);
  requireValue(typeof c.neon.neonRegion==='string' && c.neon.minCu>0 && c.neon.maxCu>=c.neon.minCu && Number.isInteger(c.neon.suspendSeconds) && c.neon.suspendSeconds>=0,'missing compute settings');
  requireValue(typeof c.neon.host==='string' && c.neon.host.endsWith('.neon.tech') && c.neon.host.startsWith(c.neon.endpointId+'-pooler.'),'pooled endpoint mismatch');
  requireValue(c.neon.database===c.production.database && /^spike220_runner_[a-f0-9]{12}$/.test(c.neon.role),'database/role mismatch');
  requireValue(c.gates?.automationBypass===true && c.gates?.branchScopedSensitive===true && c.gates?.previewProtection===true,'protection not verified');
  requireValue(/^feature\/dfsEV-220-[a-z0-9-]+$/.test(c.gitBranch) && validSha(c.reviewedSha),'unreviewed branch/SHA');
  requireValue(/^[a-f0-9-]{36}$/.test(c.runId),'invalid run ID');
  return c;
}
export function authorize(request, env, now=Date.now()) {
  try {
    if(env.SPIKE220_ENABLED!=='1' || env.VERCEL_ENV!=='preview')return null;
    const c=validateBinding(JSON.parse(env.SPIKE220_BINDING??'null'));
    if(env.VERCEL_REGION!==c.arm)return null;
    if(env.VERCEL_PROJECT_ID!==PROJECT_ID || env.VERCEL_GIT_COMMIT_REF!==c.gitBranch || env.VERCEL_GIT_COMMIT_SHA!==c.reviewedSha)return null;
    const url=new URL(request.url);
    if(url.protocol!=='https:' || url.pathname!==ROUTE || url.search || url.hostname!==env.VERCEL_URL || !url.hostname.endsWith('.vercel.app'))return null;
    const issued=Date.parse(env.SPIKE220_ISSUED_AT),expires=Date.parse(env.SPIKE220_EXPIRES_AT);
    if(!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now||now>=expires||expires-issued>6*3600_000)return null;
    const match=/^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization')??'');
    if(!match || !/^[a-f0-9]{64}$/.test(env.SPIKE220_TOKEN_SHA256??'') || !timingSafeEqual(tokenDigest(match[1]),Buffer.from(env.SPIKE220_TOKEN_SHA256,'hex')))return null;
    const db=new URL(env.SPIKE220_DATABASE_URL??'');
    if(db.protocol!==c.production.connectionProtocol || db.hostname!==c.neon.host || decodeURIComponent(db.pathname.slice(1))!==c.neon.database
      || decodeURIComponent(db.username)!==c.neon.role || db.password.length<32 || db.port)return null;
    if(JSON.stringify([...db.searchParams].sort())!==JSON.stringify([...c.production.connectionParams].sort()))return null;
    return c;
  } catch {return null;}
}
export function validateSample(x) {
  requireValue(x && Object.keys(x).sort().join(',')==='index,mode,round,stage,workers','invalid fields');
  requireValue(['warmup','warm','cold','stale','next-tick'].includes(x.stage) && ['baseline','admission','path'].includes(x.mode),'invalid stage/mode');
  requireValue([1,20].includes(x.workers) && Number.isInteger(x.round) && x.round>=0 && x.round<3,'invalid trial');
  const cap=x.stage==='warm'?1000:x.stage==='cold'?1:20;
  requireValue(Number.isInteger(x.index) && x.index>=0 && x.index<cap,'invalid sample index');
  requireValue(x.stage!=='cold'||(x.mode==='baseline'&&x.workers===1),'invalid cold mode');
  requireValue(!['stale','next-tick'].includes(x.stage)||x.mode==='path','invalid stale mode');
  return x;
}
export const sampleKey = x => [x.stage,x.workers,x.round,x.mode,x.index].join(':');
async function readBounded(request) {
  if(Number(request.headers.get('content-length'))>1024 || !request.body)throw new Error('body size');
  const reader=request.body.getReader();let size=0;const chunks=[];
  try {for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1024)throw new Error('body size');chunks.push(value);}}
  catch(error){await reader.cancel();throw error;}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
// One request, one sample. There is deliberately no worker/leader loop here.
export function createHandler({env,queryFactory,clock=()=>performance.now(),now=()=>Date.now(),freeEvents}) {
  let cached;
  return async request => {
    const entry=clock(),binding=authorize(request,env,now());
    if(!binding || request.method!=='POST')return deny();
    let sample;try{sample=validateSample(await readBounded(request));}catch{return deny();}
    try {
      if(!cached)cached=queryFactory(env.SPIKE220_DATABASE_URL);
      const q=cached,key=sampleKey(sample);let row,sqlMs=0,queries=0,freeProbe=false,transportRoundTripMs=null;const queryTimings=[];
      const run=async(text,args)=>{queries++;const t=clock();const out=await q(text,args);const elapsedMs=clock()-t;sqlMs+=elapsedMs;
        queryTimings.push({operation:text==='SELECT 1'?'transport':text.match(/spike220\.([a-z_]+)/)?.[1]??'unknown',elapsedMs});return out;};
      if(sample.mode==='baseline') {
        [row]=await run('SELECT * FROM spike220.hosted_begin($1,$2,true)',[binding.runId,key]);
      } else if(sample.mode==='admission') {
        [row]=await run('SELECT * FROM spike220.hosted_sample($1,$2,false)',[binding.runId,key]);
      } else {
        [row]=await run('SELECT * FROM spike220.hosted_begin($1,$2,false)',[binding.runId,key]);
        if(row?.outcome==='claimed') [row]=await run('SELECT * FROM spike220.hosted_sample($1,$2,true)',[binding.runId,key]);
      }
      if(row?.outcome==='quota-stale' && sample.mode==='path') {
        const [claim]=await run('SELECT spike220.claim_probe($1) AS outcome',[row.owner]);
        if(claim.outcome==='leader') {
          freeProbe=true;
          let quota;try{quota=await freeEvents();}catch{quota={remaining:null,used:null,last:null,observed:null};}
          const [finished]=await run("SELECT spike220.finish_probe($1,$2,$3,$4,'fixture-period',$5) AS outcome",
            [row.owner,quota.remaining,quota.used,quota.observed,quota.last]);
          if(finished.outcome==='accepted') [row]=await run('SELECT * FROM spike220.hosted_sample($1,$2,true)',[binding.runId,key]);
          else row={...row,outcome:'observation-unavailable'};
        } else if(claim.outcome==='fresh') {
          [row]=await run('SELECT * FROM spike220.hosted_sample($1,$2,true)',[binding.runId,key]);
        } else row={...row,outcome:'probe-follower-stale'}; // immediate, no polling
      }
      if(!row)throw new Error('unknown sample');
      const preProviderMs=clock()-entry,preProviderSqlMs=sqlMs,preProviderQueries=queries;
      // No paid provider call. Counted lease release is after the pre-provider boundary.
      if(row.outcome==='leader')await run('SELECT spike220.hosted_release($1,$2)',[binding.runId,key]);
      // Standalone trivial query through the identical cached driver, outside
      // the baseline boundary. Never inserted into the admission path.
      if(sample.mode==='baseline' && sample.stage!=='cold'){await run('SELECT 1',[]);transportRoundTripMs=queryTimings.at(-1).elapsedMs;}
      return Response.json({sample,arm:binding.arm,runId:binding.runId,outcome:row.outcome,freeProbe,
        inFunctionPreProviderMs:preProviderMs,preProviderSqlMs,preProviderQueries,
        queryTimings,transportRoundTripMs,sqlRoundTripMs:sqlMs,inFunctionTotalMs:clock()-entry,
        sqlQueries:queries,region:env.VERCEL_REGION,sha:env.VERCEL_GIT_COMMIT_SHA,
        coldQualification:'requires independent endpoint-suspension evidence; idle time is insufficient'},
      {headers:{'Cache-Control':'no-store'}});
    } catch {return Response.json({error:'sample failed; do not retry ambiguous writes'}, {status:503,headers:{'Cache-Control':'no-store'}});}
  };
}
