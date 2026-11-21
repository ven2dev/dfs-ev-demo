import { describe, expect, it, vi } from "vitest";
import { readOddsSubjectReport, oddsSubjectReportSql, pruneOddsSubjectHistory,
 pruneOddsSubjectBucketsSql, pruneOddsSubjectLimitsSql } from "@dfs-ev/db/runtime";
const counts = { admitted: 0, denied: 0, wouldDeny: 0, floorDenied: 0, anonymous: 0, signedIn: 0 };
const row = (label: string) => ({ label, totals: counts, top_admitted: [], top_denied: [], top_would_deny: [] });
describe("#223 report and maintenance work budgets", () => {
  it("reads both fixed windows in one statement", async () => {
    const query = vi.fn().mockResolvedValue([row("1h"), row("24h")]);expect(await readOddsSubjectReport(query)).toHaveLength(2);
    expect(query.mock.calls).toEqual([[oddsSubjectReportSql, []]]);
  });
  it("rejects raw identifiers and oversized or malformed reports", async () => {
    for (const entries of [[{ ...counts, subject: "raw-user" }], Array.from({ length: 21 }, () => ({ ...counts, subject: "v1:user:" + "a".repeat(64) }))]) {
      await expect(readOddsSubjectReport(vi.fn().mockResolvedValue([{ ...row("1h"), top_admitted: entries }, row("24h")]))).rejects.toThrow();
    }
    await expect(readOddsSubjectReport(vi.fn().mockResolvedValue([row("1h"),row("1h")]))).rejects.toThrow();
  });
  it("maintenance is two fixed bounded statements, never implicit report work", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ deleted: 1000 }]).mockResolvedValueOnce([{ deleted: 0 }]);
    expect(await pruneOddsSubjectHistory(query)).toEqual({ bucketsDeleted: 1000, limitsDeleted: 0 });
    expect(query.mock.calls).toEqual([[pruneOddsSubjectBucketsSql, []], [pruneOddsSubjectLimitsSql, []]]);
    expect(pruneOddsSubjectBucketsSql).toContain("LIMIT 1000");expect(pruneOddsSubjectLimitsSql).toContain("SKIP LOCKED");
  });
});
