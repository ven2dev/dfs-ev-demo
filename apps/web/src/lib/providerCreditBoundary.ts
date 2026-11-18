import "server-only";
import { randomUUID } from "node:crypto";
import { createProviderCreditStore, reserveProviderCreditSend, type ProviderCreditQuery } from "@dfs-ev/db/runtime";
import { getSql } from "./db";
import type { OddsApiQuota } from "./oddsApi";

export type PaidOddsOwnership =
  | { kind: "raw"; ownerId: string; deadline: number }
  | { kind: "collector"; checkpointId: string; ownerId: string; deadline: number };
const periodAt = (date: Date) => date.toISOString().slice(0, 7);

/** Enforce is deliberately not selectable by environment/public request. #224
 * owns activation after #294/#295 and provider/header qualification. */
export const createPaidOddsBoundary = (deps: {
  query: ProviderCreditQuery; mode: "log-only" | "enforce";
  now: () => number; date: () => Date; makeId: () => string;
  onFailure: (phase: "shadow-reserve" | "reconcile") => void;
}) => async (
  sportKey: "americanfootball_nfl", eventId: string, marketKeys: string[], signal?: AbortSignal,
  ownership?: PaidOddsOwnership
) => {
  if (deps.mode === "enforce" && !ownership) throw new Error("Enforced paid send requires an owner");
  const id = deps.makeId();
  const period = periodAt(deps.date());
  const store = createProviderCreditStore(deps.query);
  const permit = await reserveProviderCreditSend(store, {
    id, mode: deps.mode, kind: ownership?.kind ?? "raw",
    resourceId: ownership?.kind === "collector" ? ownership.checkpointId : eventId,
    ownerId: ownership?.ownerId ?? id, sportKey, marketKeys,
    expectedCost: marketKeys.length, period,
  }, { sportKey, eventId, marketKeys, signal, deadline: ownership?.deadline ?? deps.now() + 20_000 },
  { now: deps.now, onShadowFailure: () => deps.onFailure("shadow-reserve") });
  return {
    permit,
    reconcile: async (quota: OddsApiQuota) => {
      // Shadow observations never mutate the authoritative quota. No invented
      // cost on missing metadata; unknown outcomes retain their full liability.
      if (deps.mode !== "enforce" || quota.last === null) return;
      try {
        await store.reconcile({ id, actualCost: quota.last, remaining: quota.remaining,
          used: quota.used, period: periodAt(deps.date()) === period ? period : null });
      } catch { deps.onFailure("reconcile"); }
      // Reconciliation failure cannot turn a received response into another send.
    },
  };
};
export const reservePaidOdds = createPaidOddsBoundary({
  query: (text, params) => getSql().query(text, params), mode: "log-only",
  now: () => performance.now(), date: () => new Date(), makeId: randomUUID,
  onFailure: phase => console.error(`[providerCredits] ${phase} accounting unavailable`),
});
