-- Predictive evidence schema (#52). Source truth is append-only: bytes are
-- content-addressed outside the database, evidence rows are immutable source
-- revisions, and each provider keeps its own correction chain per fact.
-- No application route requires this prefix; readiness minimum stays v2.

CREATE FUNCTION public.predictive_text(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_typeof(value) = 'string' AND length(value #>> '{}') BETWEEN 1 AND 256
    AND (value #>> '{}') !~ '[[:cntrl:]]' AND length(btrim(value #>> '{}')) > 0
$$;

CREATE FUNCTION public.predictive_optional_text(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT value = 'null'::jsonb OR public.predictive_text(value)
$$;

CREATE FUNCTION public.predictive_instant(value text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  RETURN value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND to_char(value::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = value;
EXCEPTION WHEN OTHERS THEN RETURN false;
END
$$;

CREATE FUNCTION public.predictive_integer(value jsonb, minimum numeric, maximum numeric) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  RETURN jsonb_typeof(value) = 'number' AND (value #>> '{}')::numeric BETWEEN minimum AND maximum
    AND mod((value #>> '{}')::numeric, 1) = 0;
EXCEPTION WHEN OTHERS THEN RETURN false;
END
$$;

CREATE FUNCTION public.predictive_identity(value jsonb, kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_typeof(value) = 'string' AND CASE kind
    WHEN 'game' THEN value #>> '{}' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    WHEN 'player' THEN value #>> '{}' ~ '^00-[0-9]{7}$'
    WHEN 'team' THEN value #>> '{}' ~ '^nfl:team:[A-Z]{2,3}$'
    ELSE false END
$$;

-- Identical to entityKey() in src/lib/predictive/validation.ts. The entity key
-- names the fact, never the provider that reported it.
CREATE FUNCTION public.predictive_entity_key(kind text, data jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE kind
    WHEN 'schedule-coverage' THEN kind || ':' || (data->>'teamId') || ':' || (data->>'fromSeason') || ':' || (data->>'throughSeason')
    WHEN 'event-state-marker' THEN kind || ':' || (data->>'gameId') || ':' || (data->>'markerType')
    WHEN 'participation-evidence' THEN kind || ':' || (data->>'gameId') || ':' || (data->>'playerId') || ':' || (data->>'evidenceKind')
    WHEN 'team-game-stats' THEN kind || ':' || (data->>'gameId') || ':' || (data->>'teamId')
    WHEN 'schedule' THEN kind || ':' || (data->>'gameId')
    ELSE kind || ':' || (data->>'gameId') || ':' || (data->>'playerId') END
$$;

CREATE FUNCTION public.predictive_stats_valid(data jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE name text; missing jsonb := data->'missing';
BEGIN
  IF jsonb_typeof(missing) <> 'object' THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(missing) m WHERE m.key NOT IN ('attempts','completions','passingYards','passingTds',
      'passingInterceptions','carries','rushingYards','targets','receptions','receivingYards')
      OR m.value NOT IN ('"source-blank"'::jsonb, '"source-missing"'::jsonb)) THEN RETURN false; END IF;
  FOREACH name IN ARRAY ARRAY['attempts','completions','passingYards','passingTds','passingInterceptions',
      'carries','rushingYards','targets','receptions','receivingYards'] LOOP
    IF data->name = 'null'::jsonb THEN
      IF NOT missing ? name THEN RETURN false; END IF;
    ELSE
      IF missing ? name THEN RETURN false; END IF;
      IF name LIKE '%Yards' THEN
        IF NOT public.predictive_integer(data->name, -10000, 10000) THEN RETURN false; END IF;
      ELSIF NOT public.predictive_integer(data->name, 0, 1000) THEN RETURN false; END IF;
    END IF;
  END LOOP;
  IF data->'attempts' <> 'null'::jsonb AND data->'completions' <> 'null'::jsonb
      AND (data->>'completions')::integer > (data->>'attempts')::integer THEN RETURN false; END IF;
  IF data->'targets' <> 'null'::jsonb AND data->'receptions' <> 'null'::jsonb
      AND (data->>'receptions')::integer > (data->>'targets')::integer THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END
$$;

-- Exact per-kind payload contract, matching validateRevision(). Schedule
-- Eastern-time round trips are checked in code; SQL checks formats only.
CREATE FUNCTION public.predictive_payload_valid(kind text, data jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE fields text[]; name text; item jsonb;
  stats text[] := ARRAY['gameId','rawGameId','teamId','rawTeam','season','seasonType','attempts','completions','passingYards',
    'passingTds','passingInterceptions','carries','rushingYards','targets','receptions','receivingYards','missing'];
BEGIN
  fields := CASE kind
    WHEN 'schedule' THEN ARRAY['gameId','rawGameId','season','seasonType','week','kickoff','rawGameday','rawGametime',
      'homeTeamId','awayTeamId','rawHomeTeam','rawAwayTeam','rawRoof','rawSurface','rawStadiumId']
    WHEN 'schedule-coverage' THEN ARRAY['teamId','fromSeason','throughSeason','gameIds','state']
    WHEN 'membership' THEN ARRAY['gameId','playerId','teamId','rawTeam','position','rosterStatus','season','seasonType','week','effectiveFrom','effectiveTo']
    WHEN 'player-game-stats' THEN stats || ARRAY['playerId']
    WHEN 'team-game-stats' THEN stats
    WHEN 'event-state-marker' THEN ARRAY['gameId','markerType','markerValue','terminalPlayTimeOfDay']
    WHEN 'participation-evidence' THEN ARRAY['gameId','playerId','teamId','evidenceKind','claim']
    WHEN 'availability' THEN ARRAY['gameId','playerId','teamId','rawReportStatus','rawPracticeStatus','rawDepthRank']
    ELSE NULL END;
  IF fields IS NULL OR jsonb_typeof(data) <> 'object' OR
    (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(data) key) IS DISTINCT FROM
    (SELECT array_agg(key ORDER BY key) FROM unnest(fields) key) THEN RETURN false; END IF;
  IF kind <> 'schedule-coverage' AND NOT public.predictive_identity(data->'gameId', 'game') THEN RETURN false; END IF;
  IF data ? 'playerId' AND NOT public.predictive_identity(data->'playerId', 'player') THEN RETURN false; END IF;
  FOREACH name IN ARRAY ARRAY['teamId','homeTeamId','awayTeamId'] LOOP
    IF data ? name AND NOT public.predictive_identity(data->name, 'team') THEN RETURN false; END IF;
  END LOOP;
  FOREACH name IN ARRAY ARRAY['rawGameId','rawTeam','rawHomeTeam','rawAwayTeam','position','rosterStatus','markerValue'] LOOP
    IF data ? name AND NOT public.predictive_text(data->name) THEN RETURN false; END IF;
  END LOOP;
  IF data ? 'season' AND (NOT public.predictive_integer(data->'season', 1920, 9999)
    OR (data->>'seasonType' IN ('REG','POST')) IS NOT TRUE) THEN RETURN false; END IF;
  CASE kind
    WHEN 'schedule' THEN
      IF NOT public.predictive_integer(data->'week', 1, 22) OR NOT public.predictive_instant(data->>'kickoff')
        OR data->>'homeTeamId' = data->>'awayTeamId' THEN RETURN false; END IF;
      FOREACH name IN ARRAY ARRAY['rawRoof','rawSurface','rawStadiumId'] LOOP
        IF NOT public.predictive_optional_text(data->name) THEN RETURN false; END IF;
      END LOOP;
      IF (data->'rawGameday' = 'null'::jsonb) <> (data->'rawGametime' = 'null'::jsonb) THEN RETURN false; END IF;
      RETURN data->'rawGameday' = 'null'::jsonb OR (jsonb_typeof(data->'rawGameday') = 'string'
        AND data->>'rawGameday' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND jsonb_typeof(data->'rawGametime') = 'string'
        AND data->>'rawGametime' ~ '^[0-9]{2}:[0-9]{2}$');
    WHEN 'schedule-coverage' THEN
      IF NOT public.predictive_integer(data->'fromSeason', 1920, 9999) OR NOT public.predictive_integer(data->'throughSeason', 1920, 9999)
        OR (data->>'throughSeason')::integer - (data->>'fromSeason')::integer <> 2
        OR (data->>'state' IN ('complete','incomplete')) IS NOT TRUE OR jsonb_typeof(data->'gameIds') <> 'array'
        OR jsonb_array_length(data->'gameIds') > 256 THEN RETURN false; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(data->'gameIds') LOOP
        IF NOT public.predictive_identity(item, 'game') THEN RETURN false; END IF;
      END LOOP;
      RETURN (SELECT count(*) = count(DISTINCT value) FROM jsonb_array_elements(data->'gameIds'));
    WHEN 'membership' THEN
      RETURN public.predictive_integer(data->'week', 1, 22) AND public.predictive_instant(data->>'effectiveFrom')
        AND public.predictive_instant(data->>'effectiveTo') AND data->>'effectiveFrom' < data->>'effectiveTo';
    WHEN 'player-game-stats', 'team-game-stats' THEN
      RETURN public.predictive_stats_valid(data);
    WHEN 'event-state-marker' THEN
      IF (data->>'markerType' IN ('provider-final-status','terminal-play','final-team-totals','suspension-notice','postponement-notice')) IS NOT TRUE
        THEN RETURN false; END IF;
      RETURN CASE WHEN data->>'markerType' = 'terminal-play'
        THEN jsonb_typeof(data->'terminalPlayTimeOfDay') = 'string' AND data->>'terminalPlayTimeOfDay' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$'
        ELSE data->'terminalPlayTimeOfDay' = 'null'::jsonb END;
    WHEN 'participation-evidence' THEN
      RETURN (data->>'evidenceKind' IN ('participation-feed','official-inactive-list','provider-snap-count')) IS TRUE
        AND (data->>'claim' IN ('offensive-participant','zero-offensive-participation','inactive-or-dnp')) IS TRUE
        AND (data->>'evidenceKind' <> 'official-inactive-list' OR data->>'claim' = 'inactive-or-dnp');
    WHEN 'availability' THEN
      RETURN public.predictive_optional_text(data->'rawReportStatus') AND public.predictive_optional_text(data->'rawPracticeStatus')
        AND (data->'rawDepthRank' = 'null'::jsonb OR public.predictive_integer(data->'rawDepthRank', 1, 20));
    ELSE RETURN false;
  END CASE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END
$$;

-- Synthetic-test evidence is accepted only from a session that is a member of
-- the disposable harness role. That is role membership, not a settable flag,
-- and the role does not exist outside the disposable harness.
CREATE FUNCTION public.predictive_harness_session() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'predictive_harness')
    AND pg_catalog.pg_has_role(session_user, 'predictive_harness', 'MEMBER')
$$;

CREATE TABLE public.predictive_source_profiles (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9.-]{2,127}$'),
  purpose text NOT NULL CHECK (purpose IN ('source','owner-decision','synthetic-test')),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 256),
  feed text NOT NULL CHECK (length(feed) BETWEEN 1 AND 256),
  release_tag text CHECK (length(release_tag) BETWEEN 1 AND 256),
  asset_pattern text CHECK (length(asset_pattern) BETWEEN 1 AND 256),
  header_profile_sha256 text CHECK (header_profile_sha256 ~ '^[a-f0-9]{64}$'),
  parser_version text NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 256),
  allowlist_version text NOT NULL CHECK (length(allowlist_version) BETWEEN 1 AND 256),
  license text NOT NULL CHECK (length(license) BETWEEN 1 AND 256),
  attribution text CHECK (length(attribution) BETWEEN 1 AND 256),
  evidence_kinds text[] NOT NULL CHECK (cardinality(evidence_kinds) BETWEEN 1 AND 8 AND evidence_kinds <@ ARRAY['schedule','schedule-coverage',
    'membership','player-game-stats','team-game-stats','event-state-marker','participation-evidence','availability']::text[]),
  registered_at timestamptz NOT NULL CHECK (isfinite(registered_at) AND registered_at = date_trunc('milliseconds', registered_at))
);

-- Rights decisions form one linear chain per profile. effective_* is when the
-- terms apply; decided_at is when this system knew them.
CREATE TABLE public.predictive_rights_decisions (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  profile_id text NOT NULL REFERENCES public.predictive_source_profiles(id),
  predecessor_id text,
  allowed_uses text[] NOT NULL CHECK (allowed_uses <@ ARRAY['adapter-testing','internal-research','model-input',
    'outcome-label','public-display']::text[]),
  effective_from timestamptz NOT NULL CHECK (isfinite(effective_from) AND effective_from = date_trunc('milliseconds', effective_from)),
  effective_to timestamptz CHECK (isfinite(effective_to) AND effective_to = date_trunc('milliseconds', effective_to) AND effective_to > effective_from),
  decided_at timestamptz NOT NULL CHECK (isfinite(decided_at) AND decided_at = date_trunc('milliseconds', decided_at)),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('terms-review','written-confirmation','license-file','revocation','synthetic')),
  evidence_reference text NOT NULL CHECK (length(evidence_reference) BETWEEN 1 AND 512 AND evidence_reference !~ '[[:cntrl:]]'),
  UNIQUE (id, profile_id),
  FOREIGN KEY (predecessor_id, profile_id) REFERENCES public.predictive_rights_decisions(id, profile_id),
  CHECK (predecessor_id IS DISTINCT FROM id),
  CHECK (evidence_kind <> 'revocation' OR allowed_uses = '{}')
);
CREATE UNIQUE INDEX predictive_rights_one_successor ON public.predictive_rights_decisions (predecessor_id) WHERE predecessor_id IS NOT NULL;
CREATE UNIQUE INDEX predictive_rights_one_root ON public.predictive_rights_decisions (profile_id) WHERE predecessor_id IS NULL;

-- The decision applying at effective instant e using only decisions known by k:
-- the last link of the profile's chain that is known and effective then.
CREATE FUNCTION public.predictive_rights_in_force(profile text, e timestamptz, k timestamptz) RETURNS text
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain AS (
    SELECT d.id, d.decided_at, d.effective_from, d.effective_to, 1 AS position
      FROM public.predictive_rights_decisions d WHERE d.profile_id = profile AND d.predecessor_id IS NULL
    UNION ALL
    SELECT d.id, d.decided_at, d.effective_from, d.effective_to, c.position + 1
      FROM public.predictive_rights_decisions d JOIN chain c ON d.predecessor_id = c.id
  )
  SELECT id FROM chain WHERE decided_at <= k AND effective_from <= e AND (effective_to IS NULL OR e < effective_to)
  ORDER BY position DESC LIMIT 1
$$;

CREATE FUNCTION public.predictive_rights_allow(profile text, e timestamptz, k timestamptz, purpose text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT purpose = ANY(d.allowed_uses) FROM public.predictive_rights_decisions d
    WHERE d.id = public.predictive_rights_in_force(profile, e, k)), false)
$$;

CREATE TABLE public.predictive_blobs (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 0 AND 8000000),
  media_type text NOT NULL CHECK (media_type IN ('application/json','text/csv')),
  storage_ref text NOT NULL,
  CHECK (storage_ref = sha256 || CASE media_type WHEN 'application/json' THEN '.json' ELSE '.csv' END)
);

CREATE TABLE public.predictive_ingestion_runs (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  code_version text NOT NULL CHECK (length(code_version) BETWEEN 1 AND 256),
  started_at timestamptz NOT NULL CHECK (isfinite(started_at)),
  finished_at timestamptz NOT NULL CHECK (isfinite(finished_at) AND finished_at >= started_at),
  status text NOT NULL CHECK (status IN ('published','incomplete','refused')),
  failure_code text CHECK (failure_code IN ('publication-refused','artifact-store-unavailable','partial-acquisition',
    'budget-exceeded','rights-not-in-force')),
  budget jsonb NOT NULL CHECK (jsonb_typeof(budget) = 'object'),
  requests integer NOT NULL CHECK (requests >= 0),
  consumed_bytes bigint NOT NULL CHECK (consumed_bytes >= 0),
  artifact_count integer NOT NULL CHECK (artifact_count BETWEEN 0 AND 256),
  capture_count integer NOT NULL CHECK (capture_count BETWEEN 0 AND 512),
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 8192),
  peak_rss_bytes bigint CHECK (peak_rss_bytes >= 0),
  CHECK ((status = 'published') = (failure_code IS NULL))
);

-- The authorization each run relied on, preserved for audit.
CREATE TABLE public.predictive_run_rights (
  run_id text NOT NULL REFERENCES public.predictive_ingestion_runs(id),
  rights_decision_id text NOT NULL REFERENCES public.predictive_rights_decisions(id),
  PRIMARY KEY (run_id, rights_decision_id)
);

CREATE TABLE public.predictive_artifacts (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  blob_sha256 text NOT NULL REFERENCES public.predictive_blobs(sha256),
  profile_id text NOT NULL REFERENCES public.predictive_source_profiles(id),
  retrieval_kind text NOT NULL CHECK (retrieval_kind IN ('full','header-probe')),
  origin text NOT NULL CHECK (length(origin) BETWEEN 1 AND 256 AND origin ~ '^(https|fixture)://' AND origin !~ '[[:cntrl:]]'),
  provider_etag text CHECK (length(provider_etag) BETWEEN 1 AND 256),
  provider_last_modified text CHECK (length(provider_last_modified) BETWEEN 1 AND 256),
  -- Diagnostic only; never availability or publication evidence.
  release_updated_at timestamptz CHECK (isfinite(release_updated_at)),
  scope_kind text NOT NULL CHECK (scope_kind IN ('season-file','week-file','game','all-seasons','manual')),
  scope_season integer CHECK (scope_season BETWEEN 1920 AND 9999),
  scope_week integer CHECK (scope_week BETWEEN 1 AND 22),
  scope_filter text CHECK (length(scope_filter) BETWEEN 1 AND 256),
  CHECK ((scope_kind = 'week-file') = (scope_week IS NOT NULL))
);
CREATE INDEX predictive_artifacts_blob_idx ON public.predictive_artifacts (blob_sha256);

CREATE TABLE public.predictive_captures (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  run_id text NOT NULL REFERENCES public.predictive_ingestion_runs(id),
  artifact_id text NOT NULL REFERENCES public.predictive_artifacts(id),
  captured_at timestamptz NOT NULL CHECK (isfinite(captured_at) AND captured_at = date_trunc('milliseconds', captured_at)),
  available_at timestamptz NOT NULL CHECK (isfinite(available_at) AND available_at = date_trunc('milliseconds', available_at) AND available_at >= captured_at),
  ingested_at timestamptz NOT NULL CHECK (isfinite(ingested_at) AND ingested_at = date_trunc('milliseconds', ingested_at) AND ingested_at >= available_at),
  published_at timestamptz CHECK (isfinite(published_at) AND published_at = date_trunc('milliseconds', published_at) AND published_at <= captured_at),
  publication_evidence text CHECK (length(publication_evidence) BETWEEN 1 AND 256 AND publication_evidence !~ '[[:cntrl:]]'),
  state text NOT NULL CHECK (state IN ('published','incomplete')),
  body_complete boolean NOT NULL,
  header_verified boolean NOT NULL,
  parser_succeeded boolean NOT NULL,
  parsed_rows integer NOT NULL CHECK (parsed_rows BETWEEN 0 AND 1000000),
  CHECK ((published_at IS NULL) = (publication_evidence IS NULL)),
  CHECK (state = 'incomplete' OR (body_complete AND header_verified AND parser_succeeded))
);
CREATE INDEX predictive_captures_cutoff_idx ON public.predictive_captures (artifact_id, available_at, ingested_at, id) WHERE state = 'published';

-- Exactly the 32 franchise keys seeded from NFL_TEAM_ABBREVIATIONS (Rams = LA).
-- No role is granted INSERT; a 33rd row or an alias such as LAR is refused.
CREATE TABLE public.predictive_teams (
  id text PRIMARY KEY CHECK (id IN ('nfl:team:ARI','nfl:team:ATL','nfl:team:BAL','nfl:team:BUF','nfl:team:CAR',
    'nfl:team:CHI','nfl:team:CIN','nfl:team:CLE','nfl:team:DAL','nfl:team:DEN','nfl:team:DET','nfl:team:GB',
    'nfl:team:HOU','nfl:team:IND','nfl:team:JAX','nfl:team:KC','nfl:team:LA','nfl:team:LAC','nfl:team:LV',
    'nfl:team:MIA','nfl:team:MIN','nfl:team:NE','nfl:team:NO','nfl:team:NYG','nfl:team:NYJ','nfl:team:PHI',
    'nfl:team:PIT','nfl:team:SEA','nfl:team:SF','nfl:team:TB','nfl:team:TEN','nfl:team:WAS'))
);
INSERT INTO public.predictive_teams (id) VALUES ('nfl:team:ARI'),('nfl:team:ATL'),('nfl:team:BAL'),('nfl:team:BUF'),
  ('nfl:team:CAR'),('nfl:team:CHI'),('nfl:team:CIN'),('nfl:team:CLE'),('nfl:team:DAL'),('nfl:team:DEN'),('nfl:team:DET'),
  ('nfl:team:GB'),('nfl:team:HOU'),('nfl:team:IND'),('nfl:team:JAX'),('nfl:team:KC'),('nfl:team:LA'),('nfl:team:LAC'),
  ('nfl:team:LV'),('nfl:team:MIA'),('nfl:team:MIN'),('nfl:team:NE'),('nfl:team:NO'),('nfl:team:NYG'),('nfl:team:NYJ'),
  ('nfl:team:PHI'),('nfl:team:PIT'),('nfl:team:SEA'),('nfl:team:SF'),('nfl:team:TB'),('nfl:team:TEN'),('nfl:team:WAS');

CREATE TABLE public.predictive_games (
  id uuid PRIMARY KEY CHECK (id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
);

-- One envelope for every evidence kind: strict per-kind JSON plus typed routing
-- columns. The source key keeps each provider's correction chain separate.
CREATE TABLE public.predictive_observations (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  kind text NOT NULL,
  profile_id text NOT NULL REFERENCES public.predictive_source_profiles(id),
  source_record_id text NOT NULL DEFAULT '' CHECK (length(source_record_id) <= 256 AND source_record_id !~ '[[:cntrl:]|]'),
  data jsonb NOT NULL CHECK (public.predictive_payload_valid(kind, data) IS TRUE),
  entity_key text NOT NULL,
  source_key text NOT NULL,
  game_id uuid GENERATED ALWAYS AS ((data->>'gameId')::uuid) STORED REFERENCES public.predictive_games(id),
  player_id text GENERATED ALWAYS AS (data->>'playerId') STORED,
  team_id text GENERATED ALWAYS AS (data->>'teamId') STORED REFERENCES public.predictive_teams(id),
  home_team_id text GENERATED ALWAYS AS (data->>'homeTeamId') STORED REFERENCES public.predictive_teams(id),
  away_team_id text GENERATED ALWAYS AS (data->>'awayTeamId') STORED REFERENCES public.predictive_teams(id),
  season integer GENERATED ALWAYS AS ((data->>'season')::integer) STORED,
  effective_from text GENERATED ALWAYS AS (data->>'effectiveFrom') STORED,
  effective_to text GENERATED ALWAYS AS (data->>'effectiveTo') STORED,
  raw_game_id text GENERATED ALWAYS AS (data->>'rawGameId') STORED,
  predecessor_id text,
  correction_reason text CHECK (length(correction_reason) BETWEEN 1 AND 256 AND correction_reason !~ '[[:cntrl:]]'),
  CHECK (entity_key = public.predictive_entity_key(kind, data)),
  CHECK (source_key = entity_key || '|' || profile_id || '|' || source_record_id),
  CHECK (kind = split_part(entity_key, ':', 1)),
  UNIQUE (id, source_key),
  -- A correction never crosses providers, profiles or facts.
  FOREIGN KEY (predecessor_id, source_key) REFERENCES public.predictive_observations(id, source_key) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((predecessor_id IS NULL) = (correction_reason IS NULL)),
  CHECK (predecessor_id IS DISTINCT FROM id)
);
-- Branching inside one source chain is refused at write time.
CREATE UNIQUE INDEX predictive_observations_one_successor ON public.predictive_observations (predecessor_id) WHERE predecessor_id IS NOT NULL;
CREATE INDEX predictive_observations_source_idx ON public.predictive_observations (source_key);
CREATE INDEX predictive_observations_entity_idx ON public.predictive_observations (game_id, kind, player_id, team_id);
CREATE INDEX predictive_observations_membership_idx ON public.predictive_observations (player_id, team_id, effective_from, effective_to) WHERE kind = 'membership';
CREATE INDEX predictive_observations_team_idx ON public.predictive_observations (team_id, kind);
CREATE INDEX predictive_observations_home_schedule_idx ON public.predictive_observations (home_team_id, season) WHERE kind = 'schedule';
CREATE INDEX predictive_observations_away_schedule_idx ON public.predictive_observations (away_team_id, season) WHERE kind = 'schedule';
CREATE INDEX predictive_observations_alias_idx ON public.predictive_observations (raw_game_id) WHERE kind = 'schedule';

CREATE TABLE public.predictive_artifact_observations (
  artifact_id text NOT NULL REFERENCES public.predictive_artifacts(id),
  observation_id text NOT NULL REFERENCES public.predictive_observations(id),
  PRIMARY KEY (artifact_id, observation_id)
);
CREATE INDEX predictive_artifact_observations_reverse_idx ON public.predictive_artifact_observations (observation_id, artifact_id);

CREATE FUNCTION public.predictive_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'predictive-append-only' USING ERRCODE = '23514'; END
$$;
CREATE TRIGGER predictive_profiles_immutable BEFORE UPDATE OR DELETE ON public.predictive_source_profiles FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_rights_immutable BEFORE UPDATE OR DELETE ON public.predictive_rights_decisions FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_blobs_immutable BEFORE UPDATE OR DELETE ON public.predictive_blobs FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_runs_immutable BEFORE UPDATE OR DELETE ON public.predictive_ingestion_runs FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_run_rights_immutable BEFORE UPDATE OR DELETE ON public.predictive_run_rights FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_artifacts_immutable BEFORE UPDATE OR DELETE ON public.predictive_artifacts FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_captures_immutable BEFORE UPDATE OR DELETE ON public.predictive_captures FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_teams_immutable BEFORE UPDATE OR DELETE ON public.predictive_teams FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_games_immutable BEFORE UPDATE OR DELETE ON public.predictive_games FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_observations_immutable BEFORE UPDATE OR DELETE ON public.predictive_observations FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_links_immutable BEFORE UPDATE OR DELETE ON public.predictive_artifact_observations FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_profiles_no_truncate BEFORE TRUNCATE ON public.predictive_source_profiles FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_rights_no_truncate BEFORE TRUNCATE ON public.predictive_rights_decisions FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_blobs_no_truncate BEFORE TRUNCATE ON public.predictive_blobs FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_runs_no_truncate BEFORE TRUNCATE ON public.predictive_ingestion_runs FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_run_rights_no_truncate BEFORE TRUNCATE ON public.predictive_run_rights FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_artifacts_no_truncate BEFORE TRUNCATE ON public.predictive_artifacts FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_captures_no_truncate BEFORE TRUNCATE ON public.predictive_captures FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_teams_no_truncate BEFORE TRUNCATE ON public.predictive_teams FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_games_no_truncate BEFORE TRUNCATE ON public.predictive_games FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_observations_no_truncate BEFORE TRUNCATE ON public.predictive_observations FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_links_no_truncate BEFORE TRUNCATE ON public.predictive_artifact_observations FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();

-- Rights chains: synthetic profiles only carry synthetic evidence and never
-- public display; real profiles never claim synthetic evidence; knowledge time
-- never moves backwards along a chain.
CREATE FUNCTION public.predictive_rights_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE profile_purpose text;
BEGIN
  SELECT purpose INTO profile_purpose FROM public.predictive_source_profiles WHERE id = NEW.profile_id;
  IF (profile_purpose = 'synthetic-test') <> (NEW.evidence_kind = 'synthetic')
      OR (profile_purpose = 'synthetic-test' AND 'public-display' = ANY(NEW.allowed_uses)) THEN
    RAISE EXCEPTION 'predictive-synthetic-rights-refused' USING ERRCODE = '23514';
  END IF;
  IF NEW.predecessor_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.predictive_rights_decisions p
      WHERE p.id = NEW.predecessor_id AND p.decided_at > NEW.decided_at) THEN
    RAISE EXCEPTION 'predictive-rights-order-refused' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER predictive_rights_validate BEFORE INSERT ON public.predictive_rights_decisions FOR EACH ROW EXECUTE FUNCTION public.predictive_rights_check();

CREATE FUNCTION public.predictive_publication_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected text[];
BEGIN
  IF TG_TABLE_NAME = 'predictive_captures' THEN
    IF NEW.state = 'published' THEN
      IF (SELECT status FROM public.predictive_ingestion_runs WHERE id = NEW.run_id) <> 'published'
          OR (SELECT retrieval_kind FROM public.predictive_artifacts WHERE id = NEW.artifact_id) <> 'full' THEN
        RAISE EXCEPTION 'predictive-publication-invalid' USING ERRCODE = '23514';
      END IF;
      -- Historical authorization: only rights known when the bytes were captured.
      IF NOT public.predictive_rights_allow((SELECT profile_id FROM public.predictive_artifacts WHERE id = NEW.artifact_id),
          NEW.captured_at, NEW.captured_at, 'internal-research') THEN
        RAISE EXCEPTION 'predictive-rights-not-in-force' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.predictive_run_rights rr WHERE rr.run_id = NEW.run_id AND rr.rights_decision_id =
          public.predictive_rights_in_force((SELECT profile_id FROM public.predictive_artifacts WHERE id = NEW.artifact_id), NEW.captured_at, NEW.captured_at)) THEN
        RAISE EXCEPTION 'predictive-run-rights-missing' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF (SELECT p.purpose FROM public.predictive_artifacts a JOIN public.predictive_source_profiles p ON p.id = a.profile_id
        WHERE a.id = NEW.artifact_id) = 'synthetic-test' AND NOT public.predictive_harness_session() THEN
      RAISE EXCEPTION 'predictive-synthetic-outside-harness' USING ERRCODE = '23514';
    END IF;
    SELECT array_agg(observation_id) INTO affected FROM public.predictive_artifact_observations WHERE artifact_id = NEW.artifact_id;
  ELSIF TG_TABLE_NAME = 'predictive_observations' THEN affected := ARRAY[NEW.id];
  ELSE affected := ARRAY[NEW.observation_id]; END IF;
  IF EXISTS (SELECT 1 FROM public.predictive_artifact_observations l
      JOIN public.predictive_observations o ON o.id = l.observation_id
      JOIN public.predictive_artifacts a ON a.id = l.artifact_id
      JOIN public.predictive_source_profiles p ON p.id = a.profile_id
      WHERE o.id = ANY(affected) AND (o.profile_id <> a.profile_id OR NOT o.kind = ANY(p.evidence_kinds) OR a.retrieval_kind <> 'full')) OR
    EXISTS (SELECT 1 FROM public.predictive_observations o WHERE o.id = ANY(affected) AND NOT EXISTS (
      SELECT 1 FROM public.predictive_artifact_observations l JOIN public.predictive_captures c ON c.artifact_id = l.artifact_id
      WHERE l.observation_id = o.id AND c.state = 'published')) THEN
    RAISE EXCEPTION 'predictive-publication-invalid' USING ERRCODE = '23514';
  END IF;
  -- Every correction's first usable capture must follow an independently
  -- usable predecessor in the same source chain.
  IF EXISTS (SELECT 1 FROM public.predictive_observations o
    JOIN public.predictive_artifact_observations l ON l.observation_id = o.id
    JOIN public.predictive_captures c ON c.artifact_id = l.artifact_id AND c.state = 'published'
    WHERE o.id = ANY(affected) AND o.predecessor_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.predictive_artifact_observations pl JOIN public.predictive_captures pc ON pc.artifact_id = pl.artifact_id
      WHERE pl.observation_id = o.predecessor_id AND pc.state = 'published'
        AND pc.available_at <= c.available_at AND pc.ingested_at <= c.ingested_at)) THEN
    RAISE EXCEPTION 'predictive-correction-time-invalid' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (WITH RECURSIVE chain AS (
    SELECT id, predecessor_id, ARRAY[id] AS path, false AS cycle FROM public.predictive_observations WHERE id = ANY(affected) AND predecessor_id IS NOT NULL
    UNION ALL SELECT c.id, o.predecessor_id, c.path || o.id, o.id = ANY(c.path)
      FROM chain c JOIN public.predictive_observations o ON o.id = c.predecessor_id WHERE NOT c.cycle)
    SELECT 1 FROM chain WHERE cycle) THEN
    RAISE EXCEPTION 'predictive-correction-cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER predictive_check_captures AFTER INSERT ON public.predictive_captures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.predictive_publication_check();
CREATE CONSTRAINT TRIGGER predictive_check_observations AFTER INSERT ON public.predictive_observations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.predictive_publication_check();
CREATE CONSTRAINT TRIGGER predictive_check_links AFTER INSERT ON public.predictive_artifact_observations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.predictive_publication_check();

-- Privileges. PostgreSQL grants EXECUTE on new functions to PUBLIC by default;
-- every predictive function is revoked from PUBLIC. Role grants apply only where
-- the roles exist (the disposable harness creates them; hosted role setup is #95).
REVOKE ALL ON FUNCTION public.predictive_text(jsonb), public.predictive_optional_text(jsonb), public.predictive_instant(text),
  public.predictive_integer(jsonb, numeric, numeric), public.predictive_identity(jsonb, text), public.predictive_entity_key(text, jsonb),
  public.predictive_stats_valid(jsonb), public.predictive_payload_valid(text, jsonb), public.predictive_harness_session(),
  public.predictive_rights_in_force(text, timestamptz, timestamptz), public.predictive_rights_allow(text, timestamptz, timestamptz, text),
  public.predictive_append_only(), public.predictive_rights_check(), public.predictive_publication_check() FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'predictive_ingest') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_text(jsonb), public.predictive_optional_text(jsonb), public.predictive_instant(text),
      public.predictive_integer(jsonb, numeric, numeric), public.predictive_identity(jsonb, text), public.predictive_entity_key(text, jsonb),
      public.predictive_stats_valid(jsonb), public.predictive_payload_valid(text, jsonb), public.predictive_harness_session(),
      public.predictive_rights_in_force(text, timestamptz, timestamptz), public.predictive_rights_allow(text, timestamptz, timestamptz, text),
      public.predictive_append_only(), public.predictive_rights_check(), public.predictive_publication_check() TO predictive_ingest;
    GRANT SELECT, INSERT ON public.predictive_source_profiles, public.predictive_rights_decisions, public.predictive_blobs,
      public.predictive_ingestion_runs, public.predictive_run_rights, public.predictive_artifacts, public.predictive_captures,
      public.predictive_games, public.predictive_observations, public.predictive_artifact_observations TO predictive_ingest;
    GRANT SELECT ON public.predictive_teams TO predictive_ingest;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'predictive_replay') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_rights_in_force(text, timestamptz, timestamptz),
      public.predictive_rights_allow(text, timestamptz, timestamptz, text) TO predictive_replay;
    GRANT SELECT ON public.predictive_source_profiles, public.predictive_rights_decisions, public.predictive_blobs,
      public.predictive_ingestion_runs, public.predictive_run_rights, public.predictive_artifacts, public.predictive_captures,
      public.predictive_teams, public.predictive_games, public.predictive_observations, public.predictive_artifact_observations TO predictive_replay;
  END IF;
END
$grants$;
