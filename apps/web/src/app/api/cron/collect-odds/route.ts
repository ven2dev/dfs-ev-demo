import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronHeader } from "@/lib/cronAuth";
import { runOddsCollector } from "@/lib/oddsCollector";
import { serverConfig, sanitizedFailure } from "@/lib/config.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export const GET = async (request: NextRequest) => {
  let secret: string;
  try { secret = serverConfig.cronSecret(); }
  catch (error) {
    console.error("[api/cron/collect-odds] configuration failed:", sanitizedFailure(error));
    return NextResponse.json({ success: false, reason: "Internal error" }, { status: 500 });
  }
  if (!isAuthorizedCronHeader(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ success: false, reason: "Unauthorized" }, { status: 401 });
  }

  try {
    serverConfig.liveOdds();
  } catch {
    return NextResponse.json(
      { success: false, reason: "Odds collection is unavailable for this data source" },
      { status: 503 }
    );
  }

  try {
    const configuration = serverConfig.collector();
    if (configuration.profile !== "disabled") serverConfig.database();
    const result = await runOddsCollector({ ...configuration, ownerId: randomUUID() });
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error("[api/cron/collect-odds] collection failed:", sanitizedFailure(error));
    return NextResponse.json({ success: false, reason: "Internal error" }, { status: 500 });
  }
};
