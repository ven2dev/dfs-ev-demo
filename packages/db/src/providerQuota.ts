export type ProviderQuotaReading = { remaining: number; used: number | null; ageSeconds: number };
export type ProviderQuotaQuery = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
// Reuse the existing requested_at DESC index and collector-health ordering.
// Age uses the database's ingestion stamp and clock, not the host capture time.
export const latestProviderQuotaSql = `SELECT quota_remaining AS remaining, quota_used AS used,
  greatest(0,floor(extract(epoch FROM clock_timestamp()-created_at)))::double precision AS age_seconds
  FROM public.odds_api_request_log WHERE quota_remaining IS NOT NULL
  ORDER BY requested_at DESC LIMIT 1`;
export const readLatestProviderQuota = async (query: ProviderQuotaQuery): Promise<ProviderQuotaReading | null> => {
  const rows = await query(latestProviderQuotaSql, []);
  if (!Array.isArray(rows) || rows.length > 1) throw new Error("Invalid provider quota reading");
  if (!rows.length) return null;
  const row = rows[0];
  const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (!count(row.remaining) || !(row.used === null || count(row.used)) || !count(row.age_seconds)) {
    throw new Error("Invalid provider quota reading");
  }
  return { remaining: row.remaining, used: row.used, ageSeconds: row.age_seconds };
};
