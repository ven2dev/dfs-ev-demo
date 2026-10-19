import "server-only";

import { getSql } from "./db";
import type { EventOddsResponse } from "./oddsApi";
import { normalizeMarketSnapshot } from "./oddsSnapshot";

export type OddsObservationSource =
  | "scheduled"
  | "discovery"
  | "live"
  | "provider-historical";

export type OddsObservationInput = {
  observationId: string;
  sportKey: string;
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  eventStartTime: Date;
  source: OddsObservationSource;
  capturedAt: Date;
  requestedMarketKeys: string[];
  collectionProfile?: string;
  checkpointKey?: string;
  quota?: {
    remaining: number | null;
    used: number | null;
    last: number | null;
  };
};

export type PersistOddsObservationResult = {
  inserted: boolean;
  marketCount: number;
  quoteSetCount: number;
  insertedQuoteCount: number;
};

type PersistResultRow = {
  inserted: boolean;
  market_count: number;
  quote_set_count: number;
  inserted_quote_count: number;
};

type DatabaseMarketPayload = {
  market_key: string;
  status: string;
  content_hash: string | null;
  bookmaker_observations: {
    bookmaker_key: string;
    provider_updated_at: string | null;
  }[];
  quotes: {
    bookmaker_key: string;
    raw_player_name: string;
    player_id: string | null;
    direction: "over" | "under";
    point: number;
    decimal_price: number;
  }[];
};

const PERSIST_OBSERVATION_SQL = `
WITH inserted_observation AS (
  INSERT INTO odds_observations (
    id,
    sport_key,
    event_id,
    home_team,
    away_team,
    event_start_time,
    source,
    captured_at,
    requested_markets,
    collection_profile,
    checkpoint_key,
    quota_remaining,
    quota_used,
    quota_last
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  ON CONFLICT (id) DO NOTHING
  RETURNING id
),
market_input AS (
  SELECT *
  FROM jsonb_to_recordset($15::jsonb) AS market(
    market_key TEXT,
    status TEXT,
    content_hash TEXT,
    bookmaker_observations JSONB,
    quotes JSONB
  )
),
quote_sets AS (
  INSERT INTO odds_quote_sets (event_id, market_key, content_hash)
  SELECT $3, market.market_key, market.content_hash
  FROM market_input AS market
  CROSS JOIN inserted_observation
  WHERE market.status = 'returned'
  ON CONFLICT (event_id, market_key, content_hash)
  -- The no-op update is intentional: it returns the existing quote-set id and
  -- serializes concurrent writers without a race-prone follow-up SELECT.
  DO UPDATE SET content_hash = EXCLUDED.content_hash
  RETURNING id, event_id, market_key, content_hash
),
inserted_markets AS (
  INSERT INTO odds_observation_markets (
    observation_id,
    market_key,
    status,
    quote_set_id
  )
  SELECT
    observation.id,
    market.market_key,
    market.status,
    quote_set.id
  FROM inserted_observation AS observation
  CROSS JOIN market_input AS market
  LEFT JOIN quote_sets AS quote_set
    ON quote_set.event_id = $3
   AND quote_set.market_key = market.market_key
   AND quote_set.content_hash = market.content_hash
  ON CONFLICT (observation_id, market_key) DO NOTHING
  RETURNING observation_id, market_key
),
inserted_book_markets AS (
  INSERT INTO odds_observation_book_markets (
    observation_id,
    market_key,
    bookmaker_key,
    provider_updated_at
  )
  SELECT
    inserted_market.observation_id,
    inserted_market.market_key,
    bookmaker.bookmaker_key,
    bookmaker.provider_updated_at
  FROM inserted_markets AS inserted_market
  JOIN market_input AS market
    ON market.market_key = inserted_market.market_key
  CROSS JOIN LATERAL jsonb_to_recordset(market.bookmaker_observations) AS bookmaker(
    bookmaker_key TEXT,
    provider_updated_at TIMESTAMPTZ
  )
  ON CONFLICT (observation_id, market_key, bookmaker_key) DO NOTHING
  RETURNING observation_id
),
inserted_quotes AS (
  INSERT INTO odds_quotes (
    quote_set_id,
    bookmaker_key,
    raw_player_name,
    player_id,
    direction,
    point,
    decimal_price
  )
  SELECT
    quote_set.id,
    quote.bookmaker_key,
    quote.raw_player_name,
    quote.player_id,
    quote.direction,
    quote.point,
    quote.decimal_price
  FROM quote_sets AS quote_set
  JOIN market_input AS market
    ON market.market_key = quote_set.market_key
   AND market.content_hash = quote_set.content_hash
  CROSS JOIN LATERAL jsonb_to_recordset(market.quotes) AS quote(
    bookmaker_key TEXT,
    raw_player_name TEXT,
    player_id TEXT,
    direction TEXT,
    point NUMERIC,
    decimal_price NUMERIC
  )
  ON CONFLICT (
    quote_set_id,
    bookmaker_key,
    raw_player_name,
    direction,
    point
  ) DO NOTHING
  RETURNING quote_set_id
)
SELECT
  EXISTS (SELECT 1 FROM inserted_observation) AS inserted,
  (SELECT COUNT(*)::INTEGER FROM inserted_markets) AS market_count,
  (SELECT COUNT(*)::INTEGER FROM quote_sets) AS quote_set_count,
  (SELECT COUNT(*)::INTEGER FROM inserted_quotes) AS inserted_quote_count
`;

