import { describe, expect, it, vi } from "vitest";
import { createProviderCreditStore, type ProviderCreditReservationInput } from "@dfs-ev/db/runtime";

const input: ProviderCreditReservationInput = {
  id: "opaque-attempt", mode: "enforce", kind: "raw", resourceId: "event", ownerId: "owner",
  sportKey: "americanfootball_nfl", marketKeys: ["market-00"], expectedCost: 1, period: "period-one",
};
const decision = { outcome: "reserved", allowed: true, reason: "reserved", reservationId: input.id,
  cost: 1, availableCredits: 999, period: "period-one" };
const health = { initialized: true, period: "period-one", reason: "ok", severity: "ok",
  unresolvedLiabilityTotal: 1, unresolvedLiabilityCount: 1, oldestUnresolvedAgeSeconds: 0,
  collectorFloor: 100, availableCredits: 999 };

describe("provider-neutral credit query/result contracts", () => {
  it("reserves with one parameterized statement and no retry/driver creation", async () => {
    const query = vi.fn().mockResolvedValue([{ result: decision }]);
    expect(await createProviderCreditStore(query).reserve(input)).toEqual(decision);
    expect(query).toHaveBeenCalledExactlyOnceWith(
      "SELECT provider_credit.reserve($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
      [input.id, input.mode, input.kind, input.resourceId, input.ownerId, input.sportKey, ["market-00"], 1, input.period]);
  });
  it("sanitizes driver failure without exposing target/credentials or retrying", async () => {
    const query = vi.fn().mockRejectedValue(new Error("private target details"));
    await expect(createProviderCreditStore(query).reserve(input)).rejects.toThrow(/^Provider credit authority unavailable$/);
    expect(query).toHaveBeenCalledOnce();
  });
  it.each([[], [{ result: null }], [{ result: decision }, { result: decision }]].map(rows => ({ rows })))("refuses missing/ambiguous results $rows", async ({ rows }) => {
    await expect(createProviderCreditStore(vi.fn().mockResolvedValue(rows)).reserve(input)).rejects.toThrow("Invalid provider credit result");
  });
  it.each([
    { allowed: false }, { outcome: "replay" }, { outcome: "denied" }, { cost: 2 },
    { cost: Number.MAX_SAFE_INTEGER + 1 }, { availableCredits: -1 }, { reason: "anything" },
    { reservationId: "someone-else" }, { period: undefined }, { period: null }, { period: "wrong-period" },
    { availableCredits: null }, { availableCredits: 0 },
  ])("refuses inconsistent authorization %j", async change => {
    const store = createProviderCreditStore(vi.fn().mockResolvedValue([{ result: { ...decision, ...change } }]));
    await expect(store.reserve(input)).rejects.toThrow("Invalid provider credit decision");
  });
  it("shadow and replay results cannot grant an enforce permit", async () => {
    const query = vi.fn().mockResolvedValue([{ result: { ...decision, outcome: "shadow", allowed: false } }]);
    expect((await createProviderCreditStore(query).reserve({ ...input, mode: "log-only" })).allowed).toBe(false);
    query.mockResolvedValue([{ result: { ...decision, outcome: "replay", allowed: false } }]);
    expect((await createProviderCreditStore(query).reserve(input)).allowed).toBe(false);
  });
  it("returns typed health totals/count without silently defaulting missing data", async () => {
    const query = vi.fn().mockResolvedValue([{ result: health }]);
    expect(await createProviderCreditStore(query).health("period-one")).toEqual(health);
    query.mockResolvedValue([{ result: { ...health, unresolvedLiabilityCount: undefined } }]);
    await expect(createProviderCreditStore(query).health("period-one")).rejects.toThrow("Invalid provider credit health");
  });
  it("period-mismatch is critical; uninitialized balance remains unknown", async () => {
    const query = vi.fn().mockResolvedValue([{ result: { ...health, reason: "period-mismatch" } }]);
    await expect(createProviderCreditStore(query).health("period-one")).rejects.toThrow("Invalid provider credit health");
    query.mockResolvedValue([{ result: { ...health, initialized: false, reason: "uninitialized", severity: "unavailable", period: null, availableCredits: null } }]);
    expect((await createProviderCreditStore(query).health("period-one")).availableCredits).toBeNull();
  });
  it("submits reconcile/initialize/resolve once each and rejects unknown operation states", async () => {
    const query = vi.fn().mockResolvedValue([{ result: { outcome: "settled" } }]);
    const store = createProviderCreditStore(query);
    await store.reconcile({ id: input.id, actualCost: 1, remaining: 999, used: 1, period: input.period });
    query.mockResolvedValue([{ result: { outcome: "initialized" } }]);
    await store.initialize({ operationId: "op", actor: "operator", remaining: 1000, used: 0, period: "new",
      periodEndsAt: "2099-01-01T00:00:00Z", collectorFloor: 100, quotaFreshnessMs: 300_000, evidenceReference: "reference" });
    query.mockResolvedValue([{ result: { outcome: "resolved" } }]);
    await store.resolveUnknown({ operationId: "resolve", actor: "operator", attemptId: input.id,
      evidence: { kind: "covered-terminal-send", reference: "reference", sendCannotResume: true, period: input.period } });
    expect(query).toHaveBeenCalledTimes(3);
    query.mockResolvedValue([{ result: { outcome: "assumed-success" } }]);
    await expect(store.reconcile({ id: input.id, actualCost: 1, remaining: 999, used: 1, period: input.period })).rejects.toThrow("Invalid provider credit operation");
  });
});
