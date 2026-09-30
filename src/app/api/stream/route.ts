import { NextRequest, NextResponse } from "next/server";
import { computeEV } from "@/lib/computeEV";
import { devigTwoWay } from "@/lib/devig";
import { DEFAULT_SPORT_KEY, fetchPlayerPropOdds, fetchSlateEvents } from "@/lib/oddsApi";
import { getVenueForTeam } from "@/lib/nflStadiums";
import { MAX_TICKS, POLL_INTERVAL_MS, parseSampleWindow } from "@/lib/streamConfig";
import { fetchGameWeather } from "@/lib/weather";
import { mockCoverageFilters } from "@/store/mockData";
import { ODDS_MARKET_TO_STAT_TYPE } from "@/lib/playerStatsSync";
import { getRealRecentGameStats } from "@/lib/playerStatsRepo";
import { buildWatchPropId } from "@/lib/watchPropId";

// SSE endpoint. Real Odds API + real weather calls happen here,
// server-side only — the API key never reaches the client.
//
// Known gap: each connection polls independently on its own interval,
// rather than one shared server-side poller fanning out to all clients.
// A true single-poller-broadcasts-to-many architecture needs a
// persistent process or a pub/sub layer (Redis, etc.) — doesn't fit
// Vercel's serverless functions as-is. Still real: real API calls, never
// client-side, just not shared across concurrent connections yet.
//
// Quota safety: The Odds API's free tier is 500 requests/MONTH. A
// forgotten open tab must not be able to burn through that in minutes.
// POLL_INTERVAL_MS is deliberately conservative, and MAX_TICKS hard-caps
// total requests any single connection can make, bounding worst-case
// cost regardless of how long a tab is left open. A real multi-user
// production deployment would still need the shared-poller architecture
// noted above for safety across many simultaneous connections.
//
// Self-scheduling setTimeout, not setInterval: setInterval fires on a
// fixed clock regardless of whether the previous async callback has
// finished, so a single slow/hung fetch could let ticks overlap and the
// cap stop being absolute. Scheduling the next tick only after the
// current one has fully resolved makes overlap impossible by
// construction, not just unlikely.
//
// Deliberately always-fresh per tick, not reusing the discovery cache
// (#27 step 7 decision) -- a live tracker showing a value frozen for
// several ticks between real refreshes defeats its own purpose. The
// existing MAX_TICKS cap already bounds worst-case cost the same way it
// always has.

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const eventId = params.get("eventId");
  const marketKey = params.get("marketKey");
  const playerName = params.get("playerName");
  const bookmakerKey = params.get("bookmakerKey");
  const sportKey = params.get("sportKey") || DEFAULT_SPORT_KEY;
  const sampleWindow = parseSampleWindow(params.get("sampleWindow"));

  if (!eventId || !marketKey || !playerName || !bookmakerKey) {
    return NextResponse.json(
      { success: false, reason: "eventId, marketKey, playerName, and bookmakerKey are required" },
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
  } catch (err) {
    console.error("[api/stream] failed to resolve the selected event:", err);
    return NextResponse.json(
      { success: false, reason: "Failed to resolve the selected event" },
      { status: 502 }
    );
  }

  const propId = buildWatchPropId({ eventId, marketKey, playerName });

  // Fetched once per connection, not per tick, unlike odds/weather --
  // historical game stats only change weekly (as games complete), so
  // re-querying Postgres on every poll interval would be pure waste.
  // Falls back to an empty array on ANY failure to get real data -- an
  // unmapped player, but also DATABASE_URL missing entirely (a fresh
  // checkout with Postgres not yet provisioned) or the DB being
  // unreachable. Without this catch, a missing DATABASE_URL would throw
  // inside getSql() before the stream even starts, crashing the whole
  // route instead of degrading (an empty sample just means no
  // base-rate/recent-stat-average tick data, not a crash).
  let recentGameStats: number[] = [];
  try {
    const statType = ODDS_MARKET_TO_STAT_TYPE[marketKey];
    const realRecentGameStats = statType
      ? await getRealRecentGameStats(playerName, statType)
      : null;
    if (!realRecentGameStats) {
      console.warn(
        `[api/stream] no real historical stats for "${playerName}" (marketKey "${marketKey}")`
      );
    } else {
      recentGameStats = realRecentGameStats;
    }
  } catch (err) {
    console.warn(
      "[api/stream] real historical-stats lookup failed (Postgres not configured/reachable?):",
      err
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
          const [oddsLine, weather] = await Promise.all([
            fetchPlayerPropOdds(sportKey, eventId, marketKey, playerName, bookmakerKey),
            fetchGameWeather(startTime, venueLat, venueLon),
          ]);

          if (!oddsLine || !weather) {
            send({ type: "error", message: "Failed to fetch real odds/weather" });
            return;
          }

          const { impliedProbOver } = devigTwoWay(
            oddsLine.overPrice,
            oddsLine.underPrice
          );

          const result = computeEV({
            recentGameStats,
            line: oddsLine.point,
            sampleWindow,
            windSpeedMph: weather.windSpeedMph,
            precipitationMm: weather.precipitationMm,
            shadowCoverageRate: mockCoverageFilters.shadowCoverageRate as number,
            impliedProb: impliedProbOver,
          });

          send({
            type: "tick",
            propId,
            timestamp: Date.now(),
            line: oddsLine.point,
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
