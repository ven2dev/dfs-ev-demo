import { createHash, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { neon } from "@neondatabase/serverless";
import config from "./bench61-config.json";

// Disposable experiment only. Fixed identifiers/actions, no provider imports.
const schema = '"bench61_20261019"';
const budgets = `${schema}.budgets`;
const owner = config.tokenHash;
const actions = ["setup", "run", "cold1", "cold2", "cold3", "catalog", "cleanup"] as const;
export type BenchAction = typeof actions[number];
export const authorizeBenchmark = (token: unknown, action: unknown, env: Record<string, string | undefined> = process.env, now = Date.now()) => {
  if (env.VERCEL_ENV !== "preview" || env.VERCEL_REGION !== "iad1" || now >= Date.parse(config.expiresAt)
    || typeof token !== "string" || token.length !== 64 || !actions.includes(action as BenchAction)) return false;
  try {
    if (new URL(env.DATABASE_URL ?? "").hostname !== config.host) return false;
  } catch { return false; }
  return timingSafeEqual(createHash("sha256").update(token).digest(), Buffer.from(config.tokenHash, "hex"));
};
const deduct = `UPDATE ${budgets} SET balance=balance-$2 WHERE account=$1 AND active AND $2::integer>0
  AND observed_at <= $3::timestamptz AND observed_at >= $3::timestamptz-interval '5 minutes'
  AND balance-$2 >= CASE WHEN $4::boolean THEN 0 ELSE floor END RETURNING balance`;
const correct = `UPDATE ${budgets} SET balance=LEAST(balance,$2), observed_at=$3 WHERE account=$1
  AND active AND $2::integer>=0 AND observed_at<=$3::timestamptz AND $3::timestamptz<=$4::timestamptz RETURNING balance`;
const parallel = async (n: number, fn: (i: number) => Promise<void>) => {
  let next = 0;
  await Promise.all(Array.from({ length: 20 }, async () => { while (next < n) await fn(next++); }));
};
const assert = (ok: boolean, name: string) => { if (!ok) throw new Error(`Invariant failed: ${name}`); };
const distribution = (values: number[]) => {
  const sorted = [...values].sort((a,b) => a-b);
  return { samples: sorted.length, p50_ms: sorted[Math.ceil(sorted.length*.5)-1],
    p95_ms: sorted[Math.ceil(sorted.length*.95)-1], max_ms: sorted.at(-1) };
};

export const executeBenchmark = async (action: BenchAction) => {
  const sql = neon(process.env.DATABASE_URL!);
  let roundTrips = 0, statements = 0;
  // Two SQL statements, one HTTP round trip. Timeouts are transaction-local.
  const query = async (text: string, params: unknown[] = []) => {
    roundTrips++; statements += 2;
    const result = await sql.transaction([
      sql.query("SELECT set_config('statement_timeout','5000',true), set_config('lock_timeout','2000',true)"),
      sql.query(text, params),
    ], { fetchOptions: { signal: AbortSignal.timeout(10000) } });
    return result[1];
  };
  const meta = { region: process.env.VERCEL_REGION, environment: process.env.VERCEL_ENV,
    sha: process.env.VERCEL_GIT_COMMIT_SHA, host: config.host, schema: config.schema,
    transport: "Neon HTTP transaction; timeout setup + measured statement", timestamp: new Date().toISOString() };
  if (action === "setup") {
    // A repeated setup also contacts compute. Invalidate an existing owned run
    // before refusing it; never adopt or alter a schema with a different owner.
    const preflight = await sql.transaction([
      sql.query("SELECT set_config('statement_timeout','5000',true), set_config('lock_timeout','2000',true)"),
      sql.query("SELECT set_config('bench61.owner',$1,true)", [owner]),
      sql.query(`DO $setup$
        DECLARE actual_owner text;
        BEGIN
          IF to_regnamespace('bench61_20261019') IS NULL THEN RETURN; END IF;
          SELECT r.owner INTO actual_owner FROM ${schema}.run r WHERE id=1 FOR UPDATE;
          IF actual_owner IS DISTINCT FROM current_setting('bench61.owner') THEN
            RAISE EXCEPTION 'Benchmark schema ownership mismatch';
          END IF;
          UPDATE ${schema}.run SET last_query_at=NULL,active_action=COALESCE(active_action,'setup') WHERE id=1;
        END $setup$`),
      sql.query("SELECT to_regnamespace('bench61_20261019') IS NULL AS absent"),
    ], { fetchOptions: { signal: AbortSignal.timeout(10000) } });
    assert(preflight[3][0].absent,"setup refuses an existing schema");
    // CREATE without IF NOT EXISTS also refuses a concurrent schema creation.
    const result = await sql.transaction([
      sql.query("SELECT set_config('statement_timeout','5000',true), set_config('lock_timeout','2000',true)"),
      sql.query(`CREATE SCHEMA ${schema}`),
      sql.query(`CREATE TABLE ${budgets}(account text PRIMARY KEY, balance integer NOT NULL CHECK(balance>=0),
        floor integer NOT NULL CHECK(floor>=0), observed_at timestamptz NOT NULL, active boolean NOT NULL)`),
      sql.query(`CREATE TABLE ${schema}.run(id integer PRIMARY KEY CHECK(id=1), owner text NOT NULL,
        started_at timestamptz NOT NULL DEFAULT clock_timestamp(), operations text[] NOT NULL DEFAULT '{}',
        reserved_statements integer NOT NULL DEFAULT 0, reserved_round_trips integer NOT NULL DEFAULT 0,
        last_query_at timestamptz, active_action text)`),
      sql.query(`INSERT INTO ${schema}.run(id,owner,last_query_at) VALUES(1,$1,clock_timestamp())`, [owner]),
    ], { fetchOptions: { signal: AbortSignal.timeout(10000) } });
    return { ...meta, setup: result.length === 5, roundTrips: 2, statements: 9 };
  }
  if (action === "cleanup") {
    // Idempotent teardown: absence is success; a present schema is dropped only
    // after its current control-row owner is validated in the same transaction.
    const cleanupStep = async (drop: boolean) => sql.transaction([
      sql.query("SELECT set_config('statement_timeout','5000',true), set_config('lock_timeout','2000',true)"),
      sql.query("SELECT set_config('bench61.owner',$1,true)", [owner]),
      sql.query(`DO $cleanup$
        DECLARE actual_owner text;
        BEGIN
          IF to_regnamespace('bench61_20261019') IS NULL THEN RETURN; END IF;
          SELECT r.owner INTO actual_owner FROM ${schema}.run r WHERE id=1 FOR UPDATE;
          IF actual_owner IS DISTINCT FROM current_setting('bench61.owner') THEN
            RAISE EXCEPTION 'Benchmark schema ownership mismatch';
          END IF;
          UPDATE ${schema}.run SET last_query_at=NULL,active_action='cleanup' WHERE id=1;
          ${drop ? `DROP SCHEMA ${schema} CASCADE;
          IF to_regnamespace('bench61_20261019') IS NOT NULL THEN
            RAISE EXCEPTION 'Benchmark schema remains';
          END IF;` : ""}
        END $cleanup$`),
    ], { fetchOptions: { signal: AbortSignal.timeout(10000) } });
    // Persist unknown eligibility before attempting teardown, so a failed drop
    // cannot leave the old completion timestamp eligible for a cold sample.
    await cleanupStep(false);
    await cleanupStep(true);
    return { ...meta, schemaAbsent: true, roundTrips: 2, statements: 6 };
  }

  // Start makes idle eligibility unknown, including a rejected/replayed request:
  // even a rejected query wakes compute. An active action cannot be overwritten.
  const reservedTrips = action === "run" ? 7200 : 10;
  const reservedStatements = reservedTrips * 2;
  if (reservedStatements > config.maxStatements) {
    return { ...meta, blocked: "Statement cap too small for approved sample counts plus timeout statements",
      requiredStatementReservation: reservedStatements, configuredCap: config.maxStatements };
  }
  const cold = action.startsWith("cold");
  const claimSql = `WITH previous AS MATERIALIZED (
    SELECT *, (active_action IS NULL AND NOT ($2=ANY(operations))
      AND reserved_statements+$3 <= $5 AND reserved_round_trips+$4 <= $6
      AND (clock_timestamp()-started_at < interval '30 minutes' OR $2='catalog')
      ${cold ? "AND last_query_at IS NOT NULL AND clock_timestamp()-last_query_at >= interval '6 minutes'" : ""}
    ) AS eligible FROM ${schema}.run WHERE id=1 AND owner=$1 FOR UPDATE
  ), claim AS (
    UPDATE ${schema}.run r SET last_query_at=NULL,
      active_action=COALESCE(previous.active_action,$2),
      operations=CASE WHEN previous.eligible THEN array_append(previous.operations,$2) ELSE previous.operations END,
      reserved_statements=previous.reserved_statements+CASE WHEN previous.eligible THEN $3 ELSE 0 END,
      reserved_round_trips=previous.reserved_round_trips+CASE WHEN previous.eligible THEN $4 ELSE 0 END
    FROM previous WHERE r.id=previous.id
    RETURNING previous.eligible,extract(epoch FROM (clock_timestamp()-previous.last_query_at))*1000 AS idle_ms
  )`;
  const params = [owner,action,reservedStatements,reservedTrips,config.maxStatements-9,config.maxRoundTrips-2];
  const complete = async () => {
    const result = await query(`UPDATE ${schema}.run SET last_query_at=clock_timestamp(),active_action=NULL
      WHERE id=1 AND owner=$1 AND active_action=$2 RETURNING id`, [owner,action]);
    assert(result.length===1,"owned action completion");
  };
  if (cold) {
    const start = performance.now();
    const sample = await query(`${claimSql}, budget AS (
      UPDATE ${budgets} SET balance=balance-3 FROM claim
      WHERE claim.eligible AND account='cold' AND active AND observed_at<=clock_timestamp()
        AND observed_at>=clock_timestamp()-interval '5 minutes' AND balance-3>=floor RETURNING balance
    ) SELECT eligible,idle_ms,(SELECT balance FROM budget) AS admitted_balance FROM claim`, params);
    const measured_ms=performance.now()-start;
    assert(sample.length===1 && sample[0].eligible,"owned non-replayed cold sample, known six-minute idle interval and cap");
    await complete();
    return { ...meta, idle_ms:Number(sample[0].idle_ms), measured_ms,
      admitted:sample[0].admitted_balance!==null, roundTrips,statements,
      qualification:"Idle-first-request budget check; suspension must be confirmed independently. Synthetic quota may be stale after idle." };
  }
  const claim = await query(`${claimSql} SELECT eligible FROM claim`, params);
  assert(claim.length===1 && claim[0].eligible,"owned run, non-replayed action, resource cap and active deadline");
  if (action === "catalog") {
    const inventory = await query(`SELECT (SELECT count(*)::int FROM ${budgets}) AS synthetic_rows,
      pg_total_relation_size('${budgets}') AS bytes, current_setting('server_version') AS version`);
    await complete();
    return { ...meta, inventory, roundTrips, statements };
  }
  const at = new Date().toISOString();
  const seed = (name: string, balance = 100, observed = at) => query(
    `INSERT INTO ${budgets} VALUES($1,$2,20,$3,true)`, [name,balance,observed]);
  const spend = (name: string, cost = 3, collector = false) => query(deduct,[name,cost,at,collector]);
  await seed("cold",10000);
  await seed("concurrent");
  let admitted = 0;
  await parallel(1000, async () => { if ((await spend("concurrent")).length) admitted++; });
  assert(admitted === 26,"interactive floor under concurrency");
  let collected = 0;
  await parallel(100,async () => { if ((await spend("concurrent",3,true)).length) collected++; });
  assert(collected === 7,"collector total budget");
  const remaining = await query(`SELECT balance FROM ${budgets} WHERE account='concurrent'`);
  assert(remaining[0].balance===1,"never overspend");
  await seed("headers"); await spend("headers");
  assert((await query(correct,["headers",99,at,at]))[0].balance===97,"upward observation cannot refund");
  assert((await query(correct,["headers",60,at,at]))[0].balance===60,"downward correction");
  assert((await query(correct,["headers",99,at,at]))[0].balance===60,"late higher balance cannot replenish");
  assert((await query(correct,["unknown",0,at,at])).length===0,"unknown account");
  assert((await query(correct,["headers",-1,at,at])).length===0,"negative remaining");
  assert((await query(correct,["headers",0,new Date(Date.parse(at)-1).toISOString(),at])).length===0,"older observation");
  assert((await query(correct,["headers",0,new Date(Date.parse(at)+60000).toISOString(),at])).length===0,"future observation");
  await seed("stale",100,new Date(Date.parse(at)-300001).toISOString());
  assert((await spend("stale")).length===0,"stale quota");
  assert((await spend("unknown")).length===0,"unknown quota");
  assert((await spend("headers",0)).length===0,"zero cost");
  assert((await spend("headers",-3)).length===0,"negative cost");
  const trials = [];
  for (let trial=0;trial<3;trial++) {
    const pair: Record<string,ReturnType<typeof distribution>> = {};
    for (const mode of trial%2 ? ["budget","baseline"] : ["baseline","budget"]) {
      const name=`trial-${trial}-${mode}`;
      await seed(name,10000);
      const ms: number[]=[];
      await parallel(1000,async () => {
        const start=performance.now();
        if(mode==="budget") assert((await spend(name)).length===1,"warm admission");
        else await query("SELECT 1");
        ms.push(performance.now()-start);
      });
      pair[mode]=distribution(ms);
    }
    trials.push(pair);
  }
  await complete();
  return { ...meta, correctness:{attempts:1000,concurrency:20,admitted,collected,remaining:1},trials,
    headroomPassed:trials.every(t=>t.budget.p95_ms<=35),roundTrips,statements };
};
