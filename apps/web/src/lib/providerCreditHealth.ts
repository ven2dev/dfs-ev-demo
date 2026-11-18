import "server-only";
import { createProviderCreditStore, type ProviderCreditHealth, type ProviderCreditQuery } from "@dfs-ev/db/runtime";
import { getSql } from "./db";

export type ProviderCreditHealthReport = ProviderCreditHealth | {
  severity: "unavailable"; reason: "authority-unavailable";
  unresolvedLiabilityTotal: null; unresolvedLiabilityCount: null;
  oldestUnresolvedAgeSeconds: null; availableCredits: null;
};
export const readProviderCreditHealth = async (
  now: Date, query: ProviderCreditQuery = (text, params) => getSql().query(text, params)
): Promise<ProviderCreditHealthReport> => {
  try { return await createProviderCreditStore(query).health(now.toISOString().slice(0, 7)); }
  catch {
    // A missing proposal/schema and a failed read are both unknown, never zero.
    return { severity: "unavailable", reason: "authority-unavailable", unresolvedLiabilityTotal: null,
      unresolvedLiabilityCount: null, oldestUnresolvedAgeSeconds: null, availableCredits: null };
  }
};
