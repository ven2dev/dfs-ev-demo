import {randomUUID} from "node:crypto";
import {performance} from "node:perf_hooks";
import {neon} from "@neondatabase/serverless";
import {candidateCleanupStatements,candidateFence,candidateRole,candidateSchema,candidateSetupStatements,candidateSql,
  debitParams,type CandidateContext,type CandidateStatement} from "./bench61-candidate";
import {functionalIdentity,privilegeAuditSql} from "./bench61-functional";
import {isProbeAction,probeWorkerRequired,type ProbeAction} from "./bench61-probe-policy";

// Disposable hosted hold probe for #61. Synthetic rows only; no provider calls.
// It screens whether the single-statement debit can approach the 50 ms p95 target
// at 20 workers. Its results are diagnostics, never performance acceptance.
const s = '"' + candidateSchema + '"';
const account = "probe-account", period = "probe-period", amount = 3, funded = 1_000_000;
export type ProbeShape = "batch" | "single" | "batch-async";
// batch: the hosted old shape #206 measured (one HTTP transaction: timeouts, guard,
// debit). batch-async: the same with synchronous_commit=off, owner-approved as a
// measurement only. single: the candidate's one-statement debit.
export const probeShapes: readonly ProbeShape[] = ["batch","single","batch-async"];
export const probeRuns = [{workers:20,count:200},{workers:1,count:50}] as const;
export const probeStatementsPerDebit: Record<ProbeShape,number> = {batch:3,single:1,"batch-async":3};
// Per-action caps. Their sum (994 round trips / 2,298 statements) stays within the
// plan's totals plus 5% (1,040 / 2,384).
export const probeCaps: Record<ProbeAction,{trips:number;statements:number}> = {
  "probe-setup":{trips:2,statements:20},
  "probe-qualify":{trips:220,statements:440},
  "probe-run":{trips:770,statements:1830},
  "probe-cleanup":{trips:2,statements:8},
};
// Fixed run plan: workload plus one async-support check plus 17 admin round trips
// (claim, six resets, six balance checks, three snapshots, release).
export const plannedRunWork = () => {
  const debits = probeShapes.map(shape => ({shape,debits:probeRuns.reduce((n,run) => n+run.count,0)}));
  const workloadTrips = debits.reduce((n,d) => n+d.debits,0);
  const workloadStatements = debits.reduce((n,d) => n+d.debits*probeStatementsPerDebit[d.shape],0);
  return {workloadTrips,workloadStatements,trips:workloadTrips+1+17,statements:workloadStatements+1+17};
};
const runDeadlineMs = 45_000;
const ensure = (value: unknown, reason: string) => {if(!value)throw new Error(reason);};
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)];
const round = (value: number) => Math.round(value*1000)/1000;
const now = () => new Date().toISOString();
const timeouts = "SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true)";
const asyncTimeouts = `${timeouts},set_config('synchronous_commit','off',true) AS synchronous_commit`;
const identitySql = `SELECT session_user,current_user,current_setting('statement_timeout') AS statement,
  current_setting('lock_timeout') AS lock,current_setting('transaction_isolation') AS isolation,pg_backend_pid() AS pid`;
const sharedFenceHeld = `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=${candidateFence.split(",")[0]}
  AND objid=${candidateFence.split(",")[1]} AND mode='ShareLock' AND granted) AS held`;
const absenceSql = "SELECT to_regnamespace($1) IS NULL AS schema_absent,NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) AS role_absent";
type Row = Record<string,unknown>;
const code = (error: unknown) => (error as {code?:string}).code;
const message = (error: unknown) => (error as {message?:string}).message ?? "";

