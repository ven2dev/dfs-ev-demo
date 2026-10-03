import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronHeader } from "@/lib/cronAuth";
import { evaluateOddsCollectorHealth } from "@/lib/oddsCollectorHealth";
import { getOddsCollectorHealthSnapshot } from "@/lib/oddsCollectorHealthRepo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 10;

const MAX_WAKE_AGE_MS = 20 * 60 * 1_000;
const PIN_CREATION_GRACE_MS = 15 * 60 * 1_000;
const UNKNOWN_COST_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const STALE_CLAIM_GRACE_MS = 10 * 60 * 1_000;

const quotaReserve = () => {
  const raw = process.env.ODDS_COLLECTION_QUOTA_RESERVE;
  if (raw === undefined || raw.trim() === "") return 100;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new Error("ODDS_COLLECTION_QUOTA_RESERVE is invalid");
  }
  return value;
};

const response = (
  body: {
    status: "healthy" | "unhealthy" | "error" | "unauthorized";
    reasons?: string[];
    warnings?: string[];
  },
  status: number
) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

export const GET = async (request: NextRequest) => {
  if (
    !isAuthorizedCronHeader(
      request.headers.get("authorization"),
      process.env.ODDS_HEALTH_SECRET
    )
  ) {
    return response({ status: "unauthorized" }, 401);
  }

  try {
    const now = new Date();
    const snapshot = await getOddsCollectorHealthSnapshot(now, {
      unknownCostLookbackMs: UNKNOWN_COST_LOOKBACK_MS,
      staleClaimGraceMs: STALE_CLAIM_GRACE_MS,
    });
    const result = evaluateOddsCollectorHealth(snapshot, {
      now,
      actualProfile: process.env.ODDS_COLLECTION_PROFILE?.trim() || "disabled",
      quotaReserve: quotaReserve(),
      maxWakeAgeMs: MAX_WAKE_AGE_MS,
      pinCreationGraceMs: PIN_CREATION_GRACE_MS,
    });
    return response(result, result.status === "healthy" ? 200 : 503);
  } catch (error) {
    console.error(
      "[api/health/odds-collector] health query failed:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return response({ status: "error", reasons: ["health-query-failed"] }, 500);
  }
};
