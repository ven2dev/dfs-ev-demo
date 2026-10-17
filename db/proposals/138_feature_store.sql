-- #138 disposable proposal, NOT an ordered migration. Apply in one transaction
-- to a registered local scratch database. No legacy predictive objects change.
-- Pattern: trusted ELT writer, immutable snapshots, database knowledge clocks.
CREATE SCHEMA fs138;
REVOKE ALL ON SCHEMA fs138 FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fs138_pipeline_writer') THEN
    CREATE ROLE fs138_pipeline_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fs138_reader') THEN
    CREATE ROLE fs138_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA fs138 TO fs138_pipeline_writer, fs138_reader;

CREATE DOMAIN fs138.sha256 AS text CHECK (VALUE ~ '^[a-f0-9]{64}$');

CREATE TABLE fs138.source_profiles (
  profile_id text PRIMARY KEY CHECK (profile_id ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  provider text NOT NULL,
  feed text NOT NULL CHECK (feed IN ('stats', 'schedule', 'roster', 'participation')),
  parser_version text NOT NULL,
  license jsonb NOT NULL CHECK (jsonb_typeof(license) = 'object'),
  recorded_at timestamptz NOT NULL
);

-- A new decision supersedes earlier decisions only at/after its DB knowledge
-- time. Historical queries also filter recorded_at, not just the valid interval.
CREATE TABLE fs138.rights_decisions (
  decision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id text NOT NULL REFERENCES fs138.source_profiles,
  allowed_uses text[] NOT NULL CHECK (allowed_uses <@ ARRAY['research', 'training', 'prediction']::text[]),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz CHECK (valid_until > valid_from),
  rationale text NOT NULL,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX rights_as_of ON fs138.rights_decisions (profile_id, recorded_at DESC, decision_id);

CREATE TABLE fs138.job_runs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('ingest', 'normalize', 'features', 'labels', 'dataset', 'model', 'audit')),
  code_sha text NOT NULL CHECK (code_sha ~ '^[a-f0-9]{40}$'),
  policy_sha256 fs138.sha256 NOT NULL,
  input_set_sha256 fs138.sha256 NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  counts jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(counts) = 'object'),
  error_code text,
  recorded_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (kind, input_set_sha256, code_sha, policy_sha256),
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK ((status = 'failed') = (error_code IS NOT NULL))
);

CREATE TABLE fs138.source_snapshots (
  snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id text NOT NULL REFERENCES fs138.source_profiles,
  job_id uuid NOT NULL REFERENCES fs138.job_runs,
  sha256 fs138.sha256 NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  object_key text NOT NULL CHECK (object_key = 'raw/' || sha256),
  media_type text NOT NULL CHECK (media_type IN ('text/csv', 'application/gzip')),
  decoded_sha256 fs138.sha256 NOT NULL,
  header_sha256 fs138.sha256 NOT NULL,
  row_count integer NOT NULL CHECK (row_count >= 0),
  captured_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL,
  evidence_basis text NOT NULL CHECK (evidence_basis IN ('prospective', 'retrospective')),
  source_manifest jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(source_manifest) = 'object'),
  UNIQUE (profile_id, sha256),
  CHECK (captured_at <= ingested_at)
);
CREATE INDEX snapshot_as_of ON fs138.source_snapshots (profile_id, available_at DESC, ingested_at DESC);

CREATE TABLE fs138.job_inputs (
  job_id uuid NOT NULL REFERENCES fs138.job_runs,
  snapshot_id uuid NOT NULL REFERENCES fs138.source_snapshots,
  PRIMARY KEY (job_id, snapshot_id)
);

-- Normalized natural keys include the snapshot and normalizer version: a new
-- correction is an INSERT, never an overwrite. Refusals retain explicit reasons.
CREATE TABLE fs138.norm_schedule (
  snapshot_id uuid NOT NULL REFERENCES fs138.source_snapshots,
  normalizer_version text NOT NULL,
  job_id uuid NOT NULL REFERENCES fs138.job_runs,
  game_id text NOT NULL,
  season integer NOT NULL CHECK (season BETWEEN 2021 AND 2025),
  week integer NOT NULL CHECK (week BETWEEN 1 AND 22),
  game_type text NOT NULL CHECK (game_type IN ('REG', 'POST')),
  kickoff timestamptz NOT NULL,
  home_team text NOT NULL,
  away_team text NOT NULL CHECK (away_team <> home_team),
  home_score integer,
  away_score integer,
  state text NOT NULL CHECK (state IN ('usable', 'refused', 'ambiguous')),
  reasons text[] NOT NULL,
  PRIMARY KEY (snapshot_id, normalizer_version, game_id),
  CHECK ((state = 'usable') = (cardinality(reasons) = 0))
);
CREATE INDEX schedule_game ON fs138.norm_schedule (game_id);

CREATE TABLE fs138.norm_player_game_stats (
  snapshot_id uuid NOT NULL REFERENCES fs138.source_snapshots,
  normalizer_version text NOT NULL,
  job_id uuid NOT NULL REFERENCES fs138.job_runs,
  player_id text NOT NULL,
  game_id text NOT NULL,
  team text NOT NULL,
  passing_attempts integer CHECK (passing_attempts >= 0),
  passing_yards integer,
  state text NOT NULL CHECK (state IN ('usable', 'refused', 'ambiguous')),
  reasons text[] NOT NULL,
  PRIMARY KEY (snapshot_id, normalizer_version, player_id, game_id),
  CHECK ((state = 'usable') = (cardinality(reasons) = 0)),
  CHECK (state <> 'usable' OR (passing_attempts IS NOT NULL AND passing_yards IS NOT NULL))
);
CREATE INDEX stats_player_game ON fs138.norm_player_game_stats (player_id, game_id);

