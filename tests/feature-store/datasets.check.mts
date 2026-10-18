import assert from "node:assert/strict";
import { mkdtemp,realpath,rm,writeFile,readFile,utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { runDerivedJob,FEATURE_VERSION,LABEL_VERSION,HISTORY_POLICY } from "../../src/lib/featureStore/derived.ts";
import { buildDataset,readDataset,type DatasetSpec } from "../../src/lib/featureStore/datasets.ts";
import { deleteSources,cleanupDeletedObjects,pruneDerivedVersions,sweepOrphanObjects } from "../../src/lib/featureStore/governance.ts";
import { startJob,finishJob } from "../../src/lib/featureStore/jobs.ts";
import { openLocalObjectStore } from "../../src/lib/featureStore/localObjectStore.ts";
import { sha256,objectKey } from "../../src/lib/featureStore/objectStore.ts";
import { NORMALIZER_VERSION } from "../../src/lib/featureStore/source.ts";

const code={gitSha:"b".repeat(40),contentSha256:sha256(Buffer.from("synthetic-step5-v1"))};
const mode="retrospective-reconstruction-v1" as const;
const probes:{name:string;verdict:string;details:unknown}[]=[];
const paths=["db/proposals/163_effective_rights.sql","src/lib/featureStore/datasets.ts","src/lib/featureStore/governance.ts","db/proposals/138_dataset_governance.sql","db/proposals/138_feature_store.sql","src/lib/featureStore/derived.ts","tests/feature-store/datasets.check.mts"];
const codeHashes=Object.fromEntries(await Promise.all(paths.map(async p=>[p,sha256(await readFile(new URL("../../"+p,import.meta.url)))])));
test("#138 pinned datasets, rights, two-step deletion and bounded derived retention",{timeout:120000},async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),"dfs138-datasets-")));
 const store=await openLocalObjectStore(root);
 try{await withFeatureStoreDatabase(async({admin,writer,reader,openWriter,queryCounts})=>{
  const check=async(name:string,fn:()=>Promise<unknown>)=>t.test(name,async()=>{
   try{const details=await fn();probes.push({name,verdict:"pass",details});}
   catch(error){probes.push({name,verdict:"fail",details:String(error)});throw error;}
  });
  const clock=async()=>(await admin.query("SELECT clock_timestamp()::text AS clock")).rows[0].clock as string;
  const snapshots:Record<string,string>={};
  const job=await startJob(writer,{kind:"normalize",codeSha:code.gitSha,policySha256:code.contentSha256,inputSetSha256:sha256(Buffer.from("dataset-base"))});
  const makeSnapshot=async(feed:string,token:string)=>{
   const profile="step5-"+feed;
   await writer.query(`INSERT INTO fs138.source_profiles(profile_id,provider,feed,parser_version,license)
    VALUES($1,'synthetic',$2,$3,'{"scope":"synthetic research only"}') ON CONFLICT DO NOTHING`,[profile,feed,NORMALIZER_VERSION]);
   const bytes=Buffer.from(token),hash=sha256(bytes),key=objectKey("raw",bytes);
   await store.putIfAbsent(key,bytes);
   return (await writer.query(`INSERT INTO fs138.source_snapshots(profile_id,job_id,sha256,byte_size,object_key,media_type,decoded_sha256,header_sha256,row_count,captured_at,available_at,evidence_basis)
    VALUES($1,$2,$3,$4,$5,'text/csv',$3,$3,1,'2021-01-01','2021-01-01','retrospective') RETURNING snapshot_id`,[profile,job.jobId,hash,bytes.length,key])).rows[0].snapshot_id as string;
  };
  for(const feed of ["schedule","stats","roster","participation"])snapshots[feed]=await makeSnapshot(feed,feed);
  const events=[{id:"2021_01_DAL_TB",season:2021,week:1,kickoff:"2021-09-01T18:00:00Z",yards:100},
   {id:"2021_02_DAL_TB",season:2021,week:2,kickoff:"2021-09-08T18:00:00Z",yards:200},
   {id:"2022_01_DAL_TB",season:2022,week:1,kickoff:"2022-09-01T18:00:00Z",yards:250},
   {id:"2023_01_DAL_TB",season:2023,week:1,kickoff:"2023-09-01T18:00:00Z",yards:300}];
  for(const e of events){
   await writer.query(`INSERT INTO fs138.norm_schedule VALUES($1,$2,$3,$4,$5,$6,'REG',$7,'TB','DAL',20,10,'usable','{}')`,[snapshots.schedule,NORMALIZER_VERSION,job.jobId,e.id,e.season,e.week,e.kickoff]);
   for(const player of ["qb","missing-participation"]){
    await writer.query(`INSERT INTO fs138.norm_identity VALUES($1,$2,$3,$4,$5,$6,'DAL','Synthetic QB','QB','usable','{}')`,[snapshots.roster,NORMALIZER_VERSION,job.jobId,player,e.season,e.week]);
    await writer.query(`INSERT INTO fs138.norm_player_game_stats VALUES($1,$2,$3,$4,$5,'DAL',30,$6,'usable','{}')`,[snapshots.stats,NORMALIZER_VERSION,job.jobId,player,e.id,e.yards]);
    if(player==='qb')await writer.query(`INSERT INTO fs138.norm_participation VALUES($1,$2,$3,$4,$5,1,'usable','{}')`,[snapshots.participation,NORMALIZER_VERSION,job.jobId,player,e.id]);
   }
  }
  await finishJob(writer,job.jobId,{counts:{events:4}});
  const grant=async(uses:string[])=>writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
   SELECT profile_id,$1::text[],'2021-01-01','owner-approved synthetic local research' FROM fs138.source_profiles`,[uses]);
  await grant(['research']);
  const derive=async()=>{for(const season of [2021,2022,2023])for(const kind of ["features","labels"] as const)
   assert.equal((await runDerivedJob(writer,kind,{season,mode},code)).status,"succeeded");};
  await derive();
  const originalClock=await clock();
  const spec:DatasetSpec={mode,featureVersion:FEATURE_VERSION,labelVersion:LABEL_VERSION,historyPolicy:HISTORY_POLICY,
   featuresAsOf:originalClock,labelsAsOf:originalClock,includeRetrospective:true,includeSuperseded:true};
  let first:Awaited<ReturnType<typeof buildDataset>>;
  let firstRows:{rows:{featureId:string;labelId:string;label:number;season:number;sampleSize:number;flags:string[]}[]};
  await check("pinned join excludes warm-up and unavailable labels; file hash reproduces, two constant rights checks",async()=>{
   const before=queryCounts.writer;
   first=await buildDataset(writer,store,spec,code);
   assert.equal(queryCounts.writer-before,8);assert.equal(first.work.rightsQueries,2);assert.equal(first.rowCount,2);
   const bytes=await readDataset(reader,store,first.datasetId);assert.equal(sha256(bytes),first.fileSha256);
   firstRows=JSON.parse(bytes.toString());assert(firstRows.rows.every(r=>r.season>=2022&&r.sampleSize>=2));
   assert.equal(first.contentSha256,JSON.parse(bytes.toString()).contentSha256);
   assert.equal((await reader.query('SELECT content_sha256 FROM fs138.dataset_manifests WHERE dataset_id=$1',[first.datasetId])).rows[0].content_sha256,first.contentSha256);
   assert.equal(first.exclusions['warm-up-only'],4);
   assert.equal(first.exclusions['feature-unavailable'],2);
   assert(firstRows.rows.every(r=>r.flags.includes('historical-availability-unverified')));
   const repeat=await buildDataset(writer,store,spec,code);assert.equal(repeat.fileSha256,first.fileSha256);
   assert.equal((await reader.query("SELECT count(*)::integer AS n FROM fs138.dataset_members WHERE dataset_id=$1",[first.datasetId])).rows[0].n,2);
   const excluded=await buildDataset(writer,store,{...spec,includeRetrospective:false},code);assert.equal(excluded.rowCount,0);assert.equal(excluded.exclusions['retrospective-excluded'],2);
   return {rows:first.rowCount,exclusions:first.exclusions,statements:8,rightsQueries:2,repeatedHash:first.fileSha256};
  });
  await check("natural-key hash survives independent derived IDs and clocks but changes with values",async()=>{
   await derive();const now=await clock();
   const duplicate=await buildDataset(writer,store,{...spec,featuresAsOf:now,labelsAsOf:now},code);
   assert.notEqual(duplicate.fileSha256,first.fileSha256);
   assert.equal(duplicate.contentSha256,first.contentSha256);
   return {fileHashesDiffer:true,contentHash:first.contentSha256,independentDerivedIds:true};
  });
  await check("uploads hold no DB transaction; cleanup winning before publish refuses missing objects",async()=>{
   const other=await openWriter();
   const writerPid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const before=(await reader.query('SELECT count(*)::integer AS n FROM fs138.dataset_manifests')).rows[0].n;
   const racing={...store,putIfAbsent:async(key:string,bytes:Uint8Array)=>{
    const state=(await admin.query('SELECT state FROM pg_stat_activity WHERE pid=$1',[writerPid])).rows[0].state;
    assert.equal(state,'idle');
    const result=await store.putIfAbsent(key,bytes);
    assert((await sweepOrphanObjects(other,store,0)).removed.includes(key));
    return result;
   }};
   await assert.rejects(buildDataset(writer,racing,{...spec,featuresAsOf:await clock(),labelsAsOf:await clock()},code),/dataset-object-missing/);
   assert.equal((await reader.query('SELECT count(*)::integer AS n FROM fs138.dataset_manifests')).rows[0].n,before);
   return {uploadInTransaction:false,missingObjectPublicationRefused:true,partialManifest:false};
  });
  await check("unknown versions and future clocks fail closed; non-pipeline cannot forge manifests or govern",async()=>{
   await assert.rejects(buildDataset(writer,store,{...spec,featureVersion:'unknown' as typeof FEATURE_VERSION},code),/dataset-spec-refused/);
   await assert.rejects(buildDataset(writer,store,{...spec,labelsAsOf:'2099-01-01T00:00:00Z'},code),/dataset-future-clock-refused/);
   for(const table of ['dataset_manifests','dataset_members','dataset_inputs','deletion_events','object_removals']){
    await assert.rejects(reader.query(`INSERT INTO fs138.${table} DEFAULT VALUES`),{code:'42501'});
    await assert.rejects(reader.query(`DELETE FROM fs138.${table}`),{code:'42501'});
   }
   for(const sql of ["SELECT fs138.delete_sources('{}','forged')","SELECT fs138.prune_derived()","SELECT fs138.removal_recheck('raw/"+'a'.repeat(64)+"')"])
    await assert.rejects(reader.query(sql),{code:'42501'});
   return {nonPipelineRefusals:13};
  });
  await check("rights revoked before or during file I/O refuse delivery with no released bytes",async()=>{
   await grant([]);let gets=0;
   await assert.rejects(readDataset(reader,{...store,get:async key=>{gets++;return store.get(key);}},first.datasetId),/current-rights/);
   assert.equal(gets,0);await grant(['research']);
   const before=queryCounts.reader;
   await assert.rejects(readDataset(reader,{...store,get:async key=>{const b=await store.get(key);await grant([]);return b;}},first.datasetId),/current-rights/);
   assert.equal(queryCounts.reader-before,3);await grant(['research']);
   return {objectReadsWhenInitiallyDenied:0,queriesDuringRevocation:3,delivered:false};
  });
  await check("expired superseding rights refuse dataset build and file reads until an explicit new grant",async()=>{
   for(const uses of [['research'],[]]){
    await writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,valid_until,rationale)
     SELECT profile_id,$1::text[],'2020-01-01','2020-01-02','synthetic expired superseding decision' FROM fs138.source_profiles`,[uses]);
    let gets=0,puts=0;
    await assert.rejects(readDataset(reader,{...store,get:async key=>{gets++;return store.get(key);}},first.datasetId),/current-rights/);
    await assert.rejects(buildDataset(writer,{...store,putIfAbsent:async(key,bytes)=>{puts++;return store.putIfAbsent(key,bytes);}},spec,code),/current-rights/);
    assert.equal(gets,0);assert.equal(puts,0);
    await grant(['research']);await readDataset(reader,store,first.datasetId);
   }
   return {expiredGrantAndDenialRefused:true,oldGrantResurrected:false,explicitNewGrantRestored:true};
  });
  await check("SQL and rights budgets stay constant as membership grows from 2 to 130 examples",async()=>{
   await writer.query(`INSERT INTO fs138.feature_values(job_id,player_id,game_id,stat,season,cutoff,checkpoint,feature_version,history_policy,evidence_mode,state,reasons,flags,sample_size,history,history_gaps)
    SELECT f.job_id,'clone-'||n,game_id,stat,season,cutoff,checkpoint,feature_version,history_policy,evidence_mode,state,reasons,flags,sample_size,history,history_gaps
    FROM fs138.feature_values f CROSS JOIN generate_series(2,65) n WHERE player_id='qb' AND state='usable' AND NOT EXISTS(SELECT 1 FROM fs138.feature_values n WHERE n.player_id=f.player_id AND n.game_id=f.game_id AND n.evidence_mode=f.evidence_mode AND n.computed_at>f.computed_at)`);
   await writer.query(`INSERT INTO fs138.outcome_labels(job_id,player_id,game_id,stat,season,label_cutoff,label_version,evidence_mode,state,reasons,flags,value)
    SELECT l.job_id,'clone-'||n,game_id,stat,season,label_cutoff,label_version,evidence_mode,state,reasons,flags,value
    FROM fs138.outcome_labels l CROSS JOIN generate_series(2,65) n WHERE player_id='qb' AND season>=2022 AND state='usable' AND NOT EXISTS(SELECT 1 FROM fs138.outcome_labels n WHERE n.player_id=l.player_id AND n.game_id=l.game_id AND n.evidence_mode=l.evidence_mode AND n.known_at>l.known_at)`);
   await writer.query(`INSERT INTO fs138.feature_inputs SELECT DISTINCT f.feature_id,i.snapshot_id FROM fs138.feature_values f
    JOIN fs138.feature_values base ON base.player_id='qb' AND base.game_id=f.game_id
    JOIN fs138.feature_inputs i ON i.feature_id=base.feature_id WHERE f.player_id LIKE 'clone-%'`);
   await writer.query(`INSERT INTO fs138.label_inputs SELECT DISTINCT l.label_id,i.snapshot_id FROM fs138.outcome_labels l
    JOIN fs138.outcome_labels base ON base.player_id='qb' AND base.game_id=l.game_id
    JOIN fs138.label_inputs i ON i.label_id=base.label_id WHERE l.player_id LIKE 'clone-%'`);
   const now=await clock(),before=queryCounts.writer;
   const large=await buildDataset(writer,store,{...spec,featuresAsOf:now,labelsAsOf:now},code);
   assert.equal(large.rowCount,130);assert.equal(queryCounts.writer-before,8);
   const readBefore=queryCounts.reader;await readDataset(reader,store,large.datasetId);assert.equal(queryCounts.reader-readBefore,3);
   return {small:2,large:130,buildStatements:8,readStatements:3,batchedRightsQueriesPerOperation:2};
  });
  await check("strict historical snapshots remain unavailable at dataset selection",async()=>{
   for(const kind of ['features','labels'] as const)await runDerivedJob(writer,kind,{season:2022,mode:'strict-point-in-time-v1'},code);
   const now=await clock();
   const strict=await buildDataset(writer,store,{...spec,mode:'strict-point-in-time-v1',featuresAsOf:now,labelsAsOf:now,includeRetrospective:false},code);
   assert.equal(strict.rowCount,0);assert(strict.exclusions['feature-unavailable']>0);
   return {strictUsableRows:0,historicalAvailability:'unverified',fabricatedHistoricalAvailability:false};
  });
  let correction:string;
  await check("correction uses pinned clocks; superseded inclusion policy is explicit; derived pruning preserves pins and latest",async()=>{
   correction=await makeSnapshot('stats','synthetic-correction');
   await writer.query(`INSERT INTO fs138.norm_player_game_stats SELECT $1,normalizer_version,job_id,player_id,game_id,team,passing_attempts,
    CASE WHEN game_id='2022_01_DAL_TB' THEN 999 ELSE passing_yards END,state,reasons FROM fs138.norm_player_game_stats WHERE snapshot_id=$2`,[correction,snapshots.stats]);
   await derive();
   const now=await clock();
   const mixed=await buildDataset(writer,store,{...spec,labelsAsOf:now},code);
   const rows=JSON.parse((await readDataset(reader,store,mixed.datasetId)).toString()).rows;
   assert.equal(rows.find((r:{season:number})=>r.season===2022).label,999);
   assert.notEqual(mixed.contentSha256,first.contentSha256);
   assert(rows.some((r:{flags:string[]})=>r.flags.includes('superseded-feature')));
   const old=await buildDataset(writer,store,spec,code);assert.equal(JSON.parse((await readDataset(reader,store,old.datasetId)).toString()).rows[0].label,250);
   const noFlags=await buildDataset(writer,store,{...spec,includeSuperseded:false},code);assert.equal(noFlags.rowCount,0);
   await derive(); // unpinned middle version becomes collectible
   const pins=(await reader.query('SELECT DISTINCT feature_id,label_id FROM fs138.dataset_members')).rows;
   const pruned=await pruneDerivedVersions(writer);assert(pruned.featureIds.length>0&&pruned.labelIds.length>0);
   for(const pin of pins){assert(!pruned.featureIds.includes(pin.feature_id));assert(!pruned.labelIds.includes(pin.label_id));}
   const last=(await reader.query(`SELECT feature_id FROM fs138.feature_values f WHERE NOT EXISTS(SELECT 1 FROM fs138.feature_values n
    WHERE n.player_id=f.player_id AND n.game_id=f.game_id AND n.evidence_mode=f.evidence_mode AND n.computed_at>f.computed_at)`)).rows;
   assert(last.every(r=>!pruned.featureIds.includes(r.feature_id)));
   return {syntheticCorrection:true,pins:pins.length,pruned};
  });
  await check("failed dataset publication rolls back pins; immutable uncommitted file remains discoverable",async()=>{
   const before=(await reader.query('SELECT count(*)::integer AS n FROM fs138.dataset_manifests')).rows[0].n;
   const broken={...store,putIfAbsent:async(key:string,bytes:Uint8Array)=>{
    const result=await store.putIfAbsent(key,bytes);
    await admin.query(`CREATE FUNCTION fs138.fail_dataset() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic-dataset-failure'; END$$;
     CREATE TRIGGER fail_dataset BEFORE INSERT ON fs138.dataset_members FOR EACH ROW EXECUTE FUNCTION fs138.fail_dataset()`);
    return result;
   }};
   try{await assert.rejects(buildDataset(writer,broken,{...spec,featuresAsOf:await clock(),labelsAsOf:await clock()},code),/synthetic-dataset-failure/);}
   finally{await admin.query('DROP TRIGGER fail_dataset ON fs138.dataset_members; DROP FUNCTION fs138.fail_dataset()');}
   assert.equal((await reader.query('SELECT count(*)::integer AS n FROM fs138.dataset_manifests')).rows[0].n,before);
   return {partialManifest:false,partialPins:false,objectsDiscoverable:(await store.list('datasets')).length};
  });
  await check("source deletion returns exact closure, invalidates immediately, delays bytes, resumes cleanup, recomputes surviving evidence",async()=>{
   const features=(await reader.query('SELECT feature_id FROM fs138.feature_inputs WHERE snapshot_id=$1 ORDER BY feature_id',[correction])).rows.map(r=>r.feature_id);
   const labels=(await reader.query('SELECT label_id FROM fs138.label_inputs WHERE snapshot_id=$1 ORDER BY label_id',[correction])).rows.map(r=>r.label_id);
   const datasets=(await reader.query('SELECT dataset_id FROM fs138.dataset_inputs WHERE snapshot_id=$1 ORDER BY dataset_id',[correction])).rows.map(r=>r.dataset_id);
   const key=(await reader.query('SELECT object_key FROM fs138.source_snapshots WHERE snapshot_id=$1',[correction])).rows[0].object_key;
   let captured:Awaited<ReturnType<typeof deleteSources>>|undefined;
   await assert.rejects(readDataset(reader,{...store,get:async address=>{
    const b=await store.get(address);captured=await deleteSources(writer,[correction],'synthetic source correction removal',1);return b;
   }},datasets[0]),/current-rights-or-status/);
   assert(captured);const receipt=captured;
   assert.deepEqual(receipt.feature_ids,features);assert.deepEqual(receipt.label_ids,labels);assert.deepEqual(receipt.dataset_ids,datasets);
   assert(features.length>0&&labels.length>0&&datasets.length>0);
   assert(await store.head(key));assert.deepEqual((await cleanupDeletedObjects(writer,store)).removed,[]);
   await assert.rejects(readDataset(reader,store,datasets[0]),/current-rights/);
   assert.equal((await reader.query('SELECT count(*)::integer AS n FROM fs138.norm_player_game_stats WHERE snapshot_id=$1',[correction])).rows[0].n,0);
   await admin.query('SELECT pg_sleep(1.1)');
   let calls=0;
   await assert.rejects(cleanupDeletedObjects(writer,{...store,delete:async address=>{await store.delete(address);calls++;throw new Error('synthetic-crash-after-delete');}}),/synthetic-crash/);
   assert.equal(calls,1);
   const cleanup=await cleanupDeletedObjects(writer,store);assert(cleanup.removed.includes(key));assert.equal(await store.head(key),null);
   await derive();const now=await clock();const rebuilt=await buildDataset(writer,store,{...spec,featuresAsOf:now,labelsAsOf:now},code);
   const rows=JSON.parse((await readDataset(reader,store,rebuilt.datasetId)).toString()).rows;
   assert.equal(rows.find((r:{season:number})=>r.season===2022).label,250);assert.notEqual(rebuilt.fileSha256,first.fileSha256);
   assert.equal((await reader.query('SELECT count(*)::integer AS n FROM fs138.dataset_inputs WHERE dataset_id=$1 AND snapshot_id=$2',[rebuilt.datasetId,correction])).rows[0].n,0);
   return {receipt,cleanup,recomputed:{datasetId:rebuilt.datasetId,fileSha256:rebuilt.fileSha256,rows:rebuilt.rowCount,correctedLabel:250}};
  });
  await check("orphan cleanup honors grace and publication locks; temp housekeeping preserves final objects",async()=>{
   const bytes=Buffer.from('synthetic-orphan'),key=objectKey('raw',bytes);await store.putIfAbsent(key,bytes);
   assert(!(await sweepOrphanObjects(writer,store,1)).removed.includes(key));
   await admin.query('SELECT pg_sleep(1.1)');assert((await sweepOrphanObjects(writer,store,1)).removed.includes(key));
   const protectedKey=(await reader.query('SELECT object_key FROM fs138.source_snapshots WHERE snapshot_id=$1',[snapshots.schedule])).rows[0].object_key;
   assert(!(await sweepOrphanObjects(writer,store,0)).removed.includes(protectedKey));assert(await store.head(protectedKey));
   const pendingKey=objectKey('raw',Buffer.from('pending-publication'));await store.putIfAbsent(pendingKey,Buffer.from('pending-publication'));
   await writer.query('BEGIN');await writer.query('SELECT fs138.lock_object_for_publication($1)',[pendingKey]);
   const other=await openWriter();const cleanup=sweepOrphanObjects(other,store,0);
   let waiting=false;for(let n=0;n<50;n++){
    if((await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS waiting")).rows[0].waiting){waiting=true;break;}
    await admin.query('SELECT pg_sleep(0.01)');
   }
   await writer.query('COMMIT');await cleanup;assert(waiting);
   const temporary=join(root,'raw','.put-00000000-0000-0000-0000-000000000000.tmp');await writeFile(temporary,'stale temp',{mode:0o600});
   await utimes(temporary,new Date('2021-01-01'),new Date('2021-01-01'));
   assert.equal((await store.cleanupTemporary!(1)).length,1);assert(await store.head(protectedKey));
   return {orphanGraceSeconds:1,publicationWaitObserved:true,committedFinalPreserved:true,agedTemporaryRemoved:true};
  });
  await check("publication and deletion serialize on input rows; reads hold no blocking locks",async()=>{
   const other=await openWriter();
   await writer.query('BEGIN');await writer.query('SELECT fs138.lock_active_snapshots($1::uuid[])',[[snapshots.stats]]);
   const pending=deleteSources(other,[snapshots.stats],'synthetic concurrent source deletion',0);
   // Observe a real backend lock wait, not a timing-based guess.
   let waited=false;for(let i=0;i<50;i++){
    const row=(await admin.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND wait_event_type='Lock') AS waiting`)).rows[0];
    if(row.waiting){waited=true;break;}await admin.query('SELECT pg_sleep(0.01)');
   }
   await writer.query('COMMIT');const receipt=await pending;assert(waited);
   await assert.rejects(writer.query('SELECT fs138.lock_active_snapshots($1::uuid[])',[[snapshots.stats]]),/source-deleted/);
   return {observedWriterWait:true,subsequentPublicationRefused:true,eventId:receipt.event_id};
  });
  await check("shared bytes survive one deletion and the last deletion starts its own grace",async()=>{
   const bytes=Buffer.from('standalone-shared-object'),key=objectKey('raw',bytes),hash=sha256(bytes);
   await store.putIfAbsent(key,bytes);
   const ids:string[]=[];
   for(const profile of ['shared-a','shared-b']){
    await writer.query(`INSERT INTO fs138.source_profiles(profile_id,provider,feed,parser_version,license) VALUES($1,'synthetic','stats',$2,'{}')`,[profile,NORMALIZER_VERSION]);
    ids.push((await writer.query(`INSERT INTO fs138.source_snapshots(profile_id,job_id,sha256,byte_size,object_key,media_type,decoded_sha256,header_sha256,row_count,captured_at,available_at,evidence_basis)
     VALUES($1,$2,$3,$4,$5,'text/csv',$3,$3,0,'2021-01-01','2021-01-01','retrospective') RETURNING snapshot_id`,[profile,job.jobId,hash,bytes.length,key])).rows[0].snapshot_id);
   }
   await deleteSources(writer,[ids[0]],'synthetic first shared deletion',0);
   const firstCleanup=await cleanupDeletedObjects(writer,store);assert(firstCleanup.shared.includes(key));assert(await store.head(key));
   const sharedAttempt=(await reader.query('SELECT completed_at,outcome,event_id FROM fs138.object_removals WHERE object_key=$1',[key])).rows[0];
   assert(sharedAttempt.completed_at);assert.equal(sharedAttempt.outcome,'shared-retained');
   const lastDeletion=await deleteSources(writer,[ids[1]],'synthetic last shared deletion',1);
   const rearmed=(await reader.query('SELECT completed_at,outcome,event_id,remove_after>clock_timestamp() AS grace FROM fs138.object_removals WHERE object_key=$1',[key])).rows[0];
   assert.equal(rearmed.completed_at,null);assert.equal(rearmed.outcome,null);assert.equal(rearmed.event_id,lastDeletion.event_id);
   assert.notEqual(rearmed.event_id,sharedAttempt.event_id);assert.equal(rearmed.grace,true);
   assert(!(await cleanupDeletedObjects(writer,store)).removed.includes(key));assert(await store.head(key));
   await admin.query('SELECT pg_sleep(1.1)');assert((await cleanupDeletedObjects(writer,store)).removed.includes(key));assert.equal(await store.head(key),null);
   return {sharedReferencePreserved:true,latestGraceEnforced:true};
  });
 });}finally{
  await rm(root,{recursive:true,force:true});
  if(process.env.FEATURE_STORE_EVIDENCE_PATH)await writeFile(process.env.FEATURE_STORE_EVIDENCE_PATH,JSON.stringify({issue:138,step:5,recordedAt:new Date().toISOString(),fixture:'synthetic only; not an observed source correction',codeHashes,verdict:probes.length===14&&probes.every(p=>p.verdict==='pass')?'pass':'fail',probes},null,2)+'\n');
 }
});
