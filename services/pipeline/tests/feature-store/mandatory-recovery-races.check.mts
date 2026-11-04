import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { realpath, mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { test } from 'node:test';
import { withFeatureStoreDatabase } from '../../scripts/feature-store/harness.ts';
import { openLocalObjectStore } from '../../src/featureStore/localObjectStore.ts';
import { sha256 } from '../../src/featureStore/objectStore.ts';
import { cleanupDeletedObjectsWithRecovery,deleteDatasets } from '@dfs-ev/pipeline/feature-store/governance';
import { governanceFixture,governanceIdentity,governanceExamples } from './artifact-governance-fixture.ts';
import { waitForCleanerLock,cleanerTrace } from './artifact-cleaner-work.ts';
import { readCounterDelta,deterministicReadWork,type ReadCounters } from './artifact-read-work.ts';

const probes:{name:string;details:unknown}[]=[];
test('#229 Step 3: late PUT handoff, interruption, lock races and hidden work',{timeout:120_000},async t=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(), '229-step3-'))),store=await openLocalObjectStore(directory);
 try{await withFeatureStoreDatabase(async({admin,writer,openWriter})=>{
  for(const name of ['165_model_manifests.sql','166_artifact_governance.sql','229_mandatory_recovery.sql'])
   await admin.query(await readFile(new URL(import.meta.resolve(`@dfs-ev/db/assets/${name}`)),'utf8'));
  const fixture=governanceFixture(writer,store);
  const event=(await admin.query(`INSERT INTO fs138.deletion_events(reason,grace_seconds,snapshot_ids,feature_ids,label_ids,dataset_ids)
   VALUES('229 synthetic interruption controls',0,'{}','{}','{}','{}') RETURNING event_id`)).rows[0].event_id;
  const queue=async(key:string)=>admin.query(`INSERT INTO fs138.object_removals(object_key,event_id,remove_after)
   VALUES($1,$2,clock_timestamp()-interval '1 second')`,[key,event]);
  const state=async(key:string)=>(await admin.query('SELECT * FROM fs138.object_removals WHERE object_key=$1',[key])).rows[0];
  const due=async(key:string)=>admin.query("UPDATE fs138.object_removals SET recovery_due=clock_timestamp()-interval '1 second' WHERE object_key=$1",[key]);
  const check=async(name:string,run:()=>Promise<unknown>)=>t.test(name,async()=>{probes.push({name,details:await run()});});
  await check('paused real PUT across handoff/completion is reclaimed even after its upload response is lost',async()=>{
   const results=[];
   for(const lost of [false,true]){
    const bytes=Buffer.from(JSON.stringify({lost,id:randomUUID()})+'\n'),key=`audits/${sha256(bytes)}`;
    await writer.query('SELECT fs138.enroll_model_objects($1)',[[key]]);
    const started=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>();
    const putting=(async()=>{started.resolve();await resume.promise;await store.putIfAbsent(key,bytes);if(lost)throw Error('upload response lost');})()
     .then(()=>({lost:false}),error=>({lost:true,error}));
    await started.promise;
    // Scheduling metadata only is aged; producer/knowledge clocks are never forged.
    await admin.query("UPDATE fs138.orphan_observations SET first_seen=clock_timestamp()-interval '10 minutes' WHERE object_key=$1",[key]);
    try{
     await queue(key);await cleanupDeletedObjectsWithRecovery(writer,store);const completed=await state(key);
     assert.equal(completed.outcome,'removed');assert(completed.recovery_until);assert.equal(await store.head(key),null);
    }finally{resume.resolve();}
    assert.equal((await putting).lost,lost);assert(await store.head(key));await due(key);
    const result=await cleanupDeletedObjectsWithRecovery(writer,store);assert(result.recovered.includes(key));assert.equal(await store.head(key),null);
    const source=await fixture.source(),data=await fixture.dataset([source.snapshot]);const objects=await fixture.objects([data],[{objectKey:key,sha256:sha256(bytes),byteSize:bytes.length}]);
    await assert.rejects(writer.query('SELECT * FROM fs138.publish_model_run($1,$2)',[governanceIdentity,JSON.stringify(objects)]),{code:'P1662'});
    results.push({lostUploadResponse:lost,completedWhilePutPaused:true,mandatoryOwnerReclaimed:true,publicationRefused:'P1662'});
   }
   return results;
  });
  await check('unlink-before-ack exception/disconnect and lost COMMIT use fresh connections without skipping or repeating a committed revisit',async()=>{
   const results=[];
   for(const failure of ['exception','disconnect','lost-commit'] as const){
    const bytes=Buffer.from(JSON.stringify({failure,id:randomUUID()})+'\n'),key=`audits/${sha256(bytes)}`;
    await store.putIfAbsent(key,bytes);await writer.query('SELECT fs138.enroll_model_objects($1)',[[key]]);
    await admin.query("UPDATE fs138.orphan_observations SET first_seen=clock_timestamp()-interval '10 minutes' WHERE object_key=$1",[key]);
    await queue(key);await cleanupDeletedObjectsWithRecovery(writer,store);await due(key);await store.putIfAbsent(key,bytes);
    const before=await state(key),cleaner=await openWriter();cleaner.on('error',()=>{});const pid=(await cleaner.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const calls:string[]=[];
    const connection=new Proxy(cleaner,{get(target,property){if(property!=='query')return Reflect.get(target,property,target);return async(...args:unknown[])=>{
     const sql=String(args[0]);calls.push(sql);const result=await Reflect.apply(target.query,target,args);
     if(failure==='lost-commit'&&sql==='COMMIT'){await target.end();throw Object.assign(Error('commit reply lost'),{code:'ECONNRESET'});}return result;
    };}});
    const failing={...store,delete:async(address:string)=>{await store.delete(address);if(failure==='disconnect'){await admin.query('SELECT pg_terminate_backend($1)',[pid]);throw Error('Connection terminated');}if(failure==='exception')throw Error('crash after recovery unlink');}};
    await assert.rejects(cleanupDeletedObjectsWithRecovery(connection,failing),failure==='exception'?/crash after recovery unlink/:/cleanup-connection-interrupted-replace/);
    const after=await state(key);assert.equal(await store.head(key),null);assert.equal(+after.recovery_until,+before.recovery_until);
    assert.equal(calls.includes('ROLLBACK'),failure==='exception');
    const fresh=await openWriter(),trace=cleanerTrace(fresh,store);await cleanupDeletedObjectsWithRecovery(trace.client,trace.store);
    if(failure==='lost-commit'){assert.equal(after.recovery_step,before.recovery_step+1);assert.equal(trace.deletes.length,0);}
    else{assert.equal(after.recovery_step,before.recovery_step);assert.equal(+after.recovery_due,+before.recovery_due);assert(trace.deletes.includes(key));}
    results.push({failure,rollback:calls.includes('ROLLBACK'),retryDeletes:trace.deletes.length,horizonPreserved:true});
   }
   return results;
  });
  await check('both lock orders serialize recovery against a repeated real deletion event and preserve longer grace',async()=>{
   const results=[];
   for(const recoveryFirst of [false,true]){
    const source=await fixture.source(),data=await fixture.dataset([source.snapshot]),objects=await fixture.objects([data]);
    await writer.query('SELECT * FROM fs138.publish_model_run($1,$2)',[governanceIdentity,JSON.stringify(objects)]);const key=objects[1].objectKey;
    await admin.query("INSERT INTO fs138.orphan_observations VALUES($1,clock_timestamp()-interval '10 minutes')",[key]);
    await deleteDatasets(writer,[data.datasetId],'initial removal',0);await cleanupDeletedObjectsWithRecovery(writer,store);await due(key);const before=await state(key);
    const other=await openWriter(),pid=(await other.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    if(recoveryFirst){
     const paused=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>();
     const cleaning=cleanupDeletedObjectsWithRecovery(writer,{...store,delete:async address=>{if(address===key){paused.resolve();await resume.promise;}await store.delete(address);}})
      .then(value=>({value,error:undefined}),error=>({value:undefined,error}));
     await Promise.race([paused.promise,cleaning.then(r=>{throw r.error??Error('failed to pause recovery');})]);
     const deleting=deleteDatasets(other,[data.datasetId],'longer repeated grace',3600).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
     try{await waitForCleanerLock(admin,pid);}finally{resume.resolve();}
     const cleaned=await cleaning;if(cleaned.error)throw cleaned.error;const deleted=await deleting;if(deleted.error)throw deleted.error;
    }else{
     await writer.query('BEGIN');await deleteDatasets(writer,[data.datasetId],'deletion wins before recovery',3600);
     const pending=cleanupDeletedObjectsWithRecovery(other,store).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
     try{await waitForCleanerLock(admin,pid);}finally{await writer.query('COMMIT');}
     const result=await pending;if(result.error)throw result.error;assert.equal(result.value?.recovered.length,0);
    }
    const after=await state(key);assert.equal(+after.recovery_until,+before.recovery_until);assert.equal(after.completed_at,null);assert(after.remove_after>new Date(Date.now()+3500_000));
    results.push({recoveryFirst,actualLockWait:true,horizonPreserved:true,longerGracePreserved:true});
   }
   return results;
  });
  await check('#174 mixed page progress: 1025 unqueued observations, 1025 live shared references and a later removable target',async()=>{
   // Independent queue-control cohort; no production tombstones are altered.
   await admin.query('TRUNCATE fs138.object_removals,fs138.orphan_observations');
   const source=await fixture.source(),data=await fixture.dataset([source.snapshot]);
   const observed=Array.from({length:1025},(_,n)=>'audits/'+n.toString(16).padStart(64,'0'));
   // These are ordinary in-flight/unswept addresses, never queued for removal.
   await admin.query("INSERT INTO fs138.orphan_observations SELECT key,clock_timestamp()-interval '10 minutes' FROM unnest($1::text[]) key",[observed]);
   const objects=[];const shared=[];
   for(let n=0;n<1025;n++){
    const report=await fixture.persist('audits',{shared:n,cohort:'229-'+event});shared.push(report.objectKey);
    const descriptor=sha256(Buffer.from('229-shared-descriptor-'+event+'-'+n));
    objects.push([{slot:'descriptor',datasetId:null,objectKey:'models/'+descriptor,fileSha256:descriptor,byteSize:1},
     {slot:data.mode,datasetId:data.datasetId,objectKey:report.objectKey,fileSha256:report.sha256,byteSize:report.byteSize}]);
   }
   assert(observed.at(-1)! < [...shared].sort()[0],'fixture lexical order must put observations before shared controls');
   // Bound enrollment/publication transactions too; avoid a fixture-only huge advisory-lock set.
   for(let start=0;start<objects.length;start+=256)await writer.query('SELECT fs138.publish_model_run($1,objects) FROM jsonb_array_elements($2) objects',[governanceIdentity,JSON.stringify(objects.slice(start,start+256))]);
   for(let start=0;start<shared.length;start+=512)await admin.query(`INSERT INTO fs138.object_removals(object_key,event_id,remove_after)
    SELECT key,$2,clock_timestamp()-interval '1 minute' FROM unnest($1::text[]) key`,[shared.slice(start,start+512),event]);
   const target=await fixture.persist('models',{afterAudits:randomUUID()});await queue(target.objectKey);
   const pages=[];
   for(let n=0;n<2;n++){const trace=cleanerTrace(writer,store),result=await cleanupDeletedObjectsWithRecovery(trace.client,trace.store);
    assert(trace.statements.length<=8194);assert.deepEqual(trace.work,{gets:0,heads:0,puts:0,lists:0});
    pages.push({pendingRemoved:result.removed.length,shared:result.shared.length,recovered:result.recovered.length,adoptedOrDeferred:result.deferred.length,statements:trace.statements.length,targetReached:result.removed.includes(target.objectKey)});
   }
   assert.equal(pages[0].shared,1024);assert.equal(pages[0].adoptedOrDeferred,0);
   assert.equal(pages[1].shared,1);assert.equal(pages[1].pendingRemoved,1);assert.equal(pages[1].adoptedOrDeferred,0);assert(pages[1].targetReached);
   assert.equal((await admin.query('SELECT count(*)::int n FROM fs138.orphan_observations WHERE object_key=ANY($1)',[observed])).rows[0].n,1025);
   assert.equal((await admin.query("SELECT count(*)::int n FROM fs138.object_removals WHERE object_key=ANY($1) AND outcome='shared-retained'",[shared])).rows[0].n,1025);
   for(const key of [shared[0],shared.at(-1)!])assert(await store.head(key));
   assert.equal(await store.head(target.objectKey),null);
   return {unqueuedObservations:1025,liveSharedReferences:1025,pages,ordinaryPendingProgress:true,sharedBytesPreserved:true};
  });
  await check('server work is independent of 0/2504 dataset members; definer scan/DML negative controls remain visible',async()=>{
   const counters=async(client:typeof writer):Promise<ReadCounters>=>(await client.query(`SELECT relname AS "table",seq_scan::int,seq_tup_read::int,coalesce(idx_scan,0)::int idx_scan,
    coalesce(idx_tup_fetch,0)::int idx_tup_fetch,n_tup_ins::int inserted,n_tup_upd::int updated,n_tup_del::int deleted
    FROM pg_stat_xact_user_tables WHERE schemaname='fs138' ORDER BY relname`)).rows;
   const assertWork=(delta:ReadCounters,updates:number)=>{for(const row of delta){
    assert.equal(row.inserted,0);assert.equal(row.deleted,0);assert.equal(row.updated,row.table==='object_removals'?updates:0);
    if(/^(dataset_members|feature_values|feature_inputs|outcome_labels|label_inputs|norm_)/.test(row.table))assert.equal(row.seq_scan+row.seq_tup_read+row.idx_scan+row.idx_tup_fetch,0,`${row.table}: hidden example work`);
   }};
   const measure=async(key:string,recovery:boolean,allowed:boolean,shared:boolean)=>{
    await writer.query('BEGIN');try{
     const before=await counters(writer);assert.equal((await writer.query(`SELECT fs138.${recovery?'recovery_removal_recheck':'removal_recheck'}($1) ok`,[key])).rows[0].ok,allowed);
     const checked=await counters(writer),recheck=readCounterDelta(before,checked);assertWork(recheck,shared?2:0);
     let ack:ReadCounters|undefined;if(allowed){await writer.query(`SELECT fs138.${recovery?'ack_recovery_removal':'ack_removal'}($1)`,[key]);ack=readCounterDelta(checked,await counters(writer));// The repeated event preserves an already-initialized due time: ack
      // writes completion once and does not reset the backoff.
      assertWork(ack,1);}
     return {recheck,ack};
    }finally{await writer.query('ROLLBACK');}
   };
   const source=await fixture.source(),rows=await governanceExamples(writer,source,2504),measurements=[];
   for(const size of [0,2504]){
    const data=await fixture.dataset([source.snapshot],'retrospective-reconstruction-v1',size?rows:[]),objects=await fixture.objects([data]);
    await writer.query('SELECT * FROM fs138.publish_model_run($1,$2)',[governanceIdentity,JSON.stringify(objects)]);const key=objects[1].objectKey;
    await admin.query("INSERT INTO fs138.orphan_observations VALUES($1,clock_timestamp()-interval '10 minutes')",[key]);await queue(key);
    const sharedPending=await measure(key,false,false,true);
    await admin.query("UPDATE fs138.object_removals SET completed_at=clock_timestamp(),outcome='shared-retained',recovery_due=clock_timestamp()-interval '1 second',recovery_step=1 WHERE object_key=$1",[key]);
    const sharedRecovery=await measure(key,true,false,true);
    await deleteDatasets(writer,[data.datasetId],'measure invalidated run',0);
    const pending=await measure(key,false,true,false);await cleanupDeletedObjectsWithRecovery(writer,store);await due(key);
    const recovery=await measure(key,true,true,false);
    measurements.push({members:size,sharedPending,sharedRecovery,pending,recovery});
   }
   for(const phase of ['sharedPending','sharedRecovery','pending','recovery'] as const)for(const boundary of ['recheck','ack'] as const){
    const first:ReadCounters|undefined=measurements[0][phase][boundary];const last:ReadCounters|undefined=measurements[1][phase][boundary];if(first&&last)assert.deepEqual(deterministicReadWork(first),deterministicReadWork(last));
   }
   await admin.query(`CREATE FUNCTION fs138.negative229_work(dml boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
    BEGIN IF dml THEN UPDATE fs138.object_removals SET recovery_step=recovery_step; ELSE PERFORM history FROM fs138.feature_values; END IF; END $$;
    REVOKE ALL ON FUNCTION fs138.negative229_work(boolean) FROM PUBLIC; GRANT EXECUTE ON FUNCTION fs138.negative229_work(boolean) TO fs138_pipeline_writer`);
   const negative=[];for(const dml of [false,true]){await writer.query('BEGIN');try{const before=await counters(writer);await writer.query('SELECT fs138.negative229_work($1)',[dml]);const delta=readCounterDelta(before,await counters(writer));assert.throws(()=>assertWork(delta,0));negative.push({dml,delta});}finally{await writer.query('ROLLBACK');}}
   return {measurements,negative,matchedDeterministicWork:true,measurementOnlyTransactionsNoObjectIO:true};
  });
 });}finally{await rm(directory,{recursive:true,force:true});}
 // node:test child failures do not throw from t.test; never emit a pass receipt
 // unless every probe actually reached its successful completion.
 assert.equal(probes.length,5,'all race/work probes must pass before evidence is emitted');
 if(process.env.FS229_RACE_EVIDENCE)await writeFile(process.env.FS229_RACE_EVIDENCE,JSON.stringify({issue:229,step:3,verdict:'pass',probes},null,2)+'\n',{flag:'wx'});
});
