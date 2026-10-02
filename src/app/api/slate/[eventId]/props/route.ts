import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_SPORT_KEY } from "@/lib/oddsApi";
import { getOrFetchMarketOdds } from "@/lib/oddsCacheRepo";
import { groupOddsByPlayer } from "@/lib/discoveredProps";
import { isValidPlayerPropMarketKey } from "@/lib/playerPropMarkets";

// Real, shared market data (not per-user state), so this follows
// /api/stream's precedent -- no auth gate, unlike the requireUid-backed
// matchup-config/watchlist/goal routes, which guard per-user state.
export const GET = async (
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) => {
  try {
    const { eventId } = await params;
    if (!eventId) {
      return NextResponse.json({ success: false, reason: "eventId is required" }, { status: 400 });
    }

    const marketsParam = request.nextUrl.searchParams.get("markets");
    const requestedMarketKeys = marketsParam
      ? Array.from(
          new Set(
            marketsParam
              .split(",")
              .map((key) => key.trim())
              .filter(Boolean)
          )
        )
      : [];

    if (requestedMarketKeys.length === 0) {
      return NextResponse.json(
        { success: false, reason: "markets query param is required (comma-separated market keys)" },
        { status: 400 }
      );
    }

    // Rejected before spending a credit on it -- an unrecognized key
    // would otherwise just silently return no data from the Odds API,
    // paying for a market that was never real.
    const invalidMarketKeys = requestedMarketKeys.filter((key) => !isValidPlayerPropMarketKey(key));
    if (invalidMarketKeys.length > 0) {
      return NextResponse.json(
        { success: false, reason: `Unknown market key(s): ${invalidMarketKeys.join(", ")}` },
        { status: 400 }
      );
    }

    const sportKey = request.nextUrl.searchParams.get("sportKey") || DEFAULT_SPORT_KEY;
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "true";

    const oddsResult = await getOrFetchMarketOdds(sportKey, eventId, requestedMarketKeys, {
      forceRefresh,
    });
    const players = groupOddsByPlayer(oddsResult.odds);

    return NextResponse.json({ success: true, eventId, players });
  } catch (err) {
    console.error("[api/slate/[eventId]/props] GET failed:", err);
    return NextResponse.json({ success: false, reason: "Internal error" }, { status: 500 });
  }
};
