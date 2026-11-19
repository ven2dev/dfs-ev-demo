import { randomUUID } from 'node:crypto';
import { sampleKey } from '../../../apps/web/src/lib/qualification220-core.mjs';

const assert=(ok,reason)=>{if(!ok)throw new Error(reason);};
const variableKeys = ['SPIKE220_ENABLED','SPIKE220_BINDING','SPIKE220_DATABASE_URL',
  'SPIKE220_TOKEN_SHA256','SPIKE220_ISSUED_AT','SPIKE220_EXPIRES_AT'];

export const createRunMetadata = (now = Date.now()) => ({
  runId:randomUUID(),
  issuedAt:new Date(now).toISOString(),
  expiresAt:new Date(now+4*3600_000).toISOString(),
});

export function verifyEnvironmentMetadata(items,branch) {
  assert(items.length===variableKeys.length,'variable count mismatch');
  for(const key of variableKeys) {
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
export const sameSubjectControl = () => Array.from({length:20},(_,index)=>({
  stage:'same-subject',workers:20,round:0,mode:'admission',index,
}));
export function verifyCleanup(receipt) {
  for(const key of ['branchAbsent','roleAbsent','variablesAbsent','deploymentUnavailable','runnerCredentialsCleared'])assert(receipt[key]===true,`cleanup not verified: ${key}`);
  return true;
}
// Each block keeps warmup+measurement or stale+next-tick together.
export function runSchedule() {
  const all=schedule(),blocks=[];
  for(let i=0;i<all.length;){
    const first=all[i],samples=[];
    const stages=first.stage==='warmup'?['warmup','warm']:first.stage==='stale'?['stale','next-tick']:[first.stage];
    while(i<all.length && all[i].workers===first.workers && all[i].round===first.round && all[i].mode===first.mode && stages.includes(all[i].stage))samples.push(all[i++]);
    blocks.push(samples);
  }
  return blocks;
}
