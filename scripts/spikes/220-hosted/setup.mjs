// Pure fixture generation. No connection, credential generation or hosted API.
import { randomUUID } from 'node:crypto';
import { schedule } from './plan.mjs';
import { sampleKey, validateBinding } from '../../../apps/web/src/lib/qualification220-core.mjs';
export const markets=['player_pass_yds','player_pass_tds','player_pass_completions','player_pass_attempts','player_pass_interceptions','player_rush_yds','player_rush_attempts','player_reception_yds','player_receptions','player_anytime_td','player_1st_td','player_last_td'];
export const groupKey=s=>[s.stage,s.workers,s.round,s.mode].join(':');
export function tickets() {
  return schedule().map(s=>({sample:sampleKey(s),group:groupKey(s),mode:s.mode,
    // 20 independent keys exercise account contention, not same-item followers.
    resource:`event${s.index%20}/player_pass_yds`,dimensions:[`network-${s.index%20}`,`user-${s.index%20}`],owner:randomUUID()}));
}
export function prepareGroup(group,quota,runId) {
  if(!/^[a-f0-9-]{36}$/.test(runId??''))throw new Error('missing arm run ID');
  const activate={text:"UPDATE spike220.hosted_run SET active_group=CASE WHEN id=$2::uuid THEN $1 ELSE 'paused' END",values:[group,runId]};
  if(!/^(warmup|warm|cold|stale|next-tick):(1|20):[0-2]:(baseline|admission|path)$/.test(group))throw new Error('invalid group');
  if(group.startsWith('next-tick:'))return [activate];
  if(!Number.isSafeInteger(quota.remaining)||quota.remaining<(group.startsWith('stale:')?20:20000)||!Number.isSafeInteger(quota.used)||quota.used<0)throw new Error('insufficient fixture quota');
  // This is operator-only on an isolated test schema, between fully drained groups.
  // Warm trials use synthetic counters. Stale trials require a real free snapshot
  // with matching total, initialized BEFORE timing, then only age its timestamp.
  return [{text:'SELECT count(*)::int AS active FROM spike220.resources WHERE lease_until>clock_timestamp()',values:[],requireZero:'active'},
    {text:'TRUNCATE spike220.resources,spike220.subjects,spike220.attempts',values:[]},
    {text:"SELECT spike220.initialize_budget($1,$2,clock_timestamp(),'fixture-period',20)",values:[quota.remaining,quota.used]},
    {text:"UPDATE spike220.budget SET observed_at=observed_at-interval '6 minutes' WHERE id=1 AND $1",values:[group.startsWith('stale:')]},
    activate];
}
export function roleGrants(role,database) {
  if(!/^spike220_runner_[a-f0-9]{12}$/.test(role)||!/^[_a-zA-Z][_a-zA-Z0-9]{0,62}$/.test(database))throw new Error('invalid role/database');
  return `REVOKE ALL ON SCHEMA spike220 FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA spike220 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA spike220 FROM PUBLIC;
GRANT USAGE ON SCHEMA spike220 TO "${role}";
GRANT SELECT ON spike220.catalog TO "${role}";
REVOKE SELECT ON spike220.hosted_run FROM "${role}";
GRANT SELECT(id,expires_at,active_group,runner) ON spike220.hosted_run TO "${role}";
GRANT SELECT,UPDATE ON spike220.hosted_tickets TO "${role}";
GRANT SELECT,INSERT,UPDATE ON spike220.resources,spike220.subjects,spike220.budget,spike220.attempts,spike220.quota_probe TO "${role}";
-- admit removes a non-admitted attempt if freshness changes under its lock.
GRANT DELETE ON spike220.attempts TO "${role}";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA spike220 TO "${role}";
REVOKE TEMPORARY ON DATABASE "${database}" FROM PUBLIC;
ALTER ROLE "${role}" IN DATABASE "${database}" SET statement_timeout='5s';
ALTER ROLE "${role}" IN DATABASE "${database}" SET lock_timeout='2s';
ALTER ROLE "${role}" IN DATABASE "${database}" SET idle_in_transaction_session_timeout='5s';`;
}

export function initialization(binding,expiresAt,{includeFixture=true}={}) {
  validateBinding(binding);
  if(!Number.isFinite(Date.parse(expiresAt)))throw new Error('invalid private setup');
  const rows=tickets();
  const statements=[
    {text:"INSERT INTO spike220.catalog SELECT 'event'||i||'/'||market FROM generate_series(0,19) i CROSS JOIN unnest($1::text[]) market",values:[markets]},
    {text:"SELECT spike220.initialize_budget(100000,0,clock_timestamp(),'fixture-period',20)",values:[]},
    {text:'INSERT INTO spike220.hosted_run(id,expires_at,active_group,runner,max_tickets) VALUES($1,$2,$3,$4,$5)',values:[binding.runId,expiresAt,rows[0].group,binding.neon.role,rows.length]},
    {text:`INSERT INTO spike220.hosted_tickets(run_id,sample,group_name,mode,resource_keys,dimensions,owner_id)
      SELECT $1,x.sample,x."group",x.mode,ARRAY[x.resource],x.dimensions,x.owner::uuid
      FROM jsonb_to_recordset($2::jsonb) AS x(sample text,"group" text,mode text,resource text,dimensions text[],owner text)`,values:[binding.runId,JSON.stringify(rows)]},
    {text:'SELECT count(*)::int AS tickets FROM spike220.hosted_tickets WHERE run_id=$1',values:[binding.runId],requireCount:rows.length}
  ];
  return includeFixture?statements:statements.slice(2);
}
