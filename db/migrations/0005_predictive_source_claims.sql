-- PR B: raw CSV claims, deliberately outside canonical observations/labels.
-- 0003 is released and unchanged. Each complete capture is an immutable
-- snapshot; row ordinal counts parsed records (not physical CSV lines).
CREATE FUNCTION public.predictive_source_projection_valid(data jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE STRICT AS $$
DECLARE fields text[]; stats text[]; parts text[]; field text;
BEGIN
  SELECT array_agg(key ORDER BY key COLLATE "C") INTO fields FROM jsonb_object_keys(data) key;
  FOREACH field IN ARRAY ARRAY['feed','version','rawGameId','rawTeam','rawOpponent','seasonType'] LOOP
    IF jsonb_typeof(data->field) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  END LOOP;
  IF fields <> ARRAY['feed','missing','playerIdProvider','rawGameId','rawOpponent','rawPlayerId','rawTeam','season','seasonType','values','version','week']
      OR data->>'version' <> 'nflverse-raw-stats-v1' OR data->>'feed' NOT IN ('player','team')
      OR NOT public.predictive_integer(data->'season', 2026, 2026)
      OR NOT public.predictive_integer(data->'week', 1, 22) OR data->>'seasonType' NOT IN ('REG','POST')
      OR data->>'rawGameId' !~ '^[0-9]{4}_[0-9]{2}_[A-Z]{2,3}_[A-Z]{2,3}$' THEN RETURN false; END IF;
  parts := string_to_array(data->>'rawGameId', '_');
  IF parts[1]::integer <> (data->>'season')::integer OR parts[2]::integer <> (data->>'week')::integer
      OR parts[3] = parts[4] OR data->>'rawTeam' = data->>'rawOpponent'
      OR data->>'rawTeam' <> ALL(parts[3:4]) OR data->>'rawOpponent' <> ALL(parts[3:4])
      OR NOT EXISTS (SELECT 1 FROM public.predictive_teams WHERE id = 'nfl:team:' || parts[3])
      OR NOT EXISTS (SELECT 1 FROM public.predictive_teams WHERE id = 'nfl:team:' || parts[4]) THEN RETURN false; END IF;
  IF data->>'feed' = 'player' THEN
    IF data->>'rawPlayerId' !~ '^00-[0-9]{7}$' OR data->>'playerIdProvider' <> 'gsis'
        OR jsonb_typeof(data->'rawPlayerId') <> 'string' OR jsonb_typeof(data->'playerIdProvider') <> 'string' THEN RETURN false; END IF;
  ELSIF data->'rawPlayerId' <> 'null'::jsonb OR data->'playerIdProvider' <> 'null'::jsonb THEN RETURN false; END IF;
  SELECT array_agg(key ORDER BY key COLLATE "C") INTO stats FROM jsonb_object_keys(data->'values') key;
  RETURN stats = ARRAY['attempts','carries','completions','passingInterceptions','passingTds','passingYards','receivingYards','receptions','rushingYards','targets']
    AND public.predictive_stats_valid((data->'values') || jsonb_build_object('missing', data->'missing'));
EXCEPTION WHEN OTHERS THEN RETURN false;
END
$$;

CREATE TABLE public.predictive_source_stats_rows (
  id text PRIMARY KEY CHECK (id ~ '^source-row:[a-f0-9]{64}$'),
  capture_id text NOT NULL REFERENCES public.predictive_captures(id),
  row_ordinal integer NOT NULL CHECK (row_ordinal BETWEEN 1 AND 8192),
  raw_key_sha256 text NOT NULL CHECK (raw_key_sha256 ~ '^[a-f0-9]{64}$'),
  selected_sha256 text NOT NULL CHECK (selected_sha256 ~ '^[a-f0-9]{64}$'),
  projection jsonb CHECK (projection IS NULL OR public.predictive_source_projection_valid(projection) IS TRUE),
  failure_code text CHECK (failure_code IN ('source-stats-context-refused','source-stats-player-refused',
    'source-number-refused','source-stats-denominator-refused','source-stats-scope-refused')),
  CHECK ((projection IS NULL) = (failure_code IS NOT NULL)),
  UNIQUE (capture_id, row_ordinal)
);
CREATE INDEX predictive_source_stats_key_idx ON public.predictive_source_stats_rows (capture_id, raw_key_sha256);
CREATE INDEX predictive_source_capture_scope_idx ON public.predictive_artifacts (profile_id, scope_season) WHERE scope_kind = 'season-file';
CREATE TRIGGER predictive_source_rows_immutable BEFORE UPDATE OR DELETE ON public.predictive_source_stats_rows
  FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_source_rows_no_truncate BEFORE TRUNCATE ON public.predictive_source_stats_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();

-- A direct SQL writer cannot backdate a raw CSV import either. Original archive
-- times live in captured_at; ingestion is when this database received it.
CREATE FUNCTION public.predictive_source_ingestion_clock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE profile_id text;
BEGIN
  SELECT p.id INTO profile_id FROM public.predictive_artifacts a JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256
      JOIN public.predictive_source_profiles p ON p.id=a.profile_id WHERE a.id=NEW.artifact_id
      AND b.media_type='text/csv' AND p.parser_version='nflverse-csv-qualification-v1';
  IF profile_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(520053, hashtext(profile_id));
    NEW.ingested_at := date_trunc('milliseconds', clock_timestamp());
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER predictive_source_ingestion_clock BEFORE INSERT ON public.predictive_captures
  FOR EACH ROW EXECUTE FUNCTION public.predictive_source_ingestion_clock();

-- SQL checks the envelope/shape and complete snapshot coverage. Byte/selected-row
-- hashes and exact numeric normalization are independently rechecked on replay.
CREATE FUNCTION public.predictive_source_claim_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap public.predictive_captures; art public.predictive_artifacts; profile public.predictive_source_profiles;
  media text; n integer; maximum integer; minimum integer; expected_key text;
BEGIN
  IF TG_TABLE_NAME = 'predictive_captures' THEN SELECT * INTO cap FROM public.predictive_captures WHERE id = NEW.id;
  ELSE SELECT * INTO cap FROM public.predictive_captures WHERE id = NEW.capture_id; END IF;
  SELECT * INTO art FROM public.predictive_artifacts WHERE id = cap.artifact_id;
  SELECT * INTO profile FROM public.predictive_source_profiles WHERE id = art.profile_id;
  SELECT media_type INTO media FROM public.predictive_blobs WHERE sha256 = art.blob_sha256;
  -- Existing diagnostic CSVs and the released JSON proof retain their contracts.
  IF TG_TABLE_NAME = 'predictive_captures' AND (media <> 'text/csv' OR profile.parser_version <> 'nflverse-csv-qualification-v1') THEN RETURN NULL; END IF;
  IF media <> 'text/csv' OR profile.parser_version <> 'nflverse-csv-qualification-v1'
      OR profile.allowlist_version <> 'predictive-raw-allowlist-v1' OR profile.feed NOT IN ('player','team')
      OR profile.purpose NOT IN ('source','synthetic-test') OR profile.provider <> 'nflverse'
      OR profile.release_tag IS DISTINCT FROM 'stats_' || profile.feed
      OR profile.asset_pattern IS DISTINCT FROM 'stats_' || profile.feed || '_week_2026.csv'
      OR profile.header_profile_sha256 IS NULL
      OR NOT (CASE profile.feed WHEN 'player' THEN 'player-game-stats' ELSE 'team-game-stats' END = ANY(profile.evidence_kinds))
      OR cap.state <> 'published' OR art.retrieval_kind <> 'full' OR art.scope_kind <> 'season-file'
      OR art.scope_season <> 2026 OR art.scope_filter IS NOT NULL OR cap.published_at IS NOT NULL
      OR cap.available_at <> cap.captured_at OR cap.ingested_at > clock_timestamp()
      OR NOT public.predictive_rights_allow(profile.id, clock_timestamp(), clock_timestamp(), 'internal-research') THEN
    RAISE EXCEPTION 'predictive-source-claim-envelope-invalid' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'predictive_captures' THEN
    SELECT count(*), min(row_ordinal), max(row_ordinal) INTO n, minimum, maximum
      FROM public.predictive_source_stats_rows WHERE capture_id = cap.id;
    IF n <> cap.parsed_rows OR n < 1 OR minimum <> 1 OR maximum <> n THEN
      RAISE EXCEPTION 'predictive-source-claim-coverage-invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'predictive_source_stats_rows' THEN
    IF NEW.row_ordinal > cap.parsed_rows THEN RAISE EXCEPTION 'predictive-source-claim-coverage-invalid' USING ERRCODE = '23514'; END IF;
    IF NEW.id <> 'source-row:' || encode(sha256(convert_to('[' || to_json(NEW.capture_id)::text || ',' || NEW.row_ordinal::text || ']', 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'predictive-source-claim-id-invalid' USING ERRCODE = '23514';
    END IF;
    IF NEW.projection IS NOT NULL THEN
      expected_key := '[' || to_json(NEW.projection->>'rawGameId')::text || ',' || to_json(NEW.projection->>'rawTeam')::text
        || CASE profile.feed WHEN 'player' THEN ',' || to_json(NEW.projection->>'rawPlayerId')::text ELSE '' END || ']';
      IF NEW.projection->>'feed' <> profile.feed OR NEW.raw_key_sha256 <> encode(sha256(convert_to(expected_key, 'UTF8')), 'hex') THEN
        RAISE EXCEPTION 'predictive-source-claim-key-invalid' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER predictive_source_capture_check AFTER INSERT ON public.predictive_captures
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.predictive_source_claim_check();
CREATE CONSTRAINT TRIGGER predictive_source_row_check AFTER INSERT ON public.predictive_source_stats_rows
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.predictive_source_claim_check();

-- Staging is not a shortcut into canonical evidence. A later reviewed adapter
-- must add explicit raw-row and bridge bindings before these artifacts can be
-- linked to canonical observations.
CREATE FUNCTION public.predictive_source_canonical_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.predictive_artifacts a JOIN public.predictive_blobs b ON b.sha256 = a.blob_sha256
      JOIN public.predictive_source_profiles p ON p.id = a.profile_id WHERE a.id = NEW.artifact_id
      AND b.media_type = 'text/csv' AND p.parser_version = 'nflverse-csv-qualification-v1') THEN
    RAISE EXCEPTION 'predictive-source-canonical-binding-required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER predictive_source_canonical_guard BEFORE INSERT ON public.predictive_artifact_observations
  FOR EACH ROW EXECUTE FUNCTION public.predictive_source_canonical_guard();

ALTER TABLE public.predictive_retention_tombstones DROP CONSTRAINT predictive_retention_tombstones_target_kind_check;
ALTER TABLE public.predictive_retention_tombstones ADD CONSTRAINT predictive_retention_tombstones_target_kind_check
  CHECK (target_kind IN ('observation','artifact','capture','decision','label','feature-run','pin','blob','source-stats-row'));

REVOKE ALL ON public.predictive_source_stats_rows FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.predictive_source_projection_valid(jsonb), public.predictive_source_claim_check(),
  public.predictive_source_canonical_guard(), public.predictive_source_ingestion_clock() FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'predictive_ingest') THEN
    GRANT SELECT, INSERT ON public.predictive_source_stats_rows TO predictive_ingest;
    GRANT EXECUTE ON FUNCTION public.predictive_source_projection_valid(jsonb), public.predictive_source_claim_check(),
      public.predictive_source_canonical_guard(), public.predictive_source_ingestion_clock() TO predictive_ingest;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'predictive_replay') THEN
    GRANT SELECT ON public.predictive_source_stats_rows TO predictive_replay;
  END IF;
END
$grants$;

-- Extend the released retention closure for raw source rows. Existing graph,
-- role boundary, locking, audit and queued-file recovery remain identical.
CREATE OR REPLACE FUNCTION public.predictive_retention_execute(event_id text, event_reason text, event_authority text, event_decided_at timestamptz,
  event_scope jsonb, event_audit_level text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  profiles text[]; captured_from timestamptz; captured_before timestamptz; as_of timestamptz;
  arts text[] := '{}'; caps text[] := '{}'; obs text[] := '{}'; decs text[] := '{}'; labs text[] := '{}';
  runs text[] := '{}'; pins text[] := '{}'; blobs text[] := '{}'; refs text[]; source_rows text[] := '{}';
  removed_kinds text[]; removed_ids text[]; counts jsonb; ids_digest text; links integer; inputs integer; dependencies integer; unpins integer;
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
          OR l.player_bridge_observation_id = ANY(obs)
        UNION SELECT n.id FROM public.predictive_outcome_labels n JOIN chain ON n.predecessor_id = chain.id)
      SELECT id FROM chain);
    runs := ARRAY(SELECT DISTINCT d.feature_run_id FROM public.predictive_feature_run_dependencies d
      WHERE d.observation_id = ANY(obs) OR d.decision_id = ANY(decs));
  ELSE
    as_of := (event_scope->>'asOf')::timestamptz;
    IF as_of > pg_catalog.now() THEN RAISE EXCEPTION 'predictive-retention-invalid' USING ERRCODE = '23514'; END IF;
    runs := ARRAY(SELECT f.id FROM public.predictive_feature_runs f WHERE public.predictive_feature_run_expired(f.id, as_of));
  END IF;
  source_rows := ARRAY(SELECT s.id FROM public.predictive_source_stats_rows s WHERE s.capture_id = ANY(caps));
  pins := ARRAY(SELECT p.id FROM public.predictive_feature_run_pins p WHERE p.feature_run_id = ANY(runs));
  blobs := ARRAY(SELECT DISTINCT b.sha256 FROM public.predictive_blobs b
    WHERE (b.sha256 IN (SELECT a.blob_sha256 FROM public.predictive_artifacts a WHERE a.id = ANY(arts))
        OR b.sha256 IN (SELECT f.bundle_blob_sha256 FROM public.predictive_feature_runs f WHERE f.id = ANY(runs)))
      AND NOT EXISTS (SELECT 1 FROM public.predictive_artifacts a WHERE a.blob_sha256 = b.sha256 AND NOT a.id = ANY(arts))
      AND NOT EXISTS (SELECT 1 FROM public.predictive_feature_runs f WHERE f.bundle_blob_sha256 = b.sha256 AND NOT f.id = ANY(runs)));
  refs := ARRAY(SELECT b.storage_ref FROM public.predictive_blobs b WHERE b.sha256 = ANY(blobs) ORDER BY b.storage_ref COLLATE "C");

  -- Parallel arrays, never a temp table: a caller could pre-create a pg_temp
  -- relation that this definer function would then use.
  SELECT coalesce(array_agg(k ORDER BY k COLLATE "C", v COLLATE "C"), '{}'), coalesce(array_agg(v ORDER BY k COLLATE "C", v COLLATE "C"), '{}')
    INTO removed_kinds, removed_ids FROM (
      SELECT 'observation', v FROM unnest(obs) v UNION ALL SELECT 'artifact', v FROM unnest(arts) v
      UNION ALL SELECT 'capture', v FROM unnest(caps) v UNION ALL SELECT 'decision', v FROM unnest(decs) v
      UNION ALL SELECT 'label', v FROM unnest(labs) v UNION ALL SELECT 'feature-run', v FROM unnest(runs) v
      UNION ALL SELECT 'pin', v FROM unnest(pins) v UNION ALL SELECT 'blob', v FROM unnest(blobs) v
      UNION ALL SELECT 'source-stats-row', v FROM unnest(source_rows) v) t(k, v);
  -- The canonical JSON array of {"id","kind"} pairs ordered by (kind, id),
  -- mirrored by retentionIdsDigest() in persistence.ts. JSON escaping keeps it
  -- unambiguous whatever an identifier contains.
  SELECT encode(sha256(convert_to('[' || coalesce(string_agg('{"id":' || to_json(r.v)::text || ',"kind":' || to_json(r.k)::text || '}', ','
      ORDER BY r.n), '') || ']', 'UTF8')), 'hex')
    INTO ids_digest FROM unnest(removed_kinds, removed_ids) WITH ORDINALITY r(k, v, n);
  SELECT count(*) INTO links FROM public.predictive_artifact_observations l WHERE l.observation_id = ANY(obs) OR l.artifact_id = ANY(arts);
  SELECT count(*) INTO inputs FROM public.predictive_decision_inputs i WHERE i.decision_id = ANY(decs);
  SELECT count(*) INTO dependencies FROM public.predictive_feature_run_dependencies d WHERE d.feature_run_id = ANY(runs);
  SELECT count(*) INTO unpins FROM public.predictive_feature_run_unpins u WHERE u.pin_id = ANY(pins);
  counts := jsonb_build_object('observations', cardinality(obs), 'artifacts', cardinality(arts), 'captures', cardinality(caps),
    'decisions', cardinality(decs), 'labels', cardinality(labs), 'featureRuns', cardinality(runs), 'pins', cardinality(pins),
    'blobs', cardinality(blobs), 'links', links, 'decisionInputs', inputs, 'featureRunDependencies', dependencies, 'unpins', unpins);

  -- Preserve old zero-row event counts/digests for backup re-apply parity.
  IF cardinality(source_rows) > 0 THEN counts := counts || jsonb_build_object('sourceStatsRows', cardinality(source_rows)); END IF;
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
  DELETE FROM public.predictive_source_stats_rows WHERE id = ANY(source_rows);
  DELETE FROM public.predictive_captures WHERE id = ANY(caps);
  DELETE FROM public.predictive_artifacts WHERE id = ANY(arts);
  DELETE FROM public.predictive_blobs WHERE sha256 = ANY(blobs);
  INSERT INTO public.predictive_blob_removals (storage_ref, queued_at) SELECT r, pg_catalog.now() FROM unnest(refs) r ON CONFLICT DO NOTHING;
  IF event_audit_level = 'full' THEN
    INSERT INTO public.predictive_retention_tombstones (retention_event_id, target_kind, target_id)
      SELECT event_id, r.k, r.v FROM unnest(removed_kinds, removed_ids) r(k, v);
  END IF;
  DELETE FROM public.predictive_retention_authorizations WHERE txid = pg_catalog.pg_current_xact_id();
  -- Blob references are returned to the caller for file removal, never stored
  -- for digest-only events.
  RETURN jsonb_build_object('eventId', event_id, 'removedCounts', counts, 'removedIdsDigest', ids_digest, 'removedBlobRefs', to_jsonb(refs));
END
$$;
