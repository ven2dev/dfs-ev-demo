import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile,writeFile,mkdtemp,realpath,rm,mkdir } from "node:fs/promises";
import { cpus,totalmem,arch,platform,tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ClientConfig } from "pg";
import { withFeatureStoreDatabase } from "./harness.ts";
import { ingestSource } from "../../src/featureStore/ingest.ts";
import { runDerivedJob,FEATURE_VERSION,LABEL_VERSION,HISTORY_POLICY } from "../../src/featureStore/derived.ts";
import { buildDataset,readDataset,DATASET_JOIN_SQL,type DatasetSpec } from "../../src/featureStore/datasets.ts";
import { deleteSources,cleanupDeletedObjects,pruneDerivedVersions } from "../../src/featureStore/governance.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import type { SourceAsset } from "../../src/featureStore/source.ts";
const root=new URL('../../../../',import.meta.url);
const reportPath=new URL('docs/evidence/feature-store-138/step-5-real-dataset.json',root);
const sourcePath=new URL('docs/evidence/feature-store-138/step-3-source-manifest.json',root);
const manifest=JSON.parse(await readFile(sourcePath,'utf8')) as {assets:{asset:SourceAsset}[]};
const previous=JSON.parse(await readFile(new URL('docs/evidence/feature-store-138/step-3-real-ingestion.json',root),'utf8')) as {storageRoot:string;results:{name:string;objectKey:string;wireSha256:string}[]};
const originals=await openLocalObjectStore(previous.storageRoot);
const storageRoot=await realpath(await mkdtemp(join(tmpdir(),'dfs138-dataset-real-')));
const store=await openLocalObjectStore(storageRoot);
const files=['services/pipeline/src/featureStore/datasets.ts','services/pipeline/src/featureStore/governance.ts','services/pipeline/src/featureStore/derived.ts',
 'packages/db/proposals/138_feature_store.sql','packages/db/proposals/138_dataset_governance.sql','packages/db/proposals/163_effective_rights.sql','services/pipeline/scripts/feature-store/harness.ts',
 'services/pipeline/scripts/feature-store/dataset-spike.ts','services/pipeline/scripts/feature-store/dataset-cold.ts','services/pipeline/src/featureStore/objectStore.ts',
 'services/pipeline/src/featureStore/localObjectStore.ts','services/pipeline/src/featureStore/ingest.ts','services/pipeline/src/featureStore/normalize.ts','package-lock.json'];
const codeHashes=Object.fromEntries(await Promise.all(files.map(async f=>[f,sha256(await readFile(new URL(f,root)))])));
const code={gitSha:(await promisify(execFile)('git',['rev-parse','HEAD'])).stdout.trim(),contentSha256:sha256(Buffer.from(JSON.stringify(codeHashes)))};
const trials:Record<string,unknown>[]=[];
const setup:Record<string,unknown>[]=[];
const report:Record<string,unknown>={schemaVersion:1,issue:138,step:5,recordedAt:new Date().toISOString(),code,codeHashes,
 sourceManifestSha256:sha256(await readFile(sourcePath)),runtime:process.version,
 machine:{cpus:cpus().length,totalMemoryBytes:totalmem(),arch:arch(),platform:platform()},
 fixture:'exact step-3 raw objects, copied through ObjectStore to an isolated disposable root; no original objects deleted; no synthetic correction in real data',
 evidenceMode:'retrospective-reconstruction-v1',historicalAvailability:'unverified',scoringRun:false,
 cacheState:'three alternating fresh-process cold and warm builds; cold includes Node startup, new restricted connection, ObjectStore open, full join/write/hash; OS/DB caches not flushed',
 comparison:'absolute target only; no relative optimization or ABBA claim',
 deadlineMs:30000,headroomLimitMs:21000,setup,trials,verdict:'running'};
