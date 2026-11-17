import "server-only";
import type { OddsApiFetch, EventOddsResponse } from "./oddsApi";
import { persistOddsObservation } from "./oddsSnapshotRepo";

export const persistRawOddsObservation = async (
  sportKey: string,
  eventId: string,
  marketKeys: string[],
  fetched: OddsApiFetch<EventOddsResponse>,
  observationId: string,
  source: "discovery" | "live" = "discovery"
): Promise<boolean> => {
  const event = fetched.data;
  if (!event.commence_time || !event.home_team || !event.away_team) {
    console.error(
      `[oddsCacheRepo] skipped observation "${observationId}": upstream event metadata is incomplete`
    );
    return false;
  }
  const eventStartMs = Date.parse(event.commence_time);
  const capturedAtMs = Date.parse(fetched.capturedAt);
  if (
    Number.isFinite(eventStartMs) &&
    Number.isFinite(capturedAtMs) &&
    capturedAtMs >= eventStartMs
  ) {
    return false;
  }

  try {
    await persistOddsObservation(
      {
        observationId,
        sportKey: event.sport_key ?? sportKey,
        eventId,
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        eventStartTime: new Date(event.commence_time),
        source,
        capturedAt: new Date(fetched.capturedAt),
        requestedMarketKeys: marketKeys,
        quota: fetched.quota,
      },
      event
    );
    return true;
  } catch (error) {
    // History must never make a current-odds request fail after the provider
    // already returned usable data. The gap is explicit in server logs.
    console.error(
      `[oddsCacheRepo] failed to persist observation "${observationId}":`,
      error
    );
    return false;
  }
};
