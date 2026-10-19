import { execFile } from "node:child_process";
import { readFile,writeFile } from "node:fs/promises";
import { arch,cpus,platform,totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withFeatureStoreDatabase } from "./harness.ts";
import { runDerivedJob } from "../../src/featureStore/derived.ts";
import { ingestSource } from "../../src/featureStore/ingest.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { NORMALIZER_VERSION } from "../../src/featureStore/source.ts";
import type { SourceAsset } from "../../src/featureStore/source.ts";

const root=new URL("../../../../",import.meta.url);
const path=new URL("docs/evidence/feature-store-138/step-4-real-derived.json",root);
const sourcePath=new URL("docs/evidence/feature-store-138/step-3-source-manifest.json",root);
const source=JSON.parse(await readFile(sourcePath,"utf8")) as {assets:{asset:SourceAsset}[]};
const previous=JSON.parse(await readFile(new URL("docs/evidence/feature-store-138/step-3-real-ingestion.json",root),"utf8")) as {storageRoot:string;results:{name:string;objectKey:string;wireSha256:string}[]};
const store=await openLocalObjectStore(previous.storageRoot);
const files=["services/pipeline/src/featureStore/derived.ts","packages/db/proposals/138_feature_store.sql","services/pipeline/scripts/feature-store/harness.ts",
 "services/pipeline/scripts/feature-store/derived-spike.ts","services/pipeline/scripts/feature-store/derived-cold.ts","services/pipeline/src/featureStore/ingest.ts","services/pipeline/src/featureStore/normalize.ts","services/pipeline/src/featureStore/source.ts","package-lock.json"];
const codeHashes=Object.fromEntries(await Promise.all(files.map(async p=>[p,sha256(await readFile(new URL(p,root)))])));
const code={gitSha:(await promisify(execFile)("git",["rev-parse","HEAD"])).stdout.trim(),contentSha256:sha256(Buffer.from(JSON.stringify(codeHashes)))};
const trials:Record<string,unknown>[]=[];
const qualification:Record<string,unknown>[]=[];
const report:Record<string,unknown>={schemaVersion:1,issue:138,step:4,recordedAt:new Date().toISOString(),code,codeHashes,
 sourceManifestSha256:sha256(await readFile(sourcePath)),runtime:process.version,
 machine:{arch:arch(),platform:platform(),cpus:cpus().length,totalMemoryBytes:totalmem()},
 fixtureStorage:{postgresTmpfsBytes:2147483648,composeOverride:"compose.feature-store-spike.yml",retainedTrialOutputs:true,
  earlier512MiBFailure:"step-4-real-derived-storage-failure.json"},
 fixture:"exact step-3 wire objects; all five seasons normalized in a fresh scratch DB; no synthetic corrections",
 evidenceMode:"retrospective-reconstruction-v1",flags:["historical-availability-unverified"],evaluationRun:false,
 setup:"ObjectStore reads exact pinned raw bytes for re-normalization; this is not an ingestion/network benchmark",
 cacheState:"cold trials use fresh Node processes and restricted DB connections; warm trials reuse a connection; no app cache or job-output reuse; OS/DB buffers not flushed; no claim of cold disk caches",
 trials,qualification,verdict:"running"};
