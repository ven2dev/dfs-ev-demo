export type AdmissionQuery = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
export type SubjectDimension = {
  keys: readonly string[];
  report: string;
  intervalMs: number;
  burst: number;
  traffic: "anonymous" | "signed-in";
};
export const SUBJECT_KEY = /^[a-z][a-z0-9]{0,15}:(anonymous-network|signed-network|user):[0-9a-f]{64}$/;
export type AdmissionWarning = "limiter-evaluation-failed" | "limiter-counter-failed" | "quota-read-failed" | "limiter-storage-failed";
export type PaidAdmission = {
  outcome: "allow" | "quota-floor" | "subject-rate-limit";
  retryAfterMs: number;
  deniedSubjects: string[];
  warning: AdmissionWarning | null;
  remaining: number | null;
  wouldDeny: boolean;
};
export const paidAdmissionSql = "SELECT * FROM public.admit_paid_odds($1::jsonb,$2,$3,$4)";

// No driver, policy defaults, identity resolution or retry here. The paid leader
// supplies only HMAC dimensions. Startup gating is owned by the web adapter.
export const admitPaidOdds = async (
  query: AdmissionQuery,
  dimensions: readonly SubjectDimension[],
  options: { enforce: boolean; reserve: number; batch: number }
): Promise<PaidAdmission> => {
  try {
    if (!Array.isArray(dimensions) || dimensions.length < 1 || dimensions.length > 2 ||
        typeof options.enforce !== "boolean" || !Number.isSafeInteger(options.reserve) || options.reserve < 0 || options.reserve > 1_000_000 ||
        !Number.isSafeInteger(options.batch) || options.batch < 1 || options.batch > 12) throw new Error("Invalid admission input");
    // Construct an allowlisted wire shape: accidental UID/IP metadata and custom
    // object serialization never become SQL parameters, even on a caller bug.
    const wire = dimensions.map(d => {
      if (!Array.isArray(d.keys) || d.keys.length < 1 || d.keys.length > 2 ||
          !d.keys.every((k: unknown) => typeof k === "string" && SUBJECT_KEY.test(k)) ||
          typeof d.report !== "string" || !SUBJECT_KEY.test(d.report) || !d.keys.includes(d.report) ||
          !Number.isSafeInteger(d.intervalMs) || d.intervalMs < 1 || !Number.isSafeInteger(d.burst) || d.burst < 1 ||
          d.burst > 1000 || d.intervalMs * d.burst > 86_400_000 || !["anonymous", "signed-in"].includes(d.traffic)) {
        throw new Error("Invalid admission dimension");
      }
      return { keys: [...d.keys], report: d.report, intervalMs: d.intervalMs, burst: d.burst, traffic: d.traffic };
    });
    const rows = await query(paidAdmissionSql, [JSON.stringify(wire), options.enforce, options.reserve, options.batch]);
    if (rows.length !== 1) throw new Error("Invalid admission result");
    const row = rows[0];
    if (!["allow", "quota-floor", "subject-rate-limit"].includes(String(row.outcome)) ||
        typeof row.retry_after_ms !== "string" || !/^\d+$/.test(row.retry_after_ms) ||
        !Number.isSafeInteger(Number(row.retry_after_ms)) || Number(row.retry_after_ms) > 86_400_000 ||
        !Array.isArray(row.denied_subjects) || row.denied_subjects.length > 4 ||
        !row.denied_subjects.every(key => typeof key === "string" && SUBJECT_KEY.test(key)) ||
        !(row.warning === null || ["limiter-evaluation-failed", "limiter-counter-failed", "quota-read-failed"].includes(String(row.warning))) ||
        !(row.quota_remaining === null || (typeof row.quota_remaining === "number" && Number.isSafeInteger(row.quota_remaining) && row.quota_remaining >= 0)) ||
        typeof row.would_deny !== "boolean" ||
        (row.outcome === "subject-rate-limit" && (!row.denied_subjects.length || Number(row.retry_after_ms) < 1))) {
      throw new Error("Invalid admission result");
    }
    return { outcome: row.outcome as PaidAdmission["outcome"], retryAfterMs: Number(row.retry_after_ms),
      deniedSubjects: row.denied_subjects, warning: row.warning as AdmissionWarning | null,
      remaining: row.quota_remaining as number | null, wouldDeny: row.would_deny };
  } catch {
    // Never interpolate the driver error, SQL or target. Caller emits exactly
    // one reason-only warning and updates instance-local health; no retry SQL.
    return { outcome: "allow", retryAfterMs: 0, deniedSubjects: [], warning: "limiter-storage-failed", remaining: null, wouldDeny: false };
  }
};

export const paidAdmissionCapabilitySql = `SELECT
  to_regclass('public.odds_subject_limits') IS NOT NULL
  AND to_regclass('public.odds_subject_buckets') IS NOT NULL
  AND CASE WHEN to_regprocedure('public.admit_paid_odds(jsonb,boolean,integer,integer)') IS NULL THEN false
    ELSE has_function_privilege(current_user,'public.admit_paid_odds(jsonb,boolean,integer,integer)','EXECUTE') END
  AND CASE WHEN to_regprocedure('public.report_odds_subjects()') IS NULL THEN false
    ELSE has_function_privilege(current_user,'public.report_odds_subjects()','EXECUTE') END
  AND CASE WHEN to_regprocedure('public.release_shared_odds_limiter_denial(text,text[],text)') IS NULL THEN false
    ELSE has_function_privilege(current_user,'public.release_shared_odds_limiter_denial(text,text[],text)','EXECUTE') END AS ready`;
