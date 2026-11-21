import type { AdmissionQuery } from "./paidOddsAdmission.ts";
import { SUBJECT_KEY } from "./paidOddsAdmission.ts";

export type SubjectCounts = { admitted: number; denied: number; wouldDeny: number; floorDenied: number; anonymous: number; signedIn: number };
export type SubjectReportEntry = SubjectCounts & { subject: string };
export type SubjectWindow = { window: "1h" | "24h"; totals: SubjectCounts; topAdmitted: SubjectReportEntry[]; topDenied: SubjectReportEntry[]; topWouldDeny: SubjectReportEntry[] };
export const oddsSubjectReportSql = "SELECT * FROM public.report_odds_subjects()";
const countNames = ["admitted", "denied", "wouldDeny", "floorDenied", "anonymous", "signedIn"] as const;
const counts = (value: unknown): SubjectCounts => {
  if (!value || typeof value !== "object") throw new Error("Invalid subject counts");
  const record = value as Record<string, unknown>;
  const result = {} as SubjectCounts;
  for (const field of countNames) {
    const n = record[field];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("Invalid subject count");
    result[field] = n;
  }
  return result;
};
const entries = (value: unknown): SubjectReportEntry[] => {
  if (!Array.isArray(value) || value.length > 20) throw new Error("Invalid subject report");
  return value.map(entry => {
    if (!entry || typeof entry.subject !== "string" || !SUBJECT_KEY.test(entry.subject)) throw new Error("Invalid subject report key");
    return { subject: entry.subject, ...counts(entry) };
  });
};
export const readOddsSubjectReport = async (query: AdmissionQuery): Promise<SubjectWindow[]> => {
  const rows = await query(oddsSubjectReportSql, []);
  if (rows.length !== 2 || new Set(rows.map(row => row.label)).size !== 2) throw new Error("Invalid subject windows");
  return rows.map(row => {
    if (row.label !== "1h" && row.label !== "24h") throw new Error("Invalid subject window");
    return { window: row.label, totals: counts(row.totals), topAdmitted: entries(row.top_admitted),
      topDenied: entries(row.top_denied), topWouldDeny: entries(row.top_would_deny) };
  });
};
