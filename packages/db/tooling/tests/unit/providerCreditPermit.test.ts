import { describe, expect, it, vi } from "vitest";
import { consumeProviderCreditPermit, reserveProviderCreditSend, type ProviderCreditPermit } from "@dfs-ev/db/runtime";
import type { ProviderCreditDecision, ProviderCreditReservationInput } from "@dfs-ev/db/runtime";
const input: ProviderCreditReservationInput = { id: "attempt", mode: "enforce", kind: "raw", resourceId: "event",
  ownerId: "owner", sportKey: "americanfootball_nfl", marketKeys: ["b", "a"], expectedCost: 2, period: "2026-11" };
const send = { sportKey: "americanfootball_nfl" as const, eventId: "event", marketKeys: ["a", "b"], deadline: 100 };
const decision = (outcome: ProviderCreditDecision["outcome"]): ProviderCreditDecision => ({ outcome,
  allowed: outcome === "reserved", reason: "reserved", reservationId: "attempt", cost: 2, availableCredits: 100, period: "2026-11" });
const options = () => ({ now: () => 0, onShadowFailure: vi.fn() });

describe("reservation-minted single-use paid capability", () => {
  it("cannot accept a plain object at compile time", () => {
    // @ts-expect-error a plain object has no nominal brand
    const forged: ProviderCreditPermit = send;
    expect(() => consumeProviderCreditPermit(forged)).toThrow("Invalid");
  });
  it("binds canonical selectors and permits exactly one send", async () => {
    const reserve = vi.fn(async () => decision("reserved"));
    const permit = await reserveProviderCreditSend({ reserve }, input, send, options());
    expect(reserve).toHaveBeenCalledOnce();
    expect(consumeProviderCreditPermit(permit)).toMatchObject({ eventId: "event", marketKeys: ["a", "b"], authoritative: true });
    expect(() => consumeProviderCreditPermit(permit)).toThrow("consumed");
    expect(Object.isFrozen(permit.marketKeys)).toBe(true);
  });
  it.each(["replay", "denied"] as const)("%s cannot mint another send in either mode", async outcome => {
    for (const mode of ["enforce", "log-only"] as const) {
      await expect(reserveProviderCreditSend({ reserve: async () => decision(outcome) }, { ...input, mode }, send, options())).rejects.toThrow("refused");
    }
  });
  it("continues only log-only when storage outcome is ambiguous, with sanitized notice and no retry", async () => {
    const reserve = vi.fn(async () => { throw new Error("private database error"); });
    const opts = options();
    const permit = await reserveProviderCreditSend({ reserve }, { ...input, mode: "log-only" }, send, opts);
    expect(consumeProviderCreditPermit(permit).authoritative).toBe(false);
    expect(opts.onShadowFailure).toHaveBeenCalledExactlyOnceWith();
    await expect(reserveProviderCreditSend({ reserve }, input, send, opts)).rejects.toThrow("authority unavailable");
    expect(reserve).toHaveBeenCalledTimes(2);
  });
  it("mints a non-authoritative shadow permit only in log-only", async () => {
    const reserve = async () => decision("shadow");
    expect(consumeProviderCreditPermit(await reserveProviderCreditSend({ reserve }, { ...input, mode: "log-only" }, send, options())).authoritative).toBe(false);
    await expect(reserveProviderCreditSend({ reserve }, input, send, options())).rejects.toThrow("refused");
  });
  it("refuses a mismatched selector/cost before accounting", async () => {
    const reserve = vi.fn();
    await expect(reserveProviderCreditSend({ reserve }, { ...input, expectedCost: 1 }, send, options())).rejects.toThrow("binding");
    await expect(reserveProviderCreditSend({ reserve }, input, { ...send, marketKeys: ["a", "c"] }, options())).rejects.toThrow("binding");
    expect(reserve).not.toHaveBeenCalled();
  });
  it("refuses expiry after delayed reservation and does not retry or release liability", async () => {
    let now = 0;
    const reserve = vi.fn(async () => { now = 101; return decision("reserved"); });
    await expect(reserveProviderCreditSend({ reserve }, input, send, { ...options(), now: () => now })).rejects.toThrow("deadline");
    expect(reserve).toHaveBeenCalledOnce();
  });
  it("refuses paused/aborted holders at the final synchronous send boundary", async () => {
    let now = 0;
    const controller = new AbortController();
    const reserve = async () => decision("reserved");
    const permit = await reserveProviderCreditSend({ reserve }, input, { ...send, signal: controller.signal }, { ...options(), now: () => now });
    now = 100;
    expect(() => consumeProviderCreditPermit(permit)).toThrow("deadline");
    const aborted = await reserveProviderCreditSend({ reserve }, input, { ...send, signal: controller.signal }, options());
    controller.abort();
    expect(() => consumeProviderCreditPermit(aborted)).toThrow();
  });
  it("does no accounting when already aborted", async () => {
    const reserve = vi.fn(); const controller = new AbortController(); controller.abort();
    await expect(reserveProviderCreditSend({ reserve }, input, { ...send, signal: controller.signal }, options())).rejects.toThrow();
    expect(reserve).not.toHaveBeenCalled();
  });
});
