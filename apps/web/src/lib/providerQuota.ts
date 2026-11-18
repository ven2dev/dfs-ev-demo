import "server-only";
import { readLatestProviderQuota, type ProviderQuotaReading } from "@dfs-ev/db/runtime";
import { getSql } from "./db";
import { serverConfig } from "./config.server";
import { TRACKABLE_PLAYER_PROP_MARKET_KEYS } from "./playerPropMarkets";

export class InteractiveQuotaUnavailable extends Error {
  readonly reason = "quota-floor" as const;
  constructor() {
    super("Odds refresh is paused; cached odds may still be available.");
  }
}
export type PaidOddsContext =
  | { kind: "raw"; ownerId: string; deadline: number }
  | { kind: "collector"; checkpointId: string; ownerId: string; deadline: number; marketKeys: readonly string[] };
export const latestProviderQuota = (): Promise<ProviderQuotaReading | null> =>
  serverConfig.databaseConfigured() ? readLatestProviderQuota((text, params) => getSql().query(text, params)) : Promise.resolve(null);
export const checkInteractiveQuotaFloor = async () => {
  let reading: ProviderQuotaReading | null;
  try { reading = await latestProviderQuota(); }
  catch {
    // Advisory only: the provider enforces its cap. Emit a bounded reason class,
    // never the driver error, SQL, target or credentials; health stays unavailable.
    console.warn("[providerQuota] quota-read-failed");
    return;
  }
  const reserve = serverConfig.collectorHealth().quotaReserve;
  if (reading !== null && reading.remaining <= reserve + TRACKABLE_PLAYER_PROP_MARKET_KEYS.length) {
    throw new InteractiveQuotaUnavailable();
  }
};
export type QuotaHealth = { status: "available"; remaining: number; used: number | null; ageSeconds: number } |
  { status: "unavailable"; remaining: null; used: null; ageSeconds: null };
export const readQuotaHealth = async (): Promise<QuotaHealth> => {
  try {
    const reading = await latestProviderQuota();
    if (reading) return { status: "available", ...reading };
  } catch { /* Unknown stays explicitly unavailable, never a zero balance. */ }
  return { status: "unavailable", remaining: null, used: null, ageSeconds: null };
};
