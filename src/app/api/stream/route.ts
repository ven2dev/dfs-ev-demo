import { NextRequest, NextResponse } from "next/server";
import { consensusDevigAtLine } from "@/lib/consensusDevig";
import { computeEV } from "@/lib/computeEV";
import { DEFAULT_SPORT_KEY, fetchSlateEvents } from "@/lib/oddsApi";
import {
  getNflverseTeamAbbreviation,
  getVenueForTeam,
} from "@/lib/nflStadiums";
import { getCurrentSeason } from "@/lib/nflverseClient";
import { MAX_TICKS, POLL_INTERVAL_MS, parseSampleWindow } from "@/lib/streamConfig";
import { mockCoverageFilters } from "@/store/mockData";
import { getRealRecentGameStats } from "@/lib/playerStatsRepo";
import { buildWatchPropId } from "@/lib/watchPropId";
import { getPlayerPropMarket, type PlayerPropDirection } from "@/lib/playerPropMarkets";
import { getSharedLivePropInputs } from "@/lib/livePropCacheRepo";

// SSE endpoint. Real Odds API + real weather calls happen here,
// server-side only — the API key never reaches the client.
//
// Connections still schedule their own ticks and receive independent
// SSE responses, but their cost-bearing odds/weather refresh is shared
// through a Postgres-backed cache + refresh lease keyed by
// sport/event/market/player. A full single-poller broadcast transport is
// separate future work; it is no longer required for quota deduplication.
//
// Quota safety: The Odds API's free tier is 500 requests/MONTH. A
// forgotten open tab must not be able to burn through that in minutes.
// POLL_INTERVAL_MS is deliberately conservative, MAX_TICKS hard-caps
// each connection, and the distributed lease makes overlapping viewers
// reuse one upstream refresh per prop/poll window.
//
// Self-scheduling setTimeout, not setInterval: setInterval fires on a
// fixed clock regardless of whether the previous async callback has
// finished, so a single slow/hung fetch could let ticks overlap and the
// cap stop being absolute. Scheduling the next tick only after the
// current one has fully resolved makes overlap impossible by
// construction, not just unlikely.
//
// This does not reuse the five-minute discovery cache. The live cache's
// TTL matches POLL_INTERVAL_MS, retaining live cadence while sharing the
// refresh across connections and instances.

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const eventId = params.get("eventId");
  const marketKey = params.get("marketKey");
  const playerName = params.get("playerName");
  const bookmakerKey = params.get("bookmakerKey");
  const direction = params.get("direction");
  const sportKey = params.get("sportKey") || DEFAULT_SPORT_KEY;
  const sampleWindow = parseSampleWindow(params.get("sampleWindow"));

  if (!eventId || !marketKey || !playerName || !bookmakerKey || !direction) {
    return NextResponse.json(
      {
        success: false,
        reason: "eventId, marketKey, playerName, bookmakerKey, and direction are required",
      },
      { status: 400 }
    );
  }

  if (direction !== "over" && direction !== "under") {
    return NextResponse.json(
      { success: false, reason: 'direction must be either "over" or "under"' },
      { status: 400 }
    );
  }

  const marketCapability = getPlayerPropMarket(marketKey);
  if (
    !marketCapability ||
    !marketCapability.trackable ||
    marketCapability.outcomeShape !== "over-under" ||
    !marketCapability.historicalStatType
  ) {
    return NextResponse.json(
      { success: false, reason: `Market "${marketKey}" is browse-only and cannot be watched` },
      { status: 400 }
    );
  }

  // The event's real home team/kickoff time are re-resolved here, never
  // trusted from client query params -- weather (and therefore the EV
  // calc) depends on getting the right venue, and this is a free call
  // regardless (see fetchSlateEvents), so there's no cost reason to
  // trust the client instead.
  let venueLat: number;
  let venueLon: number;
  let startTime: string;
  let eventTeams: [string, string];
  try {
    const slateEvents = await fetchSlateEvents(sportKey);
    const event = slateEvents.find((e) => e.id === eventId);
    if (!event) {
      return NextResponse.json(
        { success: false, reason: `Event "${eventId}" is not in the current ${sportKey} slate` },
        { status: 404 }
      );
    }
    const venue = getVenueForTeam(event.homeTeam);
    if (!venue) {
      return NextResponse.json(
        { success: false, reason: `No known venue for home team "${event.homeTeam}"` },
        { status: 400 }
      );
    }
    venueLat = venue.lat;
    venueLon = venue.lon;
    startTime = event.commenceTime;
    const homeTeam = getNflverseTeamAbbreviation(event.homeTeam);
    const awayTeam = getNflverseTeamAbbreviation(event.awayTeam);
    if (!homeTeam || !awayTeam) {
      return NextResponse.json(
        { success: false, reason: "Failed to map the selected event's teams" },
        { status: 502 }
      );
    }
    eventTeams = [homeTeam, awayTeam];
  } catch (err) {
    console.error("[api/stream] failed to resolve the selected event:", err);
    return NextResponse.json(
      { success: false, reason: "Failed to resolve the selected event" },
      { status: 502 }
    );
  }

  const selectedDirection: PlayerPropDirection = direction;
  const propId = buildWatchPropId({
    eventId,
    marketKey,
    playerName,
    bookmakerKey,
    direction: selectedDirection,
  });

  // Fetched once per connection, not per tick, unlike odds/weather --
  // historical game stats only change weekly (as games complete), so
  // re-querying Postgres on every poll interval would be pure waste.
  let recentGameStats: number[];
  try {
    const realRecentGameStats = await getRealRecentGameStats(
      playerName,
      marketCapability.historicalStatType,
      {
        season: getCurrentSeason(new Date(startTime)),
        eventTeams,
        marketKey,
      }
    );
    if (!realRecentGameStats || realRecentGameStats.length === 0) {
      return NextResponse.json(
        {
          success: false,
          reason: `No historical data is available for "${playerName}" in market "${marketKey}"`,
        },
        { status: 422 }
      );
    }
    recentGameStats = realRecentGameStats;
  } catch (err) {
    console.error("[api/stream] real historical-stats lookup failed:", err);
    return NextResponse.json(
      { success: false, reason: "Historical stats are temporarily unavailable" },
      { status: 503 }
    );
  }

  // Average of the prop's OWN stat (same stat as the line, e.g. passing
  // yards) over the same sampleWindow used for the EV hit-rate calc --
  // deliberately just a historical average, not a "projection." No
  // predictive algo model exists in this codebase.
  const recentStatWindow = recentGameStats.slice(-sampleWindow);
  const recentStatAverage =
    recentStatWindow.length > 0
      ? recentStatWindow.reduce((sum, v) => sum + v, 0) / recentStatWindow.length
      : undefined;

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tickCount = 0;
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        // Guarded here, not at each call site: an in-flight tick can
        // still be awaiting its fetch calls when the client disconnects
        // and cancel() fires. Enqueuing on an already-cancelled
        // controller throws — including from the error-path send() call
        // inside tick()'s own catch block, which would otherwise throw
        // again, unhandled. One guard point protects every call site.
        if (cancelled) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const tick = async () => {
        // Counted here, before any fetch, so the cap bounds total request
        // ATTEMPTS against the quota — not just successful sends. A run of
        // failures must not let this loop retry indefinitely.
        tickCount += 1;

        try {
          const inputs = await getSharedLivePropInputs(
            { sportKey, eventId, marketKey, playerName },
            { startTime, venueLat, venueLon }
          );
          const oddsLine = inputs.oddsByBookmaker.find(
            (line) => line.bookmakerKey === bookmakerKey
          );
          const weather = inputs.weather;

          if (!oddsLine) {
            send({
              type: "error",
              message: `Bookmaker "${bookmakerKey}" no longer offers this prop`,
            });
            return;
          }

          const consensus = consensusDevigAtLine(inputs.oddsByBookmaker, oddsLine.point);
          if (!consensus) {
            send({
              type: "error",
              message: `No valid two-way market quotes remain at line ${oddsLine.point}`,
            });
            return;
          }

          // The selected sportsbook is the product-visible anchor for
          // this line. Do not silently build a consensus around an
          // invalid anchor even if another book still has valid prices.
          if (!consensusDevigAtLine([oddsLine], oddsLine.point)) {
            send({
              type: "error",
              message: `Bookmaker "${bookmakerKey}" no longer offers a valid two-way quote for this prop`,
            });
            return;
          }

          const result = computeEV({
            recentGameStats,
            line: oddsLine.point,
            sampleWindow,
            windSpeedMph: weather.windSpeedMph,
            precipitationMm: weather.precipitationMm,
            shadowCoverageRate: mockCoverageFilters.shadowCoverageRate as number,
            impliedProb:
              selectedDirection === "over"
                ? consensus.impliedProbOver
                : consensus.impliedProbUnder,
            direction: selectedDirection,
          });

          send({
            type: "tick",
            propId,
            timestamp: Date.now(),
            line: oddsLine.point,
            direction: selectedDirection,
            marketConsensus: {
              method: consensus.method,
              version: consensus.version,
              contributingBookCount: consensus.contributingBookCount,
            },
            weather,
            evScore: result.evScore,
            stages: {
              baseRate: result.baseRate,
              afterEnvironment: result.afterEnvironment,
              afterCoverage: result.afterCoverage,
            },
            recentStatAverage,
          });
        } catch (err) {
          send({ type: "error", message: String(err) });
        }
      };

      // Only ever schedules the next tick after the current one has
      // fully resolved — no invocation can start before the prior one
      // finishes, so the MAX_TICKS cap is a hard ceiling, not a race.
      const scheduleNext = () => {
        if (cancelled) return;
        if (tickCount >= MAX_TICKS) {
          send({
            type: "idle",
            message: `Reached ${MAX_TICKS}-request safety cap for this connection (Odds API quota protection). Refresh to resume.`,
          });
          return;
        }
        timer = setTimeout(async () => {
          await tick();
          scheduleNext();
        }, POLL_INTERVAL_MS);
      };

      await tick();
      scheduleNext();
    },
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
