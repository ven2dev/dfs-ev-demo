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
    WHEN 'source-row-absent' THEN data->>'priorEntityKey'
    WHEN 'team-alias' THEN kind || ':' || (data->>'provider') || ':' || (data->>'rawAlias')
    WHEN 'game-bridge' THEN kind || ':' || (data->>'provider') || ':' || (data->>'rawGameId')
    WHEN 'player-bridge' THEN kind || ':' || (data->>'provider') || ':' || (data->>'rawPlayerId')
    WHEN 'game-relation' THEN kind || ':' || (data->>'gameId')
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
    WHEN 'source-row-absent' THEN ARRAY['priorObservationId','priorEntityKey','coveringCaptureId','scopeKind','scopeSeason','scopeWeek','scopeFilter']
    WHEN 'team-alias' THEN ARRAY['provider','rawAlias','teamId','effectiveFromSeason','effectiveToSeason']
    WHEN 'game-bridge' THEN ARRAY['provider','rawGameId','gameId']
    WHEN 'player-bridge' THEN ARRAY['provider','rawPlayerId','playerId','effectiveFrom','effectiveTo']
    WHEN 'game-relation' THEN ARRAY['gameId','predecessorGameId','relation']
    ELSE NULL END;
  IF fields IS NULL OR jsonb_typeof(data) <> 'object' THEN RETURN false; END IF;
  IF kind = 'source-row-absent' THEN
    -- The fixed fields plus exactly the routing fields copied from the prior row.
    IF NOT (SELECT array_agg(key) FROM jsonb_object_keys(data) key) @> fields OR EXISTS (SELECT 1 FROM jsonb_object_keys(data) key
        WHERE key <> ALL(fields) AND key <> ALL(ARRAY['gameId','playerId','teamId','season','seasonType'])) THEN RETURN false; END IF;
  ELSIF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(data) key) IS DISTINCT FROM
    (SELECT array_agg(key ORDER BY key) FROM unnest(fields) key) THEN RETURN false; END IF;
  IF data ? 'gameId' AND NOT public.predictive_identity(data->'gameId', 'game') THEN RETURN false; END IF;
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
    WHEN 'source-row-absent' THEN
      RETURN public.predictive_text(data->'priorObservationId') AND public.predictive_text(data->'coveringCaptureId')
        AND jsonb_typeof(data->'priorEntityKey') = 'string' AND length(data->>'priorEntityKey') <= 300 AND position(':' IN data->>'priorEntityKey') > 0
        AND data->>'priorEntityKey' NOT LIKE 'source-row-absent:%'
        AND (data->>'scopeKind' IN ('season-file','week-file','game','all-seasons','manual')) IS TRUE
        AND (data->'scopeSeason' = 'null'::jsonb OR public.predictive_integer(data->'scopeSeason', 1920, 9999))
        AND (data->'scopeWeek' = 'null'::jsonb OR public.predictive_integer(data->'scopeWeek', 1, 22))
        AND public.predictive_optional_text(data->'scopeFilter');
    WHEN 'team-alias' THEN
      RETURN jsonb_typeof(data->'provider') = 'string' AND data->>'provider' ~ '^[a-z0-9][a-z0-9-]{0,31}$'
        AND jsonb_typeof(data->'rawAlias') = 'string' AND data->>'rawAlias' ~ '^[A-Za-z0-9._-]{1,64}$'
        AND public.predictive_integer(data->'effectiveFromSeason', 1920, 9999) AND public.predictive_integer(data->'effectiveToSeason', 1920, 9999)
        AND (data->>'effectiveFromSeason')::integer <= (data->>'effectiveToSeason')::integer;
    WHEN 'game-bridge' THEN
      RETURN jsonb_typeof(data->'provider') = 'string' AND data->>'provider' ~ '^[a-z0-9][a-z0-9-]{0,31}$'
        AND data->>'rawGameId' ~ '^[A-Za-z0-9._-]{1,64}$';
    WHEN 'player-bridge' THEN
      RETURN jsonb_typeof(data->'provider') = 'string' AND data->>'provider' ~ '^[a-z0-9][a-z0-9-]{0,31}$'
        AND jsonb_typeof(data->'rawPlayerId') = 'string' AND data->>'rawPlayerId' ~ '^[A-Za-z0-9._-]{1,64}$'
        AND public.predictive_instant(data->>'effectiveFrom') AND public.predictive_instant(data->>'effectiveTo')
        AND data->>'effectiveFrom' < data->>'effectiveTo';
    WHEN 'game-relation' THEN
      RETURN public.predictive_identity(data->'predecessorGameId', 'game') AND data->>'relation' = 'replacement'
        AND data->>'predecessorGameId' <> data->>'gameId';
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
  evidence_kinds text[] NOT NULL CHECK (cardinality(evidence_kinds) BETWEEN 1 AND 13 AND evidence_kinds <@ ARRAY['schedule','schedule-coverage',
    'membership','player-game-stats','team-game-stats','event-state-marker','participation-evidence','availability','source-row-absent',
    'team-alias','game-bridge','player-bridge','game-relation']::text[]),
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
  CHECK (kind = 'source-row-absent' OR kind = split_part(entity_key, ':', 1)),
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

-- The one exception is a DELETE inside a transaction holding a retention
-- authorization, which only predictive_retention_execute() can create.
CREATE FUNCTION public.predictive_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.predictive_retention_authorizations a WHERE a.txid = pg_catalog.pg_current_xact_id()) THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'predictive-append-only' USING ERRCODE = '23514';
END
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

-- absence-v1, mirroring validateAbsences() in code: the prior row is the
-- absence's predecessor with identical routing; a complete, full capture of the
-- same profile and filter covers the prior row's scope and lacks the row; and
-- times run prior capture <= covering capture <= absence capture.
CREATE FUNCTION public.predictive_absence_valid(absence_id text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE a public.predictive_observations; p public.predictive_observations; cov public.predictive_captures;
  ca public.predictive_artifacts; pa public.predictive_artifacts; pc public.predictive_captures; ac public.predictive_captures; field text;
BEGIN
  SELECT * INTO a FROM public.predictive_observations WHERE id = absence_id;
  SELECT * INTO p FROM public.predictive_observations WHERE id = a.predecessor_id;
  IF p.id IS NULL OR p.id <> a.data->>'priorObservationId' OR p.kind = 'source-row-absent' OR p.entity_key <> a.data->>'priorEntityKey' THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['gameId','playerId','teamId','season','seasonType'] LOOP
    IF (p.data ? field) <> (a.data ? field) OR (p.data->field) IS DISTINCT FROM (a.data->field) THEN RETURN false; END IF;
  END LOOP;
  SELECT c.* INTO cov FROM public.predictive_captures c JOIN public.predictive_ingestion_runs r ON r.id = c.run_id
    WHERE c.id = a.data->>'coveringCaptureId' AND c.state = 'published' AND r.status = 'published'
      AND c.body_complete AND c.header_verified AND c.parser_succeeded;
  IF cov.id IS NULL THEN RETURN false; END IF;
  SELECT * INTO ca FROM public.predictive_artifacts WHERE id = cov.artifact_id;
  IF ca.profile_id <> a.profile_id OR ca.scope_kind <> a.data->>'scopeKind' OR ca.scope_season IS DISTINCT FROM (a.data->>'scopeSeason')::integer
    OR ca.scope_week IS DISTINCT FROM (a.data->>'scopeWeek')::integer OR ca.scope_filter IS DISTINCT FROM a.data->>'scopeFilter' THEN RETURN false; END IF;
  SELECT c.* INTO pc FROM public.predictive_artifact_observations l JOIN public.predictive_captures c ON c.artifact_id = l.artifact_id
    JOIN public.predictive_ingestion_runs r ON r.id = c.run_id
    WHERE l.observation_id = p.id AND c.state = 'published' AND r.status = 'published'
    ORDER BY c.ingested_at, c.available_at, c.captured_at, c.id COLLATE "C" LIMIT 1;
  SELECT * INTO pa FROM public.predictive_artifacts WHERE id = pc.artifact_id;
  IF NOT (ca.retrieval_kind = 'full' AND ca.profile_id = pa.profile_id AND ca.scope_filter IS NOT DISTINCT FROM pa.scope_filter
      AND ca.scope_kind <> 'manual' AND pa.scope_kind <> 'manual' AND (
        ca.scope_kind = 'all-seasons'
        OR (ca.scope_kind = 'season-file' AND ca.scope_season IS NOT DISTINCT FROM pa.scope_season AND pa.scope_kind IN ('season-file','week-file','game'))
        OR (ca.scope_kind = 'week-file' AND pa.scope_kind IN ('week-file','game') AND ca.scope_season IS NOT DISTINCT FROM pa.scope_season
          AND ca.scope_week IS NOT DISTINCT FROM pa.scope_week)
        OR (ca.scope_kind = 'game' AND pa.scope_kind = 'game' AND ca.scope_season IS NOT DISTINCT FROM pa.scope_season))) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.predictive_artifact_observations l JOIN public.predictive_observations o ON o.id = l.observation_id
      WHERE l.artifact_id = ca.id AND o.source_key = a.source_key) THEN RETURN false; END IF;
  SELECT c.* INTO ac FROM public.predictive_artifact_observations l JOIN public.predictive_captures c ON c.artifact_id = l.artifact_id
    WHERE l.observation_id = a.id AND c.state = 'published' ORDER BY c.ingested_at, c.available_at, c.captured_at, c.id COLLATE "C" LIMIT 1;
  RETURN cov.available_at >= pc.available_at AND cov.ingested_at >= pc.ingested_at
    AND ac.available_at >= cov.available_at AND ac.ingested_at >= cov.ingested_at;
