-- #26: historical player-stat source. Run this once against the
-- provisioned Neon/Vercel Postgres instance before the sync route can
-- write anything real.
--
-- Deliberately separate from Firestore's per-user app state (goal,
-- watchlist, matchupConfig) -- this is relational/time-series game-log
-- data (range queries by date, keyed by player + stat type), not
-- per-user state, so it lives in its own store.

-- One row per player, per game, per supported stat type -- long/tidy,
-- not nflverse's own wide (~150-column) shape. Ingestion melts their
-- wide per-week row down to just the stat types we actually support as
-- prop markets; there's no reason to store the other ~145 columns we'll
-- never query.
CREATE TABLE IF NOT EXISTS player_game_stats (
  id BIGSERIAL PRIMARY KEY,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  team TEXT NOT NULL,
  opponent TEXT NOT NULL,
  -- Derived at ingestion time, not sourced directly: nflverse's weekly
  -- stats file has no is_home/game_date columns at all, only game_id
  -- (format "{season}_{week}_{away}_{home}"). Both come from joining
  -- against nflverse's separate schedules release via that same
  -- game_id. Not consumed by computeEV today either way -- captured
  -- because it's a free column off data we're already joining in, not
  -- because anything needs it yet.
  is_home BOOLEAN NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  -- Also from the schedules join -- nflverse's weekly stats file has no
  -- calendar date of its own, only a season/week pair.
  game_date DATE NOT NULL,
  stat_type TEXT NOT NULL,
  stat_value NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Makes ingestion idempotent: re-running a sync (or a Wednesday
  -- corrections pass revising an already-ingested week) upserts in
  -- place instead of creating duplicate rows.
  UNIQUE (player_id, season, week, stat_type)
);

-- The actual query computeEV's sample-window needs: "last N games for
-- this player + stat type, most recent first."
CREATE INDEX IF NOT EXISTS idx_player_game_stats_lookup
  ON player_game_stats (player_id, stat_type, game_date DESC);

