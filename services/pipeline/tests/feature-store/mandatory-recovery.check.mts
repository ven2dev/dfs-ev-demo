import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { discardUnpublishedReport, deleteDatasets } from "@dfs-ev/pipeline/feature-store/governance";
import { governanceFixture, governanceIdentity } from "./artifact-governance-fixture.ts";
import { waitForCleanerLock } from "./artifact-cleaner-work.ts";

test("#229 Step 1: mandatory ownership handoff and cleaner deferral", {timeout:120_000}, async t => {
 const directory=await mkdtemp("/private/tmp/229-step1-");const store=await openLocalObjectStore(directory);
 try {await withFeatureStoreDatabase(async ({admin,writer,reader,openWriter}) => {
  for(const name of ["165_model_manifests.sql","166_artifact_governance.sql"])
   await admin.query(await readFile(new URL(import.meta.resolve(`@dfs-ev/db/assets/${name}`)),"utf8"));
  const fixture=governanceFixture(writer,store);
  const event=(await admin.query(`INSERT INTO fs138.deletion_events(reason,grace_seconds,snapshot_ids,feature_ids,label_ids,dataset_ids)
   VALUES('229 synthetic queue controls',0,'{}','{}','{}','{}') RETURNING event_id`)).rows[0].event_id;
  const enrolled=async(key:string)=>writer.query("SELECT fs138.enroll_model_objects($1)",[[key]]);
  const queue=async(key:string)=>admin.query(`INSERT INTO fs138.object_removals(object_key,event_id,remove_after)
   VALUES($1,$2,clock_timestamp()-interval '1 second') ON CONFLICT(object_key) DO UPDATE SET event_id=excluded.event_id,completed_at=NULL,outcome=NULL`,[key,event]);
  const state=async(key:string)=>(await admin.query("SELECT * FROM fs138.object_removals WHERE object_key=$1",[key])).rows[0];
  const observation=async(key:string)=>(await admin.query("SELECT first_seen FROM fs138.orphan_observations WHERE object_key=$1",[key])).rows[0];
  const old=await fixture.persist("audits",{oldCompleted:randomUUID()});await enrolled(old.objectKey);await queue(old.objectKey);
  await admin.query("UPDATE fs138.object_removals SET completed_at=clock_timestamp(),outcome='removed' WHERE object_key=$1",[old.objectKey]);
  await admin.query(await readFile(new URL(import.meta.resolve("@dfs-ev/db/assets/229_mandatory_recovery.sql")),"utf8"));
  await t.test("queue INSERT and UPSERT transfer the precise horizon and preserve both grace deadlines",async()=>{
   for(const conflict of [false,true]){
    const object=await fixture.persist("audits",{conflict,id:randomUUID()});if(conflict)await queue(object.objectKey);
    // Trusted admin fixture models an enrollment recorded before an existing intent.
    await admin.query("INSERT INTO fs138.orphan_observations VALUES($1,clock_timestamp())",[object.objectKey]);
    const before=await observation(object.objectKey);
    await queue(object.objectKey);const row=await state(object.objectKey);
    assert.equal(+row.recovery_until,+before.first_seen+86400000);assert(row.remove_after>Date.now());assert.equal(await observation(object.objectKey),undefined);
    assert.equal((await writer.query("SELECT fs138.removal_recheck($1) ok",[object.objectKey])).rows[0].ok,false);
    const first=await state(object.objectKey);await queue(object.objectKey);assert.equal(+(await state(object.objectKey)).recovery_until,+first.recovery_until);
    await assert.rejects(writer.query("SELECT fs138.enroll_model_objects($1)",[[object.objectKey]]),{code:"P1662"});
   }
  });
  await t.test("handoff rolls back with the queue intent, without losing its observation",async()=>{
   const object=await fixture.persist("models",{rollback:randomUUID()});await enrolled(object.objectKey);
   await admin.query("BEGIN");await queue(object.objectKey);assert.equal(await observation(object.objectKey),undefined);await admin.query("ROLLBACK");
   assert.equal(await state(object.objectKey),undefined);assert(await observation(object.objectKey));
  });
  await t.test("old completed rows adopt lazily; repeat events preserve horizon/backoff and never clear tombstones",async()=>{
   assert.equal((await writer.query("SELECT fs138.adopt_removal_observation($1) ok",[old.objectKey])).rows[0].ok,true);
   assert.equal(await observation(old.objectKey),undefined);let row=await state(old.objectKey);assert(row.completed_at);assert(row.recovery_due);
   await admin.query("UPDATE fs138.object_removals SET recovery_step=5,recovery_due=clock_timestamp()+interval '30 minutes' WHERE object_key=$1",[old.objectKey]);
   row=await state(old.objectKey);await queue(old.objectKey);const repeated=await state(old.objectKey);
   assert.equal(repeated.recovery_step,5);assert.equal(+repeated.recovery_due,+row.recovery_due);assert.equal(+repeated.recovery_until,+row.recovery_until);
   assert.equal((await writer.query("SELECT fs138.adopt_removal_observation($1) ok",[old.objectKey])).rows[0].ok,false);
   await writer.query("SELECT fs138.requeue_removed_object($1)",[old.objectKey]);assert.equal(+(await state(old.objectKey)).recovery_until,+row.recovery_until);
  });
  await t.test("the real dataset-deletion entry point adopts observations while retaining its longer grace",async()=>{
   const source=await fixture.source(),data=await fixture.dataset([source.snapshot]);const objects=await fixture.objects([data]);
   await writer.query("SELECT * FROM fs138.publish_model_run($1,$2)",[governanceIdentity,JSON.stringify(objects)]);
   const key=objects[1].objectKey;await admin.query("INSERT INTO fs138.orphan_observations VALUES($1,clock_timestamp()-interval '10 minutes')",[key]);
   const receipt=await deleteDatasets(writer,[data.datasetId],"229 handoff",3600);assert(receipt.event_id);
   const row=await state(key);assert(row.recovery_until);assert(row.remove_after>new Date(Date.now()+3500_000));assert.equal(await observation(key),undefined);
   assert.equal((await writer.query("SELECT fs138.removal_recheck($1) ok",[key])).rows[0].ok,false);
  });
  await t.test("adoption does not authorize deleting an artifact still referenced by a live model",async()=>{
   const source=await fixture.source(),data=await fixture.dataset([source.snapshot]);const objects=await fixture.objects([data]);
   await writer.query("SELECT * FROM fs138.publish_model_run($1,$2)",[governanceIdentity,JSON.stringify(objects)]);
   const key=objects[1].objectKey;
   await admin.query("INSERT INTO fs138.orphan_observations VALUES($1,clock_timestamp()-interval '10 minutes')",[key]);
   await queue(key);assert((await state(key)).recovery_until);
   assert.equal((await writer.query("SELECT fs138.removal_recheck($1) ok",[key])).rows[0].ok,false);
   assert.equal((await state(key)).outcome,"shared-retained");assert(await store.head(key));
  });
  await t.test("orphan deletion and observation retirement defer to mandatory ownership",async()=>{
   assert.equal((await writer.query("SELECT fs138.orphan_recheck($1,0) ok",[old.objectKey])).rows[0].ok,false);
   // An unexpected surviving observation is retained for adoption, never discarded.
   await admin.query("INSERT INTO fs138.orphan_observations VALUES($1,clock_timestamp()-interval '2 days')",[old.objectKey]);
   assert.equal((await writer.query("SELECT fs138.retire_model_observation($1,86400) ok",[old.objectKey])).rows[0].ok,false);
   assert(await observation(old.objectKey));await writer.query("SELECT fs138.adopt_removal_observation($1)",[old.objectKey]);
  });
  await t.test("#164 cleanup re-reads ownership after waiting behind handoff and leaves bytes intact",async()=>{
   const object=await fixture.persist("audits",{discard:randomUUID()});await enrolled(object.objectKey);const cleaner=await openWriter();
   const pid=(await cleaner.query("SELECT pg_backend_pid() pid")).rows[0].pid;
   await admin.query("BEGIN");await queue(object.objectKey);
   const pending=discardUnpublishedReport(cleaner,store,object.objectKey);
   try {await waitForCleanerLock(admin,pid);} finally {await admin.query("COMMIT");}await pending;assert(await store.head(object.objectKey));
  });
  await t.test("both common-lock orders serialize orphan recheck and adoption",async()=>{
   for(const handoffFirst of [false,true]){
    const object=await fixture.persist("audits",{handoffFirst,id:randomUUID()});
    // Model an old row with an observation to test the lazy-adoption lock order.
    await queue(object.objectKey);await admin.query("INSERT INTO fs138.orphan_observations VALUES($1,clock_timestamp()-interval '10 minutes')",[object.objectKey]);
    const other=await openWriter();const pid=(await other.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await writer.query("BEGIN");
    if(handoffFirst)await writer.query("SELECT fs138.adopt_removal_observation($1)",[object.objectKey]);
    else await writer.query("SELECT fs138.orphan_recheck($1,0)",[object.objectKey]);
    const pending=other.query(handoffFirst?"SELECT fs138.orphan_recheck($1,0) ok":"SELECT fs138.adopt_removal_observation($1) ok",[object.objectKey]);
    await waitForCleanerLock(admin,pid);await writer.query("COMMIT");const result=(await pending).rows[0];assert.equal(result.ok,!handoffFirst);
    assert.equal(await observation(object.objectKey),undefined);
   }
  });
  await t.test("restricted LOGINs cannot bypass handoff validation or mutate queue state",async()=>{
   await assert.rejects(reader.query("SELECT fs138.adopt_removal_observation($1)",[old.objectKey]),{code:"42501"});
   await assert.rejects(writer.query("UPDATE fs138.object_removals SET recovery_until=NULL"),{code:"42501"});
   for(const key of [null,"audits/bad",`raw/${"a".repeat(64)}`])await assert.rejects(writer.query("SELECT fs138.adopt_removal_observation($1)",[key]),{code:"23514"});
   assert.equal((await writer.query("SELECT fs138.adopt_removal_observation($1) ok",[`audits/${"e".repeat(64)}`])).rows[0].ok,false);
   const acl=(await admin.query(`SELECT has_function_privilege('public','fs138.adopt_removal_observation(text)','execute') granted`)).rows[0];assert.equal(acl.granted,false);
  });
 });} finally {await rm(directory,{recursive:true,force:true});}
});
