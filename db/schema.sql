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

-- Manual mapping, not a fuzzy-matcher: The Odds API's prop outcomes key
-- off a plain player-name string (its `description` field), nflverse
-- keys off its own internal player_id. Right-sized for the single
-- player currently seeded -- automatic name-matching at roster scale is
-- real, separate work for #27, once many players need resolving at once.
CREATE TABLE IF NOT EXISTS player_crosswalk (
  odds_api_name TEXT PRIMARY KEY,
  nflverse_player_id TEXT NOT NULL,
  nflverse_player_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
