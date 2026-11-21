import { describe, expect, it, vi } from "vitest";
import { admitPaidOdds, paidAdmissionSql } from "@dfs-ev/db/runtime";
const subject = "v1:anonymous-network:" + "a".repeat(64);
const dims = [{ keys: [subject], report: subject, intervalMs: 1000, burst: 1, traffic: "anonymous" as const }];
const row = { outcome: "allow", retry_after_ms: "0", denied_subjects: [], warning: null, quota_remaining: 500, would_deny: false };
describe("#223 one-statement runtime primitive", () => {
  it("uses one parameterized unnamed query and parses DB bigint retry time", async () => {
    const query = vi.fn().mockResolvedValue([{ ...row, outcome: "subject-rate-limit", denied_subjects: [subject], retry_after_ms: "145" }]);
    expect(await admitPaidOdds(query, dims, { enforce: true, reserve: 100, batch: 9 })).toMatchObject({ outcome: "subject-rate-limit", retryAfterMs: 145, deniedSubjects: [subject] });
    expect(query.mock.calls).toEqual([[paidAdmissionSql, [JSON.stringify(dims), true, 100, 9]]]);
  });
  it("storage failure allows without retry or reflecting details", async () => {
    const query = vi.fn().mockRejectedValue(new Error("private SQL URI"));
    const result = await admitPaidOdds(query, dims, { enforce: true, reserve: 100, batch: 9 });
    expect(result).toMatchObject({ outcome: "allow", warning: "limiter-storage-failed", remaining: null });
    expect(JSON.stringify(result)).not.toContain("private"); expect(query).toHaveBeenCalledTimes(1);
  });
  it("rejects raw identity before SQL and omits extra caller metadata", async () => {
    const query = vi.fn().mockResolvedValue([row]);
    const result = await admitPaidOdds(query, [{ ...dims[0], keys: ["raw-user-id"], report: "raw-user-id" }], { enforce: true, reserve: 100, batch: 9 });
    expect(result.warning).toBe("limiter-storage-failed");expect(query).not.toHaveBeenCalled();
    await admitPaidOdds(query, [{ ...dims[0], uid: "raw-user-id" } as typeof dims[0]], { enforce: true, reserve: 100, batch: 9 });
    expect(JSON.stringify(query.mock.calls)).not.toContain("raw-user-id");
  });
  it("known quota refusal survives a returned counter error", async () => {
    const query = vi.fn().mockResolvedValue([{ ...row, outcome: "quota-floor", warning: "limiter-counter-failed", quota_remaining: 0 }]);
    expect(await admitPaidOdds(query, dims, { enforce: true, reserve: 100, batch: 9 })).toMatchObject({ outcome: "quota-floor", remaining: 0 });
  });
  it.each([{ ...row, outcome: "subject-rate-limit" }, { ...row, denied_subjects: ["raw-id"] }, { ...row, warning: "raw-unknown" }, { ...row, retry_after_ms: "-1" }].map((bad, i) => [i, bad] as const))("invalid reply %i fails open with bounded reason", async (_i, bad) => {
    expect(await admitPaidOdds(vi.fn().mockResolvedValue([bad]), dims, { enforce: true, reserve: 100, batch: 9 })).toMatchObject({ outcome: "allow", warning: "limiter-storage-failed" });
  });
});
