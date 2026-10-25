// Unrouted, disposable local candidate. No client construction or environment reads.
export const candidateSchema = "bench61_candidate_20261024";
export const candidateRole = "bench61_candidate_worker_20261024";
// Shared by the guard (shared) and cleanup (exclusive) transaction fences.
export const candidateFence = "610061,20261025";
const s = '"' + candidateSchema + '"';
export type CandidateMode = "baseline" | "debit" | "correction";
export type CandidateContext = {owner:string;request:string;account:string;period:string};
type Rows = Record<string,unknown>[];
export type CandidateQuery = (text:string,params:unknown[])=>Promise<Rows>;
export type CandidateStatement = {text:string;params?:unknown[]};
const guard = `WITH guard AS MATERIALIZED (SELECT ${s}.guard($1,$2))`;
const eligible = `account=$3 AND period=$4 AND active AND $5::bigint>0
  AND observed_at<=clock_timestamp() AND observed_at>=clock_timestamp()-interval '5 minutes'
  AND balance-$5::bigint>=CASE WHEN $6::boolean THEN floor ELSE 0 END`;
// pg_backend_pid() lets a trial count the distinct backends that served it, so
// pool queueing is not mistaken for row-lock contention.
export const candidateSql = (mode:CandidateMode) => {
  if(mode==="baseline")return `${guard} SELECT balance,pg_backend_pid() AS pid FROM ${s}.budgets,guard WHERE ${eligible}`;
  if(mode==="debit")return `${guard} UPDATE ${s}.budgets SET balance=balance-$5::bigint FROM guard
    WHERE ${eligible} RETURNING balance,pg_backend_pid() AS pid`;
  if(mode==="correction")return `${guard} UPDATE ${s}.budgets
    SET balance=LEAST(balance,$5::bigint),observed_at=$6::timestamptz FROM guard
    WHERE account=$3 AND period=$4 AND active AND $5::bigint>=0
      AND $6::timestamptz>=observed_at AND $6::timestamptz<=clock_timestamp() RETURNING balance,pg_backend_pid() AS pid`;
  throw new Error("Unknown candidate mode");
};
const amount = (value:number) => {
  if(!Number.isSafeInteger(value)||value<0)throw new Error("Invalid candidate amount");
  return value;
};
const base = (context:CandidateContext) => [context.owner,context.request,context.account,context.period];
// One builder per mode, so a debit flag can never be bound as a correction time.
export const debitParams = (context:CandidateContext,value:number,interactive:boolean):unknown[] =>
  [...base(context),amount(value),interactive];
