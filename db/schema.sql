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
