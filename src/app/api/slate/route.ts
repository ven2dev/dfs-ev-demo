import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_SPORT_KEY, fetchSlateEvents } from "@/lib/oddsApi";
import { getCurrentNflSlateWindow } from "@/lib/nflWeek";

// The bare game list -- zero Odds API credit cost (see fetchSlateEvents),
// so unlike /api/slate/[eventId]/props this has no caching layer of its
// own; there's nothing to protect against overuse of. Shared market
// data, not per-user state, so no auth gate -- same as /api/stream and
// the props discovery route.
export const GET = async (request: NextRequest) => {
  try {
    const sportKey = request.nextUrl.searchParams.get("sportKey") || DEFAULT_SPORT_KEY;
    const now = new Date();
    const window = getCurrentNflSlateWindow(now);
    const events = await fetchSlateEvents(sportKey, now);
    return NextResponse.json({ success: true, events, window });
  } catch (err) {
    console.error("[api/slate] GET failed:", err);
    return NextResponse.json({ success: false, reason: "Internal error" }, { status: 500 });
  }
};
