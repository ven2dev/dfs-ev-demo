import type { Client } from "pg";

const createRole = (client: Client, role: string) => client.query(`DO $harness$ BEGIN CREATE ROLE ${role} NOLOGIN;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $harness$`);

// Historical migration-test infrastructure only; no runtime evidence reader/writer. Roles are cluster-wide and migration 0003 grants only
// to roles that already exist, so they are created before migrating. Creation
// tolerates a concurrent creator. Never run against a hosted database.
export const ensureLegacyPredictiveRoles = async (client: Client) => {
  for (const role of ["predictive_ingest", "predictive_replay", "predictive_recorder", "predictive_retention_owner", "predictive_harness"]) await createRole(client, role);
};
