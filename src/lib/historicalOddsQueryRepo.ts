import "server-only";

import { getSql } from "./db";
import {
  consensusFromHistoricalObservation,
  type HistoricalConsensusResult,
  type HistoricalMarketObservation,
  type HistoricalPlayerIdentity,
  type HistoricalQuoteRow,
} from "./historicalOddsQuery";
import type { OddsObservationSource } from "./oddsSnapshotRepo";
import type { SnapshotMarketStatus } from "./oddsSnapshot";

type ObservationRow = {
  observation_id: string;
  event_id: string;
  market_key: string;
  status: SnapshotMarketStatus;
  source: OddsObservationSource;
  captured_at: string;
  event_start_time: string;
  quotes: HistoricalQuoteRow[];
};

const LATEST_OBSERVATION_SQL = `
WITH latest_market AS (
  SELECT
    observation.id AS observation_id,
    observation.event_id,
    market.market_key,
    market.status,
    market.quote_set_id,
    observation.source,
    observation.captured_at,
    observation.event_start_time
  FROM odds_observation_markets AS market
  JOIN odds_observations AS observation ON observation.id = market.observation_id
  WHERE observation.event_id = $1
    AND market.market_key = $2
    AND observation.captured_at <= $3
  ORDER BY observation.captured_at DESC, observation.created_at DESC, observation.id DESC
  LIMIT 1
)
SELECT
  latest.observation_id,
  latest.event_id,
  latest.market_key,
  latest.status,
  latest.source,
  latest.captured_at,
  latest.event_start_time,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'bookmakerKey', quote.bookmaker_key,
        'rawPlayerName', quote.raw_player_name,
        'playerId', quote.player_id,
        'direction', quote.direction,
        'point', quote.point,
        'decimalPrice', quote.decimal_price
      )
      ORDER BY quote.bookmaker_key, quote.raw_player_name, quote.point, quote.direction
    ) FILTER (WHERE quote.quote_set_id IS NOT NULL),
    '[]'::jsonb
  ) AS quotes
FROM latest_market AS latest
LEFT JOIN odds_quotes AS quote ON quote.quote_set_id = latest.quote_set_id
GROUP BY
  latest.observation_id,
  latest.event_id,
  latest.market_key,
  latest.status,
  latest.source,
  latest.captured_at,
  latest.event_start_time
`;

const nonEmpty = (value: string, field: string) => {
  if (value.trim().length === 0) throw new Error(`${field} must not be empty`);
};

export const getHistoricalMarketConsensus = async (input: {
  eventId: string;
  marketKey: string;
  cutoff: Date;
  player: HistoricalPlayerIdentity;
  line: number;
}): Promise<HistoricalConsensusResult> => {
  nonEmpty(input.eventId, "eventId");
  nonEmpty(input.marketKey, "marketKey");
  if (!Number.isFinite(input.cutoff.getTime())) throw new Error("cutoff must be a valid date");

  const rows = (await getSql().query(LATEST_OBSERVATION_SQL, [
    input.eventId,
    input.marketKey,
    input.cutoff.toISOString(),
  ])) as ObservationRow[];
  const row = rows[0];
  const observation: HistoricalMarketObservation | null = row
    ? {
        observationId: row.observation_id,
        eventId: row.event_id,
        marketKey: row.market_key,
        status: row.status,
        source: row.source,
        capturedAt: row.captured_at,
        eventStartTime: row.event_start_time,
        quotes: row.quotes,
      }
    : null;

  return consensusFromHistoricalObservation({
    observation,
    cutoff: input.cutoff,
    player: input.player,
    line: input.line,
  });
};