END
$$;

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
  -- bridge-v1 (validateBridges in code): within one source, a provider's player
  -- or game maps from one raw ID at a time; team aliases may be many-to-one.
  IF EXISTS (SELECT 1 FROM public.predictive_observations o JOIN public.predictive_observations h
      ON h.kind = o.kind AND h.profile_id = o.profile_id AND h.id <> o.id AND h.entity_key <> o.entity_key AND h.data->>'provider' = o.data->>'provider'
      WHERE o.id = ANY(affected) AND o.kind IN ('player-bridge','game-bridge')
        AND NOT EXISTS (SELECT 1 FROM public.predictive_observations n WHERE n.predecessor_id = h.id)
        AND NOT EXISTS (SELECT 1 FROM public.predictive_observations n WHERE n.predecessor_id = o.id)
        AND ((o.kind = 'game-bridge' AND h.data->>'gameId' = o.data->>'gameId')
          OR (o.kind = 'player-bridge' AND h.data->>'playerId' = o.data->>'playerId'
            AND h.data->>'effectiveFrom' < o.data->>'effectiveTo' AND o.data->>'effectiveFrom' < h.data->>'effectiveTo'))) THEN
    RAISE EXCEPTION 'predictive-bridge-ambiguous' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.predictive_observations o WHERE o.id = ANY(affected) AND o.kind = 'source-row-absent'
      AND NOT public.predictive_absence_valid(o.id)) THEN
    RAISE EXCEPTION 'predictive-absence-invalid' USING ERRCODE = '23514';
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

