import pg from 'pg';
import { fork,execFileSync } from 'node:child_process';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve,dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash,createHmac,randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { isIP } from 'node:net';
import { getSharedOddsBatch } from '../../src/sharedOddsCache.ts';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../../..');
const output=resolve(process.argv[2]??'');assert(process.argv[2]);
await mkdir(output,{recursive:true});
const cfg={host:'127.0.0.1',port:54339,user:'dfs_ev_test',password:'dfs_ev_test',database:'dfs_ev_test',ssl:false,max:4,statement_timeout:5000,connectionTimeoutMillis:5000};
const pool=new pg.Pool(cfg),lease=new pg.Client(cfg);
const tests=[],trials=[],plans={},workEvidence={},workers=[],checks={mockProviderCalls:0,realProviderCalls:0},started=new Date().toISOString();
let schemaCreated=false,id=0,owned=false;
const q=(s,a=[])=>pool.query(s,a),one=async(s,a=[])=>(await q(s,a)).rows[0];
const dim=(key,interval=1000,burst=100,extra={})=>({keys:[key],report:key,interval_ms:interval,burst,traffic:'anonymous',...extra});
const admit=async(dims,enforce=true,fault='',floor=true)=>one('SELECT * FROM spike223.admit($1::jsonb,$2,100,9,$3,$4)',[JSON.stringify(dims),enforce,floor,fault]);
const snap=()=>q('SELECT subject,tat::text FROM spike223.subjects ORDER BY subject').then(r=>r.rows);
const reset=async()=>{await q('TRUNCATE spike223.subjects,spike223.buckets,spike223.quota,spike223.event_market_odds_cache');await q('INSERT INTO spike223.quota(remaining,used,requested_at) VALUES(1000000,0,clock_timestamp())');};
const test=async(name,fn)=>{await reset();const t=performance.now();await fn();tests.push({name,passed:true,ms:performance.now()-t});console.log('PASS '+name);};
const dist=arr=>{const s=arr.toSorted((a,b)=>a-b);return {n:s.length,p50Ms:s[Math.ceil(s.length*.5)-1]??null,p95Ms:s[Math.ceil(s.length*.95)-1]??null,maxMs:s.at(-1)??null};};
const spawnWorker=()=>new Promise((resolveReady,reject)=>{
 const child=fork(resolve(here,'worker.mjs'),[],{env:{PATH:process.env.PATH,LANG:'en_US.UTF-8'},stdio:['ignore','pipe','pipe','ipc']});
 const pending=new Map();let ready=false;
 child.stdout.on('data',b=>process.stdout.write(b));child.stderr.on('data',b=>process.stderr.write(b));
 child.on('message',m=>{if(m.ready){ready=true;resolveReady({child,pid:m.pid,send:(message)=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});child.send({...message,id:n});})});}
 else{const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(Object.assign(new Error(m.error.message),m.error)):p?.resolve(m);}});
 child.on('error',reject);child.on('exit',code=>{if(!ready)reject(new Error('worker startup '+code));for(const p of pending.values())p.reject(new Error('worker exited '+code));});
});
const send=(n,variant,dims,enforce=true)=>workers[n%2].send({variant,dims,enforce});
const aggregate=()=>q(`WITH w(label,cutoff) AS(VALUES('1h',date_trunc('minute',clock_timestamp()-interval '1 hour')),('24h',date_trunc('minute',clock_timestamp()-interval '24 hours'))),
 totals AS(SELECT w.label,b.subject,sum(admitted)::bigint admitted,sum(denied)::bigint denied,sum(would_deny)::bigint would_deny,sum(anonymous)::bigint anonymous,sum(signed_in)::bigint signed_in
 FROM w JOIN spike223.buckets b ON b.minute>=w.cutoff GROUP BY w.label,b.subject),
 ranked AS(SELECT *,row_number() OVER(PARTITION BY label ORDER BY admitted DESC,subject) a_rank,
 row_number() OVER(PARTITION BY label ORDER BY denied DESC,subject) d_rank,
 row_number() OVER(PARTITION BY label ORDER BY would_deny DESC,subject) w_rank FROM totals)
 SELECT label,jsonb_build_object('admitted',sum(admitted),'denied',sum(denied),'wouldDeny',sum(would_deny),'anonymous',sum(anonymous),'signedIn',sum(signed_in)) totals,
 jsonb_agg(jsonb_build_object('subject',subject,'admitted',admitted,'denied',denied,'wouldDeny',would_deny) ORDER BY admitted DESC,subject) FILTER(WHERE a_rank<=20) top_admitted,
 jsonb_agg(jsonb_build_object('subject',subject,'admitted',admitted,'denied',denied,'wouldDeny',would_deny) ORDER BY denied DESC,subject) FILTER(WHERE d_rank<=20) top_denied,
 jsonb_agg(jsonb_build_object('subject',subject,'admitted',admitted,'denied',denied,'wouldDeny',would_deny) ORDER BY would_deny DESC,subject) FILTER(WHERE w_rank<=20) top_would_deny FROM ranked GROUP BY label ORDER BY label`);