const save=()=>writeFile(path,JSON.stringify(report,null,2)+"\n");
await save();
try{await withFeatureStoreDatabase(async({admin,writer,reader,createWriterConfig,queryCounts})=>{
 report.database=(await admin.query("SELECT version() AS version")).rows[0].version;
 const inputs=[];
 for(const {asset} of source.assets){
  const prior=previous.results.find(row=>row.name===asset.name);if(!prior)throw new Error("source-receipt-missing");
  const bytes=await store.get(prior.objectKey);if(sha256(bytes)!==prior.wireSha256)throw new Error("raw-integrity-failed");
  const result=await ingestSource(writer,store,asset,code,{download:async()=>({bytes,capturedAt:new Date().toISOString(),requests:0})});
  if(result.status!=="ingested")throw new Error("source-setup-refused");
  inputs.push({name:asset.name,sha256:result.wireSha256,normalizedRows:result.normalizedRows});
  console.log(JSON.stringify({setup:asset.name,rows:result.normalizedRows}));
 }
 report.inputs=inputs;
 await writer.query("ANALYZE fs138.job_runs,fs138.source_snapshots,fs138.norm_schedule,fs138.norm_player_game_stats,fs138.norm_identity,fs138.norm_participation");
 const body=(await admin.query("SELECT prosrc FROM pg_proc WHERE oid='fs138.qb_job_context(integer,timestamptz,text,text,text)'::regprocedure")).rows[0].prosrc as string;
 const contextSql=body.replaceAll("p_season","2025").replaceAll("p_checkpoint","clock_timestamp()")
  .replaceAll("p_mode","'retrospective-reconstruction-v1'").replaceAll("p_purpose","'features'").replaceAll("p_normalizer","'"+NORMALIZER_VERSION+"'");
 report.plainContextPlan=(await admin.query("EXPLAIN (FORMAT JSON) "+contextSql)).rows;
 await save();
 const mode="retrospective-reconstruction-v1" as const;
 const digest=async(jobId:string)=>sha256(Buffer.from(JSON.stringify((await reader.query(`SELECT player_id,game_id,cutoff::text,state,reasons,flags,sample_size,history,history_gaps
  FROM fs138.feature_values WHERE job_id=$1 ORDER BY player_id,game_id`,[jobId])).rows)));
 const measure=async(season:number,trialMode:"cold"|"warm",trial:number)=>{
  const config=trialMode==="cold"?await createWriterConfig():null;
  const before=queryCounts.writer;
  const started=performance.now();
  let entry:Record<string,unknown>;
  try{
   let result:Awaited<ReturnType<typeof runDerivedJob>>;
   let statements:number;
   let processId=process.pid;
   if(config){
    const cold=await new Promise<{result:Awaited<ReturnType<typeof runDerivedJob>>;queries:number;processId:number}>((resolve,reject)=>{
     const child=execFile(process.execPath,["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",fileURLToPath(new URL("derived-cold.ts",import.meta.url))],
      {maxBuffer:1024*1024},(error,stdout)=>{if(error)reject(error);else{try{resolve(JSON.parse(stdout));}catch(error){reject(error);}}});
     child.stdin!.end(JSON.stringify({config,request:{season,mode},code}));
    });result=cold.result;statements=cold.queries;processId=cold.processId;
   }else{result=await runDerivedJob(writer,"features",{season,mode},code);statements=queryCounts.writer-before;}
   const measuredMs=performance.now()-started;
   entry={season,trialMode,trial,...result,measuredMs,processId,queries:statements,deadlineMs:120000,headroomLimitMs:84000,
    verdict:result.status==="succeeded"&&measuredMs<=84000?"pass":"fail"};
   if(result.status==="succeeded")entry.resultContentSha256=await digest(result.jobId);
   entry.storageObservation=(await admin.query(`SELECT pg_database_size(current_database())::text AS database_bytes,
    temp_bytes::text,temp_files::integer FROM pg_stat_database WHERE datname=current_database()`)).rows[0];
  }catch(error){entry={season,trialMode,trial,status:"failed",error:String(error),measuredMs:performance.now()-started,queries:queryCounts.writer-before,verdict:"fail"};}
  trials.push(entry);await save();console.log(JSON.stringify(entry));
  if(entry.status!=="succeeded")throw new Error("feature-trial-failed-stop-before-connection-reuse");
 };
 // Absolute target: alternating cold/warm, three full recomputations of each.
 // No optimization comparison is being made, so this is not an ABBA claim.
 for(let trial=1;trial<=3;trial++)for(const trialMode of ["cold","warm"] as const)await measure(2025,trialMode,trial);
 for(const season of [2021,2022,2023,2024]){
  const before=queryCounts.writer;
  const result=await runDerivedJob(writer,"features",{season,mode},code);
  qualification.push({kind:"features",season,...result,queries:queryCounts.writer-before});await save();
 }
 for(const season of [2021,2022,2023,2024,2025]){
  const before=queryCounts.writer;
  const result=await runDerivedJob(writer,"labels",{season,mode},code);
  qualification.push({kind:"labels",season,...result,queries:queryCounts.writer-before});await save();
 }
 // Exercise the persistent writer well beyond the generic-plan threshold.
 for(let trial=4;trial<=6;trial++)await measure(2025,"warm",trial);
 const strict=await runDerivedJob(writer,"features",{season:2025,mode:"strict-point-in-time-v1"},code);
 report.strictComparison=strict;
 report.coverage=(await reader.query(`WITH latest_features AS (
   SELECT DISTINCT ON(player_id,game_id) * FROM fs138.feature_values WHERE evidence_mode=$1 ORDER BY player_id,game_id,checkpoint DESC,computed_at DESC
  ),latest_labels AS (
   SELECT DISTINCT ON(player_id,game_id) * FROM fs138.outcome_labels WHERE evidence_mode=$1 ORDER BY player_id,game_id,label_cutoff DESC,known_at DESC
  ) SELECT f.season,count(*)::integer AS candidates,count(*) FILTER(WHERE f.state='usable')::integer AS usable_features,
    count(*) FILTER(WHERE l.state='usable')::integer AS usable_labels,
    count(*) FILTER(WHERE f.state='usable' AND l.state='usable')::integer AS usable_both,
    count(*) FILTER(WHERE f.state='usable' AND f.sample_size BETWEEN 2 AND 4)::integer AS sample_2_4,
    count(*) FILTER(WHERE f.state='usable' AND f.sample_size BETWEEN 5 AND 8)::integer AS sample_5_8,
    count(*) FILTER(WHERE f.state='usable' AND f.sample_size BETWEEN 9 AND 16)::integer AS sample_9_16
   FROM latest_features f LEFT JOIN latest_labels l USING(player_id,game_id) GROUP BY f.season ORDER BY f.season`,[mode])).rows;
 report.labelRefusalReasons=(await reader.query(`SELECT reason,count(*)::integer AS n FROM fs138.outcome_labels l CROSS JOIN LATERAL unnest(l.reasons) reason GROUP BY reason ORDER BY reason`)).rows;
 report.eventTimeLeaks=(await reader.query(`SELECT count(*)::integer AS n FROM fs138.feature_values f CROSS JOIN LATERAL jsonb_array_elements(f.history) h
  WHERE h->>'gameId'=f.game_id OR (h->>'kickoff')::timestamptz>=f.cutoff`)).rows[0].n;
 report.snapshots=(await reader.query(`SELECT snapshot_id,profile_id,sha256,byte_size::text,object_key,media_type,
  decoded_sha256,header_sha256,row_count,captured_at::text,available_at::text,ingested_at::text,evidence_basis
  FROM fs138.source_snapshots ORDER BY snapshot_id`)).rows;
 report.jobs=(await reader.query(`SELECT job_id,kind,code_sha,policy_sha256,input_set_sha256,status,counts,
  recorded_at::text,finished_at::text FROM fs138.job_runs ORDER BY recorded_at,job_id`)).rows;
 report.sourceLineageByJob=(await reader.query(`SELECT job_id,array_agg(snapshot_id ORDER BY snapshot_id) AS snapshot_ids
  FROM fs138.job_inputs GROUP BY job_id ORDER BY job_id`)).rows;
 report.sampleOutputs=(await reader.query(`WITH f AS (
   SELECT DISTINCT ON(player_id,game_id) * FROM fs138.feature_values WHERE evidence_mode=$1
   ORDER BY player_id,game_id,checkpoint DESC,computed_at DESC
  ),l AS (
   SELECT DISTINCT ON(player_id,game_id) * FROM fs138.outcome_labels WHERE evidence_mode=$1
   ORDER BY player_id,game_id,label_cutoff DESC,known_at DESC
  ),examples AS (
   SELECT f.feature_id,f.job_id AS feature_job_id,l.label_id,l.job_id AS label_job_id,f.player_id,f.game_id,f.season,
    f.cutoff::text,f.checkpoint::text,f.computed_at::text,l.label_cutoff::text,l.known_at::text,
    f.sample_size,f.history,f.history_gaps,f.flags,l.value AS label_value,
    CASE WHEN f.sample_size<=4 THEN '2-4' WHEN f.sample_size<=8 THEN '5-8' ELSE '9-16' END AS sample_stratum
   FROM f JOIN l USING(player_id,game_id) WHERE f.state='usable' AND l.state='usable' AND f.season>=2022
  ),selected AS (
   SELECT *,row_number() OVER(PARTITION BY sample_stratum ORDER BY game_id,player_id) AS ordinal FROM examples
  ) SELECT * FROM selected WHERE ordinal=1 ORDER BY sample_stratum`,[mode])).rows;
 report.lineage=(await reader.query(`SELECT (SELECT count(*)::integer FROM fs138.feature_inputs) AS feature_snapshot_links,
  (SELECT count(*)::integer FROM fs138.label_inputs) AS label_snapshot_links,(SELECT count(*)::integer FROM fs138.source_snapshots) AS snapshots`)).rows[0];
 const content=new Set(trials.filter(t=>t.status==="succeeded").map(t=>t.resultContentSha256));
 report.repeatedOutputParity=content.size===1;
 report.featureTargetVerdict=trials.length===9&&trials.every(t=>t.verdict==="pass"&&t.queries===8)&&content.size===1?"pass":"fail";
 report.verdict=report.featureTargetVerdict==="pass"&&report.eventTimeLeaks===0?"step-4-real-correctness-and-season-feature-target-pass":"fail";
 });}
catch(error){report.verdict="failed";report.error=String(error);throw error;}
finally{report.peakRssBytes=process.resourceUsage().maxRSS*1024;await save();}
console.log(JSON.stringify({report:path.pathname,verdict:report.verdict,featureTargetVerdict:report.featureTargetVerdict}));
if(report.verdict!=="step-4-real-correctness-and-season-feature-target-pass")process.exitCode=1;
