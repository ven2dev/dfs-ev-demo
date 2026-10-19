import { execFile } from "node:child_process";
import { readFile,writeFile } from "node:fs/promises";
import { arch,cpus,platform,totalmem } from "node:os";
import { promisify } from "node:util";
import { withFeatureStoreDatabase } from "./harness.ts";
import { FEATURE_VERSION,HISTORY_POLICY } from "../../src/featureStore/derived.ts";
import { ingestSource } from "../../src/featureStore/ingest.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { NORMALIZER_VERSION } from "../../src/featureStore/source.ts";
import type { SourceAsset } from "../../src/featureStore/source.ts";

const root=new URL("../../../../",import.meta.url);
const path=new URL("docs/evidence/feature-store-138/step-4-query-profile.json",root);
const sourcePath=new URL("docs/evidence/feature-store-138/step-3-source-manifest.json",root);
const source=JSON.parse(await readFile(sourcePath,"utf8")) as {assets:{asset:SourceAsset}[]};
const previous=JSON.parse(await readFile(new URL("docs/evidence/feature-store-138/step-3-real-ingestion.json",root),"utf8")) as {storageRoot:string;results:{name:string;objectKey:string;wireSha256:string}[]};
const store=await openLocalObjectStore(previous.storageRoot);
const files=["services/pipeline/src/featureStore/derived.ts","packages/db/proposals/138_feature_store.sql","services/pipeline/scripts/feature-store/harness.ts",
 "services/pipeline/scripts/feature-store/profile-derived.ts","services/pipeline/src/featureStore/ingest.ts","services/pipeline/src/featureStore/normalize.ts","services/pipeline/src/featureStore/source.ts","package-lock.json"];
const codeHashes=Object.fromEntries(await Promise.all(files.map(async p=>[p,sha256(await readFile(new URL(p,root)))])));
const code={gitSha:(await promisify(execFile)("git",["rev-parse","HEAD"])).stdout.trim(),contentSha256:sha256(Buffer.from(JSON.stringify(codeHashes)))};
const trials:Record<string,unknown>[]=[];
const qualification:Record<string,unknown>[]=[];
const report:Record<string,unknown>={schemaVersion:1,issue:138,step:4,recordedAt:new Date().toISOString(),code,codeHashes,
 sourceManifestSha256:sha256(await readFile(sourcePath)),runtime:process.version,
 machine:{arch:arch(),platform:platform(),cpus:cpus().length,totalMemoryBytes:totalmem()},
 fixture:"exact step-3 wire objects; all five seasons normalized in a fresh scratch DB; no synthetic corrections",
 evidenceMode:"retrospective-reconstruction-v1",flags:["historical-availability-unverified"],evaluationRun:false,
 setup:"ObjectStore reads exact pinned raw bytes for re-normalization; this is not an ingestion/network benchmark",
 cacheState:"cold trials use fresh restricted DB connections; warm trials reuse a connection; no app cache or job-output reuse; OS/DB buffers not flushed; one Node process",
 trials,qualification,verdict:"running"};
const save=()=>writeFile(path,JSON.stringify(report,null,2)+"\n");
await save();
try{await withFeatureStoreDatabase(async({admin,writer})=>{
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
 const sourceCode=await readFile(new URL("services/pipeline/src/featureStore/derived.ts",root),"utf8");
 const marker="const featureSelect = `";
 const begin=sourceCode.indexOf(marker)+marker.length;
 const end=sourceCode.indexOf("`;",begin);
 if(begin<marker.length||end<begin)throw new Error("profile-sql-location-refused");
 const featureSql=sourceCode.slice(begin,end);
 const checkpoint=(await admin.query("SELECT clock_timestamp()::text AS clock")).rows[0].clock;
 const ids=(await admin.query("SELECT snapshot_id FROM fs138.source_snapshots ORDER BY snapshot_id")).rows.map(row=>row.snapshot_id);
 const params=["00000000-0000-0000-0000-000000000001",2025,checkpoint,mode,NORMALIZER_VERSION,FEATURE_VERSION,HISTORY_POLICY,ids];
 report.fullMaterializationPlan=(await admin.query("EXPLAIN (FORMAT JSON) "+featureSql,params)).rows;
 await save();
 await admin.query("SET statement_timeout='15s'");
 const started=performance.now();
 try{report.analyzedContextPlan=(await admin.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) "+contextSql)).rows;
  report.analyzedContextMs=performance.now()-started;}
 catch(error){report.contextFailure={error:String(error),elapsedMs:performance.now()-started};}
 report.verdict="diagnostic-complete-not-a-capacity-gate";
 });}
 catch(error){report.verdict="failed";report.error=String(error);throw error;}
 finally{await save();}
 console.log(JSON.stringify({profile:path.pathname,verdict:report.verdict,contextMs:report.analyzedContextMs,contextFailure:report.contextFailure}));
