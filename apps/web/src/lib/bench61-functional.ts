import {createHash,randomUUID,timingSafeEqual} from "node:crypto";
import {performance} from "node:perf_hooks";
import {neon} from "@neondatabase/serverless";
import {proveServerLockCancellation,qualifyHttpTimeout,timeoutRole} from "./bench61-timeout";
import config from "./bench61-config.json";

// Disposable, fixed synthetic target; no provider or application imports.
export const functionalSchema = "bench61_http_role_20261022";
const s = '"' + functionalSchema + '"';
const fence = "610061,20261024";
export type FunctionalAction = "setup" | "qualify" | "catalog" | "cleanup";
const actions: readonly string[] = ["setup","qualify","catalog","cleanup"];
const ensure = (value: unknown, reason: string) => {if(!value)throw new Error(reason);};
export const functionalIdentity = (env: Record<string,string|undefined>, workerRequired: boolean) => {
  const operator = new URL(env.DATABASE_URL ?? "");
  const database = decodeURIComponent(operator.pathname.slice(1));
  ensure(["postgres:","postgresql:"].includes(operator.protocol) && operator.hostname === config.host
    && database === config.database,"Operator target mismatch");
  ensure([...operator.searchParams.keys()].every(key=>["sslmode","channel_binding"].includes(key)),
    "Unsupported operator connection options");
  if(workerRequired) {
    const worker = new URL(env.BENCH61_DATABASE_URL ?? "");
    ensure(worker.protocol === operator.protocol && worker.port === operator.port
      && worker.hostname === operator.hostname && decodeURIComponent(worker.pathname.slice(1)) === config.database
      && decodeURIComponent(worker.username) === timeoutRole && worker.password.length>=32,
    "Dedicated worker target mismatch");
    ensure(worker.search === operator.search,"Worker connection options differ");
  }
  return {host:operator.hostname,database};
};
const identityReasons: Record<string,string> = {"Operator target mismatch":"operator_target_mismatch",
  "Unsupported operator connection options":"operator_options_unsupported",
  "Dedicated worker target mismatch":"worker_target_mismatch","Worker connection options differ":"worker_options_differ"};
// Every failed condition as a fixed code, never a value, so one refused request
// diagnoses delivery (missing vs mismatched) without a public diagnostic response.
export const admissionRefusals = (token: unknown,action: unknown,env: Record<string,string|undefined> = process.env,now=Date.now()) => {
  const reasons: string[] = [];
  if(env.VERCEL_ENV!=="preview")reasons.push("not_preview");
  if(env.VERCEL_REGION!=="iad1")reasons.push("region_not_iad1");
  if(typeof action!=="string" || !actions.includes(action))reasons.push("action_not_admitted");
  if(typeof token!=="string" || token.length!==64)reasons.push("token_malformed");
  const reviewed=env.BENCH61_REVIEWED_SHA,commit=env.VERCEL_GIT_COMMIT_SHA;
  if(!reviewed)reasons.push("reviewed_sha_missing");
  else if(!/^[a-f0-9]{40}$/.test(reviewed))reasons.push("reviewed_sha_invalid");
  if(!commit)reasons.push("commit_sha_missing");
  else if(reviewed && commit!==reviewed)reasons.push("commit_sha_mismatch");
  if(!env.BENCH61_ISSUED_AT || !env.BENCH61_EXPIRES_AT)reasons.push("token_window_missing");
  else {
    const issued=Date.parse(env.BENCH61_ISSUED_AT),expires=Date.parse(env.BENCH61_EXPIRES_AT);
    if(!Number.isFinite(issued) || !Number.isFinite(expires) || expires<=issued || expires-issued>86400000)reasons.push("token_window_invalid");
    else if(now<issued)reasons.push("token_not_yet_valid");
    else if(now>=expires)reasons.push("token_expired");
  }
  const hash=env.BENCH61_TOKEN_HASH;
  if(!hash)reasons.push("token_hash_missing");
  else if(!/^[a-f0-9]{64}$/.test(hash))reasons.push("token_hash_invalid");
  const workerRequired=action==="setup" || action==="qualify";
  if(!env.DATABASE_URL)reasons.push("operator_url_missing");
  else if(workerRequired && !env.BENCH61_DATABASE_URL)reasons.push("worker_url_missing");
  else try {functionalIdentity(env,workerRequired);}
  catch(error){reasons.push(identityReasons[(error as Error).message] ?? "connection_url_invalid");}
  // Compared only when every other condition passes, as before.
  if(reasons.length===0 && !timingSafeEqual(createHash("sha256").update(token as string).digest(),Buffer.from(hash!,"hex")))
    reasons.push("token_mismatch");
  return reasons;
};
export const authorizeFunctional = (token: unknown,action: unknown,env: Record<string,string|undefined> = process.env,now=Date.now()) =>
  admissionRefusals(token,action,env,now).length===0;

