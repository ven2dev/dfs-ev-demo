import type { Client } from "pg";

// Disposable-harness only: synthetic-test evidence is accepted solely from a
// session that is a member of predictive_harness. Roles are cluster-wide, so
// creation tolerates a concurrent creator. Never run against a hosted database.
export const ensureHarnessSession = async (client: Client) => {
  await client.query(`DO $harness$ BEGIN CREATE ROLE predictive_harness NOLOGIN;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $harness$`);
  await client.query(`DO $harness$ BEGIN EXECUTE format('GRANT predictive_harness TO %I', session_user);
    EXCEPTION WHEN unique_violation THEN NULL; END $harness$`);
  const member = (await client.query("SELECT public.predictive_harness_session() AS member")).rows[0]?.member;
  if (member !== true) throw new Error("predictive-harness-role-unavailable");
};