-- Cross-source decisions. A decision never edits a provider's revision; it
-- selects among provider heads for one fact, or records a conflict. Inputs must
-- have been usable by decided_at. Mirrors validateDecisions() in code.
CREATE FUNCTION public.predictive_decision_valid(kind text, outcome jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  IF jsonb_typeof(outcome) <> 'object' THEN RETURN false; END IF;
  IF kind = 'participation' THEN
    RETURN (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(outcome) key) = ARRAY['state']
      AND (outcome->>'state' IN ('offensive-participant','zero-offensive-participation','inactive-or-dnp','unresolved','conflicting')) IS TRUE;
  END IF;
  IF kind = 'completion' THEN
    RETURN (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(outcome) key) = ARRAY['actualEnd','completionObservedAt','state']
      AND (outcome->>'state' IN ('scheduled','in-progress','completed','suspended','postponed','conflicting')) IS TRUE
      AND outcome->'actualEnd' = 'null'::jsonb
      AND CASE WHEN outcome->>'state' = 'completed' THEN public.predictive_instant(outcome->>'completionObservedAt')
        ELSE outcome->'completionObservedAt' = 'null'::jsonb END;
  END IF;
  IF kind <> 'reconciliation' OR
    (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(outcome) key) IS DISTINCT FROM ARRAY['result','rule','selectedObservationId']
    THEN RETURN false; END IF;
  RETURN (outcome->>'result' IN ('selected','conflict','insufficient-sources')) IS TRUE
    AND (outcome->>'rule' IN ('single-source','sources-agree','material-discrepancy','no-candidates')) IS TRUE
    AND CASE WHEN outcome->>'result' = 'selected' THEN public.predictive_text(outcome->'selectedObservationId')
      ELSE outcome->'selectedObservationId' = 'null'::jsonb END;
EXCEPTION WHEN OTHERS THEN RETURN false;
END
$$;

CREATE TABLE public.predictive_decisions (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  kind text NOT NULL CHECK (kind IN ('reconciliation','completion','participation','snap-source-compatibility')),
  entity_key text NOT NULL CHECK (length(entity_key) BETWEEN 1 AND 300),
  policy_id text NOT NULL CHECK (policy_id ~ '^[a-z0-9-]+-v[0-9]+$'),
  mode text NOT NULL CHECK (mode IN ('production-research','synthetic-proof')),
  outcome jsonb NOT NULL,
  run_id text NOT NULL REFERENCES public.predictive_ingestion_runs(id),
  decided_at timestamptz NOT NULL CHECK (isfinite(decided_at) AND decided_at = date_trunc('milliseconds', decided_at)),
  predecessor_id text,
  CHECK (public.predictive_decision_valid(kind, outcome) IS TRUE),
  CHECK (kind <> 'reconciliation' OR (policy_id = 'reconciliation-v1' AND entity_key LIKE 'reconciliation:%')),
  CHECK (kind <> 'participation' OR (policy_id = 'participation-v1'
    AND entity_key ~ '^participation:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}:00-[0-9]{7}$')),
  CHECK (kind <> 'completion' OR (policy_id = 'event-completion-v1' AND entity_key ~ '^completion:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')),
  CHECK (predecessor_id IS DISTINCT FROM id),
  UNIQUE (id, kind, entity_key, policy_id),
  FOREIGN KEY (predecessor_id, kind, entity_key, policy_id)
    REFERENCES public.predictive_decisions(id, kind, entity_key, policy_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX predictive_decisions_one_successor ON public.predictive_decisions (predecessor_id) WHERE predecessor_id IS NOT NULL;
CREATE INDEX predictive_decisions_entity_idx ON public.predictive_decisions (kind, entity_key, policy_id, decided_at);

CREATE TABLE public.predictive_decision_inputs (
  decision_id text NOT NULL REFERENCES public.predictive_decisions(id),
  observation_id text NOT NULL REFERENCES public.predictive_observations(id),
  role text NOT NULL CHECK (role IN ('candidate','selected','marker','evidence')),
  PRIMARY KEY (decision_id, observation_id)
);
CREATE INDEX predictive_decision_inputs_reverse_idx ON public.predictive_decision_inputs (observation_id, decision_id);

CREATE TRIGGER predictive_decisions_immutable BEFORE UPDATE OR DELETE ON public.predictive_decisions FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_decision_inputs_immutable BEFORE UPDATE OR DELETE ON public.predictive_decision_inputs FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_decisions_no_truncate BEFORE TRUNCATE ON public.predictive_decisions FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_decision_inputs_no_truncate BEFORE TRUNCATE ON public.predictive_decision_inputs FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();

-- Whether a decision's inputs are exactly the heads of its evidence scope usable
-- at instant t: marker facts (completion), participation evidence plus stats
-- (participation), or the one fact (reconciliation). Mirrors labels.ts current().
CREATE FUNCTION public.predictive_decision_current(decision_id text, t timestamptz) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE d public.predictive_decisions; prefix text; exact_key text; heads text[]; inputs text[];
BEGIN
  SELECT * INTO d FROM public.predictive_decisions WHERE id = decision_id;
  IF d.id IS NULL OR d.decided_at > t THEN RETURN false; END IF;
  IF d.kind = 'completion' THEN prefix := 'event-state-marker:' || split_part(d.entity_key, ':', 2) || ':';
  ELSIF d.kind = 'participation' THEN
    prefix := 'participation-evidence:' || split_part(d.entity_key, ':', 2) || ':' || split_part(d.entity_key, ':', 3) || ':';
    exact_key := 'player-game-stats:' || split_part(d.entity_key, ':', 2) || ':' || split_part(d.entity_key, ':', 3);
  ELSE exact_key := substr(d.entity_key, length('reconciliation:') + 1); END IF;
  WITH visible AS (SELECT o.id, o.predecessor_id FROM public.predictive_observations o
    WHERE ((prefix IS NOT NULL AND o.entity_key LIKE prefix || '%') OR o.entity_key = exact_key) AND EXISTS (
      SELECT 1 FROM public.predictive_artifact_observations l JOIN public.predictive_captures c ON c.artifact_id = l.artifact_id
      JOIN public.predictive_ingestion_runs ru ON ru.id = c.run_id WHERE l.observation_id = o.id AND c.state = 'published' AND ru.status = 'published'
        AND c.available_at <= t AND c.ingested_at <= t))
  SELECT array_agg(v.id ORDER BY v.id COLLATE "C") INTO heads FROM visible v WHERE NOT EXISTS (SELECT 1 FROM visible n WHERE n.predecessor_id = v.id);
  SELECT array_agg(i.observation_id ORDER BY i.observation_id COLLATE "C") INTO inputs FROM public.predictive_decision_inputs i WHERE i.decision_id = d.id;
  RETURN heads IS NOT DISTINCT FROM inputs;
END
$$;

CREATE FUNCTION public.predictive_decision_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text; d public.predictive_decisions; fact text; game text;
  inputs integer; sources integer; selected integer; selected_id text; same boolean; synthetic boolean; consistent boolean;
  head_ids text[]; input_ids text[]; r record; absent boolean := false;
  final_n integer := 0; terminal_n integer := 0; totals_n integer := 0; suspended_n integer := 0; postponed_n integer := 0;
  final_at timestamptz; terminal_at timestamptz; totals_at timestamptz; state text; observed timestamptz;
  conflict boolean := false; claims text[] := '{}'; stats_n integer := 0; positive_n integer := 0;
BEGIN
  IF TG_TABLE_NAME = 'predictive_decisions' THEN target := NEW.id; ELSE target := NEW.decision_id; END IF;
  SELECT * INTO d FROM public.predictive_decisions WHERE id = target;
  IF (SELECT status FROM public.predictive_ingestion_runs WHERE id = d.run_id) <> 'published'
      OR (d.predecessor_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.predictive_decisions p WHERE p.id = d.predecessor_id AND p.decided_at > d.decided_at)) THEN
    RAISE EXCEPTION 'predictive-decision-invalid' USING ERRCODE = '23514';
  END IF;
  SELECT count(*), coalesce(bool_or(p.purpose = 'synthetic-test'), false) INTO inputs, synthetic
    FROM public.predictive_decision_inputs i JOIN public.predictive_observations o ON o.id = i.observation_id
    JOIN public.predictive_source_profiles p ON p.id = o.profile_id WHERE i.decision_id = target;
  IF (inputs > 0 AND synthetic <> (d.mode = 'synthetic-proof')) OR (d.mode = 'synthetic-proof' AND NOT public.predictive_harness_session()) THEN
    RAISE EXCEPTION 'predictive-decision-mode-invalid' USING ERRCODE = '23514';
  END IF;
  IF d.kind = 'completion' THEN
    -- event-completion-v1 (completion.ts): the inputs are exactly the marker heads
    -- usable at decided_at, and the stated outcome is what the policy computes.
    SELECT array_agg(i.observation_id ORDER BY i.observation_id COLLATE "C") INTO input_ids
      FROM public.predictive_decision_inputs i WHERE i.decision_id = target AND i.role = 'marker';
    IF NOT public.predictive_decision_current(target, d.decided_at) OR inputs <> coalesce(cardinality(input_ids), 0) THEN
      RAISE EXCEPTION 'predictive-completion-inputs-invalid' USING ERRCODE = '23514';
    END IF;
    FOR r IN SELECT o.kind, split_part(o.entity_key, ':', 3) AS marker,
        (SELECT c.captured_at FROM public.predictive_artifact_observations l JOIN public.predictive_captures c ON c.artifact_id = l.artifact_id
          WHERE l.observation_id = o.id AND c.state = 'published' ORDER BY c.ingested_at, c.available_at, c.captured_at, c.id COLLATE "C" LIMIT 1) AS captured
      FROM public.predictive_observations o WHERE o.id = ANY(coalesce(input_ids, '{}')) LOOP
      IF r.kind = 'source-row-absent' THEN absent := true; END IF;
      IF r.marker = 'provider-final-status' THEN final_n := final_n + 1; final_at := r.captured;
      ELSIF r.marker = 'terminal-play' THEN terminal_n := terminal_n + 1; terminal_at := r.captured;
      ELSIF r.marker = 'final-team-totals' THEN totals_n := totals_n + 1; totals_at := r.captured;
      ELSIF r.marker = 'suspension-notice' THEN suspended_n := suspended_n + 1;
      ELSIF r.marker = 'postponement-notice' THEN postponed_n := postponed_n + 1; END IF;
    END LOOP;
    IF absent OR greatest(final_n, terminal_n, totals_n, suspended_n, postponed_n) > 1
        OR ((suspended_n > 0 OR postponed_n > 0) AND (final_n + terminal_n + totals_n) > 0) OR (suspended_n > 0 AND postponed_n > 0) THEN state := 'conflicting';
    ELSIF suspended_n > 0 THEN state := 'suspended';
    ELSIF postponed_n > 0 THEN state := 'postponed';
    ELSIF final_n > 0 AND (terminal_n + totals_n) > 0 THEN state := 'completed'; observed := greatest(final_at, least(terminal_at, totals_at));
    ELSIF (final_n + terminal_n + totals_n) > 0 THEN state := 'in-progress';
    ELSE state := 'scheduled'; END IF;
    IF state <> d.outcome->>'state' OR (CASE WHEN observed IS NULL THEN NULL
        ELSE to_char(observed AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END) IS DISTINCT FROM d.outcome->>'completionObservedAt' THEN
      RAISE EXCEPTION 'predictive-decision-rule-invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;
  IF d.kind = 'participation' THEN
    -- participation-v1 (participation.ts): the inputs are exactly the evidence and
    -- stats heads usable at decided_at; the state is recomputed from them.
    SELECT array_agg(i.observation_id ORDER BY i.observation_id COLLATE "C") INTO input_ids
      FROM public.predictive_decision_inputs i WHERE i.decision_id = target AND i.role = 'evidence';
    IF NOT public.predictive_decision_current(target, d.decided_at) OR inputs <> coalesce(cardinality(input_ids), 0) THEN
      RAISE EXCEPTION 'predictive-participation-inputs-invalid' USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(bool_or(n > 1 OR gone), false) INTO conflict FROM (SELECT split_part(o.entity_key, ':', 4) AS evidence, count(*) AS n,
        bool_or(o.kind = 'source-row-absent') AS gone FROM public.predictive_observations o
      WHERE o.id = ANY(coalesce(input_ids, '{}')) AND o.entity_key LIKE 'participation-evidence:%' GROUP BY 1) grouped;
    SELECT coalesce(array_agg(DISTINCT o.data->>'claim'), '{}') INTO claims FROM public.predictive_observations o
      WHERE o.id = ANY(coalesce(input_ids, '{}')) AND o.kind = 'participation-evidence';
    SELECT count(*), count(*) FILTER (WHERE o.kind = 'player-game-stats' AND (coalesce((o.data->>'attempts')::integer, 0) > 0
        OR coalesce((o.data->>'carries')::integer, 0) > 0 OR coalesce((o.data->>'targets')::integer, 0) > 0))
      INTO stats_n, positive_n FROM public.predictive_observations o WHERE o.id = ANY(coalesce(input_ids, '{}')) AND o.entity_key LIKE 'player-game-stats:%';
    IF stats_n > 0 AND positive_n = stats_n AND NOT 'offensive-participant' = ANY(claims) THEN claims := array_append(claims, 'offensive-participant'); END IF;
    state := CASE WHEN conflict OR cardinality(claims) > 1 THEN 'conflicting' WHEN cardinality(claims) = 1 THEN claims[1] ELSE 'unresolved' END;
    IF state <> d.outcome->>'state' THEN RAISE EXCEPTION 'predictive-decision-rule-invalid' USING ERRCODE = '23514'; END IF;
    RETURN NULL;
  END IF;
  IF d.kind <> 'reconciliation' THEN RAISE EXCEPTION 'predictive-decision-invalid' USING ERRCODE = '23514'; END IF;
  fact := substr(d.entity_key, length('reconciliation:') + 1);
  SELECT count(DISTINCT o.source_key), count(*) FILTER (WHERE i.role = 'selected'),
    min(i.observation_id) FILTER (WHERE i.role = 'selected'), count(DISTINCT o.data) <= 1
    INTO sources, selected, selected_id, same
    FROM public.predictive_decision_inputs i JOIN public.predictive_observations o ON o.id = i.observation_id WHERE i.decision_id = target;
  IF sources <> inputs OR EXISTS (SELECT 1 FROM public.predictive_decision_inputs i JOIN public.predictive_observations o ON o.id = i.observation_id
      WHERE i.decision_id = target AND (i.role NOT IN ('candidate','selected') OR o.entity_key <> fact OR NOT EXISTS (
        SELECT 1 FROM public.predictive_artifact_observations l JOIN public.predictive_captures c ON c.artifact_id = l.artifact_id
        JOIN public.predictive_ingestion_runs ru ON ru.id = c.run_id
        WHERE l.observation_id = o.id AND c.state = 'published' AND ru.status = 'published'
          AND c.available_at <= d.decided_at AND c.ingested_at <= d.decided_at))) THEN
    RAISE EXCEPTION 'predictive-decision-invalid' USING ERRCODE = '23514';
  END IF;
  IF NOT public.predictive_decision_current(target, d.decided_at) THEN
    RAISE EXCEPTION 'predictive-reconciliation-inputs-not-heads' USING ERRCODE = '23514';
  END IF;
  consistent := CASE d.outcome->>'result'
      WHEN 'selected' THEN selected = 1 AND selected_id = d.outcome->>'selectedObservationId'
        AND ((d.outcome->>'rule' = 'single-source' AND inputs = 1) OR (d.outcome->>'rule' = 'sources-agree' AND inputs > 1 AND same))
      WHEN 'conflict' THEN selected = 0 AND d.outcome->>'rule' = 'material-discrepancy' AND inputs > 1 AND NOT same
      ELSE inputs = 0 AND d.outcome->>'rule' = 'no-candidates' END;
  IF consistent IS NOT TRUE THEN
    RAISE EXCEPTION 'predictive-decision-rule-invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER predictive_check_decisions AFTER INSERT ON public.predictive_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.predictive_decision_check();
CREATE CONSTRAINT TRIGGER predictive_check_decision_inputs AFTER INSERT ON public.predictive_decision_inputs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.predictive_decision_check();

-- canonical-label-finalization-v1 (labels.ts eligibleFinalAt): the later of the
-- completion bound + 72 hours and the first Thursday 12:00 UTC strictly after it.
CREATE FUNCTION public.predictive_label_eligible_final_at(bound timestamptz) RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE naive timestamp := bound AT TIME ZONE 'UTC'; thursday timestamp;
BEGIN
  thursday := date_trunc('day', naive) + interval '12 hours';
  thursday := thursday + ((4 - extract(dow FROM thursday)::integer + 7) % 7) * interval '1 day';
  IF thursday <= naive THEN thursday := thursday + interval '7 days'; END IF;
  RETURN greatest(bound + interval '72 hours', thursday AT TIME ZONE 'UTC');
END
$$;

CREATE TABLE public.predictive_outcome_labels (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  player_id text NOT NULL CHECK (player_id ~ '^00-[0-9]{7}$'),
  game_id uuid NOT NULL REFERENCES public.predictive_games(id),
  season_type text NOT NULL CHECK (season_type IN ('REG','POST')),
  stat text NOT NULL CHECK (stat IN ('passing_yards','passing_tds','completions','attempts','passing_interceptions',
    'rushing_yards','carries','receiving_yards','receptions')),
  value integer,
  state text NOT NULL CHECK (state IN ('provisional','final','unresolved','excluded')),
  mode text NOT NULL CHECK (mode IN ('production-research','synthetic-proof')),
  policy_id text NOT NULL CHECK (policy_id = 'canonical-label-finalization-v1'),
  label_version integer NOT NULL CHECK (label_version >= 1),
  predecessor_id text REFERENCES public.predictive_outcome_labels(id) DEFERRABLE INITIALLY DEFERRED,
  run_id text NOT NULL REFERENCES public.predictive_ingestion_runs(id),
  completion_decision_id text NOT NULL REFERENCES public.predictive_decisions(id),
  participation_decision_id text NOT NULL REFERENCES public.predictive_decisions(id),
  reconciliation_decision_id text REFERENCES public.predictive_decisions(id),
  selected_observation_id text REFERENCES public.predictive_observations(id),
  eligible_final_at timestamptz CHECK (isfinite(eligible_final_at)),
  post_window_capture_id text REFERENCES public.predictive_captures(id),
  finalized_at timestamptz CHECK (isfinite(finalized_at) AND finalized_at = date_trunc('milliseconds', finalized_at)),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at = date_trunc('milliseconds', created_at)),
  UNIQUE (player_id, game_id, season_type, stat, label_version),
  CHECK ((label_version = 1) = (predecessor_id IS NULL)),
  CHECK (predecessor_id IS DISTINCT FROM id),
  CHECK (state NOT IN ('unresolved','excluded') OR (value IS NULL AND selected_observation_id IS NULL)),
  CHECK (value IS NULL OR stat IN ('passing_yards','rushing_yards','receiving_yards') OR value >= 0)
);
CREATE UNIQUE INDEX predictive_outcome_labels_one_successor ON public.predictive_outcome_labels (predecessor_id) WHERE predecessor_id IS NOT NULL;
CREATE INDEX predictive_outcome_labels_game_idx ON public.predictive_outcome_labels (game_id, player_id, stat);
CREATE TRIGGER predictive_labels_immutable BEFORE UPDATE OR DELETE ON public.predictive_outcome_labels FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_labels_no_truncate BEFORE TRUNCATE ON public.predictive_outcome_labels FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();

-- The eight binding checks, mirroring validateLabels() in labels.ts. Each
-- failure names its check: predictive-label-binding-<n>.
CREATE FUNCTION public.predictive_label_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l public.predictive_outcome_labels; c public.predictive_decisions; p public.predictive_decisions; r public.predictive_decisions;
  s public.predictive_observations; cap public.predictive_captures; prior public.predictive_outcome_labels; field text; eligible timestamptz; synthetic boolean;
BEGIN
  SELECT * INTO l FROM public.predictive_outcome_labels WHERE id = NEW.id;
  IF (SELECT status FROM public.predictive_ingestion_runs WHERE id = l.run_id) <> 'published' THEN
    RAISE EXCEPTION 'predictive-label-binding-6' USING ERRCODE = '23514';
  END IF;
  field := CASE l.stat WHEN 'passing_yards' THEN 'passingYards' WHEN 'passing_tds' THEN 'passingTds' WHEN 'completions' THEN 'completions'
    WHEN 'attempts' THEN 'attempts' WHEN 'passing_interceptions' THEN 'passingInterceptions' WHEN 'rushing_yards' THEN 'rushingYards'
    WHEN 'carries' THEN 'carries' WHEN 'receiving_yards' THEN 'receivingYards' ELSE 'receptions' END;
  SELECT * INTO c FROM public.predictive_decisions WHERE id = l.completion_decision_id;
  SELECT * INTO p FROM public.predictive_decisions WHERE id = l.participation_decision_id;
  SELECT * INTO r FROM public.predictive_decisions WHERE id = l.reconciliation_decision_id;
  IF c.kind <> 'completion' OR c.entity_key <> 'completion:' || l.game_id OR NOT public.predictive_decision_current(c.id, l.created_at) THEN
    RAISE EXCEPTION 'predictive-label-binding-1' USING ERRCODE = '23514';
  END IF;
  IF p.kind <> 'participation' OR p.entity_key <> 'participation:' || l.game_id || ':' || l.player_id OR NOT public.predictive_decision_current(p.id, l.created_at) THEN
    RAISE EXCEPTION 'predictive-label-binding-2' USING ERRCODE = '23514';
  END IF;
  IF l.state IN ('provisional','final') THEN
    IF c.outcome->>'state' <> 'completed' OR p.outcome->>'state' <> 'offensive-participant' THEN
      RAISE EXCEPTION 'predictive-label-binding-2' USING ERRCODE = '23514';
    END IF;
    IF r.id IS NULL OR r.kind <> 'reconciliation' OR r.entity_key <> 'reconciliation:player-game-stats:' || l.game_id || ':' || l.player_id
        OR r.outcome->>'result' <> 'selected' OR r.outcome->>'selectedObservationId' IS DISTINCT FROM l.selected_observation_id
        OR NOT public.predictive_decision_current(r.id, l.created_at) THEN
      RAISE EXCEPTION 'predictive-label-binding-3' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO s FROM public.predictive_observations WHERE id = l.selected_observation_id;
    IF s.kind <> 'player-game-stats' OR s.data->>'seasonType' <> l.season_type OR s.data->field = 'null'::jsonb
        OR (s.data->>field)::integer IS DISTINCT FROM l.value OR NOT EXISTS (
          SELECT 1 FROM public.predictive_artifact_observations la JOIN public.predictive_captures ca ON ca.artifact_id = la.artifact_id
          JOIN public.predictive_ingestion_runs ru ON ru.id = ca.run_id WHERE la.observation_id = s.id AND ca.state = 'published' AND ru.status = 'published'
            AND ca.available_at <= l.created_at AND ca.ingested_at <= l.created_at) THEN
      RAISE EXCEPTION 'predictive-label-binding-4' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF l.value IS NOT NULL OR l.selected_observation_id IS NOT NULL THEN RAISE EXCEPTION 'predictive-label-binding-4' USING ERRCODE = '23514'; END IF;
    IF l.state = 'excluded' AND (c.outcome->>'state' <> 'completed' OR p.outcome->>'state' NOT IN ('zero-offensive-participation','inactive-or-dnp')) THEN
      RAISE EXCEPTION 'predictive-label-binding-2' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF l.state = 'final' THEN
    eligible := public.predictive_label_eligible_final_at((c.outcome->>'completionObservedAt')::timestamptz);
    SELECT * INTO cap FROM public.predictive_captures WHERE id = l.post_window_capture_id;
    IF l.eligible_final_at IS DISTINCT FROM eligible OR l.finalized_at IS NULL OR l.finalized_at < eligible OR l.created_at < l.finalized_at
        OR cap.id IS NULL OR cap.state <> 'published' OR NOT (cap.body_complete AND cap.header_verified AND cap.parser_succeeded)
        OR cap.captured_at < eligible OR NOT EXISTS (SELECT 1 FROM public.predictive_artifact_observations la
          WHERE la.artifact_id = cap.artifact_id AND la.observation_id = l.selected_observation_id) THEN
      RAISE EXCEPTION 'predictive-label-binding-5' USING ERRCODE = '23514';
    END IF;
    IF cap.ingested_at > l.created_at THEN RAISE EXCEPTION 'predictive-label-binding-6' USING ERRCODE = '23514'; END IF;
  ELSIF l.post_window_capture_id IS NOT NULL OR l.finalized_at IS NOT NULL OR l.eligible_final_at IS NOT NULL THEN
    RAISE EXCEPTION 'predictive-label-binding-5' USING ERRCODE = '23514';
  END IF;
  IF l.predecessor_id IS NOT NULL THEN
    SELECT * INTO prior FROM public.predictive_outcome_labels WHERE id = l.predecessor_id;
    IF prior.player_id <> l.player_id OR prior.game_id <> l.game_id OR prior.season_type <> l.season_type OR prior.stat <> l.stat
        OR prior.label_version + 1 <> l.label_version OR prior.created_at >= l.created_at THEN
      RAISE EXCEPTION 'predictive-label-binding-7' USING ERRCODE = '23514';
    END IF;
  END IF;
  synthetic := c.mode = 'synthetic-proof' OR p.mode = 'synthetic-proof' OR coalesce(r.mode = 'synthetic-proof', false) OR EXISTS (
    SELECT 1 FROM public.predictive_observations o JOIN public.predictive_source_profiles sp ON sp.id = o.profile_id
    WHERE o.id = l.selected_observation_id AND sp.purpose = 'synthetic-test');
  IF synthetic <> (l.mode = 'synthetic-proof') OR (l.mode = 'synthetic-proof' AND NOT public.predictive_harness_session()) THEN
    RAISE EXCEPTION 'predictive-label-binding-8' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER predictive_check_labels AFTER INSERT ON public.predictive_outcome_labels DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.predictive_label_check();

-- Saved feature runs (feature-run-retention-v1). A run is computed in a
-- read-only snapshot and recorded separately, with its full bundle as a blob and
-- an exact dependency manifest. input_digest covers cutoff-time inputs only;
-- execution_digest also covers rights, policies, code and timing.
CREATE TABLE public.predictive_feature_runs (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  mode text NOT NULL CHECK (mode IN ('production-research','synthetic-proof')),
  feature_version text NOT NULL CHECK (length(feature_version) BETWEEN 1 AND 64),
  candidate text NOT NULL CHECK (length(candidate) BETWEEN 1 AND 128),
  player_id text NOT NULL CHECK (player_id ~ '^00-[0-9]{7}$'),
  game_id uuid NOT NULL REFERENCES public.predictive_games(id),
  cutoff timestamptz NOT NULL CHECK (isfinite(cutoff) AND cutoff = date_trunc('milliseconds', cutoff)),
  computed_at timestamptz NOT NULL CHECK (isfinite(computed_at) AND computed_at = date_trunc('milliseconds', computed_at) AND computed_at >= cutoff),
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at = date_trunc('milliseconds', recorded_at) AND recorded_at >= computed_at),
  code_version text NOT NULL CHECK (length(code_version) BETWEEN 1 AND 64),
  status text NOT NULL CHECK (status IN ('ready-inputs','unavailable-inputs')),
  reasons text[] NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  execution_digest text NOT NULL CHECK (execution_digest ~ '^[a-f0-9]{64}$'),
  bundle_blob_sha256 text NOT NULL REFERENCES public.predictive_blobs(sha256),
  CHECK ((status = 'ready-inputs') = (cardinality(reasons) = 0))
);
CREATE INDEX predictive_feature_runs_recorded_idx ON public.predictive_feature_runs (recorded_at);

CREATE TABLE public.predictive_feature_run_dependencies (
  feature_run_id text NOT NULL REFERENCES public.predictive_feature_runs(id),
  observation_id text REFERENCES public.predictive_observations(id),
  decision_id text REFERENCES public.predictive_decisions(id),
  rights_decision_id text REFERENCES public.predictive_rights_decisions(id),
  policy_id text CHECK (policy_id ~ '^[a-z0-9-]+-v[0-9]+$'),
  feature_definition_id text CHECK (length(feature_definition_id) BETWEEN 1 AND 64),
  CHECK (num_nonnulls(observation_id, decision_id, rights_decision_id, policy_id, feature_definition_id) = 1)
);
CREATE UNIQUE INDEX predictive_feature_run_dependencies_unique ON public.predictive_feature_run_dependencies
  (feature_run_id, coalesce(observation_id, decision_id, rights_decision_id, policy_id, feature_definition_id));

CREATE TABLE public.predictive_feature_run_pins (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  feature_run_id text NOT NULL REFERENCES public.predictive_feature_runs(id),
  reason text NOT NULL CHECK (reason IN ('training','serving','evaluation','owner')),
  pinned_at timestamptz NOT NULL CHECK (isfinite(pinned_at) AND pinned_at = date_trunc('milliseconds', pinned_at))
);
-- Unpinning is its own append-only event; a pin row is never updated.
CREATE TABLE public.predictive_feature_run_unpins (
  pin_id text PRIMARY KEY REFERENCES public.predictive_feature_run_pins(id),
  unpinned_at timestamptz NOT NULL CHECK (isfinite(unpinned_at) AND unpinned_at = date_trunc('milliseconds', unpinned_at))
);

CREATE TRIGGER predictive_feature_runs_immutable BEFORE UPDATE OR DELETE ON public.predictive_feature_runs FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_feature_run_dependencies_immutable BEFORE UPDATE OR DELETE ON public.predictive_feature_run_dependencies FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_feature_run_pins_immutable BEFORE UPDATE OR DELETE ON public.predictive_feature_run_pins FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_feature_run_unpins_immutable BEFORE UPDATE OR DELETE ON public.predictive_feature_run_unpins FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_feature_runs_no_truncate BEFORE TRUNCATE ON public.predictive_feature_runs FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_feature_run_dependencies_no_truncate BEFORE TRUNCATE ON public.predictive_feature_run_dependencies FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_feature_run_pins_no_truncate BEFORE TRUNCATE ON public.predictive_feature_run_pins FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_feature_run_unpins_no_truncate BEFORE TRUNCATE ON public.predictive_feature_run_unpins FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();

CREATE FUNCTION public.predictive_unpin_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.unpinned_at < (SELECT pinned_at FROM public.predictive_feature_run_pins WHERE id = NEW.pin_id) THEN
    RAISE EXCEPTION 'predictive-unpin-before-pin' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER predictive_unpin_validate BEFORE INSERT ON public.predictive_feature_run_unpins FOR EACH ROW EXECUTE FUNCTION public.predictive_unpin_check();

-- Every dependency was usable at the cutoff; every decision's inputs are listed;
-- a ready run had model-input rights in force when recorded for every evidence
-- profile; the feature definition is named; the mode follows the evidence.
CREATE FUNCTION public.predictive_feature_run_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text; f public.predictive_feature_runs; synthetic boolean;
BEGIN
  IF TG_TABLE_NAME = 'predictive_feature_runs' THEN target := NEW.id; ELSE target := NEW.feature_run_id; END IF;
  SELECT * INTO f FROM public.predictive_feature_runs WHERE id = target;
  IF EXISTS (SELECT 1 FROM public.predictive_feature_run_dependencies d WHERE d.feature_run_id = target AND d.observation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.predictive_artifact_observations l JOIN public.predictive_captures c ON c.artifact_id = l.artifact_id
      JOIN public.predictive_ingestion_runs ru ON ru.id = c.run_id WHERE l.observation_id = d.observation_id AND c.state = 'published'
        AND ru.status = 'published' AND c.available_at <= f.cutoff AND c.ingested_at <= f.cutoff)) THEN
    RAISE EXCEPTION 'predictive-feature-run-dependency-after-cutoff' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.predictive_feature_run_dependencies d JOIN public.predictive_decisions dc ON dc.id = d.decision_id
      WHERE d.feature_run_id = target AND dc.decided_at > f.cutoff) THEN
    RAISE EXCEPTION 'predictive-feature-run-dependency-after-cutoff' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.predictive_feature_run_dependencies d JOIN public.predictive_decision_inputs i ON i.decision_id = d.decision_id
      WHERE d.feature_run_id = target AND NOT EXISTS (SELECT 1 FROM public.predictive_feature_run_dependencies o
        WHERE o.feature_run_id = target AND o.observation_id = i.observation_id)) THEN
    RAISE EXCEPTION 'predictive-feature-run-inputs-incomplete' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.predictive_feature_run_dependencies d WHERE d.feature_run_id = target AND d.feature_definition_id = f.feature_version) THEN
    RAISE EXCEPTION 'predictive-feature-run-definition-missing' USING ERRCODE = '23514';
  END IF;
  IF f.status = 'ready-inputs' AND EXISTS (
      WITH profiles AS (SELECT DISTINCT o.profile_id FROM public.predictive_feature_run_dependencies d
        JOIN public.predictive_observations o ON o.id = d.observation_id WHERE d.feature_run_id = target)
      SELECT 1 FROM profiles pr WHERE NOT EXISTS (SELECT 1 FROM public.predictive_feature_run_dependencies rd WHERE rd.feature_run_id = target
        AND rd.rights_decision_id = public.predictive_rights_in_force(pr.profile_id, f.recorded_at, f.recorded_at)
        AND public.predictive_rights_allow(pr.profile_id, f.recorded_at, f.recorded_at, 'model-input'))) THEN
    RAISE EXCEPTION 'predictive-feature-run-rights-not-in-force' USING ERRCODE = '23514';
  END IF;
  synthetic := EXISTS (SELECT 1 FROM public.predictive_feature_run_dependencies d JOIN public.predictive_observations o ON o.id = d.observation_id
    JOIN public.predictive_source_profiles sp ON sp.id = o.profile_id WHERE d.feature_run_id = target AND sp.purpose = 'synthetic-test');
  IF synthetic <> (f.mode = 'synthetic-proof') OR (f.mode = 'synthetic-proof' AND NOT public.predictive_harness_session()) THEN
    RAISE EXCEPTION 'predictive-feature-run-mode-invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER predictive_check_feature_runs AFTER INSERT ON public.predictive_feature_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.predictive_feature_run_check();
