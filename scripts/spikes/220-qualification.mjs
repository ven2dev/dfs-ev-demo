// Local synthetic Iteration 3. No dotenv, ambient DB URL, HTTP or provider client.
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const {Pool}=createRequire(import.meta.url)(process.argv[2]);
const cfg={host:'127.0.0.1',port:54362,user:'dfs_ev_test',password:'dfs_ev_test',database:'dfs_ev_test',max:20,
  options:'-c statement_timeout=5000 -c lock_timeout=2000'};
const a=new Pool(cfg),b=new Pool(cfg),tests=[],trials=[];let calls=0,created=false,receipt;
const CAP=60000;
const q=async(p,sql,args=[])=>{assert(++calls<=CAP,'query-call budget exceeded');return p.query(sql,args);};
const one=async(p,sql,args=[])=> (await q(p,sql,args)).rows[0];
const source=await readFile(new URL('../../apps/web/src/lib/playerPropMarkets.ts',import.meta.url),'utf8');
const markets=[...source.matchAll(/key: "(player_[a-z0-9_]+)"/g)].map(x=>x[1]);assert.equal(markets.length,12);
const key=(event=0,market=0)=>`event${event}/${markets[market]}`;
const keys=Array.from({length:20},(_,i)=>markets.map((_,j)=>key(i,j))).flat();
const reset=async()=>{await q(a,'TRUNCATE spike220.resources,spike220.subjects,spike220.budget,spike220.attempts');
  await q(a,`INSERT INTO spike220.budget(id,balance,floor,observed_at,provider_remaining,provider_used,quota_total,period) VALUES(1,100000,20,clock_timestamp(),100000,0,100000,'fixture-period')`);
  await q(a,'UPDATE spike220.quota_probe SET owner=NULL,lease_until=NULL,retry_after=NULL');};
const test=async(name,fn)=>{await reset();await fn();tests.push(name);console.log('PASS '+name);};
const admit=(p,resources=[key()],owner=randomUUID(),dims=['network'],rate=60000,burst=1)=>
 one(p,'SELECT * FROM spike220.admit($1,$2,$3,$4,$5,30000)',[resources,owner,dims,
   Array.isArray(rate)?rate:dims.map(()=>rate),Array.isArray(burst)?burst:dims.map(()=>burst)]);
const snapshot=async()=> (await q(a,'SELECT subject,tat::text FROM spike220.subjects ORDER BY subject')).rows;
const leases=async()=> (await q(a,'SELECT resource,owner FROM spike220.resources WHERE owner IS NOT NULL')).rows;
const stamp=async()=> (await one(a,'SELECT clock_timestamp()::text AS t')).t;
const release=(p,resources,owner)=>q(p,'UPDATE spike220.resources SET owner=NULL,lease_until=NULL WHERE resource=ANY($1) AND owner=$2',[resources,owner]);
const publish=(p,resources,owner)=>q(p,`UPDATE spike220.resources SET payload='{"synthetic":true}',fetched_at=clock_timestamp(),owner=NULL,lease_until=NULL
 WHERE resource=ANY($1) AND owner=$2 AND lease_until>clock_timestamp() RETURNING resource`,[resources,owner]);
const stale=(p,resources)=>q(p,`INSERT INTO spike220.resources(resource,payload,fetched_at)
 SELECT x,'{"old":true}'::jsonb,clock_timestamp()-interval '6 minutes' FROM unnest($1::text[]) x
 ON CONFLICT(resource) DO UPDATE SET fetched_at=clock_timestamp()-interval '6 minutes',payload='{"old":true}'`,[resources]);
const parallel=async(n,fn)=>{let next=0;const out=await Promise.allSettled(Array.from({length:20},async()=>{while(next<n)await fn(next++);}));
 const failure=out.find(x=>x.status==='rejected');if(failure)throw failure.reason;};
