import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { withFeatureStoreDatabase } from '../../scripts/feature-store/harness.ts';
import { cleanupDeletedObjectsWithRecovery } from '@dfs-ev/pipeline/feature-store/governance';
import type { ObjectStore } from '../../src/featureStore/objectStore.ts';

type Plan={['Node Type']:string;['Relation Name']?:string;['Index Name']?:string;['Actual Rows']?:number;
 ['Shared Hit Blocks']?:number;['Shared Read Blocks']?:number;Plans?:Plan[];[key:string]:unknown};
const nodes=(plan:Plan):Plan[]=>[plan,...(plan.Plans??[]).flatMap(nodes)];
const blocks=(plan:Plan)=>(plan['Shared Hit Blocks']??0)+(plan['Shared Read Blocks']??0);
const selectionBudget=128,growthBudget=16;
const evidence:Record<string,unknown>={issue:229,step:3,selectionBudget,growthBudget,qualification:'execution shared hit+read blocks, not elapsed time; no planner hints; equal inactive tombstone and unqueued-observation populations'};

test('#229 candidate selection avoids permanent-tombstone scans and has fixed buffer work',{timeout:120_000},async()=>{
 // Capture the production query rather than maintaining a second test-only copy.
 const statements:string[]=[];
 const client={query:async(sql:string)=>{statements.push(sql);return {rows:[]};}} as unknown as Parameters<typeof cleanupDeletedObjectsWithRecovery>[0];
 const never=async()=>{throw Error('selection must not access ObjectStore');};
 await cleanupDeletedObjectsWithRecovery(client,{get:never,getVerified:never,head:never,list:never,listPage:never,putIfAbsent:never,delete:never} satisfies ObjectStore);
 assert.equal(statements.length,2);const sql=statements[1];assert(!sql.includes('orphan_observations'));assert(!sql.includes('coalesce('));
 await withFeatureStoreDatabase(async({admin,writer})=>{
  for(const name of ['165_model_manifests.sql','166_artifact_governance.sql','229_mandatory_recovery.sql'])
   await admin.query(await readFile(new URL(import.meta.resolve(`@dfs-ev/db/assets/${name}`)),'utf8'));
  const event=(await admin.query(`INSERT INTO fs138.deletion_events(reason,grace_seconds,snapshot_ids,feature_ids,label_ids,dataset_ids)
   VALUES('229 plan fixture',0,'{}','{}','{}','{}') RETURNING event_id`)).rows[0].event_id;
  const key=(i:number)=>`audits/${i.toString(16).padStart(64,'0')}`;
  const due=Array.from({length:4},(_,i)=>key(i));
  await admin.query(`INSERT INTO fs138.object_removals(object_key,event_id,remove_after,completed_at,outcome,recovery_until,recovery_due)
   SELECT key,$2,now()-interval '1 hour',now(),'removed',now()+interval '1 hour',now()-interval '1 minute'
   FROM unnest($1::text[]) key`,[due,event]);
  const measurements=[];let prior=0;
  for(const size of [10_000,50_000]){
   // Each fixture transaction stays below the supported 1,024-address lock set.
   const firstNew=prior;
   for(let start=prior;start<size;start+=512)await admin.query(`INSERT INTO fs138.object_removals(object_key,event_id,remove_after,completed_at,outcome)
    SELECT 'models/'||lpad(to_hex(i),64,'0'),$1,now()-interval '2 days',now()-interval '1 day','removed' FROM generate_series($2::int,$3::int)i`,[event,start,Math.min(size-1,start+511)]);
   await admin.query("INSERT INTO fs138.orphan_observations SELECT 'audits/'||lpad(to_hex(i+1000000),64,'0'),now()-interval '1 hour' FROM generate_series($1::int,$2::int)i",[firstNew,size-1]);prior=size;
   await admin.query('ANALYZE fs138.object_removals');await admin.query('ANALYZE fs138.orphan_observations');
   const plan=(await writer.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql)).rows[0]['QUERY PLAN'][0];
   const all=nodes(plan.Plan);assert(!all.some(n=>n['Relation Name']==='object_removals'&&/Seq Scan/.test(n['Node Type'])),'full tombstone scan');
   assert(all.some(n=>n['Index Name']==='removal_recovery_due'),'due partial index missing');
   assert(!all.some(n=>n['Relation Name']==='orphan_observations'),'recovery must not inspect unrelated observations');
   assert(blocks(plan.Plan)<=selectionBudget,`selection buffer budget exceeded: ${blocks(plan.Plan)}`);
   const pendingPlan=(await writer.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+statements[0])).rows[0]['QUERY PLAN'][0];
   assert(!nodes(pendingPlan.Plan).some(n=>n['Relation Name']==='object_removals'&&/Seq Scan/.test(n['Node Type'])),'pending lane scans permanent tombstones');
   assert(nodes(pendingPlan.Plan).some(n=>n['Index Name']==='removal_pending_addresses'),'pending partial index missing');
   assert(blocks(pendingPlan.Plan)<=selectionBudget,'pending selection buffer budget exceeded');
   const rows=(await writer.query(sql)).rows.map(r=>r.object_key);assert.deepEqual(rows,due);
   const sorts=all.filter(n=>n['Node Type']==='Sort');assert(sorts.every(n=>(n['Actual Rows']??0)<=2048),'unbounded candidate sort');
   measurements.push({inactiveTombstones:size,unqueuedObservations:size,candidates:rows.length,executionBlocks:blocks(plan.Plan),plan,pendingExecutionBlocks:blocks(pendingPlan.Plan),pendingPlan});
  }
  assert(measurements[1].executionBlocks<=measurements[0].executionBlocks+growthBudget,'candidate work scales with inactive tombstones');
  assert(measurements[1].pendingExecutionBlocks<=measurements[0].pendingExecutionBlocks+growthBudget,'pending selection scales with permanent tombstones');
  // Negative control: the replaced shape must exceed the same buffer gate.
  const old=`SELECT r.object_key FROM fs138.object_removals r LEFT JOIN fs138.orphan_observations o ON o.object_key=r.object_key
   WHERE (r.object_key ~ '^(models|audits)/' AND o.object_key IS NOT NULL)
   OR (r.completed_at IS NOT NULL AND r.recovery_until IS NOT NULL AND r.recovery_due<=clock_timestamp() AND r.remove_after<=clock_timestamp())
   ORDER BY coalesce(r.recovery_due,o.first_seen),r.object_key LIMIT 1024`;
  const negative=(await writer.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+old)).rows[0]['QUERY PLAN'][0];
  assert(blocks(negative.Plan)>selectionBudget,'negative control failed to detect the old scan');
  evidence.measurements=measurements;evidence.negativeControl={executionBlocks:blocks(negative.Plan),plan:negative};evidence.productionSql=sql;evidence.verdict='pass';
 });
 if(process.env.FS229_SELECTION_EVIDENCE)await writeFile(process.env.FS229_SELECTION_EVIDENCE,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
});
