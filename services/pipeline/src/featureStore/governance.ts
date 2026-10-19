import type { Client } from "pg";
import type { ObjectStore } from "./objectStore.ts";

type Database = Pick<Client,"query">;
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
   if(error instanceof Error&&/Query read timeout|Connection terminated|Connection closed/.test(error.message))
    throw new Error("cleanup-connection-interrupted-replace",{cause:error});
   await client.query("ROLLBACK");throw error;
  }
 }
 return {removed,shared};
};
export const pruneDerivedVersions = async (client:Database):Promise<{featureIds:string[];labelIds:string[]}> =>
 (await client.query("SELECT fs138.prune_derived() AS pruned")).rows[0].pruned;

// Grace starts on first observation, so listing needs no provider-specific mtime.
// The common writer address lock closes the publication-versus-sweep race.
export const sweepOrphanObjects = async (client:Database,store:ObjectStore,graceSeconds=300) => {
 const removed:string[]=[];
 for(const namespace of ['raw','datasets'] as const)for(const object of await store.list(namespace)){
  try{
   await client.query('BEGIN');
   const allowed=(await client.query<{allowed:boolean}>('SELECT fs138.orphan_recheck($1,$2) AS allowed',[object.key,graceSeconds])).rows[0].allowed;
   if(allowed){await store.delete(object.key);removed.push(object.key);}
   await client.query('COMMIT');
  }catch(error){
   if(error instanceof Error&&/Query read timeout|Connection terminated|Connection closed/.test(error.message))
    throw new Error('orphan-connection-interrupted-replace',{cause:error});
   await client.query('ROLLBACK');throw error;
  }
 }
 return {removed};
};