-- A run and its manifest are written in one transaction and then sealed: a
-- dependency for a run created in an earlier transaction is refused, so the
-- single run-level deferred check above covers every dependency.
CREATE FUNCTION public.predictive_feature_run_dependency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.predictive_feature_runs f WHERE f.id = NEW.feature_run_id
      AND f.xmin::text::bigint = pg_catalog.pg_current_xact_id()::text::bigint % 4294967296) THEN
    RAISE EXCEPTION 'predictive-feature-run-sealed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER predictive_feature_run_dependencies_sealed BEFORE INSERT ON public.predictive_feature_run_dependencies FOR EACH ROW EXECUTE FUNCTION public.predictive_feature_run_dependency_guard();

-- feature-run-retention-v1: an unpinned run expires 90 days after recording.
-- A pin keeps it until an unpin event; provider deletions apply regardless.
CREATE FUNCTION public.predictive_feature_run_expired(run_id text, t timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT f.recorded_at + interval '90 days' <= t AND NOT EXISTS (SELECT 1 FROM public.predictive_feature_run_pins p
    WHERE p.feature_run_id = f.id AND p.pinned_at <= t AND NOT EXISTS (SELECT 1 FROM public.predictive_feature_run_unpins u WHERE u.pin_id = p.id AND u.unpinned_at <= t))
  FROM public.predictive_feature_runs f WHERE f.id = run_id
$$;

-- retention-policy-v1. Owner-run scoped deletion, outside the append-only write
-- path. An event row is written once, complete, by predictive_retention_execute;
-- tombstones exist only for audit_level 'full'. Neither is ever changed.
CREATE FUNCTION public.predictive_retention_scope_valid(reason text, scope jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE keys text[];
BEGIN
  IF jsonb_typeof(scope) <> 'object' THEN RETURN false; END IF;
  keys := ARRAY(SELECT k FROM jsonb_object_keys(scope) k ORDER BY k COLLATE "C");
  IF scope->>'kind' = 'feature-run-expiry' THEN
    RETURN reason = 'expiry' AND keys = ARRAY['asOf','kind'] AND jsonb_typeof(scope->'asOf') = 'string' AND public.predictive_instant(scope->>'asOf');
  END IF;
  IF scope->>'kind' <> 'source' OR reason = 'expiry' OR keys <> ARRAY['capturedBefore','capturedFrom','kind','profileIds']
      OR jsonb_typeof(scope->'profileIds') <> 'array' OR jsonb_array_length(scope->'profileIds') NOT BETWEEN 1 AND 64
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(scope->'profileIds') e WHERE jsonb_typeof(e) <> 'string')
      OR ARRAY(SELECT e FROM jsonb_array_elements_text(scope->'profileIds') WITH ORDINALITY x(e, n) ORDER BY n)
        <> ARRAY(SELECT DISTINCT e COLLATE "C" FROM jsonb_array_elements_text(scope->'profileIds') e ORDER BY 1) THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(scope->'capturedFrom') <> 'null' AND NOT (jsonb_typeof(scope->'capturedFrom') = 'string' AND public.predictive_instant(scope->>'capturedFrom')) THEN RETURN false; END IF;
  IF jsonb_typeof(scope->'capturedBefore') <> 'null' AND NOT (jsonb_typeof(scope->'capturedBefore') = 'string' AND public.predictive_instant(scope->>'capturedBefore')) THEN RETURN false; END IF;
  RETURN scope->>'capturedFrom' IS NULL OR scope->>'capturedBefore' IS NULL OR (scope->>'capturedFrom')::timestamptz < (scope->>'capturedBefore')::timestamptz;
EXCEPTION WHEN OTHERS THEN RETURN false;
END
$$;

CREATE TABLE public.predictive_retention_events (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256 AND id !~ '[[:cntrl:]]'),
  reason text NOT NULL CHECK (reason IN ('expiry','rights-revoked','provider-request','owner-request')),
  authority text NOT NULL CHECK (length(authority) BETWEEN 1 AND 256 AND authority !~ '[[:cntrl:]]'),
  decided_at timestamptz NOT NULL CHECK (isfinite(decided_at) AND decided_at = date_trunc('milliseconds', decided_at)),
  -- Deterministic: re-applying it to a restored backup removes the same rows.
  scope_descriptor jsonb NOT NULL CHECK (public.predictive_retention_scope_valid(reason, scope_descriptor) IS TRUE),
  audit_level text NOT NULL CHECK (audit_level IN ('full','digest-only')),
  removed_counts jsonb NOT NULL CHECK (jsonb_typeof(removed_counts) = 'object'),
  removed_ids_digest text NOT NULL CHECK (removed_ids_digest ~ '^[a-f0-9]{64}$'),
  executed_at timestamptz NOT NULL CHECK (isfinite(executed_at) AND executed_at >= decided_at)
);
CREATE TABLE public.predictive_retention_tombstones (
  retention_event_id text NOT NULL REFERENCES public.predictive_retention_events(id),
  target_kind text NOT NULL CHECK (target_kind IN ('observation','artifact','capture','decision','label','feature-run','pin','blob')),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 256),
  PRIMARY KEY (retention_event_id, target_kind, target_id)
);
-- Control state, not evidence: one row per executing transaction, inserted and
-- removed by predictive_retention_execute. No role is granted any privilege.
CREATE TABLE public.predictive_retention_authorizations (
  txid xid8 PRIMARY KEY,
  retention_event_id text NOT NULL
);