// Deliberately isolated mock identity adapter. It proves proposed contracts,
// not production Firebase or deployment header trust.
const identity=(headers,verified,version='v1')=>{
 const addr=headers['x-vercel-forwarded-for'];if(!addr||!isIP(addr))return {warning:'identity-unavailable',dims:[]};
 const key=(kind,v)=>`${version}:${kind}:`+createHmac('sha256','synthetic-q0-only').update(kind+'\0'+v).digest('hex');
 const net=key('network',addr);
 return verified?{dims:[dim('signed-backstop:'+net,1000,1000,{traffic:'signed-in'}),dim(key('user',verified),1000,5,{traffic:'signed-in'})]}:
 {dims:[dim('anonymous:'+net,1000,5)],warning:headers.authorization?'invalid-token':null};
};
const mapSql=text=>text.replaceAll('public.','spike223.');
const shared=async(event,subject,opts={})=>{
 const count={admission:0,queries:[],sends:0,warning:[],fetchCalls:0};
 const r=await getSharedOddsBatch(event,['player_pass_yds'],{
 query:async(text,args)=>{count.queries.push(text.split(/\s+/).filter(Boolean).slice(0,4).join(' '));return (await q(mapSql(text),args)).rows;},
 makeOwnerId:randomUUID,monotonicNow:()=>performance.now(),wait:ms=>new Promise(r=>setTimeout(r,ms)),
 isFetchUnavailable:error=>error.refusal===true,
 fetch:async(keys,signal,claim)=>{count.fetchCalls++;count.admission++;
  const r=await admit([dim(subject,60000,1)],true,opts.fault??'');
  if(r.warning)count.warning.push(r.warning);
  if(r.outcome!=='allow'){
   if(r.outcome==='subject-rate-limit')await q('SELECT spike223.release_limiter_denial($1,$2,$3)',[event,keys,claim.ownerId]);
   throw Object.assign(new Error('synthetic refusal'),{refusal:true});
  }
  if(opts.publishFailure)await q(`ALTER TABLE spike223.event_market_odds_cache ADD CONSTRAINT injected_publish_failure CHECK(fetched_at='epoch'::timestamptz) NOT VALID`);
  count.sends++;checks.mockProviderCalls++;return Object.fromEntries(keys.map(k=>[k,{bookmakers:[],mock:true}]));
 },onCacheWriteError:()=>{}},{ttlMs:300000});
 return {r,count};
};
try{
 await lease.connect();const acquired=(await lease.query("SELECT pg_try_advisory_lock(153045,(SELECT oid::int FROM pg_database WHERE datname=current_database())) acquired")).rows[0].acquired;
 assert(acquired,'lane-2 is already leased');owned=true;
 assert.equal((await one("SELECT current_database() d")).d,'dfs_ev_test');
 assert.equal((await one("SELECT to_regnamespace('spike223') IS NULL absent")).absent,true,'refuse existing schema');
 await q(await readFile(resolve(here,'q0.sql'),'utf8'));schemaCreated=true;
 let cacheSql=await readFile(resolve(here,'../221_shared_odds_cache.sql'),'utf8');
 cacheSql=cacheSql.replaceAll('event_market_odds_cache','spike223.event_market_odds_cache').replace(/CREATE FUNCTION (\w+)/g,'CREATE FUNCTION spike223.$1');
 await q(cacheSql);
 await q(`CREATE FUNCTION spike223.release_limiter_denial(p_event text,p_keys text[],p_owner text) RETURNS void LANGUAGE sql AS $$
 UPDATE spike223.event_market_odds_cache SET refresh_owner=NULL,refresh_lease_until=NULL,refresh_claimed_at=NULL
 WHERE event_id=p_event AND market_key=ANY(p_keys) AND refresh_owner=p_owner AND refresh_lease_until>clock_timestamp(); $$`);
 workers.push(await spawnWorker(),await spawnWorker());assert.notEqual(workers[0].pid,workers[1].pid);
 await test('twenty distinct signed-in leaders, two adapter processes, all admitted',async()=>{
  const rs=await Promise.all(Array.from({length:20},(_,i)=>send(i,'combined',[dim('backstop',1000,1000,{traffic:'signed-in'}),dim('user:'+i,1000,100,{traffic:'signed-in'})])));
  assert.equal(rs.filter(r=>r.row.outcome==='allow').length,20);assert(rs.every(r=>r.statements===1));
 });
 await test('hot anonymous subject: five admitted, fifteen denied, one minute bucket',async()=>{
  const rs=await Promise.all(Array.from({length:20},(_,i)=>send(i,'combined',[dim('hot',60000,5)])));
  assert.equal(rs.filter(r=>r.row.outcome==='allow').length,5);assert.equal(rs.filter(r=>r.row.outcome==='subject-rate-limit').length,15);
  const b=await one('SELECT count(*)::int n,sum(admitted)::int admitted,sum(denied)::int denied FROM spike223.buckets');assert.deepEqual(b,{n:1,admitted:5,denied:15});
 });
 await test('reverse-order multi-dimension locks across processes; no deadlock or partial advance',async()=>{
  await Promise.all(Array.from({length:20},(_,i)=>send(i,'combined',i%2?[dim('z'),dim('a')]:[dim('a'),dim('z')])));
  assert.equal((await one('SELECT count(DISTINCT tat)::int n FROM spike223.subjects')).n,1);
  await q("UPDATE spike223.subjects SET tat=clock_timestamp()+interval '1 day' WHERE subject='z'");const before=await snap();
  assert.equal((await admit([dim('a'),dim('z')])).outcome,'subject-rate-limit');assert.deepEqual(await snap(),before);
 });
 await test('signed-in loose network backstop isolates users from tight anonymous limit',async()=>{
  await admit([dim('anonymous:net',60000,1)]);assert.equal((await admit([dim('anonymous:net',60000,1)])).outcome,'subject-rate-limit');
  assert.equal((await admit([dim('signed:net',60000,100),dim('user:a',60000,1)])).outcome,'allow');
  assert.equal((await admit([dim('signed:net',60000,100),dim('user:b',60000,1)])).outcome,'allow');
  assert.equal((await admit([dim('signed:net',60000,100),dim('user:a',60000,1)])).outcome,'subject-rate-limit');
 });
 await test('quota floor refusal does not advance TAT or count admitted; no reading allows',async()=>{
  await q('UPDATE spike223.quota SET remaining=109');assert.equal((await admit([dim('q')])).outcome,'quota-floor');
  assert.equal((await one("SELECT tat='-infinity'::timestamptz yes FROM spike223.subjects")).yes,true);
  assert.equal((await one('SELECT admitted::int FROM spike223.buckets')).admitted,0);
  await q('TRUNCATE spike223.quota');assert.equal((await admit([dim('q')])).outcome,'allow');
 });
 await test('limiter and counter errors fail open in both modes, reason classes only',async()=>{
  for(const enforce of [true,false])for(const fault of ['limiter','counter']){
   const r=await admit([dim('error-'+fault+enforce)],enforce,fault);assert.equal(r.outcome,'allow');assert.match(r.warning,/^limiter-(evaluation|counter)-failed$/);
  }
  assert.equal((await one('SELECT count(*)::int n FROM spike223.buckets')).n,0);
  assert((await snap()).every(s=>s.tat==='-infinity'));
 });
 await test('counter/limiter errors cannot erase a known floor refusal; quota errors remain advisory',async()=>{
  await q('UPDATE spike223.quota SET remaining=109');
  for(const fault of ['counter','limiter'])assert.equal((await admit([dim('floor-'+fault)],true,fault)).outcome,'quota-floor');
  const r=await admit([dim('quota-error')],true,'quota');assert.equal(r.outcome,'allow');assert.equal(r.warning,'quota-read-failed');
 });
 await test('log-only would-deny records send intent without advancing failed shadow policy',async()=>{
  await admit([dim('shadow',60000,1)],false);const before=await snap();
  assert.equal((await admit([dim('shadow',60000,1)],false)).outcome,'allow');assert.deepEqual(await snap(),before);
  assert.deepEqual(await one('SELECT admitted::int,denied::int,would_deny::int FROM spike223.buckets'),{admitted:2,denied:0,would_deny:1});
 });
 await test('ordinary two-version rotation uses stricter debt, single reporting count',async()=>{
  await admit([dim('old',60000,1)]);const overlap=dim('new',60000,1,{keys:['new','old']});
  assert.equal((await admit([overlap])).outcome,'subject-rate-limit');
  await q("UPDATE spike223.subjects SET tat=clock_timestamp()-interval '1 second'");
  assert.equal((await admit([overlap])).outcome,'allow');
  assert.equal((await one('SELECT count(DISTINCT tat)::int n FROM spike223.subjects')).n,1);
  assert.equal((await admit([dim('new',60000,1)])).outcome,'subject-rate-limit');
  assert.equal((await one('SELECT sum(admitted)::int n FROM spike223.buckets')).n,2);
  assert.equal((await admit([dim('emergency',60000,1)])).outcome,'allow');
 });
 await test('four version/dimension reverse-order locks use <=two reporting buckets',async()=>{
  const dims=[dim('n-new',1000,1000,{keys:['n-new','n-old']}),dim('u-new',1000,1000,{keys:['u-old','u-new']})];
  await Promise.all(Array.from({length:20},(_,i)=>send(i,'combined',i%2?dims:[...dims].reverse())));
  assert.equal((await one('SELECT count(*)::int n FROM spike223.subjects')).n,4);assert.equal((await one('SELECT count(*)::int n FROM spike223.buckets')).n,2);
 });
 await test('mock identity: spoofed headers ignored, invalid/missing token anonymous, HMAC only',async()=>{
  const a=identity({'x-vercel-forwarded-for':'203.0.113.10','x-forwarded-for':'1.1.1.1',uid:'forged'},null);
  const b=identity({'x-vercel-forwarded-for':'203.0.113.10',authorization:'expired'},null);
  assert.deepEqual(a.dims,b.dims);assert.equal(b.warning,'invalid-token');assert.equal(a.warning,null);
  const c=identity({'x-vercel-forwarded-for':'203.0.113.10'},'synthetic-uid');assert.equal(c.dims.length,2);
  assert(!JSON.stringify(c.dims).includes('synthetic-uid'));assert(!JSON.stringify(c.dims).includes('203.0.113.10'));
  assert.equal(identity({'x-forwarded-for':'203.0.113.10'},null).warning,'identity-unavailable');
 });
 await test('real shared-cache kernel: fresh hit adds no admission, follower adds none',async()=>{
  await q(`INSERT INTO spike223.event_market_odds_cache(event_id,market_key,payload,fetched_at)
  VALUES('fresh','player_pass_yds','{"bookmakers":[]}',clock_timestamp())`);
  const hit=await shared('fresh','not-used');assert.equal(hit.count.admission,0);assert.equal(hit.count.queries.length,1);
  const claim=(await q('SELECT * FROM spike223.claim_shared_odds_batch($1,$2,$3,300000,30000)',['held',['player_pass_yds'],'held-owner'])).rows[0];assert.equal(claim.outcome,'leader');
  let queries=0;
  const promise=getSharedOddsBatch('held',['player_pass_yds'],{query:async(t,a)=>{queries++;return(await q(mapSql(t),a)).rows;},makeOwnerId:randomUUID,monotonicNow:()=>performance.now(),wait:ms=>new Promise(r=>setTimeout(r,ms)),fetch:async()=>{throw new Error('follower fetched');}},{ttlMs:300000});
  setTimeout(()=>q('SELECT spike223.publish_shared_odds_batch($1,$2,$3,$4)',['held',['player_pass_yds'],'held-owner',JSON.stringify({'player_pass_yds':{bookmakers:[]}})]).catch(()=>{}),300);
  const r=await promise;assert.equal(r.player_pass_yds.state,'fresh');assert(queries>=3);assert.equal((await one('SELECT count(*)::int n FROM spike223.subjects')).n,0);
 });
 await test('denied A clears only pre-send claim; B leads immediately; no payload re-age',async()=>{
  await admit([dim('a',60000,1)]);const a=await shared('handoff','a');assert.equal(a.count.sends,0);assert.equal(a.r.player_pass_yds.state,'unavailable');
  const row=await one("SELECT fetched_at='epoch'::timestamptz unchanged,refresh_claimed_at IS NULL cleared FROM spike223.event_market_odds_cache");assert.deepEqual(row,{unchanged:true,cleared:true});
  const b=await shared('handoff','b');assert.equal(b.count.sends,1);assert.equal(b.r.player_pass_yds.state,'upstream');
 });
 await test('late denied owner cannot release newer owner',async()=>{
  await q('SELECT * FROM spike223.claim_shared_odds_batch($1,$2,$3,300000,30000)',['late',['player_pass_yds'],'b']);
  await q('SELECT spike223.release_limiter_denial($1,$2,$3)',['late',['player_pass_yds'],'a']);
  assert.equal((await one('SELECT refresh_owner FROM spike223.event_market_odds_cache')).refresh_owner,'b');
 });
 await test('publish failure preserves cooldown: second request within 20s adds zero provider calls',async()=>{
  const a=await shared('publish-fail','p',{publishFailure:true});assert.equal(a.count.sends,1);
  await q('ALTER TABLE spike223.event_market_odds_cache DROP CONSTRAINT injected_publish_failure');
  const b=await shared('publish-fail','p2');assert.equal(b.count.sends,0);assert.equal(b.count.admission,0);assert.equal(b.r.player_pass_yds.state,'unavailable');
 });
 await test('quota refusal and limiter read error share existing fallback/send behavior',async()=>{
  await q('UPDATE spike223.quota SET remaining=109');const deny=await shared('low','low');assert.equal(deny.count.sends,0);
  await q('UPDATE spike223.quota SET remaining=1000000');const allow=await shared('error','err',{fault:'limiter'});assert.equal(allow.count.sends,1);assert.deepEqual(allow.count.warning,['limiter-evaluation-failed']);
 });
 await test('minute approximation includes partial cutoff, excludes previous minute',async()=>{
  await q(`INSERT INTO spike223.buckets(subject,minute,admitted) VALUES
   ('edge',date_trunc('minute',clock_timestamp()-interval '1 hour'),7),
   ('outside',date_trunc('minute',clock_timestamp()-interval '1 hour')-interval '1 minute',3)`);
  const r=(await aggregate()).rows.find(r=>r.label==='1h');assert.equal(r.totals.admitted,7);assert.equal(r.top_admitted[0].subject,'edge');
 });
 await test('bounded retention delete preserves future TAT and overlap/report split',async()=>{
  await q(`INSERT INTO spike223.buckets(subject,minute,admitted) SELECT 'old',clock_timestamp()-interval '8 days'-i*interval '1 minute',1 FROM generate_series(1,1200) i`);
  const n=await q(`WITH doomed AS(SELECT ctid FROM spike223.buckets WHERE minute<clock_timestamp()-interval '7 days' ORDER BY minute LIMIT 1000) DELETE FROM spike223.buckets WHERE ctid IN(SELECT ctid FROM doomed)`);assert.equal(n.rowCount,1000);
  await q("INSERT INTO spike223.subjects VALUES('future',clock_timestamp()+interval '1 hour'),('past',clock_timestamp()-interval '1 hour')");
  await q('DELETE FROM spike223.subjects WHERE tat<=clock_timestamp()');assert.equal((await one('SELECT count(*)::int n FROM spike223.subjects')).n,1);
 });
 await test('actual 45s follower timeout: real 250ms polls, 10s renewals, zero admission',async()=>{
  await q('SELECT * FROM spike223.claim_shared_odds_batch($1,$2,$3,300000,30000)',['timeout',['player_pass_yds'],'held-owner']);
  let reads=0,claims=0,renewals=0,fetches=0;const start=performance.now();
  const timer=setInterval(()=>{renewals++;q('SELECT spike223.renew_shared_odds_batch($1,$2,$3,30000)',['timeout',['player_pass_yds'],'held-owner']).catch(()=>{});},10000);
  try{
   await assert.rejects(()=>getSharedOddsBatch('timeout',['player_pass_yds'],{
    query:async(t,a)=>{if(t.includes('claim_shared_odds_batch'))claims++;else reads++;return(await q(mapSql(t),a)).rows;},
    makeOwnerId:randomUUID,monotonicNow:()=>performance.now(),wait:ms=>new Promise(r=>setTimeout(r,ms)),
    fetch:async()=>{fetches++;throw new Error('follower became leader');}
   },{ttlMs:300000}),/Timed out waiting/);
  }finally{clearInterval(timer);}
  assert.equal(fetches,0);assert(renewals>=4);assert(reads<=182&&claims<=182);assert(performance.now()-start>=45000);
  workEvidence.followerTimeout={elapsedMs:performance.now()-start,reads,failedClaims:claims,heldOwnerRenewals:renewals,admission:0};
 });
 console.log('TIMING_START '+new Date().toISOString());
 for(let round=0;round<5;round++){
  const order=['combined','separate','floor-only'];for(let s=0;s<round%3;s++)order.push(order.shift());
  for(const variant of order)for(const scenario of ['distinct','hot']){
   await reset();const results=[];
   // Ten synchronized waves of 20 leaders, balanced over two adapter processes.
   for(let wave=0;wave<10;wave++)results.push(...await Promise.all(Array.from({length:20},(_,i)=>send(i,variant,scenario==='hot'?[dim('hot:'+round+':'+variant,600000,5)]:[dim('n:'+wave+':'+i,1000,1000),dim('u:'+wave+':'+i,1000,100)]))));
   const successes=results.filter(r=>r.row.outcome==='allow'),denials=results.filter(r=>r.row.outcome!=='allow');
   trials.push({round:round+1,variant,scenario,success:dist(successes.map(r=>r.elapsedMs)),denied:dist(denials.map(r=>r.elapsedMs)),sqlStatements:results.reduce((s,r)=>s+r.statements,0),processIds:[...new Set(results.map(r=>r.pid))]});
   console.log(JSON.stringify(trials.at(-1)));
  }
 }
 await reset();
 await q('INSERT INTO spike223.quota(remaining,used,requested_at) SELECT 1000000,0,clock_timestamp()-i*interval \'1 second\' FROM generate_series(1,9999) i');
 await q('ANALYZE spike223.quota');
 plans.floor=(await q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT remaining FROM spike223.quota WHERE remaining IS NOT NULL ORDER BY requested_at DESC LIMIT 1')).rows[0]['QUERY PLAN'];
 plans.admission=(await q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM spike223.admit($1::jsonb,true,100,9)',[JSON.stringify([dim('plan-n'),dim('plan-u')])])).rows[0]['QUERY PLAN'];
 await q('TRUNCATE spike223.buckets');
 await q(`INSERT INTO spike223.buckets(subject,minute,admitted,denied,would_deny,anonymous,signed_in)
 SELECT 'v1:fixture:'||(i%10000),date_trunc('minute',clock_timestamp())-(i/10000)*interval '13 hours',
 1+(i%13),i%7,i%5,CASE WHEN i%2=0 THEN 1 ELSE 0 END,CASE WHEN i%2=1 THEN 1 ELSE 0 END FROM generate_series(0,99999) i`);
 await q('ANALYZE spike223.buckets');
 assert.equal((await one('SELECT count(*)::int n,count(DISTINCT subject)::int subjects FROM spike223.buckets')).n,100000);
 const reportTimes=[];let report;
 for(let i=0;i<10;i++){const t=performance.now();report=(await aggregate()).rows;reportTimes.push(performance.now()-t);}
 assert(report.every(r=>r.top_admitted.length===20&&r.top_denied.length===20&&r.top_would_deny.length===20));
 const queryConfig=aggregate.toString().match(/q\(`([\s\S]*?)`\)/)[1];
 plans.report=(await q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+queryConfig)).rows[0]['QUERY PLAN'];
 plans.admissionVariants=[];
 for(let i=0;i<5;i++)for(const rotation of [false,true]){
  const dims=[dim('buf-n-'+i,1000,100,{keys:rotation?['buf-n-'+i,'buf-old-n-'+i]:['buf-n-'+i]}),dim('buf-u-'+i,1000,100,{keys:rotation?['buf-u-'+i,'buf-old-u-'+i]:['buf-u-'+i]})];
  const plan=(await q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM spike223.admit($1::jsonb,true,100,9)',[JSON.stringify(dims)])).rows[0]['QUERY PLAN'];
  plans.admissionVariants.push({rotation,plan});
 }
 plans.subject=(await q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM spike223.subjects WHERE subject=$1 FOR UPDATE',['plan-n'])).rows[0]['QUERY PLAN'];
 const hashes={};for(const f of ['q0.sql','worker.mjs','harness.mjs'])hashes[f]=createHash('sha256').update(await readFile(resolve(here,f))).digest('hex');
 const receipt={spike:'223-paid-leader-gcra-and-visibility',fixture:'223-20-leaders-two-instances',started,finished:new Date().toISOString(),gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),schema:'spike223',lane:'lane-2',tier:'standard',workerPids:workers.map(w=>w.pid),tests,trials,workEvidence,report:{rows:100000,subjects:10000,timing:dist(reportTimes),sample:report},plans,checks,hashes,
 limitations:['Mock identity adapter only; actual Firebase header integration is checkpoint work.','No hosted Neon latency proof; local pg TCP round trips are only a comparator.','Outer live/legacy app threading and runtime health not implemented in scratch.','Function Scan buffers aggregate internal work; floor/index/report plans captured separately.','Separate-call candidate is latency comparator only; cannot preserve no-TAT-advance on a later floor refusal.']};
 await writeFile(resolve(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
 console.log('REPORT '+JSON.stringify(receipt.report.timing));
}catch(error){await writeFile(resolve(output,'failure.json'),JSON.stringify({started,failed:new Date().toISOString(),tests,trials,error:{message:error.message,code:error.code,stack:error.stack}},null,2)+'\n');throw error;}
finally{
 for(const w of workers){w.child.send({op:'stop'});}
 if(schemaCreated)await q('DROP SCHEMA spike223 CASCADE');
 await pool.end();await lease.end();
 await writeFile(resolve(output,'cleanup.json'),JSON.stringify({schemaRemoved:schemaCreated,laneLeaseReleased:owned,at:new Date().toISOString()})+'\n');
}
