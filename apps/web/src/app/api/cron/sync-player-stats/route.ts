import { NextRequest, NextResponse } from "next/server";
import { syncPlayerStats } from "@/lib/playerStatsSync";
import { syncNflverseRoster } from "@/lib/nflverseRosterSync";
import {
  fetchRosterReleaseUpdatedAt,
  fetchRosterRows,
  fetchStatsReleaseUpdatedAt,
  fetchSchedulesReleaseUpdatedAt,
  fetchStatsRows,
  fetchScheduleRows,
} from "@/lib/nflverseClient";
import { readSyncState, writeSyncState, upsertStats } from "@/lib/playerStatsRepo";
import { upsertRosterPlayers } from "@/lib/playerRosterRepo";
import { isAuthorizedCronHeader } from "@/lib/cronAuth";
import { serverConfig, sanitizedFailure } from "@/lib/config.server";

export const dynamic = "force-dynamic";

// Vercel Cron sends this header automatically on the scheduled
// invocation -- checking it means this route can't be triggered by an
// arbitrary public request, since it writes to Postgres.
const isAuthorizedCronRequest = (request: NextRequest): boolean => {
  return isAuthorizedCronHeader(
    request.headers.get("authorization"),
    serverConfig.cronSecret()
  );
};

export const GET = async (request: NextRequest) => {
  try {
    if (!isAuthorizedCronRequest(request)) {
      return NextResponse.json({ success: false, reason: "Unauthorized" }, { status: 401 });
    }
    // Validate the shared database dependency before starting either download.
    serverConfig.database();
    const [playerStats, roster] = await Promise.all([
      syncPlayerStats({
        fetchStatsReleaseUpdatedAt,
        fetchSchedulesReleaseUpdatedAt,
        fetchStatsRows,
        fetchScheduleRows,
        readSyncState,
        writeSyncState,
        upsertStats,
      }),
      syncNflverseRoster({
        fetchRosterReleaseUpdatedAt,
        fetchRosterRows,
        readSyncState,
        writeSyncState,
        upsertRosterPlayers,
      }),
    ]);

    return NextResponse.json({ success: true, result: { playerStats, roster } });
  } catch (err) {
    console.error("[api/cron/sync-player-stats] sync failed:", sanitizedFailure(err));
    return NextResponse.json({ success: false, reason: "Internal error" }, { status: 500 });
  }
};
