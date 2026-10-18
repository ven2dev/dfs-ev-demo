import type { Client } from "pg";

export type JobIdentity = {
  kind: "ingest" | "normalize" | "features" | "labels" | "dataset" | "model" | "audit";
  codeSha: string;
  policySha256: string;
  inputSetSha256: string;
};

// Only the caller that created the identity executes the job. Existing running,
// failed and successful identities are returned explicitly, never recomputed as
// a side effect of an idempotent retry. Recovery policy is a separate job concern.
export const startJob = async (client: Pick<Client, "query">, identity: JobIdentity) => {
  const values = [identity.kind, identity.codeSha, identity.policySha256, identity.inputSetSha256];
  const inserted = await client.query<{ job_id: string; status: string }>(`
    INSERT INTO fs138.job_runs (kind, code_sha, policy_sha256, input_set_sha256)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (kind, input_set_sha256, code_sha, policy_sha256) DO NOTHING RETURNING job_id, status`, values);
  if (inserted.rows[0]) return { jobId: inserted.rows[0].job_id, status: inserted.rows[0].status, created: true };
  const existing = await client.query<{ job_id: string; status: string }>(`
    SELECT job_id, status FROM fs138.job_runs
    WHERE kind = $1 AND code_sha = $2 AND policy_sha256 = $3 AND input_set_sha256 = $4`, values);
  if (!existing.rows[0]) throw new Error("job-identity-not-visible");
  return { jobId: existing.rows[0].job_id, status: existing.rows[0].status, created: false };
};

export const finishJob = async (
  client: Pick<Client, "query">,
  jobId: string,
  outcome: { counts: Record<string, number>; errorCode?: string },
): Promise<void> => {
  const result = await client.query(`
    UPDATE fs138.job_runs SET status = $2, counts = $3, error_code = $4
    WHERE job_id = $1 AND status = 'running' RETURNING job_id`,
  [jobId, outcome.errorCode === undefined ? "succeeded" : "failed", outcome.counts, outcome.errorCode ?? null]);
  if (result.rowCount !== 1) throw new Error("job-finish-refused");
};
