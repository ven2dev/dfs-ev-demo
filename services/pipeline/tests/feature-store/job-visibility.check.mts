import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { Client } from "pg";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { FEATURE_VERSION, LABEL_VERSION, HISTORY_POLICY, readLastValidFeature, readLastValidLabel } from "../../src/featureStore/derived.ts";
import { startJob, finishJob } from "../../src/featureStore/jobs.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import type { EvidenceMode } from "../../src/featureStore/asOf.ts";

const mode = "retrospective-reconstruction-v1" as const;
const codeSha = "c".repeat(40);
const policySha = sha256(Buffer.from("#241 permanent step-1 completion probes"));
type Kind = "features" | "labels";
type Revision = { id: string; jobId: string; player: string; game: string; value: unknown; evidenceMode: EvidenceMode };

test("#241 shared completion policy and derived display", { timeout: 120_000 }, async t => {
  const probes: { name: string; verdict: string; details: unknown }[] = [];
  try {
    await withFeatureStoreDatabase(async ({ admin, writer, reader }) => {
      const check = (name: string, run: () => Promise<unknown>) => t.test(name, async () => {
        try { probes.push({ name, verdict: "pass", details: await run() }); }
        catch (error) { probes.push({ name, verdict: "fail", details: String(error) }); throw error; }
      });
      const clock = async () => (await admin.query("SELECT clock_timestamp()::text AS at")).rows[0].at as string;
      const job = async (kind: Kind) => (await startJob(writer, {
        kind, codeSha, policySha256: policySha, inputSetSha256: sha256(Buffer.from(randomUUID())),
      })).jobId;
      const finish = async (jobId: string, failed = false) => {
        await finishJob(writer, jobId, { counts: {}, ...(failed ? { errorCode: "intentional-test-failure" } : {}) });
        return (await writer.query("SELECT finished_at::text AS at FROM fs138.job_runs WHERE job_id=$1", [jobId])).rows[0].at as string;
      };
      const seed = async (kind: Kind, options: { previous?: Revision; unavailable?: boolean; yards?: number; sampleSize?: number; evidenceMode?: EvidenceMode } = {}): Promise<Revision> => {
        const jobId = await job(kind), player = options.previous?.player ?? randomUUID(), game = options.previous?.game ?? "2025-test-" + randomUUID();
        const sampleSize = options.sampleSize ?? 3;
        const history = Array.from({ length: sampleSize }, (_, i) => ({ gameId: "prior-" + i, kickoff: "2024-01-01T00:00:00Z", yards: (options.yards ?? 100) + i }));
        const state = options.unavailable ? "unavailable" : "usable", reasons = options.unavailable ? ["newer-unavailable"] : [];
        const value = kind === "features" ? history : options.unavailable ? null : options.yards ?? 100;
        const evidenceMode = options.evidenceMode ?? mode;
        const values = [jobId, player, game, evidenceMode, state, reasons, options.previous?.id ?? null];
        const row = kind === "features"
          ? (await writer.query(`INSERT INTO fs138.feature_values(job_id,player_id,game_id,stat,season,cutoff,checkpoint,
              feature_version,history_policy,evidence_mode,state,reasons,flags,sample_size,history,history_gaps,supersedes_id)
              VALUES($1,$2,$3,'passing_yards',2025,'2025-01-01',clock_timestamp(),$8,$9,$4,$5,$6,'{}',$10,$11,'[]',$7)
              RETURNING feature_id AS id`, [...values, FEATURE_VERSION, HISTORY_POLICY, sampleSize, JSON.stringify(history)])).rows[0]
          : (await writer.query(`INSERT INTO fs138.outcome_labels(job_id,player_id,game_id,stat,season,label_cutoff,
              label_version,evidence_mode,state,reasons,flags,value,supersedes_id)
              VALUES($1,$2,$3,'passing_yards',2025,clock_timestamp(),$8,$4,$5,$6,'{}',$9,$7)
              RETURNING label_id AS id`, [...values, LABEL_VERSION, value])).rows[0];
        return { id: row.id, jobId, player, game, value, evidenceMode };
      };
      const display = async (kind: Kind, revision: Revision, at: string) => {
        const trace: { text: string; values: unknown[] }[] = [];
        const connection = { query: async (text: string, values: unknown[]) => {
          trace.push({ text, values }); return reader.query(text, values);
        } } as Pick<Client, "query">;
        const read = kind === "features" ? readLastValidFeature : readLastValidLabel;
        const result = await read(connection, { playerId: revision.player, gameId: revision.game, mode: revision.evidenceMode, knownAsOf: at });
        assert.equal(trace.length, 1, "display work budget is one SQL statement");
        assert(!/FOR\s+(UPDATE|SHARE)|LOCK\s+TABLE|pg_advisory/i.test(trace[0].text));
        return { result, trace: trace[0] };
      };

      await check("invoker-only relational policy has narrow grants on real reader/writer LOGINs", async () => {
        const definition = (await admin.query(`SELECT p.prosecdef,p.provolatile,p.proconfig,l.lanname,
            EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
          FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
          WHERE p.oid='fs138.completed_jobs_at(timestamptz)'::regprocedure`)).rows[0];
        assert.deepEqual(definition, { prosecdef: false, provolatile: "s", proconfig: null, lanname: "sql", public_execute: false });
        const identities = [];
        for (const connection of [reader, writer]) {
          const identity = (await connection.query(`SELECT current_user AS name,
            has_function_privilege(current_user,'fs138.completed_jobs_at(timestamptz)','EXECUTE') AS can_execute`)).rows[0];
          assert.equal(identity.can_execute, true);
          const role = (await admin.query("SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1", [identity.name])).rows[0];
          assert.deepEqual(role, { rolcanlogin: true, rolsuper: false, rolbypassrls: false });
          await connection.query("SELECT job_id FROM fs138.completed_jobs_at(NULL::timestamptz)");
          identities.push({ ...identity, ...role });
        }
        await admin.query("REVOKE SELECT ON fs138.job_runs FROM fs138_reader");
        try { await assert.rejects(reader.query("SELECT * FROM fs138.completed_jobs_at(clock_timestamp())"), { code: "42501" }); }
        finally { await admin.query("GRANT SELECT ON fs138.job_runs TO fs138_reader"); }
        return { definition, identities, tablePrivilegeBypass: false };
      });

      await check("shared relation excludes running/failed jobs and includes exact completion", async () => {
        const running = await job("features"), failed = await job("labels"), succeeded = await job("features");
        await finish(failed, true); const at = await finish(succeeded);
        const before = (await admin.query("SELECT ($1::timestamptz-interval '1 microsecond')::text AS at", [at])).rows[0].at;
        const select = async (known: string) => (await reader.query(`SELECT job_id FROM fs138.completed_jobs_at($1)
          WHERE job_id=ANY($2::uuid[]) ORDER BY job_id`, [known, [running, failed, succeeded]])).rows.map(r => r.job_id);
        assert.deepEqual(await select(before), []); assert.deepEqual(await select(at), [succeeded]);
        assert.deepEqual(await select(await clock()), [succeeded]);
        return { running, failed, succeeded, before, finishedAt: at, inclusive: true };
      });

      for (const kind of ["features", "labels"] as const) {
        await check(`${kind}: insertion-to-finish replay stays pinned, with inclusive microsecond boundary`, async () => {
          const old = await seed(kind); await finish(old.jobId);
          let next: Revision, pinned: string, finishedAt: string;
          await writer.query("BEGIN");
          try {
            next = await seed(kind, { previous: old, yards: 222 }); pinned = await clock();
            assert.equal((await display(kind, old, pinned)).result.displayed_id, old.id);
            finishedAt = await finish(next.jobId); await writer.query("COMMIT");
          } catch (error) { await writer.query("ROLLBACK"); throw error; }
          assert.equal((await display(kind, old, pinned)).result.displayed_id, old.id);
          const boundaries = (await admin.query(`SELECT ($1::timestamptz-interval '1 microsecond')::text AS before,
            $1::timestamptz::text AS exact,($1::timestamptz+interval '1 microsecond')::text AS after`, [finishedAt])).rows[0];
          const answers = [];
          for (const [boundary, at] of Object.entries(boundaries)) {
            const shown = await display(kind, old, at as string), expected = boundary === "before" ? old : next;
            assert.equal(shown.result.displayed_id, expected.id); assert.deepEqual(shown.result.value, expected.value);
            answers.push({ boundary, knownAsOf: at, id: shown.result.displayed_id, statements: 1 });
          }
          assert.equal((await display(kind, old, boundaries.after)).result.display_status, "corrected value");
          return { oldId: old.id, newId: next.id, pinned, finishedAt, answers, alteredClocks: false };
        });

        await check(`${kind}: running/failed heads do not stale values; completed unavailable head retains last valid`, async () => {
          const good = await seed(kind); await finish(good.jobId);
          const rejected = await seed(kind, { previous: good, yards: 333 });
          const running = (await display(kind, good, await clock())).result;
          assert.equal(running.head_id, good.id); assert.equal(running.stale, false); assert.equal(running.superseded, false);
          await finish(rejected.jobId, true);
          const failed = (await display(kind, good, await clock())).result;
          assert.equal(failed.head_id, good.id); assert.equal(failed.stale, false); assert.equal(failed.superseded, false);
          const unavailable = await seed(kind, { previous: good, unavailable: true }); await finish(unavailable.jobId);
          const shown = (await display(kind, good, await clock())).result;
          assert.equal(shown.head_id, unavailable.id); assert.equal(shown.displayed_id, good.id);
          assert.deepEqual(shown.value, good.value); assert.equal(shown.stale, true); assert.equal(shown.superseded, true);
          assert.deepEqual(shown.reasons, ["newer-unavailable"]); assert.match(shown.display_status, /last valid/);
          const noValid = await seed(kind, { unavailable: true }); await finish(noValid.jobId);
          const empty = (await display(kind, noValid, await clock())).result;
          assert.equal(empty.displayed_id, null); assert.equal(empty.value, null); assert.equal(empty.display_status, "unavailable");
          return { retainedId: good.id, rejectedId: rejected.id, unavailableId: unavailable.id, stale: true, superseded: true, noValidId: noValid.id };
        });

        await check(`${kind}: terminal UPDATE / COMMIT window is recorded as an accepted limitation`, async () => {
          const old = await seed(kind); await finish(old.jobId);
          let next: Revision, finishedAt: string, pin: string;
          await writer.query("BEGIN");
          try {
            next = await seed(kind, { previous: old, yards: 444 }); finishedAt = await finish(next.jobId); pin = await clock();
            assert.equal((await display(kind, old, pin)).result.displayed_id, old.id); await writer.query("COMMIT");
          } catch (error) { await writer.query("ROLLBACK"); throw error; }
          assert.equal((await display(kind, old, pin)).result.displayed_id, next.id);
          return { finishedAt, pin, beforeCommitId: old.id, afterCommitId: next.id, limitation: "finish UPDATE precedes COMMIT; no commit-clock guarantee" };
        });
      }

      await check("display remains one statement at n=2/16 and SQL relation inlines on executed branches", async () => {
        const results = [];
        for (const n of [2, 16]) for (const kind of ["features", "labels"] as const) for (const evidenceMode of [mode, "strict-point-in-time-v1"] as const) {
          const good = await seed(kind, { sampleSize: n, evidenceMode }); await finish(good.jobId);
          const newer = await seed(kind, { previous: good, sampleSize: n, unavailable: true, evidenceMode }); await finish(newer.jobId);
          const shown = await display(kind, good, await clock()); assert.equal(shown.result.stale, true);
          const plan = (await reader.query("EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) " + shown.trace.text,
            shown.trace.values)).rows[0]["QUERY PLAN"][0];
          const nodes: Record<string, unknown>[] = [];
          const visit = (node: Record<string, unknown>) => { nodes.push(node); for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child); };
          visit(plan.Plan);
          assert(!nodes.some(node => node["Node Type"] === "Function Scan" && node["Function Name"] === "completed_jobs_at"));
          assert(!nodes.some(node => node["Node Type"] === "LockRows"));
          const visible = nodes.find(node => node["Subplan Name"] === "CTE visible");
          assert(visible); assert.equal(visible["Actual Loops"], 1); assert.equal(visible["Actual Rows"], 2);
          const readers = (await admin.query(`SELECT l.mode FROM pg_locks l JOIN pg_stat_activity a USING(pid)
            WHERE a.usename=$1 AND l.locktype='relation'`, [(await reader.query("SELECT current_user AS name")).rows[0].name])).rows;
          assert.equal(readers.length, 0, "display holds no relation locks after its statement");
          results.push({ kind, n, evidenceMode, statements: 1, helperFunctionScans: 0, visibleLoops: 1, visibleRows: 2,
            explicitRowLocks: 0, locksAfterRead: 0, sharedHits: plan.Plan["Shared Hit Blocks"] });
        }
        return results;
      });
    });
  } finally {
    if (process.env.FEATURE_STORE_241_STEP1_EVIDENCE_PATH) {
      const files = ["packages/db/proposals/241_job_visibility.sql", "services/pipeline/src/featureStore/derived.ts",
        "services/pipeline/scripts/feature-store/harness.ts", "services/pipeline/tests/feature-store/job-visibility.check.mts"];
      const codeHashes = Object.fromEntries(await Promise.all(files.map(async path => [path,
        sha256(await readFile(new URL("../../../../" + path, import.meta.url)))])));
      await writeFile(process.env.FEATURE_STORE_241_STEP1_EVIDENCE_PATH, JSON.stringify({ issue: 241, step: 1,
        fixture: "synthetic revisions; real DB insertion/finish/COMMIT clocks; actual restricted LOGINs; no altered clocks",
        runtime: process.version, recordedAt: new Date().toISOString(), codeHashes,
        verdict: probes.length === 9 && probes.every(p => p.verdict === "pass") ? "pass" : "fail", probes }, null, 2) + "\n");
    }
  }
});