export const baselineParams = debitParams;
export const correctionParams = (context:CandidateContext,value:number,observedAt:string):unknown[] => {
  if(typeof observedAt!=="string"||!Number.isFinite(Date.parse(observedAt)))throw new Error("Invalid correction observation");
  return [...base(context),amount(value),observedAt];
};
// Setup runs inside one caller transaction. The worker password reaches SQL only as
// a bind parameter, read back through a transaction-local setting.
export const candidateSetupStatements = (context:CandidateContext,password:string):CandidateStatement[] => [
  {text:"SELECT set_config('bench61.candidate_password',$1,true),set_config('bench61.candidate_owner',$2,true)",params:[password,context.owner]},
  {text:`DO $role$ BEGIN
    IF to_regnamespace('${candidateSchema}') IS NOT NULL OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${candidateRole}') THEN
      RAISE EXCEPTION 'refuse existing candidate schema or role';
    END IF;
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 24',
      '${candidateRole}',current_setting('bench61.candidate_password'));
    EXECUTE format('ALTER ROLE %I IN DATABASE %I SET statement_timeout=%L','${candidateRole}',current_database(),'5s');
    EXECUTE format('ALTER ROLE %I IN DATABASE %I SET lock_timeout=%L','${candidateRole}',current_database(),'2s');
    EXECUTE format('COMMENT ON ROLE %I IS %L','${candidateRole}',current_setting('bench61.candidate_owner'));
   END $role$`},
  {text:`CREATE SCHEMA ${s}`},
  // operations/active_action let multi-request hosted actions refuse replays and overlap.
  {text:`CREATE TABLE ${s}.run(owner text NOT NULL,request uuid NOT NULL,lease_until timestamptz NOT NULL,
    operations text[] NOT NULL DEFAULT '{}',active_action text)`},
  {text:`INSERT INTO ${s}.run(owner,request,lease_until) VALUES($1,$2,clock_timestamp()+interval '5 minutes')`,params:[context.owner,context.request]},
  {text:`CREATE TABLE ${s}.budgets(account text PRIMARY KEY,period text NOT NULL,balance bigint NOT NULL CHECK(balance>=0),
    floor bigint NOT NULL CHECK(floor>=0),observed_at timestamptz NOT NULL,active boolean NOT NULL)`},
  {text:`INSERT INTO ${s}.budgets VALUES($1,$2,100,20,clock_timestamp(),true)`,params:[context.account,context.period]},
  {text:`CREATE FUNCTION ${s}.guard(who text,req uuid) RETURNS void LANGUAGE plpgsql AS $guard$ DECLARE r record; BEGIN
    PERFORM pg_advisory_xact_lock_shared(${candidateFence}); SELECT * INTO r FROM ${s}.run;
    IF r.owner IS DISTINCT FROM who OR r.request IS DISTINCT FROM req OR r.lease_until<=clock_timestamp() THEN
      RAISE EXCEPTION 'candidate owner/request/lease refused';
    END IF; END $guard$`},
  {text:`REVOKE ALL ON FUNCTION ${s}.guard(text,uuid) FROM PUBLIC`},
  {text:`GRANT USAGE ON SCHEMA ${s} TO ${candidateRole}`},
  {text:`GRANT SELECT ON ${s}.run TO ${candidateRole}`},
  {text:`GRANT SELECT,UPDATE ON ${s}.budgets TO ${candidateRole}`},
  {text:`GRANT EXECUTE ON FUNCTION ${s}.guard(text,uuid) TO ${candidateRole}`},
];
// Cleanup runs inside one caller transaction: exclusive fence, ownership of both
// schema and role, then drop. Any mismatch or in-flight guarded work raises.
export const candidateCleanupStatements = (owner:string):CandidateStatement[] => [
  {text:"SELECT set_config('bench61.candidate_owner',$1,true)",params:[owner]},
  {text:`DO $cleanup$ DECLARE run_owner text; role_owner text; BEGIN
    IF NOT pg_try_advisory_xact_lock(${candidateFence}) THEN RAISE EXCEPTION 'candidate work still in flight'; END IF;
    SELECT owner INTO run_owner FROM ${s}.run;
    SELECT shobj_description(oid,'pg_authid') INTO role_owner FROM pg_roles WHERE rolname='${candidateRole}';
    IF run_owner IS DISTINCT FROM current_setting('bench61.candidate_owner')
      OR role_owner IS DISTINCT FROM current_setting('bench61.candidate_owner') THEN
      RAISE EXCEPTION 'candidate ownership mismatch';
    END IF;
    DROP SCHEMA "${candidateSchema}" CASCADE;
    EXECUTE format('DROP ROLE %I','${candidateRole}');
   END $cleanup$`},
];
// Counts successful/denied operations separately. No retries or provider sends.
// An error stops new dispatches; all already-started queries settle before return.
export const runCandidateBatch = async (query:CandidateQuery,mode:CandidateMode,params:unknown[],count:number,workers:number) => {
  if(!Number.isInteger(count)||count<1||count>1000||!Number.isInteger(workers)||workers<1||workers>20)
    throw new Error("Candidate workload outside local cap");
  const text=candidateSql(mode);
  const pids=new Set<unknown>();
  let next=0,started=0,admitted=0,denied=0,failed=false,failure:unknown;
  const results=await Promise.allSettled(Array.from({length:Math.min(workers,count)},async()=>{
    while(!failed && next<count){
      next++;started++;
      try{
        const rows=await query(text,params);
        if(rows.length){admitted++;pids.add(rows[0].pid);}else denied++;
      }
      catch(error){if(!failed){failed=true;failure=error;}break;}
    }
  }));
  // Worker logic should not throw outside its query catch, but preserve draining
  // even if an unexpected injected adapter error occurs.
  const unexpected=results.find(result=>result.status==="rejected");
  if(unexpected?.status==="rejected")throw unexpected.reason;
  if(failed)throw failure;
  return {started,admitted,denied,backends:pids.size,roundTrips:started,submittedStatements:started};
};
