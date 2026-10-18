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

-- STEP 4: typed season jobs; mutable proposal only.
CREATE INDEX identity_player_week ON fs138.norm_identity (player_id, season, week, team);
CREATE INDEX participation_player_game ON fs138.norm_participation (player_id, game_id);

CREATE TABLE fs138.feature_values (
  feature_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES fs138.job_runs,
  player_id text NOT NULL,
  game_id text NOT NULL,
  stat text NOT NULL CHECK (stat = 'passing_yards'),
  season integer NOT NULL CHECK (season BETWEEN 2021 AND 2025),
  cutoff timestamptz,
  checkpoint timestamptz NOT NULL,
  feature_version text NOT NULL,
  history_policy text NOT NULL,
  evidence_mode text NOT NULL CHECK (evidence_mode IN ('strict-point-in-time-v1', 'retrospective-reconstruction-v1')),
  state text NOT NULL CHECK (state IN ('usable', 'unavailable')),
  reasons text[] NOT NULL,
  flags text[] NOT NULL,
  sample_size integer NOT NULL CHECK (sample_size BETWEEN 0 AND 16),
  history jsonb NOT NULL CHECK (jsonb_typeof(history) = 'array' AND jsonb_array_length(history) = sample_size),
  history_gaps jsonb NOT NULL CHECK (jsonb_typeof(history_gaps) = 'array'),
  supersedes_id uuid REFERENCES fs138.feature_values,
  computed_at timestamptz NOT NULL,
  UNIQUE (job_id, player_id, game_id, stat),
  CHECK ((state = 'usable') = (cardinality(reasons) = 0)),
  CHECK (state <> 'usable' OR (sample_size >= 2 AND cutoff IS NOT NULL))
);
CREATE INDEX feature_head ON fs138.feature_values (player_id, game_id, stat, feature_version, evidence_mode, computed_at DESC);
CREATE TABLE fs138.feature_inputs (
  feature_id uuid NOT NULL REFERENCES fs138.feature_values,
  snapshot_id uuid NOT NULL REFERENCES fs138.source_snapshots,
  PRIMARY KEY (feature_id, snapshot_id)
);
CREATE INDEX feature_inputs_reverse ON fs138.feature_inputs (snapshot_id, feature_id);

CREATE TABLE fs138.outcome_labels (
  label_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES fs138.job_runs,
  player_id text NOT NULL,
  game_id text NOT NULL,
  stat text NOT NULL CHECK (stat = 'passing_yards'),
  season integer NOT NULL CHECK (season BETWEEN 2021 AND 2025),
  label_cutoff timestamptz NOT NULL,
  label_version text NOT NULL,
  evidence_mode text NOT NULL CHECK (evidence_mode IN ('strict-point-in-time-v1', 'retrospective-reconstruction-v1')),
  state text NOT NULL CHECK (state IN ('usable', 'unavailable')),
  reasons text[] NOT NULL,
  flags text[] NOT NULL,
  value integer,
  supersedes_id uuid REFERENCES fs138.outcome_labels,
  known_at timestamptz NOT NULL,
  UNIQUE (job_id, player_id, game_id, stat),
  CHECK ((state = 'usable') = (cardinality(reasons) = 0)),
  CHECK ((state = 'usable') = (value IS NOT NULL))
);
CREATE INDEX label_head ON fs138.outcome_labels (player_id, game_id, stat, label_version, evidence_mode, known_at DESC);
CREATE TABLE fs138.label_inputs (
  label_id uuid NOT NULL REFERENCES fs138.outcome_labels,
  snapshot_id uuid NOT NULL REFERENCES fs138.source_snapshots,
  PRIMARY KEY (label_id, snapshot_id)
);
CREATE INDEX label_inputs_reverse ON fs138.label_inputs (snapshot_id, label_id);

