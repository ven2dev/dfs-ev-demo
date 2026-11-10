// Explicit local fixture only. No dotenv, URLs, provider calls or hosted mode.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createQualificationQuery } from '../../../apps/web/src/lib/qualification220-pg.mjs';
import { roleGrants, prepareGroup } from './setup.mjs';
const localPort = key => {
 const port=Number(process.env[key]);
 assert.ok(Number.isInteger(port) && port>=1024 && port<=65535,'explicit disposable fixture port required');
 return port;
};
const cfg={host:'127.0.0.1',port:localPort('SPIKE220_LOCAL_POSTGRES_PORT'),database:'spike220_fixture',user:'spike220_fixture',max:20};
const pooledPort=localPort('SPIKE220_LOCAL_POOL_PORT');
assert.notEqual(cfg.port,pooledPort);
const admin=new pg.Pool(cfg),role='spike220_runner_123456abcdef';
const runnerUrl=`postgresql://${role}@127.0.0.1:${pooledPort}/${cfg.database}?sslmode=verify-full`;
const single=createQualificationQuery(runnerUrl,{max:1});
const run=randomUUID();let created=false,roleCreated=false,runner;const cases=[];
const q=(text,args=[])=>admin.query(text,args);
const sample=async(key,mode='admission',resource='event0/player_pass_yds',dimensions=['network-'+key,'user-'+key])=>{
 await q(`INSERT INTO spike220.hosted_tickets(run_id,sample,group_name,mode,resource_keys,dimensions,owner_id) VALUES($1,$2,'active',$3,$4,$5,$6)`,[run,key,mode,[resource],dimensions,randomUUID()]);
};
const query=async(text,args=[])=> (await runner(text,args)).rows;
try{
 assert.deepEqual((await q('SELECT current_database() AS name, current_user AS role')).rows[0],
  {name:cfg.database,role:cfg.user});
 assert.equal((await q("SELECT to_regnamespace('spike220') IS NULL AS absent")).rows[0].absent,true);
 assert.equal((await q('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=$1',[role])).rows[0].n,0);
 await q(await readFile(new URL('../../../packages/db/proposals/220_atomic_leader_gcra.sql',import.meta.url),'utf8'));created=true;
 await q(await readFile(new URL('../../../packages/db/proposals/220_hosted_harness.sql',import.meta.url),'utf8'));
 await q(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);roleCreated=true;
 await q(roleGrants(role,cfg.database));
 await q(`INSERT INTO spike220.hosted_run VALUES($1,clock_timestamp()+interval '1 hour','active',$2,20000)`,[run,role]);
 await q("INSERT INTO spike220.catalog SELECT 'event'||i||'/player_pass_yds' FROM generate_series(0,19) i");
 await q("INSERT INTO spike220.budget(id,balance,floor,observed_at,provider_remaining,provider_used,quota_total,period) VALUES(1,100000,20,clock_timestamp(),100000,0,100000,'fixture-period')");
 runner=createQualificationQuery(runnerUrl);
 const poolAdmin=new pg.Client({host:'127.0.0.1',port:pooledPort,database:'pgbouncer',user:cfg.user,ssl:{rejectUnauthorized:true}});
 await poolAdmin.connect();
 try { assert.equal((await poolAdmin.query('SHOW CONFIG')).rows.find(x=>x.key==='pool_mode').value,'transaction'); }
 finally { await poolAdmin.end(); }
 const second=createQualificationQuery(runnerUrl,{max:1});
 try {
  const a=(await single('SELECT pg_backend_pid() AS pid, current_user AS role',[])).rows[0];
  const b=(await second('SELECT pg_backend_pid() AS pid, current_user AS role',[])).rows[0];
  assert.equal(a.role,role);assert.deepEqual(a,b);
 } finally {await second.close();}
 cases.push('transaction mode confirmed, distinct frontends reuse one backend with runner identity');
 const fresh=await runner('SELECT $1::int AS n',[220],{fresh:true});
 assert.equal(fresh.rows[0].n,220);assert.ok(fresh.checkoutMs>=0);
 cases.push('fresh verified-TLS client uses the real adapter and unnamed bind');
 const wrongHost=createQualificationQuery(runnerUrl.replace('127.0.0.1','localhost'),{max:1});
 try { await assert.rejects(wrongHost('SELECT 1',[]),e=>e.code==='ERR_TLS_CERT_ALTNAME_INVALID'); }
 finally {await wrongHost.close();}
 cases.push('adapter refuses a trusted certificate issued for the wrong host');
 for(const setting of ['statement_timeout','lock_timeout','idle_in_transaction_session_timeout'])assert.notEqual((await query('SHOW '+setting))[0][setting],'0');
 cases.push('restricted connection inherits server timeouts before first statement');
 await assert.rejects(query('SELECT pg_sleep(6)'),e=>e.code==='57014');cases.push('statement timeout cancels active statement');
 const held=await admin.connect();
 try {
  await held.query('BEGIN');
  await held.query('SELECT 1 FROM spike220.budget FOR UPDATE');
  await assert.rejects(query('SELECT 1 FROM spike220.budget FOR UPDATE'),e=>e.code==='55P03');
 } finally {
  await held.query('ROLLBACK');held.release();
 }
 cases.push('server lock timeout refuses a contended row through the pool');
 const idle=(await single('BEGIN',[])).rows;
 assert.deepEqual(idle,[]);
 const [{pid}]=(await single('SELECT pg_backend_pid() AS pid',[])).rows;
 const deadline=Date.now()+8_000;
 while((await q('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[pid])).rowCount) {
  assert.ok(Date.now()<deadline,'idle transaction backend survived');
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.equal((await single('SELECT 1 AS recovered',[])).rows[0].recovered,1);
 cases.push('server idle transaction timeout terminates backend and adapter recovers');
 await assert.rejects(query('UPDATE spike220.hosted_run SET active_group=active_group'),e=>e.code==='42501');
 await assert.rejects(query('CREATE TABLE spike220.forbidden(id int)'),e=>e.code==='42501');
 await assert.rejects(query("INSERT INTO spike220.hosted_tickets SELECT * FROM spike220.hosted_tickets"),e=>e.code==='42501');await assert.rejects(query('SELECT max_tickets FROM spike220.hosted_run'),e=>e.code==='42501');
 assert.equal((await query('SELECT id,expires_at,active_group,runner FROM spike220.hosted_run')).length,1);
 assert.equal((await q("SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='spike220' AND p.prosecdef")).rows[0].n,0);
 cases.push('column-limited run reads and SECURITY INVOKER; runner cannot change phases, mint tickets or create tables');
 await sample('one');
 await assert.rejects(query('SELECT * FROM spike220.hosted_begin($1,$2,false)',[run,'one']));
 assert.equal((await q('SELECT state FROM spike220.hosted_tickets WHERE run_id=$1 AND sample=$2',[run,'one'])).rows[0].state,'pending');
 await assert.rejects(query('SELECT * FROM spike220.hosted_sample($1,$2,false)',[randomUUID(),'one']));
 assert.equal((await query('SELECT * FROM spike220.hosted_sample($1,$2,false)',[run,'one']))[0].outcome,'leader');
 await assert.rejects(query('SELECT * FROM spike220.hosted_sample($1,$2,false)',[run,'one']));
 await query('SELECT spike220.hosted_release($1,$2)',[run,'one']);cases.push('admission ticket refuses path claim without mutation; missing run and replay fenced');
 await sample('path','path');
 assert.equal((await query('SELECT * FROM spike220.hosted_begin($1,$2,false)',[run,'path']))[0].outcome,'claimed');
 assert.equal((await query('SELECT * FROM spike220.hosted_sample($1,$2,true)',[run,'path']))[0].outcome,'leader');
 await query('SELECT spike220.hosted_release($1,$2)',[run,'path']);cases.push('separate cache-read/admission path and owner-fenced release');
 for(let i=0;i<20;i++)await sample('wave'+i,'admission',`event${i}/player_pass_yds`);
 const result=await Promise.all(Array.from({length:20},(_,i)=>query('SELECT * FROM spike220.hosted_sample($1,$2,false)',[run,'wave'+i])));
 assert.ok(result.every(x=>x[0].outcome==='leader'));cases.push('20 independent connections admit distinct leaders through shared account');
 for(let i=0;i<20;i++) {
  await query('SELECT spike220.hosted_release($1,$2)',[run,'wave'+i]);
  await sample('same'+i,'admission',`event${i}/player_pass_yds`,['control-network','control-user']);
 }
 const same=await Promise.all(Array.from({length:20},(_,i)=>query('SELECT * FROM spike220.hosted_sample($1,$2,false)',[run,'same'+i])));
 assert.ok(same.every(x=>x[0].outcome==='leader'));
 cases.push('20 leaders share subject rows across distinct resources');
 const before=(await q('SELECT count(*)::int AS n FROM spike220.attempts')).rows[0].n;
 await sample('follower');
 assert.equal((await query('SELECT * FROM spike220.hosted_sample($1,$2,false)',[run,'follower']))[0].outcome,'follower');
 assert.equal((await q('SELECT count(*)::int AS n FROM spike220.attempts')).rows[0].n,before);
 assert.equal((await q("SELECT count(*)::int AS n FROM spike220.subjects WHERE subject LIKE '%follower'")).rows[0].n,0);
 cases.push('same-resource follower consumes neither a credit reservation nor a subject charge');
 await q("UPDATE spike220.resources SET owner=NULL,lease_until=NULL");await sample('stale','path');
 await q("UPDATE spike220.budget SET observed_at=clock_timestamp()-interval '6 minutes'");
 await query('SELECT * FROM spike220.hosted_begin($1,$2,false)',[run,'stale']);
 const stale=(await query('SELECT * FROM spike220.hosted_sample($1,$2,true)',[run,'stale']))[0];assert.equal(stale.outcome,'quota-stale');
 assert.equal((await query('SELECT spike220.claim_probe($1) AS state',[stale.owner]))[0].state,'leader');
 assert.equal((await query('SELECT spike220.claim_probe($1) AS state',[randomUUID()]))[0].state,'follower');
 assert.equal((await query("SELECT spike220.finish_probe($1,100000,0,clock_timestamp(),'fixture-period',0) AS state",[stale.owner]))[0].state,'accepted');
 const retried=(await query('SELECT * FROM spike220.hosted_sample($1,$2,true)',[run,'stale']))[0];
 assert.equal(retried.outcome,'leader');assert.notEqual(retried.owner,stale.owner);cases.push('stale quota transition accepts single probe then retries one ticket');
 await q("UPDATE spike220.resources SET owner=NULL,lease_until=NULL");
 await q("UPDATE spike220.quota_probe SET needs_init=true,failures=4,health_reason='quota-counter-reset',suspect_reason='older-or-reset'");
 for(const statement of prepareGroup('stale:20:0:path',{remaining:100000,used:0},run))await q(statement.text,statement.values);
 const reset=(await q('SELECT * FROM spike220.quota_probe')).rows[0];
 assert.equal(reset.needs_init,false);assert.equal(reset.failures,0);assert.equal(reset.health_reason,null);assert.equal(reset.suspect_reason,null);
 assert.equal((await query('SELECT spike220.claim_probe($1) AS state',[randomUUID()]))[0].state,'leader');
 cases.push('setup clears prior-run terminal latch via initialize_budget; first stale probe leads');
 const otherRun=randomUUID();await q("INSERT INTO spike220.hosted_run VALUES($1,clock_timestamp()+interval '1 hour','paused',$2,20000)",[otherRun,role]);
 const activate=prepareGroup('next-tick:20:0:path',{},otherRun)[0];await q(activate.text,activate.values);
 assert.equal((await q('SELECT active_group FROM spike220.hosted_run WHERE id=$1',[run])).rows[0].active_group,'paused');
 assert.equal((await q('SELECT active_group FROM spike220.hosted_run WHERE id=$1',[otherRun])).rows[0].active_group,'next-tick:20:0:path');
 await sample('expired');await q("UPDATE spike220.hosted_run SET expires_at=clock_timestamp()-interval '1 second'");
 await assert.rejects(query('SELECT * FROM spike220.hosted_sample($1,$2,false)',[run,'expired']));
 await assert.rejects(query('SELECT * FROM spike220.hosted_begin($1,$2,false)',[run,'expired']));
 await assert.rejects(query('SELECT spike220.hosted_release($1,$2)',[run,'one']));cases.push('group activation pauses other run; expired begin/sample/release still fenced');
 console.log(JSON.stringify({fixture:'disposable PostgreSQL 18, 512 MiB, TLS PgBouncer in transaction mode',cases,passed:cases.length}));
}finally{
 await single.close();
 await runner?.close();
 if(created)await q('DROP SCHEMA spike220 CASCADE');
 if(roleCreated){await q(`DROP OWNED BY ${role}`);await q(`DROP ROLE ${role}`);}
 assert.equal((await q("SELECT to_regnamespace('spike220') IS NULL AS absent")).rows[0].absent,true);
 await admin.end();
}
