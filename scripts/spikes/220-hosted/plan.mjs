import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { open, realpath, access } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateBinding, sampleKey } from '../../../apps/web/src/lib/qualification220-core.mjs';

export const root=fileURLToPath(new URL('../../../',import.meta.url));
const assert=(ok,reason)=>{if(!ok)throw new Error(reason);};
export function createBranchPayload(profile,name,expiresAt) {
  assert(profile?.verified===true && profile.projectId==='wandering-tree-67967407','unverified Production Neon profile');
  assert(/^br-/.test(profile.branchId) && /^spike220-[a-f0-9]{12}$/.test(name),'invalid parent/name');
  assert(Number.isFinite(Date.parse(expiresAt)),'invalid expiry');
  assert(profile.minCu>0 && profile.maxCu>=profile.minCu && Number.isInteger(profile.suspendSeconds) && profile.suspendSeconds>=0,'unverified compute');
  return {branch:{name,parent_id:profile.branchId,init_source:'schema-only',expires_at:expiresAt},
    endpoints:[{type:'read_write',autoscaling_limit_min_cu:profile.minCu,
      autoscaling_limit_max_cu:profile.maxCu,suspend_timeout_seconds:profile.suspendSeconds}]};
}
export function environmentPayload(binding,privateRun,connection,providerKey) {
  validateBinding(binding);
  assert(/^[a-f0-9]{64}$/.test(privateRun.bearer),'invalid private bearer');
  const values={SPIKE220_ENABLED:'1',SPIKE220_BINDING:JSON.stringify(binding),SPIKE220_DATABASE_URL:connection,
    SPIKE220_TOKEN_SHA256:createHash('sha256').update(privateRun.bearer).digest('hex'),
    SPIKE220_ISSUED_AT:privateRun.issuedAt,SPIKE220_EXPIRES_AT:privateRun.expiresAt};
  if(providerKey)values.SPIKE220_ODDS_API_KEY=providerKey;
  return Object.entries(values).map(([key,value])=>({key,value,type:'sensitive',visibility:'secret',
    target:['preview'],gitBranch:binding.gitBranch}));
}
export function verifyEnvironmentMetadata(items,branch,expectedKeys) {
  assert(items.length===expectedKeys.length,'variable count mismatch');
  for(const key of expectedKeys) {
    const v=items.find(x=>x.key===key);
    assert(v && v.type==='sensitive' && (!v.visibility||v.visibility==='secret')
      && v.target?.length===1 && v.target[0]==='preview' && v.gitBranch===branch,'unscoped or readable variable');
    assert(typeof v.id==='string','missing variable cleanup ID');
  }
  return items.map(x=>({id:x.id,key:x.key,gitBranch:x.gitBranch}));
}
export function schedule() {
  const out=[];
  for(const workers of [1,20])for(let round=0;round<3;round++){
    for(const mode of round%2?['path','admission','baseline']:['baseline','admission','path'])for(const stage of ['warmup','warm']){
      const n=stage==='warm'?1000:20;
      for(let index=0;index<n;index++)out.push({stage,workers,round,mode,index});
    }
  }
  for(let round=0;round<3;round++){
    out.push({stage:'cold',workers:1,round,mode:'baseline',index:0});
    for(const stage of ['stale','next-tick'])for(let index=0;index<20;index++)out.push({stage,workers:20,round,mode:'path',index});
  }
  assert(out.length<=20000 && new Set(out.map(sampleKey)).size===out.length,'ticket schedule exceeds cap');
  return out;
}
export async function createPrivateRun(file,now=Date.now()) {
  const parent=await realpath(dirname(resolve(file))),repo=await realpath(root);
  assert(parent!==repo && relative(repo,parent).startsWith('..'),'secret must be outside checkout');
  for(let d=parent;;d=dirname(d)){
    let git=false;try{await access(resolve(d,'.git'));git=true;}catch{}
    assert(!git,'secret must be outside every Git checkout');
    if(dirname(d)===d)break;
  }
  const handle=await open(resolve(parent,basename(file)),'wx',0o600);
  const data={runId:randomUUID(),bearer:randomBytes(32).toString('hex'),issuedAt:new Date(now).toISOString(),
    expiresAt:new Date(now+4*3600_000).toISOString()};
  try{await handle.writeFile(JSON.stringify(data)+'\n');}finally{await handle.close();}
  return {path:resolve(file),runId:data.runId}; // no bearer, hash, DSN or bypass in output
}
export async function readPrivate(file) {
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const s=await handle.stat();
    assert(s.isFile()&&(s.mode&0o777)===0o600&&s.nlink===1,'private file must be a regular exclusive 0600 file');
    if(process.getuid)assert(s.uid===process.getuid(),'private file owner mismatch');
    return JSON.parse(await handle.readFile('utf8'));
  }finally{await handle.close();}
}
export function verifyCleanup(receipt) {
  for(const key of ['branchAbsent','roleAbsent','variablesAbsent','deploymentUnavailable','secretFileAbsent'])assert(receipt[key]===true,`cleanup not verified: ${key}`);
  return true;
}
// Each block keeps warmup+measurement or stale+next-tick together. Only one arm
// drives the shared disposable database at a time; AB/BA order alternates.
export function armSchedule() {
  const all=schedule(),blocks=[];
  for(let i=0;i<all.length;){
    const first=all[i],samples=[];
    const stages=first.stage==='warmup'?['warmup','warm']:first.stage==='stale'?['stale','next-tick']:[first.stage];
    while(i<all.length && all[i].workers===first.workers && all[i].round===first.round && all[i].mode===first.mode && stages.includes(all[i].stage))samples.push(all[i++]);
    blocks.push(samples);
  }
  return blocks.flatMap((samples,i)=>(i%2?['pdx1','iad1']:['iad1','pdx1']).map(arm=>({arm,samples})));
}