const nonEmpty = (value: string, field: string) => {
  if (value.trim().length === 0) throw new Error(`${field} must not be empty`);
};

const validQuotaValue = (value: number | null | undefined, field: string) => {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer or null`);
  }
};

const prepareObservation = (
  input: OddsObservationInput,
  response: EventOddsResponse
): { requestedMarketKeys: string[]; markets: DatabaseMarketPayload[] } => {
  nonEmpty(input.observationId, "observationId");
  nonEmpty(input.sportKey, "sportKey");
  nonEmpty(input.eventId, "eventId");
  nonEmpty(input.homeTeam, "homeTeam");
  nonEmpty(input.awayTeam, "awayTeam");
  if (input.collectionProfile !== undefined) {
    nonEmpty(input.collectionProfile, "collectionProfile");
  }
  if (input.checkpointKey !== undefined) {
    nonEmpty(input.checkpointKey, "checkpointKey");
  }

  if (!Number.isFinite(input.capturedAt.getTime())) {
    throw new Error("capturedAt must be a valid date");
  }
  if (!Number.isFinite(input.eventStartTime.getTime())) {
    throw new Error("eventStartTime must be a valid date");
  }
  if (input.capturedAt.getTime() >= input.eventStartTime.getTime()) {
    throw new Error("Pregame odds observations must be captured before event start");
  }
  if (response.id !== input.eventId) {
    throw new Error(`Odds response event "${response.id}" does not match "${input.eventId}"`);
  }

  const requestedMarketKeys = input.requestedMarketKeys.map((marketKey) => {
    nonEmpty(marketKey, "requestedMarketKey");
    return marketKey;
  });
  if (requestedMarketKeys.length === 0) {
    throw new Error("requestedMarketKeys must contain at least one market");
  }
  if (new Set(requestedMarketKeys).size !== requestedMarketKeys.length) {
    throw new Error("requestedMarketKeys must not contain duplicates");
  }

  validQuotaValue(input.quota?.remaining, "quota.remaining");
  validQuotaValue(input.quota?.used, "quota.used");
  validQuotaValue(input.quota?.last, "quota.last");

  const markets = requestedMarketKeys.map((marketKey): DatabaseMarketPayload => {
    const normalized = normalizeMarketSnapshot(response, marketKey);
    return {
      market_key: normalized.marketKey,
      status: normalized.status,
      content_hash: normalized.contentHash,
      bookmaker_observations: normalized.bookmakerObservations.map((bookmaker) => ({
        bookmaker_key: bookmaker.bookmakerKey,
        provider_updated_at: bookmaker.providerUpdatedAt,
      })),
      quotes: normalized.quotes.map((quote) => ({
        bookmaker_key: quote.bookmakerKey,
        raw_player_name: quote.rawPlayerName,
        player_id: quote.playerId,
        direction: quote.direction,
        point: quote.point,
        decimal_price: quote.decimalPrice,
      })),
    };
  });

  return { requestedMarketKeys, markets };
};

export const persistOddsObservation = async (
  input: OddsObservationInput,
  response: EventOddsResponse
): Promise<PersistOddsObservationResult> => {
  const prepared = prepareObservation(input, response);
  const rows = (await getSql().query(PERSIST_OBSERVATION_SQL, [
    input.observationId,
    input.sportKey,
    input.eventId,
    input.homeTeam,
    input.awayTeam,
    input.eventStartTime.toISOString(),
    input.source,
    input.capturedAt.toISOString(),
    prepared.requestedMarketKeys,
    input.collectionProfile ?? null,
    input.checkpointKey ?? null,
    input.quota?.remaining ?? null,
    input.quota?.used ?? null,
    input.quota?.last ?? null,
    JSON.stringify(prepared.markets),
  ])) as PersistResultRow[];

  const result = rows[0];
  if (!result) throw new Error("Odds observation persistence returned no result");
  return {
    inserted: result.inserted,
    marketCount: result.market_count,
    quoteSetCount: result.quote_set_count,
    insertedQuoteCount: result.inserted_quote_count,
  };
};
