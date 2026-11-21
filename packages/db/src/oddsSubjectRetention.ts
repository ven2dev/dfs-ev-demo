import type { AdmissionQuery } from "./paidOddsAdmission.ts";

// Proposed policy only; no schedule/route invokes maintenance. Each transaction
// is a bounded batch, not an unbounded vacuum on the paid path.
export const pruneOddsSubjectBucketsSql = `WITH doomed AS (
 SELECT subject,minute FROM public.odds_subject_buckets
 WHERE minute < statement_timestamp()-interval '7 days'
 ORDER BY minute,subject LIMIT 1000 FOR UPDATE SKIP LOCKED
), deleted AS (DELETE FROM public.odds_subject_buckets b USING doomed d
 WHERE b.subject=d.subject AND b.minute=d.minute RETURNING 1)
 SELECT count(*)::int AS deleted FROM deleted`;
export const pruneOddsSubjectLimitsSql = `WITH doomed AS (
 SELECT subject FROM public.odds_subject_limits s
 WHERE tat <= statement_timestamp()-interval '24 hours'
 AND NOT EXISTS(SELECT FROM public.odds_subject_buckets b WHERE b.subject=s.subject)
 ORDER BY subject LIMIT 1000 FOR UPDATE SKIP LOCKED
), deleted AS (DELETE FROM public.odds_subject_limits s USING doomed d
 WHERE s.subject=d.subject RETURNING 1)
 SELECT count(*)::int AS deleted FROM deleted`;
export const pruneOddsSubjectHistory = async (query: AdmissionQuery) => {
  const run = async (text: string) => {
    const rows = await query(text, []);
    const deleted = rows[0]?.deleted;
    if (rows.length !== 1 || typeof deleted !== "number" || !Number.isInteger(deleted) || deleted < 0 || deleted > 1000) {
      throw new Error("Invalid subject maintenance result");
    }
    return deleted;
  };
  return { bucketsDeleted: await run(pruneOddsSubjectBucketsSql), limitsDeleted: await run(pruneOddsSubjectLimitsSql) };
};