export const executeProbe = async (action: ProbeAction) => {
  ensure(isProbeAction(action),"Unknown probe action");
  const env = process.env, identity = functionalIdentity(env,probeWorkerRequired(action),candidateRole);
  const owner = env.BENCH61_TOKEN_HASH!;
  ensure(/^[a-f0-9]{64}$/.test(owner),"Missing experiment owner");
  const cap = probeCaps[action];
  let trips = 0, statements = 0;
  // Counted before dispatch, so a cap is never exceeded even on a failing path.
  const spend = (count: number) => {
    ensure(trips+1<=cap.trips && statements+count<=cap.statements,"Probe work budget exceeded");
    trips++;statements+=count;
  };
  const totals = () => ({roundTrips:trips,statements});
  const op = neon(env.DATABASE_URL!);
  // A fresh 10-second abort per request; one shared signal would expire mid-action.
  const fetchOptions = () => ({signal:AbortSignal.timeout(10000)});
  const admin = async (queries: CandidateStatement[]) => {
    spend(queries.length);
    return await op.transaction(queries.map(q => op.query(q.text,q.params ?? [])),{fetchOptions:fetchOptions()}) as Row[][];
  };
  const meta = {host:identity.host,database:identity.database,schema:candidateSchema,role:candidateRole,
    region:env.VERCEL_REGION,sha:env.VERCEL_GIT_COMMIT_SHA,reviewedSha:env.BENCH61_REVIEWED_SHA,
    deploymentId:env.VERCEL_DEPLOYMENT_ID ?? null,expiresAt:env.BENCH61_EXPIRES_AT,ownerFingerprint:owner,
    performanceEnabled:false,action};

  if(action==="probe-setup") {
    const password = decodeURIComponent(new URL(env.BENCH61_DATABASE_URL!).password);
    // The DO block refuses an existing schema or role; all setup commits atomically.
    await admin(candidateSetupStatements({owner,request:randomUUID(),account,period},password));
    return {...meta,setup:true,observedAt:now(),...totals()};
  }
  if(action==="probe-cleanup") {
    const [[before]] = await admin([{text:absenceSql,params:[candidateSchema,candidateRole]}]) as [[{schema_absent:boolean;role_absent:boolean}]];
    if(before.schema_absent && before.role_absent)
      return {...meta,alreadyAbsent:true,schemaAbsent:true,roleAbsent:true,sessionsTerminated:false,observedAt:now(),...totals()};
    ensure(!before.schema_absent && !before.role_absent,"Partial candidate state; owner-validated operator cleanup required");
    // One transaction: count worker sessions, exclusive fence, ownership, drop, confirm.
    const result = await admin([
      {text:"SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE usename=$1",params:[candidateRole]},
      ...candidateCleanupStatements(owner),
      {text:absenceSql,params:[candidateSchema,candidateRole]},
    ]);
    const after = result.at(-1)![0] as {schema_absent:boolean;role_absent:boolean};
    ensure(after.schema_absent && after.role_absent,"Candidate objects survived cleanup");
    return {...meta,schemaAbsent:true,roleAbsent:true,workerSessionsBeforeDrop:result[0][0].sessions,
      sessionsTerminated:false,observedAt:now(),...totals()};
  }

  // Qualify and run: one-shot, never overlapping, under a renewed five-minute lease.
  const [claim] = await admin([
    {text:`UPDATE ${s}.run SET active_action=$2,operations=array_append(operations,$2),
      lease_until=clock_timestamp()+interval '5 minutes'
      WHERE owner=$1 AND active_action IS NULL AND NOT ($2=ANY(operations)) RETURNING request::text AS request`,params:[owner,action]},
  ]);
  ensure(claim.length===1,"Probe action replay or active workload refused");
  const context: CandidateContext = {owner,request:String(claim[0].request),account,period};
  const worker = neon(env.BENCH61_DATABASE_URL!);
  const single = async (text: string, params: unknown[] = []) => {
    spend(1);
    return await worker.query(text,params,{fetchOptions:fetchOptions()}) as Row[];
  };
  const transaction = async (queries: CandidateStatement[]) => {
    spend(queries.length);
    return await worker.transaction(queries.map(q => worker.query(q.text,q.params ?? [])),{fetchOptions:fetchOptions()}) as Row[][];
  };
  const reset = async (balance: number) => {
    const [rows] = await admin([{text:`UPDATE ${s}.budgets SET balance=$1,observed_at=clock_timestamp(),active=true
      WHERE account=$2 AND period=$3 RETURNING balance`,params:[balance,account,period]}]);
    ensure(rows.length===1,"Probe budget row missing");
  };
  const balance = async () => Number((await admin([{text:`SELECT balance FROM ${s}.budgets WHERE account=$1`,params:[account]}]))[0][0].balance);
  const release = () => admin([{text:`UPDATE ${s}.run SET active_action=NULL WHERE owner=$1 AND active_action=$2 RETURNING owner`,params:[owner,action]}]);
  const refuse = async (run: Promise<unknown>, expected: string, reason: RegExp) => {
    try {await run;}catch(error){
      ensure(code(error)===expected && reason.test(message(error)),`Expected ${expected}, got ${code(error) ?? "no code"}`);
      return true;
    }
    throw new Error(`Expected ${expected} refusal`);
  };
  const debitText = candidateSql("debit");

  if(action==="probe-qualify") {
    await reset(100);
    const identities: Row[] = [];
    const checkIdentity = async () => {
      const [row] = await single(identitySql);
      ensure(row.session_user===candidateRole && row.current_user===candidateRole && row.statement==="5s"
        && row.lock==="2s" && row.isolation==="read committed","Effective login defaults differ from qualified policy");
      identities.push(row);
    };
    await checkIdentity();await checkIdentity();
    const concurrent = await Promise.allSettled([checkIdentity(),checkIdentity(),checkIdentity()]);
    const failed = concurrent.find(result => result.status==="rejected");
    if(failed?.status==="rejected")throw failed.reason;
    const [audit] = await admin([{text:privilegeAuditSql,params:[candidateSchema,candidateRole]}]);
    ensure(audit.length===1 && Object.values(audit[0]).every(value => value===false),"Worker effective privileges exceed scope");
    const statementStart = performance.now();
    await refuse(single("SELECT pg_sleep(6)"),"57014",/statement timeout/i);
    const statementProbeMs = performance.now()-statementStart;
    await refuse(single(debitText.replace("RETURNING balance","RETURNING balance,pg_sleep(6)"),debitParams(context,amount,true)),"57014",/statement timeout/i);
    ensure(await balance()===100,"Cancelled debit changed the balance");
    // A bounded operator transaction holds the row; the worker must hit lock_timeout.
    const held = admin([{text:timeouts},{text:`SELECT balance FROM ${s}.budgets WHERE account=$1 FOR UPDATE`,params:[account]},
      {text:"SELECT pg_sleep(4)"}]).then(value => ({value}),error => ({error}));
    let lockProbeMs = 0;
    try {
      let observed = false;
      for(let i=0;i<20 && !observed;i++) {
        observed = Boolean((await admin([{text:`SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
          WHERE c.relname='budgets' AND c.relnamespace=to_regnamespace($1) AND l.mode='RowShareLock' AND l.granted) AS held`,
          params:[candidateSchema]}]))[0][0].held);
        if(!observed)await new Promise(resolve => setTimeout(resolve,25));
      }
      ensure(observed,"Finite blocker was not observed");
      const lockStart = performance.now();
      await refuse(single(debitText,debitParams(context,amount,true)),"55P03",/lock timeout/i);
      lockProbeMs = performance.now()-lockStart;
    }finally{const outcome = await held;if("error" in outcome)throw outcome.error;}
    ensure(await balance()===100,"Lock timeout changed the balance");
    await refuse(single(debitText,debitParams({...context,owner:"wrong-owner"},amount,true)),"P0001",/refused/);
    await refuse(single(debitText,debitParams({...context,request:randomUUID()},amount,true)),"P0001",/refused/);
    // An admitted debit holds the shared fence; exclusive cleanup must be refused until it commits.
    const running = single(debitText.replace("RETURNING balance","RETURNING balance,pg_sleep(2)"),debitParams(context,amount,true))
      .then(value => ({value}),error => ({error}));
    let fenceRefused = false;
    try {
      let observed = false;
      for(let i=0;i<20 && !observed;i++) {
        observed = Boolean((await admin([{text:sharedFenceHeld}]))[0][0].held);
        if(!observed)await new Promise(resolve => setTimeout(resolve,25));
      }
      ensure(observed,"Admitted debit did not hold the shared fence");
      fenceRefused = (await admin([{text:`SELECT pg_try_advisory_xact_lock(${candidateFence}) AS held`}]))[0][0].held===false;
    }finally{const outcome = await running;if("error" in outcome)throw outcome.error;}
    ensure(fenceRefused,"Exclusive cleanup fence was not refused during admitted work");
    ensure(await balance()===97,"Admitted debit did not commit exactly once");
    // Whether Neon applies synchronous_commit=off inside a transaction.
    let asyncSupported = false;
    try {
      const [[row]] = await transaction([{text:asyncTimeouts}]);
      asyncSupported = row.synchronous_commit==="off";
    }catch{asyncSupported = false;}
    ensure((await release())[0].length===1,"Owned completion failed");
    return {...meta,qualification:"probe role functional checks passed; no performance acceptance",identities,
      statementTimeout:true,rollback:true,lockTimeout:true,cleanupFence:true,mismatchedIdentityRefused:true,asyncSupported,
      statementProbeMs:round(statementProbeMs),lockProbeMs:round(lockProbeMs),observedAt:now(),...totals()};
  }

  // probe-run
  const plan = plannedRunWork();
  ensure(plan.trips<=cap.trips && plan.statements<=cap.statements,"Planned probe work exceeds its cap");
  const startedAt = now(), began = performance.now();
  let asyncSupported = false;
  try {
    const [[row]] = await transaction([{text:asyncTimeouts}]);
    asyncSupported = row.synchronous_commit==="off";
  }catch{asyncSupported = false;}
  const debit = async (shape: ProbeShape) => {
    const params = debitParams(context,amount,true);
    if(shape==="single")return {rows:await single(debitText,params),async:null};
    const result = await transaction([{text:shape==="batch-async"?asyncTimeouts:timeouts},
      {text:`SELECT ${s}.guard($1,$2)`,params:[context.owner,context.request]},{text:debitText,params}]);
    return {rows:result[2],async:shape==="batch-async"?result[0][0].synchronous_commit:null};
  };
  const measure = async (shape: ProbeShape, workers: number, count: number) => {
    await reset(funded);
    const latencies: number[] = [], pids = new Set<unknown>();
    let next = 0, admitted = 0, asyncOff = 0, failed = false, failure: unknown, snapshot: Promise<Row[][]> | undefined;
    const observedAt = now(), started = performance.now();
    // allSettled: an error stops new dispatches; every started debit drains first. No retries.
    const results = await Promise.allSettled(Array.from({length:workers},async () => {
      while(!failed && next<count) {
        ensure(performance.now()-began<runDeadlineMs,"Probe deadline reached; trial invalid");
        next++;
        if(workers>1 && !snapshot && next>=count/2)snapshot = admin([{text:`SELECT count(*)::int AS sessions,
          count(*) FILTER (WHERE state='active')::int AS active FROM pg_stat_activity WHERE usename=$1`,params:[candidateRole]}]);
        const t = performance.now();
        try {
          const {rows,async} = await debit(shape);
          latencies.push(performance.now()-t);
          if(rows.length){admitted++;pids.add(rows[0].pid);}
          if(async==="off")asyncOff++;
        }catch(error){if(!failed){failed = true;failure = error;}break;}
      }
    }));
    const elapsedMs = performance.now()-started;
    const snap = snapshot ? (await snapshot)[0][0] : null;
    const unexpected = results.find(result => result.status==="rejected");
    if(unexpected?.status==="rejected")throw unexpected.reason;
    if(failed)throw failure;
    ensure(admitted===count,"Funded debit unexpectedly denied; trial invalid");
    ensure(await balance()===funded-count*amount,"Probe balance arithmetic failed");
    ensure(shape!=="batch-async" || asyncOff===count,"synchronous_commit=off was not applied to every batch-async debit");
    const sorted = [...latencies].sort((a,b) => a-b);
    return {shape,workers,count,observedAt,admitted,backends:pids.size,activeSnapshot:snap,
      elapsedMs:round(elapsedMs),commitsPerSecond:round(admitted/(elapsedMs/1000)),
      // A hold-time diagnostic only when the row is always contended (workers > 1).
      impliedHoldMs:workers>1?round(elapsedMs/admitted):null,
      p50Ms:round(percentile(sorted,0.5)),p95Ms:round(percentile(sorted,0.95)),maxMs:round(sorted.at(-1)!)};
  };
  const runs = [];
  for(const shape of probeShapes) {
    if(shape==="batch-async" && !asyncSupported)continue;
    for(const run of probeRuns)runs.push(await measure(shape,run.workers,run.count));
  }
  ensure((await release())[0].length===1,"Owned completion failed");
  return {...meta,qualification:"hold probe screening only; no performance acceptance",startedAt,finishedAt:now(),
    asyncSupported,skippedShapes:asyncSupported?[]:["batch-async"],plannedWork:plan,runs,...totals()};
};
