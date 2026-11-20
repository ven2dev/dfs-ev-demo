import { paidOddsHealth } from "@/lib/paidOddsBoundary";
import { readQuotaHealth, type QuotaHealth } from "@/lib/providerQuota";
import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronHeader } from "@/lib/cronAuth";
import { evaluateOddsCollectorHealth } from "@/lib/oddsCollectorHealth";
import { getOddsCollectorHealthSnapshot } from "@/lib/oddsCollectorHealthRepo";
import { serverConfig, sanitizedFailure } from "@/lib/config.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 10;

// Sized for a 15-minute external collector wake, so the Neon compute can
// suspend between wakes. Wake age tolerates one missed wake plus trigger jitter;
// the pin grace covers the first new-week wake; the claim grace lets the next
// wake recover an ordinary abandoned lease first.
const MAX_WAKE_AGE_MS = 35 * 60 * 1_000;
const PIN_CREATION_GRACE_MS = 30 * 60 * 1_000;
const UNKNOWN_COST_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const STALE_CLAIM_GRACE_MS = 25 * 60 * 1_000;

const response = (
  body: {
    status: "healthy" | "unhealthy" | "unavailable" | "error" | "unauthorized";
    reasons?: string[];
    warnings?: string[];
    quota?: QuotaHealth;
    limiter?: ReturnType<typeof paidOddsHealth>;
  },
  status: number
) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

export const GET = async (request: NextRequest) => {
  let secret: string;
  try { secret = serverConfig.oddsHealthSecret(); }
  catch { return response({ status: "unavailable", reasons: ["not-configured"] }, 503); }
  if (!isAuthorizedCronHeader(request.headers.get("authorization"), secret)) {
    return response({ status: "unauthorized" }, 401);
  }

  try {
    serverConfig.liveOdds();
  } catch {
    return response({ status: "unavailable", reasons: ["data-source-not-live"] }, 503);
  }

  try {
    const configuration = serverConfig.collectorHealth();
    const now = new Date();
    const snapshot = await getOddsCollectorHealthSnapshot(now, {
      unknownCostLookbackMs: UNKNOWN_COST_LOOKBACK_MS,
      staleClaimGraceMs: STALE_CLAIM_GRACE_MS,
    });
    const result = evaluateOddsCollectorHealth(snapshot, {
      now,
      actualProfile: configuration.profile,
      quotaReserve: configuration.quotaReserve,
      maxWakeAgeMs: MAX_WAKE_AGE_MS,
      pinCreationGraceMs: PIN_CREATION_GRACE_MS,
    });
    const quota = await readQuotaHealth();
    return response({ ...result, quota, limiter: paidOddsHealth() }, result.status === "healthy" ? 200 : 503);
  } catch (error) {
    console.error(
      "[api/health/odds-collector] health query failed:",
      sanitizedFailure(error)
    );
    return response({ status: "error", reasons: ["health-query-failed"] }, 500);
  }
};
