// Opt-in diagnostic: explain the first derived job before/after producer statistics.
import assert from "node:assert/strict";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {withFeatureStoreDatabase} from "./harness.ts";
import {ingestSource} from "../../src/lib/featureStore/ingest.ts";
import {FEATURE_JOB_SQL,FEATURE_VERSION,HISTORY_POLICY,runDerivedJob} from "../../src/lib/featureStore/derived.ts";
import {openLocalObjectStore} from "../../src/lib/featureStore/localObjectStore.ts";
import {sha256} from "../../src/lib/featureStore/objectStore.ts";
import {NORMALIZER_VERSION,type SourceAsset} from "../../src/lib/featureStore/source.ts";
const root=new URL('../../',import.meta.url);
const previous=JSON.parse(await readFile(new URL('docs/evidence/feature-store-138/step-3-real-ingestion.json',root),'utf8'));
const manifest=JSON.parse(await readFile(new URL('docs/evidence/feature-store-138/step-3-source-manifest.json',root),'utf8')) as {assets:{asset:SourceAsset}[]};
const store=await openLocalObjectStore(previous.storageRoot);
const report:Record<string,unknown>={issue:138,step:5,purpose:'planner diagnostic and single bounded derived job; not a repeated capacity gate',plans:[]};
await withFeatureStoreDatabase(async({admin,writer})=>{
 for(const {asset} of manifest.assets){
  const prior=previous.results.find((r:{name:string})=>r.name===asset.name);assert(prior);
  const bytes=await store.get(prior.objectKey);
  await ingestSource(writer,store,asset,{gitSha:'d07f42c776797bc5c808ba8faaefe55870a71221',contentSha256:sha256(Buffer.from('diagnostic'))},
   {download:async()=>({bytes,capturedAt:new Date().toISOString(),requests:0})});
 }
 const ids=(await writer.query('SELECT snapshot_id FROM fs138.source_snapshots ORDER BY snapshot_id')).rows.map(r=>r.snapshot_id);
 const clock=(await writer.query('SELECT clock_timestamp()::text AS clock')).rows[0].clock;
 const params=['00000000-0000-0000-0000-000000000001',2021,clock,'retrospective-reconstruction-v1',NORMALIZER_VERSION,FEATURE_VERSION,HISTORY_POLICY,ids];
 const capture=async()=>{
  const plan=(await admin.query('EXPLAIN (FORMAT JSON) '+FEATURE_JOB_SQL,params)).rows[0]['QUERY PLAN'][0].Plan;
  const nodes:Record<string,unknown>[]=[];
  const visit=(n:Record<string,unknown>)=>{if(n['Relation Name']||n['Node Type']==='Nested Loop')nodes.push(Object.fromEntries(['Node Type','Relation Name','Plan Rows','Total Cost'].map(k=>[k,n[k]])));for(const c of (n.Plans??[]) as Record<string,unknown>[])visit(c);};visit(plan);
  return {plan,nodes,totalCost:plan['Total Cost']};
 };
 report.before=await capture();
 await writer.query('ANALYZE fs138.job_runs,fs138.source_snapshots,fs138.norm_schedule,fs138.norm_identity,fs138.norm_player_game_stats,fs138.norm_participation');
 report.after=await capture();
 const started=performance.now();
 try {report.execution=await runDerivedJob(writer,'features',{season:2021,mode:'retrospective-reconstruction-v1'},
 {gitSha:'d07f42c776797bc5c808ba8faaefe55870a71221',contentSha256:sha256(Buffer.from('diagnostic'))});}
 catch(error){report.execution={error:String(error),elapsedMs:performance.now()-started};}

});
const raw=JSON.stringify(report,null,2)+'\n';
const out=new URL('../dfs-ev-demo-138-data/step-5-diagnostics/',root);await mkdir(out,{recursive:true});
const path=new URL('producer-statistics-profile.json',out);await writeFile(path,raw);
const receipt={issue:138,step:5,purpose:report.purpose,execution:report.execution,before:(report.before as {nodes:unknown}).nodes,after:(report.after as {nodes:unknown}).nodes,
 diagnostics:{path:path.pathname,sha256:sha256(Buffer.from(raw)),byteSize:Buffer.byteLength(raw)}};
await writeFile(new URL('docs/evidence/feature-store-138/step-5-producer-statistics.json',root),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt));
