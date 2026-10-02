import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronHeader } from "@/lib/cronAuth";
import { runOddsCollector } from "@/lib/oddsCollector";
import { parseOddsCollectionProfile } from "@/lib/oddsCollectionPolicy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const integerSetting = (
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
};

export const GET = async (request: NextRequest) => {
  if (
    !isAuthorizedCronHeader(
      request.headers.get("authorization"),
      process.env.CRON_SECRET
    )
  ) {
    return NextResponse.json({ success: false, reason: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runOddsCollector({
      profile: parseOddsCollectionProfile(process.env.ODDS_COLLECTION_PROFILE),
      freePilotEventId: process.env.ODDS_FREE_PILOT_EVENT_ID || undefined,
      eveningHourEastern: integerSetting("ODDS_COLLECTION_EVENING_HOUR_ET", 20, 0, 23),
      ownerId: randomUUID(),
      leaseMs: integerSetting("ODDS_COLLECTION_LEASE_MS", 45_000, 5_000, 55_000),
      claimLimit: integerSetting("ODDS_COLLECTION_CLAIM_LIMIT", 2, 1, 10),
      requestTimeoutMs: integerSetting(
        "ODDS_COLLECTION_REQUEST_TIMEOUT_MS",
        15_000,
        1_000,
        20_000
      ),
      retryDelayMs: integerSetting("ODDS_COLLECTION_RETRY_DELAY_MS", 60_000, 1_000, 300_000),
      quotaReserve: integerSetting("ODDS_COLLECTION_QUOTA_RESERVE", 100, 0, 1_000_000),
      priorityFarIntervalMs: integerSetting(
        "ODDS_PRIORITY_FAR_INTERVAL_MS",
        60 * 60 * 1_000,
        60_000,
        24 * 60 * 60 * 1_000
      ),
      priorityActiveIntervalMs: integerSetting(
        "ODDS_PRIORITY_ACTIVE_INTERVAL_MS",
        5 * 60 * 1_000,
        60_000,
        6 * 60 * 60 * 1_000
      ),
    });
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error("[api/cron/collect-odds] collection failed:", error);
    return NextResponse.json({ success: false, reason: "Internal error" }, { status: 500 });
  }
};
