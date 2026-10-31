import type { Client } from "pg";
import type { ObjectStore } from "./objectStore.ts";
import { connectionInterrupted } from "./connections.ts";

type Database = Pick<Client,"query">;

// Only the writer can inspect the model registry. A research report reader is
// never granted artifact access for cleanup. Use a dedicated idle connection.
export const discardUnpublishedReport = async (client:Database,store:ObjectStore,key:string) => {
 if(!/^audits\/[a-f0-9]{64}$/.test(key))throw new Error('report-cleanup-address-refused');
 try{
  await client.query('BEGIN');
  const {registry,writer}=(await client.query<{registry:boolean;writer:boolean}>(`SELECT
   pg_advisory_xact_lock(hashtextextended($1,138)),
   to_regclass('fs138.model_artifacts') IS NOT NULL AS registry,
   pg_has_role(session_user,'fs138_pipeline_writer','member') AS writer`,[key])).rows[0];
  if(!writer)throw new Error('report-cleanup-writer-required');
  const referenced=registry&&(await client.query<{referenced:boolean}>(
   'SELECT EXISTS(SELECT 1 FROM fs138.model_artifacts WHERE object_key=$1) AS referenced',[key])).rows[0].referenced;
  if(!referenced)await store.delete(key);
  await client.query('COMMIT');
 }catch(error){
  if(connectionInterrupted(error))throw new Error('report-cleanup-connection-interrupted-replace',{cause:error});
  try{await client.query('ROLLBACK');}
  catch(rollbackError){throw new Error('report-cleanup-connection-interrupted-replace',{cause:rollbackError});}
  throw error;
 }
};
export type DeletionReceipt = {event_id:string;recorded_at:Date;grace_seconds:number;
 snapshot_ids:string[];feature_ids:string[];label_ids:string[];dataset_ids:string[]};
export const deleteSources = async (client:Database,snapshotIds:string[],reason:string,graceSeconds=300):Promise<DeletionReceipt> =>
 (await client.query<DeletionReceipt>("SELECT * FROM fs138.delete_sources($1::uuid[],$2,$3)",[snapshotIds,reason,graceSeconds])).rows[0];

// One bounded page, resumable after failures. The writer-only address lock
// prevents republication between reference check and ObjectStore deletion.
// Recheck completes shared attempts durably; deleting another source reference
// re-arms them. This lets later pages progress without polling shared addresses.
// A crash after delete but before ack is safe: ObjectStore.delete is idempotent.
export const cleanupDeletedObjects = async (client:Database,store:ObjectStore) => {
 const pending=(await client.query<{object_key:string}>(`SELECT object_key FROM fs138.object_removals
  WHERE completed_at IS NULL AND remove_after<=clock_timestamp() ORDER BY object_key LIMIT 1024`)).rows;
 const removed:string[]=[];
 const shared:string[]=[];
 for(const {object_key:key} of pending){
  try{
   await client.query("BEGIN");
   const allowed=(await client.query<{allowed:boolean}>("SELECT fs138.removal_recheck($1) AS allowed",[key])).rows[0].allowed;
   if(allowed){await store.delete(key);await client.query("SELECT fs138.ack_removal($1)",[key]);removed.push(key);}
   else shared.push(key);
   await client.query("COMMIT");
  }catch(error){
   if(connectionInterrupted(error))
    throw new Error("cleanup-connection-interrupted-replace",{cause:error});
   try{await client.query("ROLLBACK");}catch(rollbackError){throw new Error("cleanup-connection-interrupted-replace",{cause:rollbackError});}throw error;
  }
 }
 return {removed,shared};
};
export const pruneDerivedVersions = async (client:Database):Promise<{featureIds:string[];labelIds:string[]}> =>
 (await client.query("SELECT fs138.prune_derived() AS pruned")).rows[0].pruned;

// GC recovery window, intentionally much longer than the normal 300 s grace and
// expected PUT duration. No upload deadline/fencing is implied by this policy.
export const MODEL_ORPHAN_RETIREMENT_SECONDS=24*60*60;

// Registered model/report addresses are the work source, even before their PUT
// finishes. Raw/dataset discovery retains its existing metadata-list behavior.
// Each candidate is rechecked under the common address lock; absent recovery
// records retire only after the configured window from the last enrollment.
export const sweepOrphanObjects = async (client:Database,store:ObjectStore,graceSeconds=300,
 retirementSeconds=MODEL_ORPHAN_RETIREMENT_SECONDS) => {
 if(!Number.isFinite(graceSeconds)||graceSeconds<0||graceSeconds>86400
  ||!Number.isFinite(retirementSeconds)||retirementSeconds<=0||retirementSeconds<graceSeconds||retirementSeconds>31536000)
  throw new Error('orphan-window-refused');
 const removed:string[]=[];
 const candidates=(await client.query<{object_key:string}>(`SELECT object_key FROM fs138.orphan_observations
  WHERE object_key ~ '^(models|audits)/' ORDER BY object_key`)).rows.map(row=>row.object_key);
 for(const namespace of ['raw','datasets'] as const)
  for(const object of await store.list(namespace))candidates.push(object.key);
 for(const key of candidates){
  try{
   await client.query('BEGIN');
   const allowed=(await client.query<{allowed:boolean}>('SELECT fs138.orphan_recheck($1,$2) AS allowed',[key,graceSeconds])).rows[0].allowed;
   if(allowed){
    if(/^(models|audits)\//.test(key)&&!await store.head(key))
     await client.query('SELECT fs138.retire_model_observation($1,$2)',[key,retirementSeconds]);
    else{await store.delete(key);removed.push(key);}
   }
   await client.query('COMMIT');
  }catch(error){
   if(connectionInterrupted(error))
    throw new Error('orphan-connection-interrupted-replace',{cause:error});
   try{await client.query('ROLLBACK');}catch(rollbackError){throw new Error('orphan-connection-interrupted-replace',{cause:rollbackError});}throw error;
  }
 }
 return {removed};
};