const diagnosticsRoot=fileURLToPath(new URL('../dfs-ev-demo-138-data/step-5-diagnostics/',root));
await mkdir(diagnosticsRoot,{recursive:true});
const diagnosticsPath=join(diagnosticsRoot,`dataset-${new Date().toISOString().replaceAll(':','-')}.json`);
const compactResult=(r:Record<string,unknown>)=>Object.fromEntries(Object.entries(r).filter(([k])=>!['authorization','delivery'].includes(k)));
const save=async()=>{
 const raw=JSON.stringify(report,null,2)+'\n';await writeFile(diagnosticsPath,raw);
 const compact={...report,setup:setup.map(r=>({name:r.name,status:r.status,wireSha256:r.wireSha256,rawRows:r.rawRows,normalizedRows:r.normalizedRows})),
  trials:trials.map(t=>({...t,result:t.result?compactResult(t.result as Record<string,unknown>):undefined})),
  rights:undefined,datasetPlan:undefined,sampleRows:undefined,snapshots:undefined,
  fullDiagnostics:{path:diagnosticsPath,sha256:sha256(Buffer.from(raw)),byteSize:Buffer.byteLength(raw)}};
 await writeFile(reportPath,JSON.stringify(compact,null,2)+'\n');
};await save();
try{await withFeatureStoreDatabase(async({admin,writer,reader,createWriterConfig,queryCounts})=>{
 report.database=(await admin.query('SELECT version() AS version')).rows[0].version;
 for(const {asset} of manifest.assets){
  const previousObject=previous.results.find(r=>r.name===asset.name);assert(previousObject);
  const bytes=await originals.get(previousObject.objectKey);assert.equal(sha256(bytes),previousObject.wireSha256);
  const receipt=await ingestSource(writer,store,asset,code,{download:async()=>({bytes,capturedAt:new Date().toISOString(),requests:0})});
  assert.equal(receipt.status,'ingested');setup.push({name:asset.name,...receipt});console.log(JSON.stringify({setup:asset.name,status:receipt.status}));await save();
 }
 // Local research permission only, supported by the owner's approved spike.
 // This is not a commercial license/availability qualification.
 report.rights=(await writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
  SELECT profile_id,ARRAY['research'],clock_timestamp(),'owner-approved #138 local retrospective research; no commercial clearance claim'
  FROM fs138.source_profiles RETURNING decision_id,profile_id,recorded_at::text,allowed_uses`)).rows;
 const mode='retrospective-reconstruction-v1' as const;
 const derived=[];
 for(const season of [2021,2022,2023,2024,2025])for(const kind of ['features','labels'] as const){
  const result=await runDerivedJob(writer,kind,{season,mode},code);assert.equal(result.status,'succeeded');derived.push({season,kind,...result});
  report.derivedSetup=derived;await save();console.log(JSON.stringify({derived:kind,season,elapsedMs:result.elapsedMs}));
 }
 report.derivedSetup=derived;await save();
 const clock=async()=>(await admin.query('SELECT clock_timestamp()::text AS clock')).rows[0].clock as string;
 const selectionClock=await clock();
 const spec:DatasetSpec={mode,featureVersion:FEATURE_VERSION,labelVersion:LABEL_VERSION,historyPolicy:HISTORY_POLICY,
  featuresAsOf:selectionClock,labelsAsOf:selectionClock,includeRetrospective:true,includeSuperseded:true};report.spec=spec;
 report.datasetPlan=(await admin.query('EXPLAIN (FORMAT JSON) '+DATASET_JOIN_SQL,
  [spec.featureVersion,spec.labelVersion,spec.historyPolicy,spec.mode,spec.featuresAsOf,spec.labelsAsOf,spec.includeRetrospective,spec.includeSuperseded])).rows;
 await save();
 let last:Awaited<ReturnType<typeof buildDataset>>;
 const cold=async(config:ClientConfig)=>new Promise<{result:Awaited<ReturnType<typeof buildDataset>>;statements:number;rightsQueries:number;processId:number;peakRssBytes:number}>((resolve,reject)=>{
  const child=execFile(process.execPath,['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',fileURLToPath(new URL('dataset-cold.ts',import.meta.url))],{maxBuffer:1024*1024},(error,stdout)=>{
   if(error)reject(error);else{try{resolve(JSON.parse(stdout));}catch(error){reject(error);}}
  });child.stdin!.end(JSON.stringify({config,spec,code,storageRoot}));
 });
 let warmRightsQueries=0;
 const measuredWriter=new Proxy(writer,{get(target,property){
  if(property!=='query')return Reflect.get(target,property,target);
  return(...args:unknown[])=>{const q=args[0];const sql=typeof q==='string'?q:(q as {text:string}).text;
   if(sql.includes('decisions AS MATERIALIZED'))warmRightsQueries++;
   return Reflect.apply(target.query,target,args);
  };
 }});
 for(let trial=1;trial<=3;trial++)for(const mode of ['cold','warm'] as const){
  const config=mode==='cold'?await createWriterConfig():null;
  const before=queryCounts.writer;const rightsBefore=warmRightsQueries;const started=performance.now();let entry:Record<string,unknown>;
  try{
   const receipt=config?await cold(config):{result:await buildDataset(measuredWriter,store,spec,code),statements:queryCounts.writer-before,rightsQueries:warmRightsQueries-rightsBefore,processId:process.pid,peakRssBytes:process.resourceUsage().maxRSS*1024};
   last=receipt.result;const measuredMs=performance.now()-started;
   entry={trial,mode,...receipt,measuredMs,verdict:measuredMs<=21000&&receipt.statements===8&&receipt.rightsQueries===2?'pass':'fail'};
  }catch(error){entry={trial,mode,error:String(error),measuredMs:performance.now()-started,verdict:'fail'};}
  trials.push(entry);await save();console.log(JSON.stringify({trial,mode,measuredMs:entry.measuredMs,verdict:entry.verdict,statements:entry.statements,rowCount:(entry.result as {rowCount:number}|undefined)?.rowCount,error:entry.error}));if(entry.error)throw new Error('dataset-trial-failed');
 }
 const bytes=await readDataset(reader,store,last!.datasetId);assert.equal(sha256(bytes),last!.fileSha256);
 const dataset=JSON.parse(bytes.toString()) as {rows:{season:number;sampleSize:number;history:{gameId:string;kickoff:string}[];gameId:string;cutoff:string;label:number;flags:string[]}[]};
 assert.equal(dataset.rows.length,2504);assert(dataset.rows.every(r=>r.season>=2022));
 report.coverage=[2022,2023,2024,2025].map(season=>({season,rows:dataset.rows.filter(r=>r.season===season).length,
  strata:Object.fromEntries([[2,4],[5,8],[9,16]].map(([lo,hi])=>[`${lo}-${hi}`,dataset.rows.filter(r=>r.season===season&&r.sampleSize>=lo&&r.sampleSize<=hi).length]))}));
 report.eventTimeLeaks=dataset.rows.filter(r=>r.history.some(h=>h.gameId===r.gameId||Date.parse(h.kickoff)>=Date.parse(r.cutoff))).length;
 report.hashParity=new Set(trials.map(t=>(t.result as {fileSha256:string})?.fileSha256)).size===1;
 report.contentHashParity=new Set(trials.map(t=>(t.result as {contentSha256:string})?.contentSha256)).size===1;
 report.sampleRows=[2,5,9].map(min=>dataset.rows.find(r=>r.sampleSize>=min));
 report.snapshots=(await reader.query('SELECT snapshot_id,profile_id,sha256,object_key,ingested_at::text FROM fs138.source_snapshots ORDER BY snapshot_id')).rows;
 report.pruningBeforeDeletion=await pruneDerivedVersions(writer); // all retained latest/pinned
 const source=setup.find(r=>String(r.name).includes('stats_player_week_2025')||String(r.name)==='stats_player_week_2025.csv');
 const target=source??setup.find(r=>String(r.name).includes('2025')&&String(r.name).startsWith('stats'));
 assert(target,'2025 stats source missing');const targetId=target.snapshotId as string;
 const expected=(await reader.query(`SELECT ARRAY(SELECT feature_id FROM fs138.feature_inputs WHERE snapshot_id=$1 ORDER BY feature_id) AS features,
  ARRAY(SELECT label_id FROM fs138.label_inputs WHERE snapshot_id=$1 ORDER BY label_id) AS labels,
  ARRAY(SELECT dataset_id FROM fs138.dataset_inputs WHERE snapshot_id=$1 ORDER BY dataset_id) AS datasets`,[targetId])).rows[0];
 // Capture exact old IDs AND all values before deletion; do not rerun old jobs.
 const oldValues=async()=>{
  const result=(await reader.query(`SELECT
   (SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY feature_id),'[]') FROM fs138.feature_values f WHERE season BETWEEN 2022 AND 2024) AS features,
   (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY label_id),'[]') FROM fs138.outcome_labels l WHERE season BETWEEN 2022 AND 2024) AS labels`)).rows[0];
  return {features:result.features.length,labels:result.labels.length,sha256:sha256(Buffer.from(JSON.stringify(result)))};
 };
 const beforeOld=await oldValues();
 assert((await reader.query(`SELECT count(*)::integer AS n FROM fs138.feature_values WHERE feature_id=ANY($1::uuid[]) AND season<2025`,[expected.features])).rows[0].n===0);
 assert((await reader.query(`SELECT count(*)::integer AS n FROM fs138.outcome_labels WHERE label_id=ANY($1::uuid[]) AND season<2025`,[expected.labels])).rows[0].n===0);
 const deletion=await deleteSources(writer,[targetId],'#138 real disposable 2025 statistics deletion probe',1);
 assert.deepEqual(deletion.feature_ids,expected.features);assert.deepEqual(deletion.label_ids,expected.labels);assert.deepEqual(deletion.dataset_ids,expected.datasets);
 const idReceipt=(ids:string[])=>({count:ids.length,sha256:sha256(Buffer.from(JSON.stringify(ids)))});
 const afterOld=await oldValues();assert.deepEqual(afterOld,beforeOld);
 report.survivalWithoutRecompute={before:beforeOld,after:afterOld,identical:true,seasons:[2022,2023,2024],jobsRerun:0};
 report.deletion={sourceName:target.name,eventId:deletion.event_id,featureIds:idReceipt(deletion.feature_ids),labelIds:idReceipt(deletion.label_ids),datasetIds:idReceipt(deletion.dataset_ids),exactClosureVerified:true,seasonScopedLineage:true,
  invalidatedCounts:{features:deletion.feature_ids.length,labels:deletion.label_ids.length,datasets:deletion.dataset_ids.length}};
 assert(await store.head(target.objectKey as string));assert.deepEqual((await cleanupDeletedObjects(writer,store)).removed,[]);
 await assert.rejects(readDataset(reader,store,last!.datasetId),/current-rights-or-status/);
 await admin.query('SELECT pg_sleep(1.1)');report.cleanup=await cleanupDeletedObjects(writer,store);assert.equal(await store.head(target.objectKey as string),null);
 const recomputed=[];for(const season of [2025])for(const kind of ['features','labels'] as const)
  recomputed.push({season,kind,...await runDerivedJob(writer,kind,{season,mode},code)});
 const afterClock=await clock();const rebuilt=await buildDataset(writer,store,{...spec,featuresAsOf:afterClock,labelsAsOf:afterClock},code);
 const rebuiltRows=JSON.parse((await readDataset(reader,store,rebuilt.datasetId)).toString()).rows as {season:number}[];
 assert.equal(rebuilt.rowCount,1871);assert(!rebuiltRows.some(r=>r.season===2025));
 report.recomputation={jobs:recomputed,dataset:compactResult(rebuilt),coverage:[2022,2023,2024,2025].map(season=>({season,rows:rebuiltRows.filter(r=>r.season===season).length})),
  explanation:'2022–2024 IDs and values survived untouched; only 2025 jobs reran; 2025 stats are gone so affected examples stay explicitly unavailable, never zero'};
 report.storage=(await admin.query('SELECT pg_database_size(current_database())::text AS database_bytes')).rows[0];
 report.targetVerdict=trials.length===6&&trials.every(t=>t.verdict==='pass')&&report.hashParity===true&&report.contentHashParity===true?'pass':'fail';
 report.verdict=report.targetVerdict==='pass'&&report.eventTimeLeaks===0?'step-5-local-dataset-rights-deletion-pass':'fail';
 });}catch(error){report.verdict='fail';report.error=String(error);throw error;}
finally{report.peakRssBytes=process.resourceUsage().maxRSS*1024;await save();await rm(storageRoot,{recursive:true,force:true});}
console.log(JSON.stringify({report:reportPath.pathname,verdict:report.verdict}));
if(report.verdict!=='step-5-local-dataset-rights-deletion-pass')process.exitCode=1;