CREATE TABLE fs138.norm_identity (
  snapshot_id uuid NOT NULL REFERENCES fs138.source_snapshots,
  normalizer_version text NOT NULL,
  job_id uuid NOT NULL REFERENCES fs138.job_runs,
  player_id text NOT NULL,
  season integer NOT NULL CHECK (season BETWEEN 2021 AND 2025),
  week integer NOT NULL CHECK (week BETWEEN 1 AND 22),
  team text NOT NULL,
  display_name text NOT NULL,
  position text NOT NULL,
  state text NOT NULL CHECK (state IN ('usable', 'refused', 'ambiguous')),
  reasons text[] NOT NULL,
  PRIMARY KEY (snapshot_id, normalizer_version, player_id, season, week, team),
  CHECK ((state = 'usable') = (cardinality(reasons) = 0))
);

CREATE TABLE fs138.norm_participation (
  snapshot_id uuid NOT NULL REFERENCES fs138.source_snapshots,
  normalizer_version text NOT NULL,
  job_id uuid NOT NULL REFERENCES fs138.job_runs,
  player_id text NOT NULL,
  game_id text NOT NULL,
  offense_play_count integer CHECK (offense_play_count > 0),
  state text NOT NULL CHECK (state IN ('usable', 'refused', 'ambiguous')),
  reasons text[] NOT NULL,
  PRIMARY KEY (snapshot_id, normalizer_version, player_id, game_id),
  CHECK ((state = 'usable') = (cardinality(reasons) = 0)),
  CHECK (state <> 'usable' OR offense_play_count IS NOT NULL)
);

CREATE FUNCTION fs138.stamp_recorded_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, fs138 AS $$
BEGIN
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER profile_clock BEFORE INSERT ON fs138.source_profiles
  FOR EACH ROW EXECUTE FUNCTION fs138.stamp_recorded_at();
CREATE TRIGGER rights_clock BEFORE INSERT ON fs138.rights_decisions
  FOR EACH ROW EXECUTE FUNCTION fs138.stamp_recorded_at();
CREATE FUNCTION fs138.start_job() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, fs138 AS $$
BEGIN
  IF NEW.status <> 'running' OR NEW.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'job-initial-state-refused' USING ERRCODE = '23514';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER job_clock BEFORE INSERT ON fs138.job_runs
  FOR EACH ROW EXECUTE FUNCTION fs138.start_job();

CREATE FUNCTION fs138.stamp_ingested_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, fs138 AS $$
BEGIN
  NEW.ingested_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER snapshot_clock BEFORE INSERT ON fs138.source_snapshots
  FOR EACH ROW EXECUTE FUNCTION fs138.stamp_ingested_at();

CREATE FUNCTION fs138.finish_job() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, fs138 AS $$
BEGIN
  IF OLD.status <> 'running' OR NEW.status NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'job-transition-refused' USING ERRCODE = '23514';
  END IF;
  NEW.finished_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER job_finish BEFORE UPDATE ON fs138.job_runs
  FOR EACH ROW EXECUTE FUNCTION fs138.finish_job();

-- The roles own no objects, cannot disable triggers, cannot create functions or
-- tables, and have no DELETE. Governance invalidation/cleanup is a later step.
REVOKE ALL ON ALL TABLES IN SCHEMA fs138 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fs138 FROM PUBLIC;
GRANT SELECT ON ALL TABLES IN SCHEMA fs138 TO fs138_pipeline_writer, fs138_reader;
GRANT INSERT ON ALL TABLES IN SCHEMA fs138 TO fs138_pipeline_writer;
GRANT UPDATE (status, counts, error_code, finished_at) ON fs138.job_runs TO fs138_pipeline_writer;


-- Simple normalized evidence view. Cutoffs are parameters of the application
-- selector, not session state or reader locks. Unknown normalizer versions are
-- excluded explicitly by each versioned job.
CREATE VIEW fs138.normalized_evidence AS
WITH normalized AS (
  SELECT 'stats'::text AS feed, n.player_id || '/' || n.game_id AS natural_key,
    n.snapshot_id, n.normalizer_version, to_jsonb(n) - ARRAY['snapshot_id','normalizer_version','job_id'] AS data
    FROM fs138.norm_player_game_stats n
  UNION ALL
  SELECT 'schedule', n.game_id, n.snapshot_id, n.normalizer_version,
    to_jsonb(n) - ARRAY['snapshot_id','normalizer_version','job_id'] FROM fs138.norm_schedule n
  UNION ALL
  SELECT 'roster', n.player_id || '/' || n.season || '/' || n.week || '/' || n.team, n.snapshot_id, n.normalizer_version,
    to_jsonb(n) - ARRAY['snapshot_id','normalizer_version','job_id'] FROM fs138.norm_identity n
  UNION ALL
  SELECT 'participation', n.player_id || '/' || n.game_id, n.snapshot_id, n.normalizer_version,
    to_jsonb(n) - ARRAY['snapshot_id','normalizer_version','job_id'] FROM fs138.norm_participation n
)
SELECT n.*, s.profile_id, s.available_at, s.ingested_at
FROM normalized n JOIN fs138.source_snapshots s USING (snapshot_id);
GRANT SELECT ON fs138.normalized_evidence TO fs138_pipeline_writer, fs138_reader;