const dist=x=>{const s=x.toSorted((a,b)=>a-b);return {samples:s.length,p50_ms:s[Math.ceil(s.length*.5)-1],p95_ms:s[Math.ceil(s.length*.95)-1],max_ms:s.at(-1)};};
const read=(p,resources)=>q(p,`SELECT resource,payload,fetched_at>clock_timestamp()-interval '5 minutes' AS fresh FROM spike220.resources WHERE resource=ANY($1)`,[resources]);
let freeCalls=0,freeMode='ok',freeSnapshot={remaining:100,used:0,last:0};
const ensureQuota=async(p)=>{
 const owner=randomUUID();
 for(let poll=0;poll<200;poll++){
  const claim=(await one(p,'SELECT spike220.claim_probe($1) AS state',[owner])).state;
  if(claim==='fresh')return true;if(claim==='backoff')return false;
  if(claim==='follower'){await new Promise(r=>setTimeout(r,5));continue;}
  assert.equal(claim,'leader');freeCalls++;
  // Models fetchSlateEvents outside any transaction. Exactly zero provider
  // credits; real HTTP and real credentials are deliberately absent.
  await new Promise(r=>setTimeout(r,15));
  const row={...freeSnapshot}; // independent mocked upstream state, not the local budget
  const failed=freeMode==='failure';
  const state=(await one(p,"SELECT spike220.finish_probe($1,$2,$3,$4,'fixture-period',$5) AS state",
   [owner,failed?null:row.remaining,failed?null:row.used,await stamp(),failed?null:row.last])).state;
  if(state==='accepted')return true;
  return (await one(p,"SELECT observed_at>clock_timestamp()-interval '5 minutes' AS fresh FROM spike220.budget")).fresh;
 }return false;
};
const fetchMock=async(p,resources,subject)=>{
 const cached=(await read(p,resources)).rows;
 if(cached.length===resources.length&&cached.every(x=>x.fresh&&x.payload))return {kind:'fresh'};
 const owner=randomUUID();let gate=await admit(p,resources,owner,[subject]);
 if(gate.outcome==='quota-stale'){
  if(!await ensureQuota(p))return cached.length===resources.length&&cached.every(x=>x.payload)
   ?{kind:'stale',stale:true,reason:'quota-observation-unavailable'}:{kind:'quota-observation-unavailable'};
  gate=await admit(p,resources,owner,[subject]);
 }
 if(['denied','budget-refused'].includes(gate.outcome)){
  return cached.length===resources.length&&cached.every(x=>x.payload)
   ?{kind:'stale',stale:true,reason:gate.outcome}
   :{kind:gate.outcome==='denied'?'rate-limited':'budget-refused'};
 }
 if(gate.outcome!=='leader')return {kind:gate.outcome};
 // Mock send is permitted once only on a newly committed leader result.
 await publish(p,gate.resources,owner);return {kind:'provider-mock',attempt:gate.attempt_id};
};
try{
 assert((await one(a,"SELECT to_regnamespace('spike220') IS NULL AS absent")).absent,'refuse an existing schema');
 const sql=await readFile(new URL('../../packages/db/proposals/220_atomic_leader_gcra.sql',import.meta.url),'utf8');
 await q(a,sql);created=true;
 await q(a,'INSERT INTO spike220.catalog SELECT x FROM unnest($1::text[]) x',[keys]);
 await test('held lease: follower never evaluates GCRA or reserves credit',async()=>{
  const first=await admit(a);const before=await snapshot(),balance=await one(a,'SELECT balance FROM spike220.budget');
  assert.equal(first.outcome,'leader');assert.equal((await admit(b,[key()],randomUUID(),['untouched'])).outcome,'follower');
  assert.deepEqual(await snapshot(),before);assert.deepEqual(await one(a,'SELECT balance FROM spike220.budget'),balance);
 });
 await test('rate denial: no lease/TAT advancement and another subject can lead immediately',async()=>{
  await admit(a,[key(0,0)],randomUUID(),['limited']);const before=await snapshot();
  assert.equal((await admit(b,[key(0,1)],randomUUID(),['limited'])).outcome,'denied');assert.deepEqual(await snapshot(),before);
  assert.equal((await one(a,'SELECT owner FROM spike220.resources WHERE resource=$1',[key(0,1)])).owner,null);
  assert.equal((await admit(a,[key(0,1)],randomUUID(),['other'])).outcome,'leader');
 });
 await test('budget refusal: no GCRA charge, no lease, no provider reservation; next subject is not blocked',async()=>{
  await q(a,"INSERT INTO spike220.subjects VALUES('n','-infinity')");const before=await snapshot();
  await q(a,'UPDATE spike220.budget SET balance=floor,provider_remaining=floor+pending_reserved,quota_total=floor+pending_reserved+provider_used');
  assert.equal((await admit(a,[key()],randomUUID(),['n'])).outcome,'budget-refused');
  assert.deepEqual(await snapshot(),before);assert.deepEqual(await leases(),[]);
  assert.equal((await one(a,'SELECT count(*)::int AS n FROM spike220.attempts WHERE admitted')).n,0);
  await q(a,'UPDATE spike220.budget SET balance=100,provider_remaining=100+pending_reserved,quota_total=100+pending_reserved+provider_used');assert.equal((await admit(b,[key()],randomUUID(),['other'])).outcome,'leader');
 });
 await test('multi-market request: one GCRA charge, one reservation, sorted leases and exact stale-market cost',async()=>{
  const owner=randomUUID(),r=await admit(a,[key(0,2),key(0,0),key(0,1)],owner);
  assert.equal(r.outcome,'leader');assert.equal(r.resources.length,3);
  assert.equal((await one(a,'SELECT count(*)::int AS n FROM spike220.attempts')).n,1);
  assert.equal((await one(a,'SELECT cost FROM spike220.attempts')).cost,3);
  assert.equal((await one(a,'SELECT count(*)::int AS n FROM spike220.subjects')).n,1);
  assert.equal((await one(a,'SELECT balance FROM spike220.budget')).balance,99997);
 });
 await test('partial overlap: no partial leases or charge; after publish, only missing markets are reserved',async()=>{
  const owner=randomUUID();await admit(a,[key(0,1)],owner,['first']);const before=await snapshot();
  assert.equal((await admit(b,[key(0,0),key(0,1)],randomUUID(),['second'])).outcome,'follower');assert.deepEqual(await snapshot(),before);
  assert.equal((await one(a,'SELECT owner FROM spike220.resources WHERE resource=$1',[key(0,0)]))?.owner??null,null);
  await publish(a,[key(0,1)],owner);const r=await admit(b,[key(0,1),key(0,0)],randomUUID(),['second']);
  assert.deepEqual(r.resources,[key(0,0)]);assert.equal((await one(a,'SELECT balance FROM spike220.budget')).balance,99998);
 });
 await test('reverse-order overlapping market batches and subject arrays do not deadlock or double charge',async()=>{
  const result=await Promise.all(Array.from({length:20},(_,i)=>admit(i%2?a:b,i%2?[key(0,1),key(0,0)]:[key(0,0),key(0,1)],randomUUID(),i%2?['n','u']:['u','n'])));
  assert.equal(result.filter(x=>x.outcome==='leader').length,1);assert.equal((await one(a,'SELECT count(*)::int AS n FROM spike220.attempts')).n,1);
 });
 await test('coarser network and stricter user dimensions remain all-or-none',async()=>{
  for(let i=0;i<6;i++)assert.equal((await admit(a,[key(i)],randomUUID(),['n','u'],[1000,10000],[30,6])).outcome,'leader');
  const before=await snapshot();assert.equal((await admit(b,[key(6)],randomUUID(),['n','u'],[1000,10000],[30,6])).outcome,'denied');
  assert.deepEqual(await snapshot(),before);assert.equal((await admit(b,[key(6)],randomUUID(),['n','other'],[1000,10000],[30,6])).outcome,'leader');
 });
 await test('twenty distinct eligible paid leaders all admit without an artificial concurrency ceiling',async()=>{
  const result=await Promise.all(Array.from({length:20},(_,i)=>admit(i%2?a:b,[key(i)],randomUUID(),['n'+i,'u'+i])));
  assert.equal(result.filter(x=>x.outcome==='leader').length,20);
 });
 await test('freshness recheck under locks prevents a second leader after racing publish',async()=>{
  const owner=randomUUID();await admit(a,[key()],owner);await publish(a,[key()],owner);const before=await snapshot();
  assert.equal((await admit(b,[key()],randomUUID(),['other'])).outcome,'fresh');assert.deepEqual(await snapshot(),before);
 });
 await test('a held-lease follower bypasses a locked subject row',async()=>{
  await admit(a);const c=await a.connect();try{await q(c,'BEGIN');await q(c,"SELECT 1 FROM spike220.subjects WHERE subject='network' FOR UPDATE");
   assert.equal((await admit(b)).outcome,'follower');await q(c,'ROLLBACK');}finally{c.release();}
 });
 await test('new lease attempt gets a new reservation on every later refresh of the same key',async()=>{
  const first=await fetchMock(a,[key()],'a');assert.equal(first.kind,'provider-mock');await stale(a,[key()]);
  const second=await fetchMock(b,[key()],'b');assert.equal(second.kind,'provider-mock');assert.notEqual(first.attempt,second.attempt);
  assert.equal((await one(a,'SELECT count(*)::int AS n FROM spike220.attempts WHERE admitted')).n,2);
 });
 await test('same attempt replay cannot grant a new lease, charge GCRA again or send provider work',async()=>{
  const owner=randomUUID();await admit(a,[key()],owner,['a'],1,10000);await release(a,[key()],owner);const before=await snapshot();
  assert.equal((await admit(b,[key()],owner,['a'],1,10000)).outcome,'replay');assert.deepEqual(await snapshot(),before);assert.deepEqual(await leases(),[]);
 });
 await test('both GCRA and budget denials serve flagged stale values; absent cache yields typed denials',async()=>{
  await stale(a,[key()]);await q(a,'UPDATE spike220.budget SET balance=floor,provider_remaining=floor+pending_reserved,quota_total=floor+pending_reserved+provider_used');
  assert.deepEqual(await fetchMock(a,[key()],'n'),{kind:'stale',stale:true,reason:'budget-refused'});
  assert.equal((await fetchMock(a,[key(1)],'n')).kind,'budget-refused');assert.deepEqual(await leases(),[]);
  await q(a,'UPDATE spike220.budget SET balance=100,provider_remaining=100+pending_reserved,quota_total=100+pending_reserved+provider_used');await admit(a,[key(2)],randomUUID(),['limited']);
  assert.deepEqual(await fetchMock(b,[key()],'limited'),{kind:'stale',stale:true,reason:'denied'});
  assert.equal((await fetchMock(b,[key(1)],'limited')).kind,'rate-limited');
 });
 await test('fresh cache hit performs one existing read and zero added limiter/budget calls',async()=>{
  await q(a,"INSERT INTO spike220.resources(resource,payload,fetched_at) VALUES($1,'{}',clock_timestamp())",[key()]);
  const before=calls;assert.equal((await fetchMock(a,[key()],'n')).kind,'fresh');assert.equal(calls-before,1);
  assert.equal((await one(a,'SELECT count(*)::int AS n FROM spike220.subjects')).n,0);
  assert.equal((await one(a,'SELECT count(*)::int AS n FROM spike220.attempts')).n,0);
 });
 const seed=async(total=100)=>q(a,'UPDATE spike220.budget SET balance=$1::int,provider_remaining=$1::int,provider_used=0,quota_total=$1::int,pending_reserved=0,floor=20,observed_at=clock_timestamp()',[total]);
 const liabilityInvariant=async()=>{
  const r=await one(a,`SELECT pending_reserved::text AS pending,
    (SELECT coalesce(sum(liability),0)::text FROM spike220.attempts WHERE admitted AND NOT settled) AS ledger,
    balance,greatest(0,provider_remaining::bigint-pending_reserved)::int AS expected FROM spike220.budget`);
  assert.equal(r.pending,r.ledger);assert.equal(r.balance,r.expected);
 };
 const reconcile=async(id,actual,remaining,used,observed)=>one(a,
  "SELECT spike220.reconcile($1,$2,$3,$4,$5,'fixture-period') AS state",[id,actual,remaining,used,observed??await stamp()]);
 await test('concurrent cheaper calls resync upward after out-of-order responses without normal-use drift',async()=>{
  await seed();await q(a,"SELECT * FROM spike220.reserve('a',3,false)");await q(a,"SELECT * FROM spike220.reserve('b',3,false)");
  assert.equal((await one(a,'SELECT balance FROM spike220.budget')).balance,94);
  await reconcile('b',1,98,2);assert.equal((await one(a,'SELECT balance FROM spike220.budget')).balance,95);
  await reconcile('a',1,99,1);assert.equal((await one(a,'SELECT balance FROM spike220.budget')).balance,98);
  assert.equal((await one(a,'SELECT provider_used FROM spike220.budget')).provider_used,2);await liabilityInvariant();
 });
 await test('twenty overlapping reservations reconcile in shuffled order to the true provider balance',async()=>{
  await seed(1000);let used=0;const responses=[];
  for(let i=0;i<20;i++){await q(a,'SELECT * FROM spike220.reserve($1,3,false)',['batch'+i]);const actual=i%4;used+=actual;
   responses.push({id:'batch'+i,actual,remaining:1000-used,used});}
  const order=[19,0,18,1,17,2,16,3,15,4,14,5,13,6,12,7,11,8,10,9];
  for(const i of order){const r=responses[i];await reconcile(r.id,r.actual,r.remaining,r.used);await liabilityInvariant();}
  assert.equal((await one(a,'SELECT balance FROM spike220.budget')).balance,1000-used);
  assert.equal((await one(a,'SELECT pending_reserved::int AS n FROM spike220.budget')).n,0);
 });
 await test('a late older higher reading cannot overwrite a newer lower snapshot',async()=>{
  await seed();await q(a,"SELECT * FROM spike220.reserve('old',3,false)");await q(a,"SELECT * FROM spike220.reserve('new',3,false)");
  await reconcile('new',3,50,50);await q(a,"SELECT * FROM spike220.reserve('after',3,false)");
  await reconcile('old',0,99,1); // old provider snapshot, despite later arrival
  const r=await one(a,'SELECT balance,provider_remaining,provider_used FROM spike220.budget');
  assert.deepEqual(r,{balance:47,provider_remaining:50,provider_used:50});await liabilityInvariant();
 });
 await test('fresh response updates observation time beyond setup plus five minutes; exact replay is inert',async()=>{
  await seed();await q(a,"SELECT * FROM spike220.reserve('a',3,false)");
  await q(a,"UPDATE spike220.budget SET observed_at=clock_timestamp()-interval '6 minutes'");
  const observed=await stamp();await reconcile('a',1,99,1,observed);
  assert.equal((await one(a,'SELECT observed_at::text AS t FROM spike220.budget')).t,observed);
  await q(a,"SELECT * FROM spike220.reserve('b',3,false)");const before=await one(a,'SELECT balance,pending_reserved::text,observed_at::text FROM spike220.budget');
  assert.equal((await reconcile('a',1,99,1,observed)).state,'replay');
  assert.deepEqual(await one(a,'SELECT balance,pending_reserved::text,observed_at::text FROM spike220.budget'),before);await liabilityInvariant();
 });
 await test('actual over-reservation cost is recorded, balance can reach zero, and anomaly blocks further paid work',async()=>{
  await seed(25);await q(a,"SELECT * FROM spike220.reserve('over',3,false)");
  await reconcile('over',25,0,25);
  assert.deepEqual(await one(a,'SELECT balance,cost_overrun FROM spike220.budget'),{balance:0,cost_overrun:true});
  assert.deepEqual(await one(a,"SELECT actual,overrun,settled FROM spike220.attempts WHERE id='over'"),{actual:25,overrun:true,settled:true});
  assert.equal((await one(a,"SELECT * FROM spike220.reserve('later',1,false)")).admitted,false);await liabilityInvariant();
 });
 await test('missing headers still record overrun cost and retain enlarged unresolved liability',async()=>{
  await seed();await q(a,"SELECT * FROM spike220.reserve('missing',3,false)");
  assert.equal((await reconcile('missing',8,null,null,await stamp())).state,'invalid');
  assert.deepEqual(await one(a,"SELECT actual,liability,settled FROM spike220.attempts WHERE id='missing'"),{actual:8,liability:8,settled:false});
  assert.deepEqual(await one(a,'SELECT balance,pending_reserved::int AS pending,cost_overrun FROM spike220.budget'),{balance:92,pending:8,cost_overrun:true});await liabilityInvariant();
 });
 await test('invalid/future metadata cannot restore credit but trusted metadata can later settle the recorded cost',async()=>{
  await seed();await q(a,"SELECT * FROM spike220.reserve('a',3,false)");
  const future=(await one(a,"SELECT (clock_timestamp()+interval '1 minute')::text AS t")).t;
  assert.equal((await reconcile('a',1,99,1,future)).state,'invalid');
  assert.equal((await one(a,'SELECT balance FROM spike220.budget')).balance,97);await liabilityInvariant();
  await reconcile('a',1,99,1);assert.equal((await one(a,'SELECT balance FROM spike220.budget')).balance,99);await liabilityInvariant();
 });
 await test('free observation retains unresolved in-flight liability and detects reset without granting a new period',async()=>{
  await seed();await q(a,"SELECT * FROM spike220.reserve('inflight',3,false)");
  await q(a,"SELECT spike220.observe(90,10,clock_timestamp(),'fixture-period')");
  assert.equal((await one(a,'SELECT balance FROM spike220.budget')).balance,87);await liabilityInvariant();
  await q(a,"UPDATE spike220.budget SET observed_at=clock_timestamp()-interval '6 minutes'");
  assert.equal((await one(a,"SELECT spike220.observe(100,0,clock_timestamp(),'fixture-period') AS state")).state,'older-or-reset');
  assert.equal((await admit(b,[key()],randomUUID(),['n'])).outcome,'quota-stale');await liabilityInvariant();
 });
 await test('without WAF/GCRA the single account still protects interactive floor and collector reserve',async()=>{
  await q(a,'UPDATE spike220.budget SET balance=100,floor=20,provider_remaining=100,quota_total=100');let admitted=0,collected=0;
  await parallel(1000,async i=>{if((await one(i%2?a:b,'SELECT * FROM spike220.reserve($1,3,false)',['i'+i])).admitted)admitted++;});
  await parallel(100,async i=>{if((await one(i%2?a:b,'SELECT * FROM spike220.reserve($1,3,true)',['c'+i])).admitted)collected++;});
  assert.equal(admitted,26);assert.equal(collected,7);assert.equal((await one(a,'SELECT balance FROM spike220.budget')).balance,1);
  assert.equal((await one(a,"SELECT * FROM spike220.reserve('i0',3,false)")).replay,true);
  await assert.rejects(q(a,"SELECT * FROM spike220.reserve('i0',4,false)"));
 });
 await test('explicit rollback removes debit, lease, ledger and GCRA together',async()=>{
  const c=await a.connect();try{await q(c,'BEGIN');await admit(c);await q(c,'ROLLBACK');}finally{c.release();}
  assert.deepEqual(await leases(),[]);assert.deepEqual(await snapshot(),[]);
  assert.equal((await one(a,'SELECT count(*)::int AS n FROM spike220.attempts')).n,0);assert.equal((await one(a,'SELECT balance FROM spike220.budget')).balance,100000);
 });
 await test('server statement/lock timeouts fail safely without a partial combined admission',async()=>{
  const c=await a.connect();try{await q(c,'BEGIN');await q(c,"SET LOCAL statement_timeout='30ms'");
   await assert.rejects(q(c,'SELECT pg_sleep(0.2)'),e=>e.code==='57014');await q(c,'ROLLBACK');}finally{c.release();}
  await q(a,"INSERT INTO spike220.subjects VALUES('n','-infinity')");const blocker=await a.connect();
  const limited=new Pool({...cfg,max:1,options:'-c statement_timeout=500 -c lock_timeout=30'});
  try{await q(blocker,'BEGIN');await q(blocker,"SELECT 1 FROM spike220.subjects WHERE subject='n' FOR UPDATE");
   await assert.rejects(admit(limited,[key()],randomUUID(),['n']),e=>e.code==='55P03');await q(blocker,'ROLLBACK');
   assert.deepEqual(await leases(),[]);assert.equal((await one(a,'SELECT balance FROM spike220.budget')).balance,100000);
  }finally{blocker.release();await limited.end();}
 });
 await test('expired/replaced lease owners cannot publish',async()=>{
  const old=randomUUID(),fresh=randomUUID();await admit(a,[key()],old,['old']);
  await q(a,"UPDATE spike220.resources SET lease_until=clock_timestamp()-interval '1 second'");await admit(b,[key()],fresh,['fresh']);
  assert.equal((await publish(a,[key()],old)).rowCount,0);assert.equal((await publish(b,[key()],fresh)).rowCount,1);
 });
 await test('uncatalogued events/markets and duplicate market dimensions create no state',async()=>{
  await assert.rejects(admit(a,['unknown/event']));await assert.rejects(admit(a,[key(),key()]));
  assert.equal((await one(a,'SELECT count(*)::int AS n FROM spike220.resources')).n,0);
 });
 await test('twenty stale callers for different markets coalesce into one account-wide free observation',async()=>{
  freeCalls=0;freeMode='ok';freeSnapshot={remaining:70,used:30,last:0};await seed();
  await q(a,"UPDATE spike220.budget SET observed_at=clock_timestamp()-interval '6 minutes'");
  const result=await Promise.all(Array.from({length:20},(_,i)=>fetchMock(i%2?a:b,[key(i)],'n'+i)));
  assert.equal(freeCalls,1);assert.equal(result.filter(x=>x.kind==='provider-mock').length,20);
  assert.deepEqual(await one(a,'SELECT balance,provider_remaining,provider_used FROM spike220.budget'),{balance:50,provider_remaining:70,provider_used:30});await liabilityInvariant();
 });
 await test('fresh cache hits and held paid-lease followers never trigger free quota observation',async()=>{
  freeCalls=0;freeMode='ok';const owner=randomUUID();await admit(a,[key()],owner);await publish(a,[key()],owner);
  await admit(a,[key(1)],randomUUID(),['other']);
  await q(a,"UPDATE spike220.budget SET observed_at=clock_timestamp()-interval '6 minutes'");
  assert.equal((await fetchMock(a,[key()],'n')).kind,'fresh');assert.equal((await fetchMock(b,[key(1)],'n')).kind,'follower');assert.equal(freeCalls,0);
 });
 await test('one failed free probe backs off concurrent followers and never admits paid work',async()=>{
  freeCalls=0;freeMode='failure';await seed();await q(a,"UPDATE spike220.budget SET observed_at=clock_timestamp()-interval '6 minutes'");
  const result=await Promise.all(Array.from({length:20},(_,i)=>fetchMock(i%2?a:b,[key(i)],'n'+i)));
  assert.equal(freeCalls,1);assert(result.every(x=>x.kind==='quota-observation-unavailable'));
  assert.deepEqual(await leases(),[]);assert.deepEqual(await snapshot(),[]);
  assert.equal((await one(a,'SELECT count(*)::int AS n FROM spike220.attempts')).n,0);freeMode='ok';
 });
 await test('a failed free observation still serves an eligible visibly stale cached value',async()=>{
  freeCalls=0;freeMode='failure';await seed();await stale(a,[key()]);
  await q(a,"UPDATE spike220.budget SET observed_at=clock_timestamp()-interval '6 minutes'");
  assert.deepEqual(await fetchMock(a,[key()],'n'),{kind:'stale',stale:true,reason:'quota-observation-unavailable'});
  assert.equal(freeCalls,1);assert.deepEqual(await leases(),[]);assert.deepEqual(await snapshot(),[]);freeMode='ok';
 });
 await test('free probe recovers after failure backoff without needing a paid quota refresh',async()=>{
  freeCalls=0;freeMode='failure';await seed();await q(a,"UPDATE spike220.budget SET observed_at=clock_timestamp()-interval '6 minutes'");
  assert.equal((await fetchMock(a,[key()],'n')).kind,'quota-observation-unavailable');assert.equal(freeCalls,1);
  freeMode='ok';freeSnapshot={remaining:100,used:0,last:0};
  await q(a,"UPDATE spike220.quota_probe SET retry_after=clock_timestamp()-interval '1 second'");
  assert.equal((await fetchMock(b,[key()],'n')).kind,'provider-mock');assert.equal(freeCalls,2);await liabilityInvariant();
 });
 await test('unexpected cost on the nominally free observation is recorded and flags the breaker',async()=>{
  freeCalls=0;freeMode='ok';freeSnapshot={remaining:98,used:2,last:2};await seed();
  await q(a,"UPDATE spike220.budget SET observed_at=clock_timestamp()-interval '6 minutes'");
  assert.equal((await fetchMock(a,[key()],'n')).kind,'budget-refused');assert.equal(freeCalls,1);
  assert.deepEqual(await one(a,'SELECT actual,overrun FROM spike220.attempts WHERE cost=0'),{actual:2,overrun:true});
  assert.equal((await one(a,'SELECT cost_overrun FROM spike220.budget')).cost_overrun,true);await liabilityInvariant();
 });
 await test('expired free-probe owners cannot apply snapshots; a replacement owner can recover',async()=>{
  await seed();await q(a,"UPDATE spike220.budget SET observed_at=clock_timestamp()-interval '6 minutes'");
  const old=randomUUID(),fresh=randomUUID();assert.equal((await one(a,'SELECT spike220.claim_probe($1) AS s',[old])).s,'leader');
  await q(a,"UPDATE spike220.quota_probe SET lease_until=clock_timestamp()-interval '1 second'");
  assert.equal((await one(b,'SELECT spike220.claim_probe($1) AS s',[fresh])).s,'leader');
  assert.equal((await one(a,"SELECT spike220.finish_probe($1,100,0,clock_timestamp(),'fixture-period') AS s",[old])).s,'owner-expired');
  assert.equal((await one(b,"SELECT spike220.finish_probe($1,100,0,clock_timestamp(),'fixture-period') AS s",[fresh])).s,'accepted');
 });
 await test('catalog caps every allowed market subset at 240 per-market resource rows',async()=>{
  // Enumerate every nonempty subset. Materialize flattened individual keys,
  // never a market-set key. Logical payload bound uses a 4 KiB fixture per row.
  const all=new Set();let combinations=0;
  for(let e=0;e<20;e++)for(let mask=1;mask<2**markets.length;mask++){
   combinations++;for(let j=0;j<markets.length;j++)if(mask&(1<<j))all.add(key(e,j));}
  assert.equal(combinations,81900);assert.equal(all.size,240);
  await q(a,`INSERT INTO spike220.resources(resource,payload,fetched_at) SELECT x,jsonb_build_object('data',repeat('x',4096)),clock_timestamp() FROM unnest($1::text[]) x`,[[...all]]);
  const size=await one(a,`SELECT count(*)::int AS rows,sum(octet_length(payload::text))::int AS logical_bytes,pg_total_relation_size('spike220.resources')::int AS physical_bytes FROM spike220.resources`);
  assert.equal(size.rows,240);assert(size.logical_bytes<=1048576);
  receipt={cacheFixture:{events:20,markets:markets.length,nonemptyRequestedSets:combinations,resourceRows:size.rows,
   logicalBytes:size.logical_bytes,physicalBytes:size.physical_bytes,rowBudget:240,logicalBudgetBytes:1048576,
   limitation:'synthetic 4 KiB payload; production payload limit/retention and trusted catalog refresh require review'}};
 });
 for(const workers of process.argv.includes('--behavior-only')?[]:[1,20])for(let round=0;round<3;round++){
  const result={workers,round,samplesPerMode:1000,modes:{}};
  for(const mode of round%2?['paid-path','shared','atomic','baseline']:['baseline','atomic','shared','paid-path']){
   await reset();const times=[];let next=0;
   await Promise.all(Array.from({length:workers},(_,worker)=>(async()=>{for(;;){const i=next++;if(i>=1000)return;
    const p=worker%2?a:b,resource=[key(worker)],owner=randomUUID(),start=performance.now();
    if(mode==='baseline')await read(p,resource);
    else{if(mode==='paid-path')await read(p,resource);
     const r=await admit(p,resource,owner,mode==='shared'?['n','u']:['n'+worker,'u'+worker],10000,10000);
     assert.equal(r.outcome,'leader');}
    times.push(performance.now()-start);
    // Simulated post-provider release; counted in work cap, outside pre-provider timing.
    if(mode!=='baseline')await release(p,resource,owner);
   }})()));result.modes[mode]=dist(times);
  }trials.push(result);console.log('TRIAL '+JSON.stringify(result));
 }
 receipt={...receipt,iteration:3,base:'71cdd90e11cbee7ec6b0eb1961322d40c49a20e9',
  tests,trials,queryCalls:calls,queryCallCap:CAP,sqlSha256:createHash('sha256').update(sql).digest('hex'),
  fixture:{port:54362,postgres:(await one(a,'SHOW server_version')).server_version,memoryMiB:512,transport:'local pg TCP; no managed HTTP claim'},
  workBudgets:{freshHitAddedStatements:0,freshHitAddedRoundTrips:0,combinedAdmissionLeaseGcraAndBudgetStatements:1,
   combinedAdmissionLocalRoundTrips:1,mockPaidPathStatementsIncludingCacheRead:2,mockPaidPathLocalRoundTrips:2,
   maxResourceRowsLockedPerRequest:12,maxSubjectRowsLockedPerRequest:2,quotaObservation:'stale path: one account-wide claim, one mocked free /events, one fenced snapshot finish; followers bounded-poll with one claim query per poll; fresh path unchanged',
   pendingAggregate:'updated under account row lock; audited against SUM of unsettled ledger liabilities in behavior tests, not scanned on admission',
   lockOrder:'sorted resource rows, sorted subject rows, single budget row',
   internalWork:'catalog lookup; up to 12 inserts/locks/freshness reads; up to two GCRA inserts/locks/checks/updates; account lock, attempt lookup, conditional debit and audit insert; lease updates',
   postProviderRelease:'one counted query outside pre-provider timing; real publication/renewal outside this mock budget'},
  limitations:['local-only; no production route wiring, HMAC/auth or managed transport proof','on-demand zero-credit observation coalesced across markets in mocks only; no real /events integration or period rollover approval',
   'WAF exhaustion availability unverified; no WAF assumption needed for credit correctness','200/140 ms and log-only policy values remain owner decisions']};
}finally{
 if(created){await a.query('DROP SCHEMA spike220 CASCADE');const x=await a.query("SELECT to_regnamespace('spike220') IS NULL AS absent");if(receipt)receipt.cleanup={schemaAbsent:x.rows[0].absent};}
 await Promise.all([a.end(),b.end()]);
}
if(receipt){await writeFile(new URL('../../docs/evidence/220-qualification/local-iteration-3.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');console.log('RECEIPT saved');}
