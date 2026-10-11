import type { Client } from "pg";

const createRole = (client: Client, role: string) => client.query(`DO $harness$ BEGIN CREATE ROLE ${role} NOLOGIN;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $harness$`);

// Disposable-harness only. Roles are cluster-wide and migration 0003 grants only
// to roles that already exist, so they are created before migrating. Creation
// tolerates a concurrent creator. Never run against a hosted database.
export const ensurePredictiveRoles = async (client: Client) => {
  for (const role of ["predictive_ingest", "predictive_replay", "predictive_harness"]) await createRole(client, role);
};

// Synthetic-test evidence is accepted solely from a session that is a member of
// predictive_harness; membership is checked against session_user.
export const ensureHarnessSession = async (client: Client) => {
  await ensurePredictiveRoles(client);
  await client.query(`DO $harness$ BEGIN EXECUTE format('GRANT predictive_harness TO %I', session_user);
    EXCEPTION WHEN unique_violation THEN NULL; END $harness$`);
  const member = (await client.query("SELECT public.predictive_harness_session() AS member")).rows[0]?.member;
  if (member !== true) throw new Error("predictive-harness-role-unavailable");
};
