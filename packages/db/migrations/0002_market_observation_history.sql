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
