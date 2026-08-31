import { computeEV } from "@/lib/computeEV";
import { devigTwoWay } from "@/lib/devig";
import { fetchPlayerPropOdds } from "@/lib/oddsApi";
import { MAX_TICKS, POLL_INTERVAL_MS } from "@/lib/streamConfig";
import { fetchGameWeather } from "@/lib/weather";
import { mockCoverageFilters, mockMatchup } from "@/store/mockData";

// SSE endpoint. Real Odds API + real weather calls happen here,
// server-side only — the API key never reaches the client.
//
// Scope note: each connection polls independently on its own interval,
// rather than one shared server-side poller fanning out to all clients.
// A true single-poller-broadcasts-to-many architecture needs a
// persistent process or a pub/sub layer (Redis, etc.) — non-trivial on
// serverless in the time available. Still real: real API calls, never
// client-side, just not shared across concurrent connections tonight.
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

export const dynamic = "force-dynamic";

export async function GET() {
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
          const prop = mockMatchup.props[0];
          const [oddsLine, weather] = await Promise.all([
            fetchPlayerPropOdds(
              mockMatchup.sportKey,
              mockMatchup.eventId,
              prop.marketKey,
              prop.playerName
            ),
            fetchGameWeather(mockMatchup.startTime),
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
            recentGameStats: prop.recentGameStats,
            line: oddsLine.point,
            sampleWindow: 5,
            windSpeedMph: weather.windSpeedMph,
            precipitationMm: weather.precipitationMm,
            shadowCoverageRate: mockCoverageFilters.shadowCoverageRate as number,
            impliedProb: impliedProbOver,
          });

          send({
            type: "tick",
            propId: prop.propId,
            playerName: prop.playerName,
            propType: prop.propType,
            timestamp: Date.now(),
            line: oddsLine.point,
            weather,
            evScore: result.evScore,
            stages: {
              baseRate: result.baseRate,
              afterEnvironment: result.afterEnvironment,
              afterCoverage: result.afterCoverage,
            },
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