CREATE FUNCTION fs138.stamp_derived_time() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, fs138 AS $$
BEGIN
  IF TG_TABLE_NAME = 'feature_values' THEN NEW.computed_at := clock_timestamp();
  ELSE NEW.known_at := clock_timestamp(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER feature_clock BEFORE INSERT ON fs138.feature_values
  FOR EACH ROW EXECUTE FUNCTION fs138.stamp_derived_time();
CREATE TRIGGER label_clock BEFORE INSERT ON fs138.outcome_labels
  FOR EACH ROW EXECUTE FUNCTION fs138.stamp_derived_time();
REVOKE ALL ON fs138.feature_values, fs138.feature_inputs, fs138.outcome_labels, fs138.label_inputs FROM PUBLIC;
GRANT SELECT ON fs138.feature_values, fs138.feature_inputs, fs138.outcome_labels, fs138.label_inputs TO fs138_reader, fs138_pipeline_writer;
GRANT INSERT ON fs138.feature_values, fs138.feature_inputs, fs138.outcome_labels, fs138.label_inputs TO fs138_pipeline_writer;
REVOKE ALL ON FUNCTION fs138.stamp_derived_time() FROM PUBLIC;

-- Called once for the entire season, never per example. Windows rank normalized
-- natural keys AFTER snapshot eligibility. All field access stays typed.
CREATE FUNCTION fs138.qb_job_context(p_season integer, p_checkpoint timestamptz,
  p_mode text, p_purpose text, p_normalizer text)
RETURNS TABLE(player_id text, game_id text, season integer, cutoff timestamptz,
  context_game_id text, context_kickoff timestamptz, discovery_kickoff timestamptz,
  yards integer, reasons text[], target_reasons text[])
-- SECURITY INVOKER, with explicitly qualified relations. No SET clause: this
-- set-returning SQL function stays inlinable so each call can plan from its
-- season/mode/purpose instead of reusing a poor generic function-body plan.
LANGUAGE sql STABLE AS $$
WITH snapshots AS MATERIALIZED (
  SELECT s.* FROM fs138.source_snapshots s JOIN fs138.job_runs j ON j.job_id=s.job_id
  WHERE s.ingested_at <= p_checkpoint AND j.status='succeeded'
    AND p_mode IN ('strict-point-in-time-v1','retrospective-reconstruction-v1')
    AND p_purpose IN ('features','labels')
), discovery_schedule AS MATERIALIZED (
  SELECT DISTINCT ON(n.game_id) n.*,
    count(*) OVER(PARTITION BY n.game_id,s.available_at,s.ingested_at) AS heads
  FROM fs138.norm_schedule n JOIN snapshots s USING(snapshot_id)
  WHERE n.normalizer_version=p_normalizer
  ORDER BY n.game_id,s.available_at DESC,s.ingested_at DESC,n.snapshot_id
), discovery_roster AS (
  SELECT DISTINCT ON(n.player_id,n.season,n.week,n.team) n.*
  FROM fs138.norm_identity n JOIN snapshots s USING(snapshot_id) WHERE n.normalizer_version=p_normalizer
  ORDER BY n.player_id,n.season,n.week,n.team,s.available_at DESC,s.ingested_at DESC,n.snapshot_id
), discovery_stats AS (
  SELECT DISTINCT ON(n.player_id,n.game_id) n.*
  FROM fs138.norm_player_game_stats n JOIN snapshots s USING(snapshot_id) WHERE n.normalizer_version=p_normalizer
  ORDER BY n.player_id,n.game_id,s.available_at DESC,s.ingested_at DESC,n.snapshot_id
), population AS MATERIALIZED (
  SELECT n.player_id,s.game_id FROM discovery_roster n JOIN discovery_schedule s
    ON n.season=s.season AND n.week=s.week AND n.team IN(s.home_team,s.away_team)
  UNION SELECT player_id,game_id FROM discovery_stats
), targets AS MATERIALIZED (
  SELECT p.*,coalesce(s.season,substring(p.game_id from '^([0-9]{4})_')::integer) AS season,
    s.kickoff-interval '1 hour' AS cutoff,s.heads AS discovery_heads
  FROM population p LEFT JOIN discovery_schedule s USING(game_id)
  WHERE coalesce(s.season,substring(p.game_id from '^([0-9]{4})_')::integer)=p_season
), requests AS MATERIALIZED (
  SELECT t.*,h.game_id AS context_game_id,d.kickoff AS discovery_kickoff,
    CASE WHEN p_purpose='labels' THEN p_checkpoint ELSE t.cutoff END AS eligibility_clock
  FROM targets t JOIN population h ON h.player_id=t.player_id
    AND (p_purpose='features' OR h.game_id=t.game_id)
  LEFT JOIN discovery_schedule d ON d.game_id=h.game_id
), schedules AS MATERIALIZED (
  SELECT DISTINCT ON(r.player_id,r.game_id,r.context_game_id)
    r.player_id,r.game_id,r.context_game_id,n.season,n.week,n.kickoff,n.home_team,n.away_team,
    n.state='usable' AND n.game_type='REG' AS usable,n.state='ambiguous' AS ambiguous,
    n.home_score IS NOT NULL AND n.away_score IS NOT NULL AS completed,
    count(*) OVER(PARTITION BY r.player_id,r.game_id,r.context_game_id,s.available_at,s.ingested_at) AS heads
  FROM requests r JOIN fs138.norm_schedule n ON n.game_id=r.context_game_id JOIN snapshots s USING(snapshot_id)
  WHERE n.normalizer_version=p_normalizer AND (p_mode='retrospective-reconstruction-v1'
    OR (s.available_at<=r.eligibility_clock AND s.ingested_at<=r.eligibility_clock))
  ORDER BY r.player_id,r.game_id,r.context_game_id,s.available_at DESC,s.ingested_at DESC,n.snapshot_id
), stats AS MATERIALIZED (
  SELECT DISTINCT ON(r.player_id,r.game_id,r.context_game_id)
    r.player_id,r.game_id,r.context_game_id,n.team,n.passing_yards AS yards,
    n.state='usable' AS usable,n.state='ambiguous' AS ambiguous,
    count(*) OVER(PARTITION BY r.player_id,r.game_id,r.context_game_id,s.available_at,s.ingested_at) AS heads
  FROM requests r JOIN fs138.norm_player_game_stats n ON n.player_id=r.player_id AND n.game_id=r.context_game_id
    JOIN snapshots s USING(snapshot_id)
  WHERE n.normalizer_version=p_normalizer AND (p_mode='retrospective-reconstruction-v1'
    OR (s.available_at<=r.eligibility_clock AND s.ingested_at<=r.eligibility_clock))
  ORDER BY r.player_id,r.game_id,r.context_game_id,s.available_at DESC,s.ingested_at DESC,n.snapshot_id
), identity_heads AS (
  SELECT DISTINCT ON(r.player_id,r.game_id,r.context_game_id,n.team)
    r.player_id,r.game_id,r.context_game_id,n.team,n.state,n.position,
    count(*) OVER(PARTITION BY r.player_id,r.game_id,r.context_game_id,n.team,s.available_at,s.ingested_at) AS heads
  FROM requests r JOIN schedules g USING(player_id,game_id,context_game_id)
    JOIN fs138.norm_identity n ON n.player_id=r.player_id AND n.season=g.season AND n.week=g.week
      AND n.team IN(g.home_team,g.away_team) JOIN snapshots s USING(snapshot_id)
  WHERE n.normalizer_version=p_normalizer AND (p_mode='retrospective-reconstruction-v1'
    OR (s.available_at<=r.eligibility_clock AND s.ingested_at<=r.eligibility_clock))
  ORDER BY r.player_id,r.game_id,r.context_game_id,n.team,s.available_at DESC,s.ingested_at DESC,n.snapshot_id
), identities AS MATERIALIZED (
  SELECT player_id,game_id,context_game_id,min(team) AS team,sum(heads) AS heads,
    bool_and(state='usable' AND position='QB') AS usable,bool_or(state='ambiguous') AS ambiguous
  FROM identity_heads GROUP BY player_id,game_id,context_game_id
), participation AS MATERIALIZED (
  SELECT DISTINCT ON(r.player_id,r.game_id,r.context_game_id)
    r.player_id,r.game_id,r.context_game_id,n.state='usable' AND n.offense_play_count>0 AS usable,n.state='ambiguous' AS ambiguous,
    count(*) OVER(PARTITION BY r.player_id,r.game_id,r.context_game_id,s.available_at,s.ingested_at) AS heads
  FROM requests r JOIN fs138.norm_participation n ON n.player_id=r.player_id AND n.game_id=r.context_game_id
    JOIN snapshots s USING(snapshot_id)
  WHERE n.normalizer_version=p_normalizer AND (p_mode='retrospective-reconstruction-v1'
    OR (s.available_at<=r.eligibility_clock AND s.ingested_at<=r.eligibility_clock))
  ORDER BY r.player_id,r.game_id,r.context_game_id,s.available_at DESC,s.ingested_at DESC,n.snapshot_id
)
SELECT r.player_id,r.game_id,r.season,r.cutoff,r.context_game_id,g.kickoff,r.discovery_kickoff,st.yards,
  array_remove(ARRAY[
    CASE WHEN g.heads IS NULL THEN 'schedule-missing' WHEN g.heads<>1 OR g.ambiguous THEN 'schedule-ambiguous' WHEN NOT g.usable THEN 'schedule-refused' END,
    CASE WHEN NOT coalesce(g.completed,false) THEN 'completion-unavailable' END,
    CASE WHEN st.heads IS NULL THEN 'stats-missing' WHEN st.heads<>1 OR st.ambiguous THEN 'stats-ambiguous' WHEN NOT st.usable THEN 'stats-refused' END,
    CASE WHEN i.heads IS NULL THEN 'identity-missing' WHEN i.heads<>1 OR i.ambiguous THEN 'identity-ambiguous' WHEN NOT i.usable THEN 'identity-refused' END,
    CASE WHEN st.team IS NOT NULL AND (st.team NOT IN(g.home_team,g.away_team) OR st.team<>i.team) THEN 'identity-team-conflict' END,
    CASE WHEN p.heads IS NULL THEN 'positive-offense-participation-missing' WHEN p.heads<>1 OR p.ambiguous THEN 'participation-ambiguous' WHEN NOT p.usable THEN 'participation-refused' END
  ],NULL),
  array_remove(ARRAY[
    CASE WHEN r.cutoff IS NULL THEN 'target-schedule-missing' WHEN r.discovery_heads<>1 THEN 'target-schedule-ambiguous' END,
    CASE WHEN g.heads IS NULL THEN 'target-schedule-missing' WHEN g.heads<>1 OR g.ambiguous THEN 'target-schedule-ambiguous'
      WHEN NOT g.usable THEN 'target-schedule-refused' WHEN g.kickoff-interval '1 hour'<>r.cutoff THEN 'target-schedule-changed' END,
    CASE WHEN i.heads IS NULL THEN 'target-identity-missing' WHEN i.heads<>1 OR i.ambiguous THEN 'target-identity-ambiguous' WHEN NOT i.usable THEN 'target-identity-refused' END
  ],NULL)
FROM requests r LEFT JOIN schedules g USING(player_id,game_id,context_game_id)
  LEFT JOIN stats st USING(player_id,game_id,context_game_id)
  LEFT JOIN identities i USING(player_id,game_id,context_game_id)
  LEFT JOIN participation p USING(player_id,game_id,context_game_id);
$$;
REVOKE ALL ON FUNCTION fs138.qb_job_context(integer,timestamptz,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fs138.qb_job_context(integer,timestamptz,text,text,text) TO fs138_pipeline_writer;

-- Standard bulk-load statistics maintenance prevents generic cardinality guesses
-- from choosing quadratic nested loops. This grant does not permit row mutation.
GRANT MAINTAIN ON fs138.job_runs,fs138.source_snapshots,fs138.norm_schedule,
 fs138.norm_player_game_stats,fs138.norm_identity,fs138.norm_participation TO fs138_pipeline_writer;
