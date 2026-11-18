import { describe, expect, it, vi } from "vitest";
import { readProviderCreditHealth } from "./providerCreditHealth";
describe("provider credit health visibility", () => {
  it("reports one typed authority read with real unresolved total/count", async () => {
    const result = { initialized: true, period: "2026-11", reason: "period-mismatch", severity: "critical",
      unresolvedLiabilityTotal: 24, unresolvedLiabilityCount: 2, oldestUnresolvedAgeSeconds: 360,
      collectorFloor: 100, availableCredits: 976 };
    const query = vi.fn(async () => [{ result }]);
    expect(await readProviderCreditHealth(new Date("2026-11-17"), query)).toEqual(result);
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("provider_credit.health"), ["2026-11"]);
  });
  it.each(["missing-schema", "invalid-result"])("%s never becomes a fake zero", async reason => {
    const query = vi.fn(async () => { if (reason === "missing-schema") throw new Error("private connection"); return []; });
    expect(await readProviderCreditHealth(new Date("2026-11-17"), query)).toEqual({ severity: "unavailable", reason: "authority-unavailable",
      unresolvedLiabilityTotal: null, unresolvedLiabilityCount: null, oldestUnresolvedAgeSeconds: null, availableCredits: null });
    expect(query).toHaveBeenCalledOnce();
  });
});
