import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpath, mkdtemp, readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { cleanupDeletedObjectsWithRecovery } from "@dfs-ev/pipeline/feature-store/governance";
import { governanceFixture, governanceIdentity } from "./artifact-governance-fixture.ts";
import { cleanerTrace } from "./artifact-cleaner-work.ts";

test("#229 Step 2: completion scheduling, bounded revisits and final retirement",{timeout:120_000},async t=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(), '229-step2-'))),store=await openLocalObjectStore(directory);
 try{await withFeatureStoreDatabase(async({admin,writer,reader})=>{
  for(const name of ['165_model_manifests.sql','166_artifact_governance.sql'])
   await admin.query(await readFile(new URL(import.meta.resolve(`@dfs-ev/db/assets/${name}`)),'utf8'));
  const fixture=governanceFixture(writer,store);
  const event=(await admin.query(`INSERT INTO fs138.deletion_events(reason,grace_seconds,snapshot_ids,feature_ids,label_ids,dataset_ids)
   VALUES('229 recovery controls',0,'{}','{}','{}','{}') RETURNING event_id`)).rows[0].event_id;
  const queue=async(key:string)=>admin.query(`INSERT INTO fs138.object_removals(object_key,event_id,remove_after)
   VALUES($1,$2,clock_timestamp()-interval '1 second')`,[key,event]);
  await admin.query(await readFile(new URL(import.meta.resolve('@dfs-ev/db/assets/229_mandatory_recovery.sql')),'utf8'));
  const state=async(key:string)=>(await admin.query('SELECT * FROM fs138.object_removals WHERE object_key=$1',[key])).rows[0];
  const clock=async()=>(await admin.query('SELECT clock_timestamp() now')).rows[0].now as Date;
  const due=async(key:string)=>admin.query("UPDATE fs138.object_removals SET recovery_due=clock_timestamp()-interval '1 second' WHERE object_key=$1",[key]);
  const maintenance=async()=>{const trace=cleanerTrace(writer,store);const result=await cleanupDeletedObjectsWithRecovery(trace.client,trace.store);
   assert.deepEqual(trace.work,{gets:0,heads:0,puts:0,lists:0});return {trace,result};};
  await t.test('unqueued observations are never scanned/adopted by maintenance; queue-time trigger handles new intents',async()=>{
   const object=await fixture.persist('audits',{unqueued:randomUUID()});await writer.query('SELECT fs138.enroll_model_objects($1)',[[object.objectKey]]);
   const {trace,result}=await maintenance();assert.deepEqual(result,{removed:[],shared:[],recovered:[],deferred:[]});assert.equal(trace.statements.length,2);
   assert.equal((await admin.query('SELECT count(*)::int n FROM fs138.orphan_observations WHERE object_key=$1',[object.objectKey])).rows[0].n,1);
   await admin.query("UPDATE fs138.orphan_observations SET first_seen=clock_timestamp()-interval '10 minutes' WHERE object_key=$1",[object.objectKey]);await queue(object.objectKey);
   assert.equal((await admin.query('SELECT count(*)::int n FROM fs138.orphan_observations WHERE object_key=$1',[object.objectKey])).rows[0].n,0);
   assert((await state(object.objectKey)).recovery_until);await maintenance();assert.equal(await store.head(object.objectKey),null);
  });
  let removed:string,shared:string,removedBytes:Buffer;
  await t.test('ordinary removed acknowledgement starts 60-second backoff',async()=>{
   const value={normal:randomUUID()};removedBytes=Buffer.from(JSON.stringify(value)+'\n');const object=await fixture.persist('audits',value);removed=object.objectKey;
   await admin.query("INSERT INTO fs138.orphan_observations VALUES($1,clock_timestamp()-interval '10 minutes')",[removed]);await queue(removed);
   const before=await clock(),{trace,result}=await maintenance(),after=await clock();const row=await state(removed);
   assert(result.removed.includes(removed));assert.equal(row.outcome,'removed');assert.equal(row.recovery_step,1);
   assert(+row.recovery_due>=+before+60_000&&+row.recovery_due<=+after+60_000);assert.equal(await store.head(removed),null);
   assert.equal(trace.statements.length,6);assert.equal(trace.deletes.length,1); // 2 page selects + 4 candidate statements.
  });
  await t.test('shared-retained completion also starts 60-second backoff without deleting live bytes',async()=>{
   const source=await fixture.source(),data=await fixture.dataset([source.snapshot]),objects=await fixture.objects([data]);
   await writer.query('SELECT * FROM fs138.publish_model_run($1,$2)',[governanceIdentity,JSON.stringify(objects)]);shared=objects[1].objectKey;
   await admin.query("INSERT INTO fs138.orphan_observations VALUES($1,clock_timestamp()-interval '10 minutes')",[shared]);await queue(shared);
   const before=await clock(),{trace,result}=await maintenance(),after=await clock(),row=await state(shared);
   assert(result.shared.includes(shared));assert.equal(row.outcome,'shared-retained');assert.equal(row.recovery_step,1);
   assert(+row.recovery_due>=+before+60_000&&+row.recovery_due<=+after+60_000);assert(await store.head(shared));
   assert.equal(trace.statements.length,5);assert.equal(trace.deletes.length,0);
  });
  await t.test('committed revisits double through 120/240/480/960/1920 seconds, cap at one hour and never reset horizon',async()=>{
   const horizon=+(await state(removed)).recovery_until;
   for(const seconds of [120,240,480,960,1920,3600,3600]){
    await due(removed);const before=await clock(),{trace,result}=await maintenance(),after=await clock(),row=await state(removed);
    assert(result.recovered.includes(removed));assert.equal(+row.recovery_until,horizon);
    assert(+row.recovery_due>=+before+seconds*1000&&+row.recovery_due<=+after+seconds*1000);
    assert.equal(trace.statements.length,6);assert.equal(trace.deletes.length,1);
   }
  });
  await t.test('shared revisits advance the same backoff and expired shared metadata retires without DELETE',async()=>{
   await due(shared);const {result,trace}=await maintenance();assert(result.deferred.includes(shared));
   assert.equal((await state(shared)).recovery_step,2);assert.equal(trace.deletes.length,0);assert.equal(trace.statements.length,5);
   await admin.query("UPDATE fs138.object_removals SET recovery_until=clock_timestamp()-interval '1 second',recovery_due=clock_timestamp()-interval '1 second' WHERE object_key=$1",[shared]);
   await maintenance();const row=await state(shared);assert.equal(row.recovery_until,null);assert.equal(row.recovery_due,null);assert.equal(row.outcome,'shared-retained');assert(await store.head(shared));
  });
  await t.test('next due clips exactly to the horizon, including a delayed final worker',async()=>{
   await admin.query("UPDATE fs138.object_removals SET recovery_until=clock_timestamp()+interval '30 seconds',recovery_due=clock_timestamp()-interval '1 second' WHERE object_key=$1",[removed]);
   await maintenance();let row=await state(removed);assert.equal(+row.recovery_due,+row.recovery_until);assert(row.recovery_until);
   await admin.query("UPDATE fs138.object_removals SET recovery_until=clock_timestamp()-interval '1 second',recovery_due=clock_timestamp()-interval '1 second' WHERE object_key=$1",[removed]);
   // Re-create bytes after completion: a delayed in-flight PUT, not new enrollment.
   await store.putIfAbsent(removed,removedBytes);assert(await store.head(removed));
   const {result}=await maintenance();assert.equal(await store.head(removed),null);assert(result.recovered.includes(removed));row=await state(removed);
   assert.equal(row.recovery_until,null);assert.equal(row.recovery_due,null);assert.equal(row.recovery_step,0);assert.equal(row.outcome,'removed');assert(row.completed_at);
   await assert.rejects(writer.query('SELECT fs138.enroll_model_objects($1)',[[removed]]),{code:'P1662'});
  });
  await t.test('late PUT is reclaimed; unlink followed by lost response leaves backoff unchanged until retry commits',async()=>{
   const value={latePut:randomUUID()},object=await fixture.persist('audits',value),key=object.objectKey;
   await store.delete(key);await admin.query("INSERT INTO fs138.orphan_observations VALUES($1,clock_timestamp()-interval '10 minutes')",[key]);await queue(key);await maintenance();
   const prior=await state(key);await due(key);const before=await state(key);await store.putIfAbsent(key,Buffer.from(JSON.stringify(value)+'\n'));
   const failing={...store,delete:async(address:string)=>{await store.delete(address);throw new Error('simulated lost DELETE response');}};
   await assert.rejects(cleanupDeletedObjectsWithRecovery(writer,failing),/simulated lost DELETE response/);
   assert.equal(await store.head(key),null);assert.equal((await state(key)).recovery_step,before.recovery_step);assert.equal(+(await state(key)).recovery_due,+before.recovery_due);
   const {result}=await maintenance();assert(result.recovered.includes(key));assert.equal((await state(key)).recovery_step,prior.recovery_step+1);
  });
  await t.test('pending runs first; two full 1024 pages cost 8194 statements and both remaining rows progress',async()=>{
   const keys=Array.from({length:1025},(_,i)=>`audits/${i.toString(16).padStart(64,'0')}`);
   const pending=Array.from({length:1025},(_,i)=>`models/${i.toString(16).padStart(64,'0')}`);
   await admin.query("INSERT INTO fs138.object_removals(object_key,event_id,remove_after) SELECT key,$2,clock_timestamp()-interval '1 second' FROM unnest($1::text[]) key",[pending,event]);
   await admin.query(`INSERT INTO fs138.object_removals(object_key,event_id,remove_after,completed_at,outcome,recovery_until,recovery_due,recovery_step)
    SELECT key,$2,clock_timestamp()-interval '1 minute',clock_timestamp(),'removed',clock_timestamp()+interval '1 hour',clock_timestamp()-interval '1 second',1
    FROM unnest($1::text[]) key`,[keys,event]);
   const first=await maintenance();assert.equal(first.result.recovered.length,1024);assert.equal(first.result.removed.length,1024);assert.equal(first.trace.statements.length,8194);assert.equal(first.trace.deletes.length,2048);
   assert.match(first.trace.statements[4097],/ORDER BY r.recovery_due,r.object_key/);
   assert(first.trace.deletes.slice(0,1024).every(key=>key.startsWith('models/')));
   const second=await maintenance();assert.equal(second.result.recovered.length,1);assert.equal(second.result.removed.length,1);assert.equal(second.trace.statements.length,10);
  });
  await t.test('restricted reader and direct private scheduling calls cannot bypass recovery authorization',async()=>{
   for(const fn of ['recovery_removal_recheck','ack_recovery_removal'])await assert.rejects(reader.query(`SELECT fs138.${fn}($1)`,[removed]),{code:'42501'});
   await assert.rejects(writer.query('SELECT fs138.schedule_removal_recovery($1,true)',[removed]),{code:'42501'});
   for(const key of [null,'audits/bad',`raw/${'a'.repeat(64)}`])await assert.rejects(writer.query('SELECT fs138.recovery_removal_recheck($1)',[key]),{code:'23514'});
   await assert.rejects(writer.query('SELECT fs138.ack_recovery_removal($1)',[`audits/${'f'.repeat(64)}`]),{code:'23514'});
  });
 });}finally{await rm(directory,{recursive:true,force:true});}
});
