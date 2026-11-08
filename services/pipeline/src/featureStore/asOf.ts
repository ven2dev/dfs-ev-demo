import type { Client } from "pg";
import type { NormalizedRow } from "./normalize.ts";
import { NORMALIZER_VERSION } from "./source.ts";

export type EvidenceMode = "strict-point-in-time-v1" | "retrospective-reconstruction-v1";
export type AsOfRow = { feed: string; naturalKey: string; snapshotIds: string[]; data: NormalizedRow | null;
  state: string; reasons: string[]; flags: string[] };

// Both owners must have completed before ranking; a late normalizer cannot
// make an old snapshot retroactively visible at an earlier knowledge boundary.
export const NORMALIZED_AS_OF_SQL = `WITH eligible AS (
  SELECT n.*,dense_rank() OVER (PARTITION BY feed,natural_key ORDER BY available_at DESC,ingested_at DESC) AS rank
  FROM fs138.normalized_job_evidence n
  JOIN fs138.completed_jobs_at(CASE WHEN $3='strict-point-in-time-v1' THEN $1::timestamptz ELSE $2::timestamptz END) sj
    ON sj.job_id=n.source_job_id
  JOIN fs138.completed_jobs_at(CASE WHEN $3='strict-point-in-time-v1' THEN $1::timestamptz ELSE $2::timestamptz END) nj
    ON nj.job_id=n.normalizer_job_id
  WHERE normalizer_version=$4 AND ingested_at<=$2::timestamptz
    AND ($3='retrospective-reconstruction-v1' OR (available_at<=$1::timestamptz AND ingested_at<=$1::timestamptz))
) SELECT feed,natural_key,snapshot_id,data FROM eligible WHERE rank=1 ORDER BY feed,natural_key,snapshot_id`;

// Internal normalized-data selection for trusted feature/label jobs. This is not
// the dataset delivery API; source-rights delivery checks are step 5's boundary.
export const readNormalizedAsOf = async (client: Pick<Client, "query">,
  request: { cutoff: string; checkpoint: string; mode: EvidenceMode }): Promise<AsOfRow[]> => {
  // Explicit offsets keep JavaScript and PostgreSQL from interpreting a
  // timezone-less caller value differently. Accept PG's microsecond clock text.
  const zoned = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
  if (!zoned.test(request.cutoff) || !zoned.test(request.checkpoint) ||
      !["strict-point-in-time-v1", "retrospective-reconstruction-v1"].includes(request.mode) ||
      !Number.isFinite(Date.parse(request.cutoff)) || !Number.isFinite(Date.parse(request.checkpoint)) ||
      Date.parse(request.cutoff) > Date.parse(request.checkpoint)) throw new Error("as-of-request-refused");
  const result = await client.query<{ feed: string; natural_key: string; snapshot_id: string; data: NormalizedRow }>(NORMALIZED_AS_OF_SQL,
  [request.cutoff, request.checkpoint, request.mode, NORMALIZER_VERSION]);
  const grouped = new Map<string, AsOfRow>();
  for (const row of result.rows) {
    const key = `${row.feed}/${row.natural_key}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.snapshotIds.push(row.snapshot_id);
      existing.state = "ambiguous"; existing.reasons = ["equal-time-snapshot-conflict"]; existing.data = null;
    } else grouped.set(key, { feed: row.feed, naturalKey: row.natural_key, snapshotIds: [row.snapshot_id], data: row.data,
      state: String(row.data.state), reasons: row.data.reasons as string[],
      flags: request.mode === "retrospective-reconstruction-v1" ? ["historical-availability-unverified"] : [] });
  }
  return [...grouped.values()];
};