export const executeFunctional = async (action: FunctionalAction) => {
  ensure(actions.includes(action),"Unknown functional action");
  const env=process.env,identity=functionalIdentity(env,action==="setup" || action==="qualify");
  const owner=env.BENCH61_TOKEN_HASH!;
  ensure(/^[a-f0-9]{64}$/.test(owner),"Missing experiment owner");
  const request=randomUUID(),sql=neon(env.DATABASE_URL!);
  let trips=0,statements=0;
  const batch = async (queries: {text:string;params?:unknown[]}[]) => {
    ensure(++trips<=220 && statements+queries.length<=440,"Functional work budget exceeded");
    statements+=queries.length;
    return await sql.transaction(queries.map(q=>sql.query(q.text,q.params ?? [])),{
      fetchOptions:{signal:AbortSignal.timeout(10000)},
    });
  };
  const admin = async (text:string,params:unknown[]=[]) => (await batch([
    {text:"SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true)"},
    {text,params},
  ]))[1];
  const fenced = async (text:string,params:unknown[]=[],claim=false) => (await batch([
    {text:"SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true)"},
    {text:`SELECT ${s}.guard($1,$2,$3)`,params:[owner,request,claim]},
    {text,params},
  ]))[2];
  const meta={host:identity.host,database:identity.database,schema:functionalSchema,role:timeoutRole,
    region:env.VERCEL_REGION,sha:env.VERCEL_GIT_COMMIT_SHA,reviewedSha:env.BENCH61_REVIEWED_SHA,
    expiresAt:env.BENCH61_EXPIRES_AT,ownerFingerprint:owner,performanceEnabled:false};
  const cleanup = async () => {
    // One transaction: absence, ownership, fence, lease and drop. No one-shot claim.
    const result=await batch([
      {text:"SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true),set_config('bench61.owner',$1,true)",params:[owner]},
      {text:`DO $cleanup$ DECLARE actual text; live timestamptz; role_owner text; worker_oid oid; worker_sessions integer;
       BEGIN
        IF NOT pg_try_advisory_xact_lock(${fence}) THEN RAISE EXCEPTION 'workload transaction still in flight'; END IF;
        IF to_regnamespace('${functionalSchema}') IS NOT NULL THEN
          SELECT r.owner,r.lease_until INTO actual,live FROM ${s}.run r WHERE id=1 FOR UPDATE;
          IF actual IS DISTINCT FROM current_setting('bench61.owner') THEN RAISE EXCEPTION 'schema owner mismatch'; END IF;
          IF live>clock_timestamp() THEN RAISE EXCEPTION 'workload lease still live'; END IF;
        END IF;
        SELECT oid,shobj_description(oid,'pg_authid') INTO worker_oid,role_owner FROM pg_roles WHERE rolname='${timeoutRole}';
        IF FOUND AND role_owner IS DISTINCT FROM current_setting('bench61.owner') THEN RAISE EXCEPTION 'role owner mismatch'; END IF;
        IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE usesysid=worker_oid AND state='active') THEN
          RAISE EXCEPTION 'worker still active';
        END IF;
        IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE usesysid=worker_oid AND state IS NULL) THEN
          RAISE EXCEPTION 'worker activity cannot be verified';
        END IF;
        SELECT count(*) INTO worker_sessions FROM pg_stat_activity WHERE usesysid=worker_oid;
        PERFORM set_config('bench61.worker_sessions',CASE WHEN worker_oid IS NULL THEN 'unknown' ELSE worker_sessions::text END,true);
        PERFORM set_config('bench61.worker_oid',COALESCE(worker_oid::text,'unknown'),true);
        IF to_regnamespace('${functionalSchema}') IS NOT NULL THEN DROP SCHEMA ${s} CASCADE; END IF;
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${timeoutRole}') THEN DROP ROLE ${timeoutRole}; END IF;
       END $cleanup$`},
      {text:"SELECT to_regnamespace($1) IS NULL AS schema_absent,NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) AS role_absent,NULLIF(current_setting('bench61.worker_sessions',true),'unknown')::integer AS worker_sessions_before_drop,NULLIF(current_setting('bench61.worker_oid',true),'unknown')::oid AS worker_oid_before_drop",params:[functionalSchema,timeoutRole]},
    ]);
    ensure(result[2][0].schema_absent && result[2][0].role_absent,"Cleanup absence not confirmed");
    return {schemaAbsent:true,roleAbsent:true,workerSessionsBeforeDrop:result[2][0].worker_sessions_before_drop,
      workerOidBeforeDrop:result[2][0].worker_oid_before_drop,sessionsTerminated:false};
  };
  if(action==="cleanup")return {...meta,...await cleanup(),roundTrips:trips,statements};
  if(action==="setup") {
    const credential=new URL(env.BENCH61_DATABASE_URL!);
    // All setup, including role creation, commits atomically or rolls back.
    await batch([
      {text:"SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true),set_config('bench61.owner',$1,true),set_config('bench61.password',$2,true)",
        params:[owner,decodeURIComponent(credential.password)]},
      {text:`DO $role$ BEGIN
        IF NOT pg_try_advisory_xact_lock(${fence}) THEN RAISE EXCEPTION 'setup busy'; END IF;
        IF to_regnamespace('${functionalSchema}') IS NOT NULL OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${timeoutRole}') THEN
          RAISE EXCEPTION 'refuse existing schema or role';
        END IF;
        EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8',
          '${timeoutRole}',current_setting('bench61.password'));
        EXECUTE format('ALTER ROLE %I IN DATABASE %I SET statement_timeout=%L','${timeoutRole}',current_database(),'5s');
        EXECUTE format('ALTER ROLE %I IN DATABASE %I SET lock_timeout=%L','${timeoutRole}',current_database(),'2s');
        EXECUTE format('COMMENT ON ROLE %I IS %L','${timeoutRole}',current_setting('bench61.owner'));
       END $role$`},
      {text:`CREATE SCHEMA ${s}`},
      {text:`CREATE TABLE ${s}.run(id integer PRIMARY KEY CHECK(id=1),owner text NOT NULL,
        operations text[] NOT NULL DEFAULT '{}',active_action text,lease_request uuid,lease_until timestamptz)`},
      {text:`INSERT INTO ${s}.run(id,owner) VALUES(1,$1)`,params:[owner]},
      {text:`CREATE TABLE ${s}.budgets(account text PRIMARY KEY,balance integer NOT NULL CHECK(balance>=0),
        floor integer NOT NULL,observed_at timestamptz NOT NULL,active boolean NOT NULL)`},
      {text:`INSERT INTO ${s}.budgets VALUES('timeout-proof',100,20,clock_timestamp(),true)`},
      {text:`CREATE FUNCTION ${s}.guard(who text,req uuid,claiming boolean) RETURNS void LANGUAGE plpgsql SET lock_timeout='2s' AS $guard$
        DECLARE r record; BEGIN
        PERFORM pg_advisory_xact_lock_shared(${fence});
        SELECT * INTO r FROM ${s}.run WHERE id=1;
        IF r.owner IS DISTINCT FROM who THEN RAISE EXCEPTION 'schema owner mismatch'; END IF;
        IF NOT claiming AND (r.lease_request IS DISTINCT FROM req OR r.lease_until IS NULL OR r.lease_until<=clock_timestamp()) THEN
          RAISE EXCEPTION 'workload lease expired or mismatched';
        END IF; END $guard$`},
      {text:`REVOKE ALL ON FUNCTION ${s}.guard(text,uuid,boolean) FROM PUBLIC`},
      {text:`GRANT USAGE ON SCHEMA ${s} TO ${timeoutRole}`},
      {text:`GRANT SELECT ON ${s}.run TO ${timeoutRole}`},
      {text:`GRANT SELECT,UPDATE ON ${s}.budgets TO ${timeoutRole}`},
      {text:`GRANT EXECUTE ON FUNCTION ${s}.guard(text,uuid,boolean) TO ${timeoutRole}`},
    ]);
    return {...meta,setup:true,roundTrips:trips,statements};
  }
  const claim=await fenced(`UPDATE ${s}.run SET active_action=$1,lease_request=$2,
    lease_until=clock_timestamp()+interval '300 seconds',operations=array_append(operations,$1)
    WHERE id=1 AND owner=$3 AND active_action IS NULL AND NOT ($1=ANY(operations)) RETURNING id`,
  [action,request,owner],true);
  ensure(claim.length===1,"Action replay or active workload refused");
  if(action==="catalog") {
    const rows=await fenced(`SELECT current_setting('server_version') AS version,
      (SELECT count(*) FROM ${s}.budgets) AS synthetic_rows`);
    await fenced(`UPDATE ${s}.run SET active_action=NULL,lease_request=NULL,lease_until=NULL WHERE id=1 AND owner=$1 AND lease_request=$2`,[owner,request]);
    return {...meta,rows,roundTrips:trips,statements};
  }
  const workerSql=neon(env.BENCH61_DATABASE_URL!);
  const worker = async (text:string,params:unknown[]=[]) => {
    ensure(++trips<=220 && ++statements<=440,"Functional work budget exceeded");
    return await workerSql.query(text,params,{fetchOptions:{signal:AbortSignal.timeout(10000)}});
  };
  // Metadata only: no application rows. Stop rather than alter shared ACLs.
  const audit=await admin(`SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema',$1) AND n.nspname NOT LIKE 'pg_toast%'
      AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN
        (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')) ELSE false END) AS foreign_table_access,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema',$1) AND n.nspname NOT LIKE 'pg_toast%'
      AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,'SELECT,USAGE,UPDATE') ELSE false END) AS foreign_sequence_access,
    has_database_privilege(r.oid,(SELECT oid FROM pg_database WHERE datname=current_database()),'CREATE') AS database_create,
    EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
      AND has_schema_privilege(r.oid,n.oid,'CREATE')) AS schema_create,
    EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema',$1)
      AND has_function_privilege(r.oid,p.oid,'EXECUTE')) AS foreign_definer_access
    FROM pg_roles r WHERE r.rolname=$2`,[functionalSchema,timeoutRole]);
  ensure(audit.length===1 && Object.values(audit[0]).every(value=>value===false),"Worker effective privileges exceed scope");
  const timeout=await qualifyHttpTimeout(env.BENCH61_DATABASE_URL!,identity.host,identity.database,
    {schema:s,owner,request},fenced);
  // Include the module's standalone HTTP requests in this action's total budget.
  trips+=timeout.roundTrips;statements+=timeout.statements;
  const debit=`WITH guard AS MATERIALIZED (SELECT ${s}.guard($1,$2,false)),
    debit AS (UPDATE ${s}.budgets SET balance=balance-3 FROM guard
      WHERE account='timeout-proof' AND active AND balance-3>=floor RETURNING balance)
    SELECT balance FROM debit`;
  for(const [who,req,reason] of [[owner,randomUUID(),"workload lease expired or mismatched"],
    ["wrong-owner",request,"schema owner mismatch"]]) {
    let rejected=false;
    try {await worker(debit,[who,req]);}catch(error){
      const e=error as {code?:string;message?:string};
      if(e.code!=="P0001" || !e.message?.includes(reason))throw error;
      rejected=true;
    }
    ensure(rejected,"Mismatched workload identity was admitted");
  }
  let lockProbeMs=0;
  const held=batch([
    {text:"SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true)"},
    {text:`SELECT ${s}.guard($1,$2,false)`,params:[owner,request]},
    {text:`SELECT balance FROM ${s}.budgets WHERE account='timeout-proof' FOR UPDATE`},
    {text:"SELECT pg_sleep(4)"},
  ]).then(value=>({value}),error=>({error}));
  try {
    let observed=false;
    for(let i=0;i<20;i++) {
      const rows=await fenced(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='relation'
        AND relation=to_regclass($1) AND mode='RowShareLock' AND granted) AS held`,[s+".budgets"]);
      if(rows[0].held){observed=true;break;}
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    ensure(observed,"Finite blocker was not observed");
    const start=performance.now();
    await proveServerLockCancellation(worker,debit,[owner,request]);
    lockProbeMs=performance.now()-start;
  }finally{
    const outcome=await held;if("error" in outcome)throw outcome.error;
  }
  const balance=await fenced(`SELECT balance FROM ${s}.budgets WHERE account='timeout-proof'`);
  ensure(balance[0].balance===100,"Lock timeout changed balance");
  // The final phase intentionally expires only this action's lease. No further
  // workload is admitted after it. Cleanup can safely win after in-flight work drains.
  await fenced(`UPDATE ${s}.run SET lease_until=clock_timestamp()+interval '2 seconds'
    WHERE id=1 AND owner=$1 AND lease_request=$2`,[owner,request]);
  const running=worker(debit.replace("SELECT balance FROM debit","SELECT balance,pg_sleep(4) FROM debit"),
    [owner,request]).then(value=>({value}),error=>({error}));
  let fenceRefused=false,expiredRefused=false;
  try {
    let expired=false;
    for(let i=0;i<30;i++) {
      const rows=await admin(`SELECT lease_until<=clock_timestamp() AS expired FROM ${s}.run WHERE id=1 AND owner=$1 AND lease_request=$2`,[owner,request]);
      if(rows[0]?.expired){expired=true;break;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    ensure(expired,"Fixture lease expiry was not observed");
    try {await cleanup();} catch(error) {
      if((error as {code?:string}).code!=="P0001" || !/workload transaction still in flight/.test((error as Error).message))throw error;
      fenceRefused=true;
    }
    ensure(fenceRefused,"Cleanup was not fenced by in-flight transaction");
    try {await worker(debit,[owner,request]);}catch(error){
      if((error as {code?:string}).code!=="P0001" || !/workload lease expired or mismatched/.test((error as Error).message))throw error;
      expiredRefused=true;
    }
    ensure(expiredRefused,"Expired request was admitted");
  }finally{
    const outcome=await running;if("error" in outcome)throw outcome.error;
    ensure(outcome.value[0].balance===97,"Admitted fixture debit did not commit exactly once");
  }
  const completed=await fenced(`UPDATE ${s}.run SET active_action=NULL,lease_request=NULL,lease_until=NULL
    WHERE id=1 AND owner=$1 AND lease_request=$2 RETURNING id`,[owner,request],true);
  ensure(completed.length===1,"Owned completion failed");
  return {...meta,qualification:"functional probes passed; no performance acceptance",identities:timeout.identities,
    transactionStateIsolatedOnReusedBackend:timeout.transactionStateIsolatedOnReusedBackend,
    backendReuse:timeout.backendReuse,statementProbeMs:timeout.statementProbeMs,debitRollbackProbeMs:timeout.debitRollbackProbeMs,lockProbeMs,
    statementTimeout:true,rollback:true,lockTimeout:true,cleanupFence:true,lateAdmissionRefused:true,mismatchedIdentityRefused:true,
    roundTrips:trips,statements,remaining:["separate independent review of evidence before any performance decision"]};
};
