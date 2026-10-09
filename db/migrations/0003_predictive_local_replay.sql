-- Local synthetic persistence proof. No application route requires this prefix.
-- Source truth is append-only; a capture's routing timestamps never change.
CREATE FUNCTION public.predictive_text(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_typeof(value) = 'string' AND length(value #>> '{}') BETWEEN 1 AND 256
    AND (value #>> '{}') !~ '[[:cntrl:]]' AND length(btrim(value #>> '{}')) > 0
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

CREATE FUNCTION public.predictive_payload_valid(kind text, data jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE fields text[]; name text; item jsonb;
BEGIN
  fields := CASE kind
    WHEN 'schedule' THEN ARRAY['gameId','rawGameId','season','seasonType','week','kickoff','homeTeamId','awayTeamId','rawHomeTeam','rawAwayTeam','mappingVersion']
    WHEN 'membership' THEN ARRAY['gameId','playerId','rawPlayerId','teamId','rawTeam','position','effectiveFrom','effectiveTo','mappingVersion']
    WHEN 'player-passing' THEN ARRAY['gameId','rawGameId','teamId','rawTeam','season','seasonType','attempts','passingYards','missingReason','playerId','rawPlayerId']
    WHEN 'team-passing' THEN ARRAY['gameId','rawGameId','teamId','rawTeam','season','seasonType','attempts','passingYards','missingReason']
    WHEN 'completion' THEN ARRAY['gameId','state','bound','boundKind','evidenceVersion']
    WHEN 'participation' THEN ARRAY['gameId','playerId','state','evidenceVersion']
    WHEN 'availability' THEN ARRAY['gameId','playerId','injury','depth','evidenceVersion']
    WHEN 'schedule-coverage' THEN ARRAY['teamId','fromSeason','throughSeason','gameIds','state','evidenceVersion']
    ELSE NULL END;
  IF fields IS NULL OR jsonb_typeof(data) <> 'object' OR
    (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(data) key) IS DISTINCT FROM
    (SELECT array_agg(key ORDER BY key) FROM unnest(fields) key) THEN RETURN false; END IF;
  FOREACH name IN ARRAY ARRAY['rawGameId','rawTeam','rawHomeTeam','rawAwayTeam','mappingVersion','evidenceVersion','position'] LOOP
    IF data ? name AND NOT public.predictive_text(data->name) THEN RETURN false; END IF;
  END LOOP;
  IF data ? 'gameId' AND (jsonb_typeof(data->'gameId') <> 'string' OR data->>'gameId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') THEN RETURN false; END IF;
  IF data ? 'playerId' AND (jsonb_typeof(data->'playerId') <> 'string' OR data->>'playerId' !~ '^00-[0-9]{7}$') THEN RETURN false; END IF;
  IF data ? 'rawPlayerId' AND data->'rawPlayerId' IS DISTINCT FROM data->'playerId' THEN RETURN false; END IF;
  FOREACH name IN ARRAY ARRAY['teamId','homeTeamId','awayTeamId'] LOOP
    IF data ? name AND (jsonb_typeof(data->name) <> 'string' OR data->>name !~ '^nfl:team:[A-Z]{2,3}$') THEN RETURN false; END IF;
  END LOOP;
  IF data ? 'season' AND (NOT public.predictive_integer(data->'season',1920,9999) OR (data->>'seasonType' IN ('REG','POST')) IS NOT TRUE) THEN RETURN false; END IF;
  CASE kind
    WHEN 'schedule' THEN
      RETURN public.predictive_integer(data->'week',1,22) AND public.predictive_instant(data->>'kickoff')
        AND data->>'homeTeamId' <> data->>'awayTeamId';
    WHEN 'membership' THEN
      RETURN public.predictive_instant(data->>'effectiveFrom') AND public.predictive_instant(data->>'effectiveTo')
        AND data->>'effectiveFrom' < data->>'effectiveTo';
    WHEN 'player-passing', 'team-passing' THEN
      IF data->'attempts' <> 'null'::jsonb AND NOT public.predictive_integer(data->'attempts',0,1000) THEN RETURN false; END IF;
      IF data->'passingYards' <> 'null'::jsonb AND NOT public.predictive_integer(data->'passingYards',-10000,10000) THEN RETURN false; END IF;
      RETURN CASE WHEN data->'attempts' = 'null'::jsonb OR data->'passingYards' = 'null'::jsonb
        THEN data->>'missingReason' IN ('source-blank','source-missing') ELSE data->'missingReason' = 'null'::jsonb END;
    WHEN 'completion' THEN
      RETURN CASE data->>'state' WHEN 'confirmed' THEN public.predictive_instant(data->>'bound') AND data->>'boundKind' IN ('actual-end','completion-observed-at')
        WHEN 'unresolved' THEN data->'bound' = 'null'::jsonb AND data->'boundKind' = 'null'::jsonb ELSE false END;
    WHEN 'participation' THEN RETURN data->>'state' IN ('confirmed','absent','unresolved');
    WHEN 'availability' THEN RETURN data->>'injury' IN ('unknown','eligible','excluded') AND data->>'depth' IN ('unknown','observed');
    WHEN 'schedule-coverage' THEN
      IF NOT public.predictive_integer(data->'fromSeason',1920,9999) OR NOT public.predictive_integer(data->'throughSeason',1920,9999)
        OR (data->>'throughSeason')::integer - (data->>'fromSeason')::integer <> 2
        OR (data->>'state' IN ('complete','incomplete')) IS NOT TRUE OR jsonb_typeof(data->'gameIds') <> 'array'
        OR jsonb_array_length(data->'gameIds') > 256 THEN RETURN false; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(data->'gameIds') LOOP
        IF jsonb_typeof(item) <> 'string' OR item #>> '{}' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RETURN false; END IF;
      END LOOP;
      RETURN (SELECT count(*) = count(DISTINCT value) FROM jsonb_array_elements(data->'gameIds'));
    ELSE RETURN false;
  END CASE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END
$$;

CREATE TABLE public.predictive_ingestion_runs (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  code_version text NOT NULL CHECK (code_version = 'predictive-local-store-v1'),
  adapter_version text NOT NULL CHECK (adapter_version = 'synthetic-json-v1'),
  started_at timestamptz NOT NULL CHECK (isfinite(started_at)),
  finished_at timestamptz NOT NULL CHECK (isfinite(finished_at) AND finished_at >= started_at),
  status text NOT NULL CHECK (status IN ('published','incomplete','refused')),
  failure_code text CHECK (failure_code IN ('publication-refused','artifact-store-unavailable','partial-acquisition')),
  artifact_count integer NOT NULL CHECK (artifact_count BETWEEN 0 AND 256),
  capture_count integer NOT NULL CHECK (capture_count BETWEEN 0 AND 512),
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 8192),
  bounds jsonb NOT NULL CHECK (bounds = '{"artifacts":256,"captures":512,"bytes":8000000,"rows":8192}'::jsonb),
  CHECK ((status = 'published') = (failure_code IS NULL))
);

CREATE TABLE public.predictive_artifacts (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 0 AND 1000000),
  storage_ref text NOT NULL CHECK (storage_ref = sha256 || '.json'),
  source text NOT NULL CHECK (source = 'synthetic'),
  origin text NOT NULL CHECK (length(origin) BETWEEN 1 AND 256 AND origin !~ '[[:cntrl:]]'),
  feed text NOT NULL CHECK (feed IN ('schedule','membership','player-passing','team-passing','completion','participation','availability','schedule-coverage')),
  schema_version text NOT NULL CHECK (schema_version = 'predictive-proof-v1'),
  parser_version text NOT NULL CHECK (parser_version = 'synthetic-json-v1'),
  rights_review_version text NOT NULL CHECK (rights_review_version = 'synthetic-only-v1')
);
CREATE INDEX predictive_artifacts_content_idx ON public.predictive_artifacts (sha256);

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
  CHECK ((published_at IS NULL) = (publication_evidence IS NULL))
);
CREATE INDEX predictive_captures_cutoff_idx ON public.predictive_captures (artifact_id, available_at, ingested_at, id) WHERE state = 'published';

CREATE TABLE public.predictive_teams (
  id text PRIMARY KEY CHECK (id ~ '^nfl:team:(ARI|ATL|BAL|BUF|CAR|CHI|CIN|CLE|DAL|DEN|DET|GB|HOU|IND|JAX|KC|LAC|LAR|LV|MIA|MIN|NE|NO|NYG|NYJ|PHI|PIT|SEA|SF|TB|TEN|WAS)$')
);
CREATE TABLE public.predictive_games (
  id uuid PRIMARY KEY CHECK (id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
);

-- JSON is an exact per-kind schema, not an open payload. Generated routing
-- columns and foreign keys bind its indexed identity to the validated payload.
CREATE TABLE public.predictive_observations (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  kind text NOT NULL,
  data jsonb NOT NULL CHECK (public.predictive_payload_valid(kind, data) IS TRUE),
  natural_key text GENERATED ALWAYS AS (kind || ':' || CASE WHEN kind = 'schedule-coverage'
    THEN (data->>'teamId') || ':' || (data->>'fromSeason') || ':' || (data->>'throughSeason')
    ELSE (data->>'gameId') || CASE WHEN data ? 'playerId' THEN ':' || (data->>'playerId')
      WHEN data ? 'teamId' THEN ':' || (data->>'teamId') ELSE '' END END) STORED,
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
  UNIQUE (id, kind, natural_key),
  FOREIGN KEY (predecessor_id, kind, natural_key) REFERENCES public.predictive_observations(id, kind, natural_key) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((predecessor_id IS NULL) = (correction_reason IS NULL)),
  CHECK (predecessor_id IS DISTINCT FROM id)
);
CREATE INDEX predictive_observations_entity_idx ON public.predictive_observations (game_id, kind, player_id, team_id);
CREATE INDEX predictive_observations_key_idx ON public.predictive_observations (natural_key);
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
CREATE TRIGGER predictive_runs_immutable BEFORE UPDATE OR DELETE ON public.predictive_ingestion_runs FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_artifacts_immutable BEFORE UPDATE OR DELETE ON public.predictive_artifacts FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_captures_immutable BEFORE UPDATE OR DELETE ON public.predictive_captures FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_teams_immutable BEFORE UPDATE OR DELETE ON public.predictive_teams FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_games_immutable BEFORE UPDATE OR DELETE ON public.predictive_games FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_observations_immutable BEFORE UPDATE OR DELETE ON public.predictive_observations FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_links_immutable BEFORE UPDATE OR DELETE ON public.predictive_artifact_observations FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_runs_no_truncate BEFORE TRUNCATE ON public.predictive_ingestion_runs FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_artifacts_no_truncate BEFORE TRUNCATE ON public.predictive_artifacts FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_captures_no_truncate BEFORE TRUNCATE ON public.predictive_captures FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_teams_no_truncate BEFORE TRUNCATE ON public.predictive_teams FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_games_no_truncate BEFORE TRUNCATE ON public.predictive_games FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_observations_no_truncate BEFORE TRUNCATE ON public.predictive_observations FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_links_no_truncate BEFORE TRUNCATE ON public.predictive_artifact_observations FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();

CREATE FUNCTION public.predictive_publication_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected text[];
BEGIN
  IF TG_TABLE_NAME = 'predictive_captures' THEN
    IF NEW.state = 'published' AND (SELECT status FROM public.predictive_ingestion_runs WHERE id = NEW.run_id) <> 'published' THEN
      RAISE EXCEPTION 'predictive-publication-invalid' USING ERRCODE = '23514';
    END IF;
    SELECT array_agg(observation_id) INTO affected FROM public.predictive_artifact_observations WHERE artifact_id = NEW.artifact_id;
  ELSIF TG_TABLE_NAME = 'predictive_observations' THEN affected := ARRAY[NEW.id];
  ELSE affected := ARRAY[NEW.observation_id]; END IF;
  IF
    EXISTS (SELECT 1 FROM public.predictive_artifact_observations l JOIN public.predictive_observations o ON o.id = l.observation_id
      JOIN public.predictive_artifacts a ON a.id = l.artifact_id WHERE o.id = ANY(affected) AND o.kind <> a.feed) OR
    EXISTS (SELECT 1 FROM public.predictive_observations o WHERE o.id = ANY(affected) AND NOT EXISTS
      (SELECT 1 FROM public.predictive_artifact_observations l JOIN public.predictive_captures c ON c.artifact_id = l.artifact_id
        WHERE l.observation_id = o.id AND c.state = 'published')) THEN
    RAISE EXCEPTION 'predictive-publication-invalid' USING ERRCODE = '23514';
  END IF;
  -- Every correction's first usable capture must follow an independently
  -- usable predecessor. That also makes correction cycles impossible.
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
