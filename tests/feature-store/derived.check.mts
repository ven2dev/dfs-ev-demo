import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { runDerivedJob, readLastValidLabel, readLastValidFeature, FEATURE_JOB_SQL, FEATURE_VERSION, HISTORY_POLICY } from "../../src/lib/featureStore/derived.ts";
import { startJob,finishJob } from "../../src/lib/featureStore/jobs.ts";
import { sha256 } from "../../src/lib/featureStore/objectStore.ts";
import { NORMALIZER_VERSION } from "../../src/lib/featureStore/source.ts";

const code = {gitSha:"b".repeat(40),contentSha256:sha256(Buffer.from("synthetic-derived-fixture-v1"))};
const mode = "retrospective-reconstruction-v1" as const;
const strict = "strict-point-in-time-v1" as const;
const player = "00-0000001";
const target = "2022_01_DAL_TB";
const probes: {name:string;verdict:string;details:unknown}[]=[];
const files=["db/proposals/138_feature_store.sql","src/lib/featureStore/derived.ts","tests/feature-store/derived.check.mts"];
const hashes=Object.fromEntries(await Promise.all(files.map(async path=>[path,sha256(await readFile(new URL("../../"+path,import.meta.url)))])));

test("#138 derived jobs: synthetic event-time, qualification, correction and budgets",{timeout:120_000},async t=>{
 try { await withFeatureStoreDatabase(async ({admin,writer,reader,queryCounts})=>{
  const check=async(name:string,run:()=>Promise<unknown>)=>{
   await t.test(name,async()=>{try{const details=await run();probes.push({name,verdict:"pass",details});}
    catch(error){probes.push({name,verdict:"fail",details:String(error)});throw error;}});
  };
  const job=await startJob(writer,{kind:"normalize",codeSha:code.gitSha,policySha256:code.contentSha256,inputSetSha256:sha256(Buffer.from("synthetic-base"))});
  const snapshots:Record<string,string>={};
  const snapshot=async(feed:string,token:string)=>{
   const profile="synthetic-"+feed;
   await writer.query(`INSERT INTO fs138.source_profiles(profile_id,provider,feed,parser_version,license)
    VALUES($1,'synthetic',$2,$3,'{"qualification":"synthetic-only"}') ON CONFLICT DO NOTHING`,[profile,feed,NORMALIZER_VERSION]);
   const hash=sha256(Buffer.from(token));
   return (await writer.query(`INSERT INTO fs138.source_snapshots(profile_id,job_id,sha256,byte_size,object_key,media_type,decoded_sha256,
    header_sha256,row_count,captured_at,available_at,evidence_basis,source_manifest)
    VALUES($1,$2,$3::text,1,'raw/'||$3::text,'text/csv',$3::text,$3::text,1,'2021-01-01','2021-01-01','retrospective','{"synthetic":true}')
    RETURNING snapshot_id`,[profile,job.jobId,hash])).rows[0].snapshot_id as string;
  };
  for(const feed of ["schedule","stats","roster","participation"]) snapshots[feed]=await snapshot(feed,feed);
  const events=Array.from({length:18},(_,i)=>({id:`2021_${String(i+1).padStart(2,"0")}_DAL_TB`,season:2021,week:i+1,
   kickoff:new Date(Date.UTC(2021,8,5+i*7,18)).toISOString(),yards:101+i}));
  events.push(...[
   {id:target,season:2022,week:1,kickoff:"2022-09-01T18:00:00Z",yards:9999},
   {id:"2022_02_DAL_TB",season:2022,week:2,kickoff:"2022-09-01T17:00:00Z",yards:8888},
   {id:"2022_03_DAL_TB",season:2022,week:3,kickoff:"2022-09-01T19:00:00Z",yards:7777},
   {id:"2022_04_DAL_TB",season:2022,week:4,kickoff:"2022-09-01T16:59:59Z",yards:4444},
  ]);
  for(const e of events)await writer.query(`INSERT INTO fs138.norm_schedule VALUES($1,$2,$3,$4,$5,$6,'REG',$7,'TB','DAL',20,10,'usable','{}')`,
   [snapshots.schedule,NORMALIZER_VERSION,job.jobId,e.id,e.season,e.week,e.kickoff]);
  const seedPlayer=async(id:string,includeParticipation=true)=>{
   for(const e of events){
    await writer.query(`INSERT INTO fs138.norm_identity VALUES($1,$2,$3,$4,$5,$6,'DAL','Synthetic QB','QB','usable','{}')`,
     [snapshots.roster,NORMALIZER_VERSION,job.jobId,id,e.season,e.week]);
    await writer.query(`INSERT INTO fs138.norm_player_game_stats VALUES($1,$2,$3,$4,$5,'DAL',0,$6,'usable','{}')`,
     [snapshots.stats,NORMALIZER_VERSION,job.jobId,id,e.id,e.yards]);
    if(includeParticipation)await writer.query(`INSERT INTO fs138.norm_participation VALUES($1,$2,$3,$4,$5,1,'usable','{}')`,
     [snapshots.participation,NORMALIZER_VERSION,job.jobId,id,e.id]);
   }
  };
  await seedPlayer(player);
  await seedPlayer("00-0000002",false);
  await finishJob(writer,job.jobId,{counts:{syntheticEvents:events.length}});
  // Owner-only historical fixture clocks; no public/real source is backdated.
  await admin.query("UPDATE fs138.source_snapshots SET ingested_at='2021-01-01'");
  const clock=async()=>(await admin.query("SELECT clock_timestamp()::text AS clock")).rows[0].clock as string;
  const features=async(jobId:string,id=player)=>(await reader.query("SELECT * FROM fs138.feature_values WHERE job_id=$1 AND player_id=$2 AND game_id=$3",[jobId,id,target])).rows[0];
  const label=async(jobId:string,id=player)=>(await reader.query("SELECT * FROM fs138.outcome_labels WHERE job_id=$1 AND player_id=$2 AND game_id=$3",[jobId,id,target])).rows[0];
  let originalLabel:Record<string,unknown>;
  let originalKnown:string;
  let originalHistory:unknown;
  let smallQueries:number;
  await check("SQL excludes target, equal-cutoff and future events in BOTH evidence modes",async()=>{
   const checkpoint=await clock();
   for(const evidenceMode of [mode,strict]){
    const before=queryCounts.writer;
    const run=await runDerivedJob(writer,"features",{season:2022,mode:evidenceMode,checkpoint},code);
    assert.equal(run.status,"succeeded");smallQueries=queryCounts.writer-before;assert.equal(smallQueries,8);
    const row=await features(run.jobId);assert.equal(row.state,"usable");assert.equal(row.sample_size,16);
    const unavailable=await features(run.jobId,"00-0000002");assert.equal(unavailable.state,"unavailable");assert.equal(unavailable.sample_size,0);
    assert.ok(unavailable.reasons.includes("insufficient-history"));assert.ok(unavailable.history_gaps.length>0);
    const history=row.history as {gameId:string;yards:number}[];
    assert.equal(history[0].gameId,"2022_04_DAL_TB");
    assert.equal(history.some(h=>[target,"2022_02_DAL_TB","2022_03_DAL_TB"].includes(h.gameId)),false);
    assert.equal(history.some(h=>[9999,8888,7777].includes(h.yards)),false);
    if(evidenceMode===mode)originalHistory=history;else assert.deepEqual(history,originalHistory);
   }
   const leaks=(await reader.query(`SELECT count(*)::integer AS n FROM fs138.feature_values f CROSS JOIN LATERAL jsonb_array_elements(f.history) h
    WHERE h->>'gameId'=f.game_id OR (h->>'kickoff')::timestamptz>=f.cutoff`)).rows[0].n;
   assert.equal(leaks,0);return {sameGameLeaks:leaks,equalCutoffIncluded:false,futureIncluded:false,statements:smallQueries!,sample:16};
  });
  await check("missing participation is an unavailable NULL label, and zero is preserved when qualified",async()=>{
   const run=await runDerivedJob(writer,"labels",{season:2022,mode,checkpoint:await clock()},code);
   const absent=await label(run.jobId,"00-0000002");assert.equal(absent.state,"unavailable");assert.equal(absent.value,null);
   assert.ok(absent.reasons.includes("positive-offense-participation-missing"));
   originalLabel=await label(run.jobId);assert.equal(originalLabel.value,9999);
   originalKnown=await clock();
   await admin.query("UPDATE fs138.norm_player_game_stats SET passing_yards=0 WHERE player_id=$1 AND game_id='2022_04_DAL_TB'",[player]);
   const zeroRun=await runDerivedJob(writer,"labels",{season:2022,mode,checkpoint:await clock()},code);
   const zero=(await reader.query("SELECT * FROM fs138.outcome_labels WHERE job_id=$1 AND player_id=$2 AND game_id='2022_04_DAL_TB'",[zeroRun.jobId,player])).rows[0];
   assert.equal(zero.state,"usable");assert.equal(zero.value,0);
   await admin.query("UPDATE fs138.norm_player_game_stats SET passing_yards=4444 WHERE player_id=$1 AND game_id='2022_04_DAL_TB'",[player]);
   return {missingValue:null,qualifiedZero:zero.value};
  });
  const correction=async(token:string,rows:{game:string;value:number;state?:string}[])=>{
   const next=await startJob(writer,{kind:"normalize",codeSha:code.gitSha,policySha256:code.contentSha256,inputSetSha256:sha256(Buffer.from(token))});
   const hash=sha256(Buffer.from(token));
   const snap=(await writer.query(`INSERT INTO fs138.source_snapshots(profile_id,job_id,sha256,byte_size,object_key,media_type,decoded_sha256,
    header_sha256,row_count,captured_at,available_at,evidence_basis,source_manifest)
    VALUES('synthetic-stats',$1,$2::text,1,'raw/'||$2::text,'text/csv',$2::text,$2::text,1,'2026-01-01','2026-01-01','retrospective','{"syntheticCorrection":true}') RETURNING snapshot_id`,[next.jobId,hash])).rows[0].snapshot_id;
   for(const row of rows)await writer.query(`INSERT INTO fs138.norm_player_game_stats VALUES($1,$2,$3,$4,$5,'DAL',30,$6,$7,$8)`,
    [snap,NORMALIZER_VERSION,next.jobId,player,row.game,row.value,row.state??"usable",row.state?["synthetic-conflict"]:[]]);
   await finishJob(writer,next.jobId,{counts:{syntheticCorrectionRows:rows.length}});return snap as string;
  };
  await check("synthetic corrections preserve old labels and never put the corrected target outcome into its features",async()=>{
   await correction("correction-350",[{game:target,value:350},{game:"2021_18_DAL_TB",value:700}]);
   const checkpoint=await clock();
   const run=await runDerivedJob(writer,"labels",{season:2022,mode,checkpoint},code);
   const current=await label(run.jobId);assert.equal(current.value,350);assert.notEqual(current.label_id,originalLabel!.label_id);
   assert.ok(current.supersedes_id);
   const old=await readLastValidLabel(reader,{playerId:player,gameId:target,mode,knownAsOf:originalKnown!});assert.equal(old.value,9999);
   const currentDisplay=await readLastValidLabel(reader,{playerId:player,gameId:target,mode,knownAsOf:await clock()});assert.equal(currentDisplay.value,350);
   assert.equal(currentDisplay.display_status,"corrected value");
   const r=await runDerivedJob(writer,"features",{season:2022,mode,checkpoint},code);
   const s=await runDerivedJob(writer,"features",{season:2022,mode:strict,checkpoint},code);
   const a=await features(r.jobId),b=await features(s.jobId);
   assert.deepEqual(a.history.map((h:{gameId:string})=>h.gameId),b.history.map((h:{gameId:string})=>h.gameId));
   assert.equal(a.history.find((h:{gameId:string})=>h.gameId==="2021_18_DAL_TB").yards,700);
   assert.equal(b.history.find((h:{gameId:string})=>h.gameId==="2021_18_DAL_TB").yards,118);
   assert.equal(a.history.some((h:{gameId:string;yards:number})=>h.gameId===target||h.yards===350),false);
   return {synthetic:true,oldLabel:old.value,correctedLabel:current.value,reconstructionPriorCorrection:700,strictPriorValue:118,eventMembershipEqual:true};
  });
  await check("ambiguous stats give an unavailable label while the earlier valid value stays visibly stale",async()=>{
   await correction("ambiguous-newer",[{game:target,value:900,state:"ambiguous"}]);
   const run=await runDerivedJob(writer,"labels",{season:2022,mode,checkpoint:await clock()},code);
   const row=await label(run.jobId);assert.equal(row.state,"unavailable");assert.equal(row.value,null);assert.ok(row.reasons.includes("stats-ambiguous"));
   const shown=await readLastValidLabel(reader,{playerId:player,gameId:target,mode,knownAsOf:await clock()});
   assert.equal(shown.value,350);assert.equal(shown.stale,true);assert.equal(shown.superseded,true);
   assert.match(shown.display_status,/last valid/);return {unavailableValue:row.value,displayed:shown.value,stale:true,superseded:true};
  });
  await check("equal-time source rivals stay ambiguous and an unavailable feature preserves its last valid history",async()=>{
   const first=await correction("tie-a",[{game:target,value:501}]);
   const second=await correction("tie-b",[{game:target,value:502}]);
   await admin.query("UPDATE fs138.source_snapshots SET ingested_at=statement_timestamp() WHERE snapshot_id=ANY($1::uuid[])",[[first,second]]);
   const run=await runDerivedJob(writer,"labels",{season:2022,mode,checkpoint:await clock()},code);
   const ambiguous=await label(run.jobId);assert.equal(ambiguous.value,null);assert.ok(ambiguous.reasons.includes("stats-ambiguous"));
   const pre=await runDerivedJob(writer,"features",{season:2022,mode,checkpoint:await clock()},code);
   const good=await features(pre.jobId);assert.equal(good.state,"usable");
   await admin.query("UPDATE fs138.norm_identity SET state='ambiguous',reasons=ARRAY['synthetic-identity-conflict'] WHERE player_id=$1 AND season=2022 AND week=1",[player]);
   const post=await runDerivedJob(writer,"features",{season:2022,mode,checkpoint:await clock()},code);
   const bad=await features(post.jobId);assert.equal(bad.state,"unavailable");assert.ok(bad.reasons.includes("target-identity-ambiguous"));
   const shown=await readLastValidFeature(reader,{playerId:player,gameId:target,mode,knownAsOf:await clock()});
   assert.deepEqual(shown.value,good.history);assert.equal(shown.stale,true);assert.equal(shown.superseded,true);
   await admin.query("UPDATE fs138.norm_identity SET state='usable',reasons='{}' WHERE player_id=$1 AND season=2022 AND week=1",[player]);
   return {equalTimeLabel:null,preservedFeatureSample:shown.value.length,stale:true,superseded:true};
  });
  await check("only pipeline writes derived rows, timestamps are DB clocks and lineage is snapshot level",async()=>{
   for(const table of ["feature_values","feature_inputs","outcome_labels","label_inputs"]){
    await assert.rejects(reader.query(`INSERT INTO fs138.${table} DEFAULT VALUES`),{code:"42501"});
    await assert.rejects(reader.query(`DELETE FROM fs138.${table}`),{code:"42501"});
    await assert.rejects(reader.query(`TRUNCATE fs138.${table}`),{code:"42501"});
   }
   await assert.rejects(writer.query("UPDATE fs138.outcome_labels SET value=123"),{code:"42501"});
   await assert.rejects(writer.query("UPDATE fs138.feature_values SET history='[]'"),{code:"42501"});
   await assert.rejects(reader.query("SELECT * FROM fs138.qb_job_context(2022,clock_timestamp(),'retrospective-reconstruction-v1','features',$1)",[NORMALIZER_VERSION]),{code:"42501"});
   const linked=(await reader.query(`SELECT count(*)::integer AS n FROM fs138.feature_inputs i JOIN fs138.source_snapshots s USING(snapshot_id)`)).rows[0].n;
   assert.ok(linked>0);
   const badClock=(await reader.query("SELECT count(*)::integer AS n FROM fs138.feature_values WHERE computed_at<checkpoint")).rows[0].n;
   assert.equal(badClock,0);return {snapshotLinks:linked,badClock,nonPipelineMutationRefusals:13};
  });
  await check("feature SQL statement count stays constant from 2 to 65 QBs",async()=>{
   for(let i=3;i<=65;i++)await seedPlayer("00-"+String(i).padStart(7,"0"));
   const before=queryCounts.writer;
   const run=await runDerivedJob(writer,"features",{season:2022,mode,checkpoint:await clock()},code);
   const queries=queryCounts.writer-before;assert.equal(queries,smallQueries!);
   assert.equal(run.status,"succeeded");if(run.status!=="succeeded")throw new Error("expected-success");assert.equal(run.counts.rows,260);
   return {smallExamples:8,largeExamples:260,smallQueries:smallQueries!,largeQueries:queries};
  });
  await check("history and gap aggregates execute once for the complete cohort",async()=>{
   const probe=await startJob(writer,{kind:"features",codeSha:code.gitSha,policySha256:sha256(Buffer.from("synthetic-plan-probe")),inputSetSha256:code.contentSha256});
   const ids=(await reader.query("SELECT snapshot_id FROM fs138.source_snapshots ORDER BY snapshot_id")).rows.map(row=>row.snapshot_id);
   const params=[probe.jobId,2022,await clock(),mode,NORMALIZER_VERSION,FEATURE_VERSION,HISTORY_POLICY,ids];
   await writer.query("BEGIN");
   let plan:Record<string,unknown>;
   try{
    await writer.query("SET LOCAL statement_timeout='84s'");
    const query={text:"EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) "+FEATURE_JOB_SQL,values:params,query_timeout:90_000};
    plan=(await writer.query(query)).rows[0]["QUERY PLAN"][0].Plan;
   }
   finally{await writer.query("ROLLBACK");}
   await finishJob(writer,probe.jobId,{counts:{},errorCode:"synthetic-plan-probe-intentionally-rolled-back"});
   const counts:Record<string,number>={};
   const visit=(node:Record<string,unknown>)=>{
    const name=String(node["Subplan Name"]??"");
    if(["CTE histories","CTE gaps"].includes(name))counts[name]=Number(node["Actual Loops"]);
    for(const child of (node.Plans??[]) as Record<string,unknown>[])visit(child);
   };visit(plan!);
   assert.deepEqual(counts,{"CTE histories":1,"CTE gaps":1});
   return {examples:260,aggregateExecutionCounts:counts};
  });
  await check("derived publication rollback leaves no partial outputs or lineage",async()=>{
   const before=(await reader.query("SELECT count(*)::integer AS n FROM fs138.outcome_labels")).rows[0].n;
   await admin.query("REVOKE INSERT ON fs138.label_inputs FROM fs138_pipeline_writer");
   try{await assert.rejects(runDerivedJob(writer,"labels",{season:2022,mode,checkpoint:await clock()},code),{code:"42501"});}
   finally{await admin.query("GRANT INSERT ON fs138.label_inputs TO fs138_pipeline_writer");}
   assert.equal((await reader.query("SELECT count(*)::integer AS n FROM fs138.outcome_labels")).rows[0].n,before);
   assert.equal((await reader.query("SELECT count(*)::integer AS n FROM fs138.job_runs WHERE kind='labels' AND status='failed'")).rows[0].n,1);
   return {partialLabels:0,failedJob:1};
  });
 });} finally {
  if(process.env.FEATURE_STORE_EVIDENCE_PATH)await writeFile(process.env.FEATURE_STORE_EVIDENCE_PATH,JSON.stringify({schemaVersion:1,issue:138,step:4,
   recordedAt:new Date().toISOString(),fixture:"synthetic-only; includes owner-admin historical clock setup and fabricated corrections",codeHashes:hashes,
   verdict:probes.length===9&&probes.every(p=>p.verdict==="pass")?"pass":"fail",probes},null,2)+"\n");
 }
});