-- The idempotency high-water-mark from the scheduling-landmine
-- discussion: before downloading nflverse's actual data file, the sync
-- route checks the GitHub Releases API's cheap metadata response and
-- compares the current season's asset `updated_at` against the value
-- stored here. Only downloads + upserts if it's newer; otherwise a safe
-- no-op, regardless of whether the cron fired before that week's file
-- was actually refreshed.
CREATE TABLE IF NOT EXISTS sync_state (
  source_name TEXT PRIMARY KEY,
  last_synced_asset_updated_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Durable identity cache: The Odds API's prop outcomes key off a plain
-- player-name string (its `description` field), while nflverse keys off
-- a GSIS player id. A cache miss is resolved conservatively against the
-- current event's two teams and market-compatible roster positions;
-- ambiguous or low-confidence names are never inserted.
CREATE TABLE IF NOT EXISTS player_crosswalk (
  odds_api_name TEXT PRIMARY KEY,
  nflverse_player_id TEXT NOT NULL,
  nflverse_player_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- #32: current-season identity source for conservative on-demand
-- crosswalk matching. This stays separate from player_game_stats:
-- stats contain abbreviated display names and omit players who have
-- not recorded a supported stat, while the roster supplies full names,
-- current team, position, and the same GSIS id used by the stats rows.
-- source_updated_at identifies one complete upstream roster snapshot;
-- reads use only the newest snapshot for a season, so a player removed
-- from a later source file cannot remain an active matching candidate.
CREATE TABLE IF NOT EXISTS nflverse_roster_players (
  season INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  football_name TEXT,
  team TEXT NOT NULL,
  position TEXT NOT NULL,
  status TEXT NOT NULL,
  source_updated_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (season, player_id)
);

CREATE INDEX IF NOT EXISTS idx_nflverse_roster_match_candidates
  ON nflverse_roster_players (season, source_updated_at DESC, team);

-- #34: creator-content confidence layer, transcript submission form.
-- Manual sourcing only (no scraper -- see the issue for why) -- these
-- tables just persist what's pasted through the internal submission
-- form, for #35's extraction pipeline to consume later. transcript_text
-- is stored as ONE raw blob per video; segmenting/parsing it into
-- structured picks is #35's job, not this one.
CREATE TABLE IF NOT EXISTS creators (
  id BIGSERIAL PRIMARY KEY,
  channel_name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creator_video_submissions (
  id BIGSERIAL PRIMARY KEY,
  creator_id BIGINT NOT NULL REFERENCES creators(id),
  -- Required (2026-09-29 revision) -- it's the only real dedup key
  -- (matches on video_title alone would be far too fragile) and #35/
  -- #36 need a real source link for evidence/traceability. video_title
  -- stays nullable -- real submissions have often had a blank one.
  video_url TEXT NOT NULL UNIQUE,
  video_title TEXT,
  transcript_text TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Follow-up correction to the original (nullable) column definition
-- above -- ALTER COLUMN ... SET NOT NULL is itself idempotent (a
-- harmless no-op if already NOT NULL), so this stays safe to re-run
-- alongside the CREATE TABLE IF NOT EXISTS statements on an existing
-- database that predates this revision.
ALTER TABLE creator_video_submissions ALTER COLUMN video_url SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_creator_video_submissions_creator
  ON creator_video_submissions (creator_id, submitted_at DESC);

-- #27: per-(event, market) odds cache. Discovering a game's available
-- player props costs real API credits (1 per market requested), so
-- caching at whole-event or per-player granularity would either
-- re-charge for markets already fetched moments ago, or fail to share
-- one market's data across every player who has a line in it. Keying
-- on (event_id, market_key) means the FIRST check of e.g. "Passing
-- Yards" for a game pays once, and every other request for that same
-- market on that same game -- regardless of which player it's for --
-- reuses it until fetched_at ages past the app's TTL (oddsCacheRepo.ts
-- owns that TTL, not this table).
CREATE TABLE IF NOT EXISTS event_market_odds_cache (
  event_id TEXT NOT NULL,
  market_key TEXT NOT NULL,
  -- Raw-ish bookmakers/markets/outcomes slice for just this one market,
  -- as returned by the Odds API -- not reshaped into an app-level prop
  -- type. Keeps this table a pure cache of what the API said, so a
  -- future change to how props are grouped/displayed doesn't require a
  -- cache-schema migration.
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, market_key)
);

-- #28: distributed live odds/weather cache. The serving key is one
-- player prop within a sport/event/market; bookmaker and direction are
-- intentionally absent because one upstream market response contains
-- every book and both Over/Under sides. All watchers of that prop share
-- one refreshed payload, even when they run on different serverless
-- instances or select different books/sides.
--
-- refresh_owner/refresh_lease_until form a short database-backed lease.
-- A crashed refresher cannot hold the key forever; another instance may
-- take over after the lease expires. payload/fetched_at are nullable only
-- while the first refresh for a new key is in flight.
CREATE TABLE IF NOT EXISTS live_prop_inputs_cache (
  sport_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  market_key TEXT NOT NULL,
  player_name TEXT NOT NULL,
  payload JSONB,
  fetched_at TIMESTAMPTZ,
  refresh_owner TEXT,
  refresh_lease_until TIMESTAMPTZ,
  PRIMARY KEY (sport_key, event_id, market_key, player_name),
  CHECK ((payload IS NULL) = (fetched_at IS NULL))
);

-- #41: immutable market-observation history. One observation represents one
-- completed upstream response and therefore one honest point in time. Quote
-- values live in content-addressed sets so a later response with unchanged
-- prices still gets its own timestamp without duplicating every quote row.
CREATE TABLE IF NOT EXISTS odds_observations (
  id TEXT PRIMARY KEY,
  sport_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  event_start_time TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (
    source IN ('scheduled', 'discovery', 'live', 'provider-historical')
  ),
  captured_at TIMESTAMPTZ NOT NULL,
  requested_markets TEXT[] NOT NULL,
  collection_profile TEXT,
  checkpoint_key TEXT,
  quota_remaining INTEGER CHECK (quota_remaining IS NULL OR quota_remaining >= 0),
  quota_used INTEGER CHECK (quota_used IS NULL OR quota_used >= 0),
  quota_last INTEGER CHECK (quota_last IS NULL OR quota_last >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cardinality(requested_markets) > 0)
);

CREATE INDEX IF NOT EXISTS idx_odds_observations_event_cutoff
  ON odds_observations (event_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS odds_quote_sets (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL,
  market_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, market_key, content_hash)
);

CREATE TABLE IF NOT EXISTS odds_observation_markets (
  observation_id TEXT NOT NULL REFERENCES odds_observations(id),
  market_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('returned', 'empty', 'invalid', 'unavailable')
  ),
  quote_set_id BIGINT REFERENCES odds_quote_sets(id),
  PRIMARY KEY (observation_id, market_key),
  CHECK ((status = 'returned') = (quote_set_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_odds_observation_markets_market
  ON odds_observation_markets (market_key, observation_id);

-- Provider last_update belongs to each bookmaker's market in the event-odds
-- response. It is observation metadata, not quote-set content: a bookmaker
-- can report a newer update time while all normalized prices remain equal.
CREATE TABLE IF NOT EXISTS odds_observation_book_markets (
  observation_id TEXT NOT NULL,
  market_key TEXT NOT NULL,
  bookmaker_key TEXT NOT NULL,
  provider_updated_at TIMESTAMPTZ,
  PRIMARY KEY (observation_id, market_key, bookmaker_key),
  FOREIGN KEY (observation_id, market_key)
    REFERENCES odds_observation_markets(observation_id, market_key)
);

CREATE TABLE IF NOT EXISTS odds_quotes (
  quote_set_id BIGINT NOT NULL REFERENCES odds_quote_sets(id),
  bookmaker_key TEXT NOT NULL,
  raw_player_name TEXT NOT NULL,
  player_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('over', 'under')),
  point NUMERIC NOT NULL,
  decimal_price NUMERIC NOT NULL CHECK (decimal_price > 1),
  PRIMARY KEY (
    quote_set_id,
    bookmaker_key,
    raw_player_name,
    direction,
    point
  )
);

CREATE INDEX IF NOT EXISTS idx_odds_quotes_lookup
  ON odds_quotes (quote_set_id, raw_player_name, point, bookmaker_key);

-- One durable free-tier event choice per NFL week. Automatic selection never
-- drifts after a schedule flex; an explicit operator override may replace it.
CREATE TABLE IF NOT EXISTS odds_free_pilot_selections (
  week_start_time TIMESTAMPTZ PRIMARY KEY,
  week_end_time TIMESTAMPTZ NOT NULL,
  sport_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  event_start_time TIMESTAMPTZ NOT NULL,
  selection_reason TEXT NOT NULL CHECK (
    selection_reason IN ('latest-sunday', 'explicit-override')
  ),
  selected_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (week_start_time < week_end_time),
  CHECK (event_start_time >= week_start_time AND event_start_time < week_end_time)
);

-- Generic event-market targets are independent of creator picks. Any later
-- trigger can activate one without changing the collector's cadence contract.
CREATE TABLE IF NOT EXISTS odds_priority_targets (
  id TEXT PRIMARY KEY,
  sport_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  event_start_time TIMESTAMPTZ NOT NULL,
  market_keys TEXT[] NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cardinality(market_keys) > 0),
  CHECK (activated_at < event_start_time)
);

CREATE INDEX IF NOT EXISTS idx_odds_priority_targets_active_event
  ON odds_priority_targets (active, event_start_time, event_id);

-- Durable work ledger: leases make cron invocations safe to overlap, while
-- due windows prevent a late worker from spending quota to recreate stale work.
CREATE TABLE IF NOT EXISTS odds_collection_checkpoints (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('baseline', 'priority')),
  collection_profile TEXT NOT NULL CHECK (
    collection_profile IN ('free-pilot', 'paid-baseline', 'priority')
  ),
  target_id TEXT REFERENCES odds_priority_targets(id),
  sport_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  event_start_time TIMESTAMPTZ NOT NULL,
  market_keys TEXT[] NOT NULL,
  checkpoint_key TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  due_window_end TIMESTAMPTZ NOT NULL,
  priority_rank INTEGER NOT NULL CHECK (priority_rank > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'claimed', 'completed', 'failed', 'skipped')
  ),
  claim_owner TEXT,
  claim_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  next_attempt_at TIMESTAMPTZ,
  observation_id TEXT REFERENCES odds_observations(id),
  credit_cost INTEGER CHECK (credit_cost IS NULL OR credit_cost >= 0),
  schedule_reason TEXT NOT NULL,
  outcome_reason TEXT,
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (collection_profile, event_id, checkpoint_key),
  CHECK (cardinality(market_keys) > 0),
  CHECK (due_at < due_window_end),
  CHECK (due_window_end <= event_start_time),
  CHECK ((kind = 'priority') = (target_id IS NOT NULL)),
  CHECK (
    (status = 'claimed' AND claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR
    (status <> 'claimed' AND claim_owner IS NULL AND claim_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_odds_collection_checkpoints_due
  ON odds_collection_checkpoints (
    status,
    priority_rank,
    due_at,
    next_attempt_at,
    claim_expires_at
  );

CREATE INDEX IF NOT EXISTS idx_odds_collection_checkpoints_event
  ON odds_collection_checkpoints (event_id, due_at);

CREATE TABLE IF NOT EXISTS odds_api_request_log (
  id TEXT PRIMARY KEY,
  request_kind TEXT NOT NULL CHECK (request_kind IN ('events', 'event-odds')),
  source TEXT NOT NULL CHECK (source IN ('slate', 'discovery', 'live', 'scheduled', 'direct')),
  sport_key TEXT NOT NULL,
  event_id TEXT,
  requested_markets TEXT[] NOT NULL DEFAULT '{}',
  requested_at TIMESTAMPTZ NOT NULL,
  response_received_at TIMESTAMPTZ,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('success', 'http-error', 'network-error', 'aborted')
  ),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  quota_remaining INTEGER CHECK (quota_remaining IS NULL OR quota_remaining >= 0),
  quota_used INTEGER CHECK (quota_used IS NULL OR quota_used >= 0),
  quota_last INTEGER CHECK (quota_last IS NULL OR quota_last >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((request_kind = 'event-odds') = (event_id IS NOT NULL)),
  CHECK ((request_kind = 'event-odds') = (cardinality(requested_markets) > 0)),
  CHECK ((outcome IN ('success', 'http-error')) = (response_received_at IS NOT NULL)),
  CHECK (response_received_at IS NULL OR response_received_at >= requested_at),
  CHECK ((outcome = 'network-error' OR outcome = 'aborted') = (http_status IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_odds_api_request_log_requested
  ON odds_api_request_log (requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_odds_api_request_log_source
  ON odds_api_request_log (source, requested_at DESC);
