import { NextRequest, NextResponse } from "next/server";
import { serverConfig } from "@/lib/config.server";
import { isAuthorizedCronHeader } from "@/lib/cronAuth";
import { paidOddsHealth } from "@/lib/paidOddsBoundary";
import { evaluateSubjectHealth, proposedSubjectThresholds } from "@/lib/oddsSubjectHealth";
import { getOddsSubjectReport } from "@/lib/oddsSubjectReport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 10;
const response = (body: unknown, status: number) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "no-store" },
});
export const GET = async (request: NextRequest) => {
  let secret: string;
  try { secret = serverConfig.oddsHealthSecret(); }
  catch { return response({ status: "unavailable", reason: "not-configured" }, 503); }
  if (!isAuthorizedCronHeader(request.headers.get("authorization"), secret)) return response({ status: "unauthorized" }, 401);
  try {
    const windows = await getOddsSubjectReport();
    if (!windows) return response({ status: "unavailable", reason: "not-installed", limiter: paidOddsHealth() }, 503);
    return response({ status: "available", approximate: true, excessAtCutoffSeconds: 60,
      counts: "subject-dimension admissions to send, not unique HTTP calls", windows,
      health: evaluateSubjectHealth(windows), proposedThresholds: proposedSubjectThresholds,
      thresholdsActive: false, limiter: paidOddsHealth() }, 200);
  } catch {
    console.warn("[odds-subject-report] report-unavailable");
    return response({ status: "unavailable", reason: "report-unavailable", limiter: paidOddsHealth() }, 503);
  }
};