CREATE FUNCTION public.predictive_retention_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'predictive-append-only' USING ERRCODE = '23514'; END
$$;
CREATE TRIGGER predictive_retention_events_immutable BEFORE UPDATE OR DELETE ON public.predictive_retention_events FOR EACH ROW EXECUTE FUNCTION public.predictive_retention_audit_immutable();
CREATE TRIGGER predictive_retention_tombstones_immutable BEFORE UPDATE OR DELETE ON public.predictive_retention_tombstones FOR EACH ROW EXECUTE FUNCTION public.predictive_retention_audit_immutable();
CREATE TRIGGER predictive_retention_events_no_truncate BEFORE TRUNCATE ON public.predictive_retention_events FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_retention_audit_immutable();
CREATE TRIGGER predictive_retention_tombstones_no_truncate BEFORE TRUNCATE ON public.predictive_retention_tombstones FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_retention_audit_immutable();

-- Computes the deletion closure and removes it in dependency order:
--   1. observations in scope plus every descendant in their source chains;
--   2. their links, then the artifacts in scope with all their captures;
--   3. decisions with any deleted input, plus their descendants;
--   4. labels citing any deleted decision, observation or capture, plus later versions;
--   5. feature runs depending on any of the above (or expired), with dependencies, pins, unpins;
--   6. blobs no longer referenced by any artifact or feature run.
-- Ordinary foreign keys stay, without CASCADE: an incomplete closure fails the
-- transaction. Blob files are removed by the owner CLI after commit.
CREATE FUNCTION public.predictive_retention_execute(event_id text, event_reason text, event_authority text, event_decided_at timestamptz,
  event_scope jsonb, event_audit_level text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  profiles text[]; captured_from timestamptz; captured_before timestamptz; as_of timestamptz;
  arts text[] := '{}'; caps text[] := '{}'; obs text[] := '{}'; decs text[] := '{}'; labs text[] := '{}';
  runs text[] := '{}'; pins text[] := '{}'; blobs text[] := '{}'; refs text[];
  removed text[]; counts jsonb; ids_digest text; links integer; inputs integer; dependencies integer; unpins integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'predictive_retention_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'predictive-retention-not-authorized' USING ERRCODE = '42501';
  END IF;
  IF event_decided_at IS NULL OR event_decided_at > pg_catalog.now() OR NOT public.predictive_retention_scope_valid(event_reason, event_scope) THEN
    RAISE EXCEPTION 'predictive-retention-invalid' USING ERRCODE = '23514';
  END IF;
  IF event_scope->>'kind' = 'source' THEN
    profiles := ARRAY(SELECT jsonb_array_elements_text(event_scope->'profileIds'));
    IF EXISTS (SELECT 1 FROM unnest(profiles) p WHERE NOT EXISTS (SELECT 1 FROM public.predictive_source_profiles sp WHERE sp.id = p)) THEN
      RAISE EXCEPTION 'predictive-retention-invalid' USING ERRCODE = '23514';
    END IF;
    captured_from := (event_scope->>'capturedFrom')::timestamptz; captured_before := (event_scope->>'capturedBefore')::timestamptz;
    -- An artifact with any capture in range is removed whole, bytes and captures.
    arts := ARRAY(SELECT DISTINCT a.id FROM public.predictive_artifacts a JOIN public.predictive_captures c ON c.artifact_id = a.id
      WHERE a.profile_id = ANY(profiles) AND (captured_from IS NULL OR c.captured_at >= captured_from)
        AND (captured_before IS NULL OR c.captured_at < captured_before));
    caps := ARRAY(SELECT c.id FROM public.predictive_captures c WHERE c.artifact_id = ANY(arts));
    obs := ARRAY(WITH RECURSIVE chain AS (
        SELECT o.id FROM public.predictive_observations o JOIN public.predictive_artifact_observations l ON l.observation_id = o.id
        WHERE l.artifact_id = ANY(arts) AND o.profile_id = ANY(profiles)
        UNION SELECT n.id FROM public.predictive_observations n JOIN chain ON n.predecessor_id = chain.id)
      SELECT id FROM chain);
    decs := ARRAY(WITH RECURSIVE chain AS (
        SELECT DISTINCT i.decision_id AS id FROM public.predictive_decision_inputs i WHERE i.observation_id = ANY(obs)
        UNION SELECT n.id FROM public.predictive_decisions n JOIN chain ON n.predecessor_id = chain.id)
      SELECT id FROM chain);
    labs := ARRAY(WITH RECURSIVE chain AS (
        SELECT l.id FROM public.predictive_outcome_labels l WHERE l.completion_decision_id = ANY(decs) OR l.participation_decision_id = ANY(decs)
          OR l.reconciliation_decision_id = ANY(decs) OR l.selected_observation_id = ANY(obs) OR l.post_window_capture_id = ANY(caps)
        UNION SELECT n.id FROM public.predictive_outcome_labels n JOIN chain ON n.predecessor_id = chain.id)
      SELECT id FROM chain);
    runs := ARRAY(SELECT DISTINCT d.feature_run_id FROM public.predictive_feature_run_dependencies d
      WHERE d.observation_id = ANY(obs) OR d.decision_id = ANY(decs));
  ELSE
    as_of := (event_scope->>'asOf')::timestamptz;
    IF as_of > pg_catalog.now() THEN RAISE EXCEPTION 'predictive-retention-invalid' USING ERRCODE = '23514'; END IF;
    runs := ARRAY(SELECT f.id FROM public.predictive_feature_runs f WHERE public.predictive_feature_run_expired(f.id, as_of));
  END IF;
  pins := ARRAY(SELECT p.id FROM public.predictive_feature_run_pins p WHERE p.feature_run_id = ANY(runs));
  blobs := ARRAY(SELECT DISTINCT b.sha256 FROM public.predictive_blobs b
    WHERE (b.sha256 IN (SELECT a.blob_sha256 FROM public.predictive_artifacts a WHERE a.id = ANY(arts))
        OR b.sha256 IN (SELECT f.bundle_blob_sha256 FROM public.predictive_feature_runs f WHERE f.id = ANY(runs)))
      AND NOT EXISTS (SELECT 1 FROM public.predictive_artifacts a WHERE a.blob_sha256 = b.sha256 AND NOT a.id = ANY(arts))
      AND NOT EXISTS (SELECT 1 FROM public.predictive_feature_runs f WHERE f.bundle_blob_sha256 = b.sha256 AND NOT f.id = ANY(runs)));
  refs := ARRAY(SELECT b.storage_ref FROM public.predictive_blobs b WHERE b.sha256 = ANY(blobs) ORDER BY b.storage_ref COLLATE "C");

  removed := ARRAY(SELECT x FROM (
      SELECT 'observation:' || v FROM unnest(obs) v UNION ALL SELECT 'artifact:' || v FROM unnest(arts) v
      UNION ALL SELECT 'capture:' || v FROM unnest(caps) v UNION ALL SELECT 'decision:' || v FROM unnest(decs) v
      UNION ALL SELECT 'label:' || v FROM unnest(labs) v UNION ALL SELECT 'feature-run:' || v FROM unnest(runs) v
      UNION ALL SELECT 'pin:' || v FROM unnest(pins) v UNION ALL SELECT 'blob:' || v FROM unnest(blobs) v) t(x) ORDER BY x COLLATE "C");
  ids_digest := encode(sha256(convert_to(array_to_string(removed, E'\n'), 'UTF8')), 'hex');
  SELECT count(*) INTO links FROM public.predictive_artifact_observations l WHERE l.observation_id = ANY(obs) OR l.artifact_id = ANY(arts);
  SELECT count(*) INTO inputs FROM public.predictive_decision_inputs i WHERE i.decision_id = ANY(decs);
  SELECT count(*) INTO dependencies FROM public.predictive_feature_run_dependencies d WHERE d.feature_run_id = ANY(runs);
  SELECT count(*) INTO unpins FROM public.predictive_feature_run_unpins u WHERE u.pin_id = ANY(pins);
  counts := jsonb_build_object('observations', cardinality(obs), 'artifacts', cardinality(arts), 'captures', cardinality(caps),
    'decisions', cardinality(decs), 'labels', cardinality(labs), 'featureRuns', cardinality(runs), 'pins', cardinality(pins),
    'blobs', cardinality(blobs), 'links', links, 'decisionInputs', inputs, 'featureRunDependencies', dependencies, 'unpins', unpins);

  INSERT INTO public.predictive_retention_events (id,reason,authority,decided_at,scope_descriptor,audit_level,removed_counts,removed_ids_digest,executed_at)
    VALUES (event_id, event_reason, event_authority, event_decided_at, event_scope, event_audit_level, counts, ids_digest, pg_catalog.now());
  INSERT INTO public.predictive_retention_authorizations (txid, retention_event_id) VALUES (pg_catalog.pg_current_xact_id(), event_id);
  DELETE FROM public.predictive_feature_run_unpins WHERE pin_id = ANY(pins);
  DELETE FROM public.predictive_feature_run_pins WHERE id = ANY(pins);
  DELETE FROM public.predictive_feature_run_dependencies WHERE feature_run_id = ANY(runs);
  DELETE FROM public.predictive_feature_runs WHERE id = ANY(runs);
  DELETE FROM public.predictive_outcome_labels WHERE id = ANY(labs);
  DELETE FROM public.predictive_decision_inputs WHERE decision_id = ANY(decs);
  DELETE FROM public.predictive_decisions WHERE id = ANY(decs);
  DELETE FROM public.predictive_artifact_observations WHERE observation_id = ANY(obs) OR artifact_id = ANY(arts);
  DELETE FROM public.predictive_observations WHERE id = ANY(obs);
  DELETE FROM public.predictive_captures WHERE id = ANY(caps);
  DELETE FROM public.predictive_artifacts WHERE id = ANY(arts);
  DELETE FROM public.predictive_blobs WHERE sha256 = ANY(blobs);
  IF event_audit_level = 'full' THEN
    INSERT INTO public.predictive_retention_tombstones (retention_event_id, target_kind, target_id)
      SELECT event_id, split_part(x, ':', 1), substr(x, length(split_part(x, ':', 1)) + 2) FROM unnest(removed) x;
  END IF;
  DELETE FROM public.predictive_retention_authorizations WHERE txid = pg_catalog.pg_current_xact_id();
  -- Blob references are returned to the caller for file removal, never stored
  -- for digest-only events.
  RETURN jsonb_build_object('eventId', event_id, 'removedCounts', counts, 'removedIdsDigest', ids_digest, 'removedBlobRefs', to_jsonb(refs));
END
$$;

-- Privileges. PostgreSQL grants EXECUTE on new functions to PUBLIC by default;
-- every predictive function is revoked from PUBLIC. Role grants apply only where
-- the roles exist (the disposable harness creates them; hosted role setup is #95).
REVOKE ALL ON FUNCTION public.predictive_text(jsonb), public.predictive_optional_text(jsonb), public.predictive_instant(text),
  public.predictive_integer(jsonb, numeric, numeric), public.predictive_identity(jsonb, text), public.predictive_entity_key(text, jsonb),
  public.predictive_stats_valid(jsonb), public.predictive_payload_valid(text, jsonb), public.predictive_harness_session(),
  public.predictive_rights_in_force(text, timestamptz, timestamptz), public.predictive_rights_allow(text, timestamptz, timestamptz, text),
  public.predictive_append_only(), public.predictive_rights_check(), public.predictive_publication_check(),
  public.predictive_decision_valid(text, jsonb), public.predictive_decision_check(), public.predictive_absence_valid(text),
  public.predictive_decision_current(text, timestamptz), public.predictive_label_eligible_final_at(timestamptz), public.predictive_label_check(),
  public.predictive_unpin_check(), public.predictive_feature_run_check(), public.predictive_feature_run_expired(text, timestamptz),
  public.predictive_feature_run_dependency_guard(), public.predictive_retention_scope_valid(text, jsonb),
  public.predictive_retention_audit_immutable(),
  public.predictive_retention_execute(text, text, text, timestamptz, jsonb, text) FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'predictive_ingest') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_text(jsonb), public.predictive_optional_text(jsonb), public.predictive_instant(text),
      public.predictive_integer(jsonb, numeric, numeric), public.predictive_identity(jsonb, text), public.predictive_entity_key(text, jsonb),
      public.predictive_stats_valid(jsonb), public.predictive_payload_valid(text, jsonb), public.predictive_harness_session(),
      public.predictive_rights_in_force(text, timestamptz, timestamptz), public.predictive_rights_allow(text, timestamptz, timestamptz, text),
      public.predictive_append_only(), public.predictive_rights_check(), public.predictive_publication_check(),
      public.predictive_decision_valid(text, jsonb), public.predictive_decision_check(), public.predictive_absence_valid(text),
      public.predictive_decision_current(text, timestamptz), public.predictive_label_eligible_final_at(timestamptz), public.predictive_label_check() TO predictive_ingest;
    GRANT SELECT, INSERT ON public.predictive_source_profiles, public.predictive_rights_decisions, public.predictive_blobs,
      public.predictive_ingestion_runs, public.predictive_run_rights, public.predictive_artifacts, public.predictive_captures,
      public.predictive_games, public.predictive_observations, public.predictive_artifact_observations,
      public.predictive_decisions, public.predictive_decision_inputs, public.predictive_outcome_labels TO predictive_ingest;
    GRANT SELECT ON public.predictive_teams TO predictive_ingest;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'predictive_replay') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_rights_in_force(text, timestamptz, timestamptz),
      public.predictive_rights_allow(text, timestamptz, timestamptz, text) TO predictive_replay;
    GRANT SELECT ON public.predictive_source_profiles, public.predictive_rights_decisions, public.predictive_blobs,
      public.predictive_ingestion_runs, public.predictive_run_rights, public.predictive_artifacts, public.predictive_captures,
      public.predictive_teams, public.predictive_games, public.predictive_observations, public.predictive_artifact_observations,
      public.predictive_decisions, public.predictive_decision_inputs, public.predictive_outcome_labels TO predictive_replay;
  END IF;
  -- The recorder saves feature runs: it reads evidence for the deferred checks and
  -- writes only blobs and feature-run tables.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'predictive_recorder') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_rights_in_force(text, timestamptz, timestamptz),
      public.predictive_rights_allow(text, timestamptz, timestamptz, text), public.predictive_harness_session(),
      public.predictive_feature_run_expired(text, timestamptz) TO predictive_recorder;
    GRANT SELECT ON public.predictive_source_profiles, public.predictive_rights_decisions, public.predictive_ingestion_runs,
      public.predictive_artifacts, public.predictive_captures, public.predictive_games, public.predictive_observations,
      public.predictive_artifact_observations, public.predictive_decisions, public.predictive_decision_inputs TO predictive_recorder;
    GRANT SELECT, INSERT ON public.predictive_blobs, public.predictive_feature_runs, public.predictive_feature_run_dependencies,
      public.predictive_feature_run_pins, public.predictive_feature_run_unpins TO predictive_recorder;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'predictive_replay') THEN
    GRANT SELECT ON public.predictive_feature_runs, public.predictive_feature_run_dependencies, public.predictive_feature_run_pins,
      public.predictive_feature_run_unpins, public.predictive_retention_events TO predictive_replay;
  END IF;
  -- The retention owner can only execute the definer function; it holds no
  -- table privilege, and no role holds UPDATE, DELETE or TRUNCATE.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'predictive_retention_owner') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_retention_execute(text, text, text, timestamptz, jsonb, text) TO predictive_retention_owner;
  END IF;
END
$grants$;
