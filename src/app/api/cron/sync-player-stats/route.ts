import { NextRequest, NextResponse } from "next/server";
import { syncPlayerStats } from "@/lib/playerStatsSync";
import {
  fetchStatsReleaseUpdatedAt,
  fetchSchedulesReleaseUpdatedAt,
  fetchStatsRows,
  fetchScheduleRows,
} from "@/lib/nflverseClient";
import { readSyncState, writeSyncState, upsertStats } from "@/lib/playerStatsRepo";

export const dynamic = "force-dynamic";

// Vercel Cron sends this header automatically on the scheduled
// invocation -- checking it means this route can't be triggered by an
// arbitrary public request, since it writes to Postgres.
const isAuthorizedCronRequest = (request: NextRequest): boolean => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
};

export const GET = async (request: NextRequest) => {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ success: false, reason: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncPlayerStats({
      fetchStatsReleaseUpdatedAt,
      fetchSchedulesReleaseUpdatedAt,
      fetchStatsRows,
      fetchScheduleRows,
      readSyncState,
      writeSyncState,
      upsertStats,
    });

    return NextResponse.json({ success: true, result });
  } catch (err) {
    console.error("[api/cron/sync-player-stats] sync failed:", err);
    return NextResponse.json({ success: false, reason: "Internal error" }, { status: 500 });
  }
};
