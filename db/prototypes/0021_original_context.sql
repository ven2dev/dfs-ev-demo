-- Scratch-only 0021 prototype. Not an ordered migration or a qualified consumer path.
-- Original-byte replay remains mandatory; a raw ingest seal is not authority.
CREATE TABLE public.predictive_context_captures (
  capture_id text PRIMARY KEY REFERENCES public.predictive_captures(id) ON DELETE CASCADE,
  request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
  season_range jsonb NOT NULL,
  claims jsonb NOT NULL CHECK(jsonb_typeof(claims)='array' AND jsonb_array_length(claims) BETWEEN 1 AND 80000),
  claims_sha256 text NOT NULL CHECK(claims_sha256~'^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp())
    CHECK(isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at))
);
CREATE TABLE public.predictive_context_associations (
  capture_id text PRIMARY KEY REFERENCES public.predictive_context_captures(capture_id) ON DELETE CASCADE,
  artifact_id text NOT NULL UNIQUE REFERENCES public.predictive_artifacts(id),
  basis jsonb NOT NULL, association_sha256 text NOT NULL CHECK(association_sha256~'^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp())
    CHECK(isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at))
);
CREATE TABLE public.predictive_context_association_audits (
  event_id text NOT NULL REFERENCES public.predictive_retention_events(id),
  capture_digest text NOT NULL CHECK(capture_digest~'^[a-f0-9]{64}$'),
  removed_observations integer NOT NULL CHECK(removed_observations BETWEEN 2 AND 512),
  removed_ids_digest text NOT NULL CHECK(removed_ids_digest~'^[a-f0-9]{64}$'), PRIMARY KEY(event_id,capture_digest)
);
CREATE FUNCTION public.predictive_context_association_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE event text; ids jsonb;
BEGIN
  IF TG_OP='DELETE' AND pg_has_role(session_user,'predictive_retention_owner','MEMBER') THEN
    SELECT retention_event_id INTO event FROM public.predictive_retention_authorizations WHERE txid=pg_current_xact_id();
    IF event IS NOT NULL THEN
      SELECT jsonb_agg(id ORDER BY id COLLATE "C") INTO ids FROM (
        SELECT value->'schedule'->>'id' AS id FROM jsonb_array_elements(OLD.basis->'bindings')
        UNION SELECT value->'bridge'->>'id' FROM jsonb_array_elements(OLD.basis->'bindings')) x;
      INSERT INTO public.predictive_context_association_audits VALUES(event,public.predictive_source_digest(to_jsonb(OLD.capture_id)),
        jsonb_array_length(ids),public.predictive_source_digest(ids));
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'context-association-append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER predictive_context_association_immutable BEFORE UPDATE OR DELETE ON public.predictive_context_associations
 FOR EACH ROW EXECUTE FUNCTION public.predictive_context_association_immutable();
CREATE TRIGGER predictive_context_association_no_truncate BEFORE TRUNCATE ON public.predictive_context_associations
 FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_context_association_immutable();
CREATE TRIGGER predictive_context_association_audit_immutable BEFORE UPDATE OR DELETE ON public.predictive_context_association_audits
 FOR EACH ROW EXECUTE FUNCTION public.predictive_retention_audit_immutable();
CREATE TRIGGER predictive_context_association_audit_no_truncate BEFORE TRUNCATE ON public.predictive_context_association_audits
 FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_retention_audit_immutable();
REVOKE ALL ON public.predictive_context_associations,public.predictive_context_association_audits FROM PUBLIC;

CREATE TABLE public.predictive_context_retention_audits (
  event_id text NOT NULL REFERENCES public.predictive_retention_events(id),
  capture_digest text NOT NULL CHECK(capture_digest~'^[a-f0-9]{64}$'), removed_rows integer NOT NULL CHECK(removed_rows BETWEEN 1 AND 80000),
  removed_ids_digest text NOT NULL CHECK(removed_ids_digest~'^[a-f0-9]{64}$'), PRIMARY KEY(event_id,capture_digest)
);
CREATE FUNCTION public.predictive_context_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE event text; ids jsonb;
BEGIN
  IF TG_OP='DELETE' AND pg_has_role(session_user,'predictive_retention_owner','MEMBER') THEN
    SELECT retention_event_id INTO event FROM public.predictive_retention_authorizations WHERE txid=pg_current_xact_id();
    IF event IS NOT NULL THEN
      SELECT jsonb_agg(value->>'id' ORDER BY value->>'id' COLLATE "C") INTO ids FROM jsonb_array_elements(OLD.claims);
      INSERT INTO public.predictive_context_retention_audits VALUES(event,public.predictive_source_digest(to_jsonb(OLD.capture_id)),
        jsonb_array_length(OLD.claims),public.predictive_source_digest(ids));
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'context-append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER predictive_context_immutable BEFORE UPDATE OR DELETE ON public.predictive_context_captures
 FOR EACH ROW EXECUTE FUNCTION public.predictive_context_immutable();
CREATE TRIGGER predictive_context_no_truncate BEFORE TRUNCATE ON public.predictive_context_captures
 FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_context_immutable();
CREATE TRIGGER predictive_context_audit_immutable BEFORE UPDATE OR DELETE ON public.predictive_context_retention_audits
 FOR EACH ROW EXECUTE FUNCTION public.predictive_retention_audit_immutable();
CREATE TRIGGER predictive_context_audit_no_truncate BEFORE TRUNCATE ON public.predictive_context_retention_audits
 FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_retention_audit_immutable();
REVOKE ALL ON public.predictive_context_captures,public.predictive_context_retention_audits FROM PUBLIC;

ALTER FUNCTION public.predictive_training_read_guard() RENAME TO predictive_training_read_guard_prefix20;
CREATE FUNCTION public.predictive_training_read_guard() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE clock text;
BEGIN
  clock:=public.predictive_training_read_guard_prefix20();
  LOCK TABLE public.predictive_context_captures,public.predictive_context_associations IN SHARE MODE;
  RETURN clock;
END $$;
-- Extend the existing memo's dependency set through forward DDL. No prior file
-- changes, caller-supplied cache certificates, or cached current-rights results.
DO $extend$ DECLARE definition text; needle text:='''predictive_compressed_inspections'',''predictive_compressed_publications'']'; BEGIN
  definition:=pg_get_functiondef('public.predictive_training_memo_ready()'::regprocedure);
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
    RAISE EXCEPTION 'context-memo-prefix-refused'; END IF;
  EXECUTE replace(definition,needle,'''predictive_compressed_inspections'',''predictive_compressed_publications'',''predictive_context_captures'',''predictive_context_associations'']');
END $extend$;

CREATE FUNCTION public.predictive_context_profile_valid(artifact text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
SELECT coalesce((SELECT p.purpose='source' AND p.provider='nflverse' AND p.feed IN ('schedule','identifiers')
  AND p.parser_version='nflverse-original-context-qualification-v1' AND p.allowlist_version='predictive-raw-allowlist-v1'
  AND p.release_tag=CASE p.feed WHEN 'schedule' THEN 'schedules' ELSE 'players' END
  AND p.asset_pattern=CASE p.feed WHEN 'schedule' THEN 'games.csv' ELSE 'players.csv' END
  AND p.header_profile_sha256=CASE p.feed WHEN 'schedule' THEN '6cdacf455895ebf361cdd8162b5655acfbfbc5598de01e47effb801282fdb779'
    ELSE '7e3cbd23fdac182009f438361a55d31570b36a7d2cd53f56cd2cf173166ce07c' END
  AND p.evidence_kinds=CASE p.feed WHEN 'schedule' THEN ARRAY['schedule','game-bridge','team-alias'] ELSE ARRAY['player-bridge'] END
  AND b.media_type='text/csv' AND b.byte_size BETWEEN 1 AND 8000000
  AND a.retrieval_kind='full' AND a.origin='https://github.com/nflverse/nflverse-data/releases/download/'||p.release_tag||'/'||p.asset_pattern
  AND a.scope_kind='all-seasons' AND a.scope_season IS NULL AND a.scope_week IS NULL AND a.scope_game_id IS NULL AND a.scope_filter IS NULL
FROM public.predictive_artifacts a JOIN public.predictive_source_profiles p ON p.id=a.profile_id
JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256 WHERE a.id=artifact),false)
$$;
CREATE FUNCTION public.predictive_context_guard() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT pg_has_role(session_user,'predictive_ingest','MEMBER') THEN RAISE EXCEPTION 'context-not-authorized' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(520052,1);
  PERFORM public.predictive_training_read_guard();
  LOCK TABLE public.predictive_context_captures,public.predictive_context_associations IN SHARE ROW EXCLUSIVE MODE;
  RETURN public.predictive_source_time(date_trunc('milliseconds',clock_timestamp()));
END $$;
CREATE FUNCTION public.predictive_context_access(profile text,captured timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT (pg_has_role(session_user,'predictive_ingest','MEMBER') OR pg_has_role(session_user,'predictive_replay','MEMBER')) THEN
    RAISE EXCEPTION 'context-not-authorized' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.predictive_source_profiles p WHERE p.id=profile AND p.parser_version='nflverse-original-context-qualification-v1') THEN
    RAISE EXCEPTION 'context-profile-refused' USING ERRCODE='23514'; END IF;
  PERFORM public.predictive_compressed_source_access(profile,captured);
END $$;
ALTER TABLE public.predictive_ingestion_runs DROP CONSTRAINT predictive_ingestion_runs_row_count_check;
ALTER TABLE public.predictive_ingestion_runs ADD CONSTRAINT predictive_ingestion_runs_row_count_check CHECK
 (row_count BETWEEN 0 AND 8192 OR (code_version IN ('nflverse-gzip-csv-source-claims-v1','nflverse-original-context-claims-v1') AND row_count BETWEEN 1 AND 80000));

-- Same canonical bytes as predictive_source_digest for the exact validated
-- context schema. Fixed sorted keys avoid recursive SQL calls per scalar in a
-- complete 25k-row snapshot; JSON scalar rendering still escapes every string.
-- The recorder validates all keys/types BEFORE calling this private helper.
CREATE FUNCTION public.predictive_context_claims_digest(rows jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
SELECT encode(sha256(convert_to('['||coalesce(string_agg(
  format('{"failureCode":%s,"id":%s,"projection":%s,"rawKeySha256":%s,"rowOrdinal":%s,"selectedSha256":%s}',
    e->'failureCode',e->'id',CASE WHEN e->'projection'='null'::jsonb THEN 'null'
      WHEN e->'projection'->>'kind'='raw-player-identity' THEN format('{"crosswalk":%s,"gsisId":%s,"kind":%s,"position":%s}',
        format('{"esb_id":%s,"espn_id":%s,"nfl_id":%s,"pfr_id":%s,"smart_id":%s}',
          e->'projection'->'crosswalk'->'esb_id',e->'projection'->'crosswalk'->'espn_id',e->'projection'->'crosswalk'->'nfl_id',
          e->'projection'->'crosswalk'->'pfr_id',e->'projection'->'crosswalk'->'smart_id'),
        e->'projection'->'gsisId',e->'projection'->'kind',e->'projection'->'position')
      ELSE format('{"kickoff":%s,"kind":%s,"rawAwayTeam":%s,"rawGameId":%s,"rawGameday":%s,"rawGametime":%s,"rawHomeTeam":%s,"season":%s,"seasonType":%s,"week":%s}',
        e->'projection'->'kickoff',e->'projection'->'kind',e->'projection'->'rawAwayTeam',e->'projection'->'rawGameId',
        e->'projection'->'rawGameday',e->'projection'->'rawGametime',e->'projection'->'rawHomeTeam',e->'projection'->'season',
        e->'projection'->'seasonType',e->'projection'->'week') END,
    e->'rawKeySha256',e->'rowOrdinal',e->'selectedSha256'),',' ORDER BY n),'')||']','UTF8')),'hex')
FROM jsonb_array_elements(rows) WITH ORDINALITY x(e,n)
$$;

CREATE FUNCTION public.predictive_record_context_capture(id text,scope jsonb,rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.predictive_captures; a public.predictive_artifacts; p public.predictive_source_profiles;
  r public.predictive_ingestion_runs; item jsonb; projection jsonb; ordinal integer:=0; hash text; prior public.predictive_context_captures;
  local_time timestamp; utc_time timestamptz; matches integer;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_ingest','MEMBER') THEN RAISE EXCEPTION 'context-not-authorized' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation='public.predictive_context_captures'::regclass
      AND granted AND mode='ShareRowExclusiveLock') THEN RAISE EXCEPTION 'context-guard-required' USING ERRCODE='55000'; END IF;
  SELECT * INTO c FROM public.predictive_captures WHERE predictive_captures.id=predictive_record_context_capture.id;
  SELECT * INTO a FROM public.predictive_artifacts WHERE predictive_artifacts.id=c.artifact_id;
  SELECT * INTO p FROM public.predictive_source_profiles WHERE predictive_source_profiles.id=a.profile_id;
  SELECT * INTO r FROM public.predictive_ingestion_runs WHERE predictive_ingestion_runs.id=c.run_id;
  IF public.predictive_context_profile_valid(a.id) IS NOT TRUE OR c.state IS DISTINCT FROM 'published' OR r.status IS DISTINCT FROM 'published'
      OR r.code_version IS DISTINCT FROM 'nflverse-original-context-claims-v1' OR r.row_count<>c.parsed_rows
      OR NOT(c.body_complete AND c.header_verified AND c.parser_succeeded) OR c.available_at<>c.captured_at
      OR c.published_at IS NOT NULL OR c.publication_evidence IS NOT NULL OR c.captured_at>clock_timestamp() OR c.ingested_at>clock_timestamp()
      OR p.registered_at>clock_timestamp() OR (a.release_updated_at IS NOT NULL AND a.release_updated_at>c.captured_at)
      OR jsonb_typeof(rows) IS DISTINCT FROM 'array' OR jsonb_array_length(rows)<>c.parsed_rows
      OR c.parsed_rows NOT BETWEEN 1 AND 80000 OR octet_length(rows::text)>64000000 THEN
    RAISE EXCEPTION 'context-envelope-refused' USING ERRCODE='23514'; END IF;
  IF p.feed='identifiers' AND scope IS DISTINCT FROM 'null'::jsonb OR p.feed='schedule' AND (
      public.predictive_source_exact(scope,ARRAY['fromSeason','throughSeason']) IS NOT TRUE
      OR public.predictive_integer(scope->'fromSeason',1920,9997) IS NOT TRUE
      OR public.predictive_integer(scope->'throughSeason',1922,9999) IS NOT TRUE
      OR (scope->>'throughSeason')::integer-(scope->>'fromSeason')::integer<>2) THEN
    RAISE EXCEPTION 'context-scope-refused' USING ERRCODE='23514'; END IF;
  PERFORM public.predictive_blob_reference_guard((SELECT storage_ref FROM public.predictive_blobs WHERE sha256=a.blob_sha256));
  PERFORM public.predictive_compressed_source_access(p.id,c.captured_at);
  FOR item IN SELECT value FROM jsonb_array_elements(rows) LOOP
    ordinal:=ordinal+1; projection:=item->'projection';
    IF public.predictive_source_exact(item,ARRAY['id','rowOrdinal','rawKeySha256','selectedSha256','projection','failureCode']) IS NOT TRUE
        OR public.predictive_integer(item->'rowOrdinal',ordinal,ordinal) IS NOT TRUE
        OR item->>'id' IS DISTINCT FROM 'context-row:'||public.predictive_source_digest(jsonb_build_array(c.id,ordinal))
        OR item->>'rawKeySha256'!~'^[a-f0-9]{64}$' OR jsonb_typeof(item->'rawKeySha256') IS DISTINCT FROM 'string'
        OR item->>'selectedSha256'!~'^[a-f0-9]{64}$' OR jsonb_typeof(item->'selectedSha256') IS DISTINCT FROM 'string'
        OR (projection='null'::jsonb) IS DISTINCT FROM (item->'failureCode'<>'null'::jsonb) THEN
      RAISE EXCEPTION 'context-row-refused' USING ERRCODE='23514'; END IF;
    IF projection='null'::jsonb THEN
      IF item->>'failureCode' NOT IN ('context-gsis-refused','context-position-refused','context-identifier-refused','context-schedule-refused',
          'context-kickoff-refused','source-kickoff-refused','context-season-out-of-scope','context-duplicate-key-conflict','context-reverse-identity-conflict') THEN
        RAISE EXCEPTION 'context-row-refused' USING ERRCODE='23514'; END IF;
    ELSE
      IF p.feed='identifiers' THEN
        IF public.predictive_source_exact(projection,ARRAY['kind','gsisId','position','crosswalk']) IS NOT TRUE
            OR projection->>'kind' IS DISTINCT FROM 'raw-player-identity' OR (projection->>'gsisId'~'^00-[0-9]{7}$') IS NOT TRUE
            OR (projection->>'position'~'^[A-Z][A-Z0-9/-]{0,15}$') IS NOT TRUE
            OR public.predictive_source_exact(projection->'crosswalk',ARRAY['nfl_id','espn_id','pfr_id','esb_id','smart_id']) IS NOT TRUE
            OR EXISTS(SELECT 1 FROM jsonb_each(projection->'crosswalk') x WHERE x.value<>'null'::jsonb
              AND (jsonb_typeof(x.value)<>'string' OR length(x.value#>>'{}') NOT BETWEEN 1 AND 128 OR (x.value#>>'{}')~'[[:cntrl:]]'))
            OR item->>'rawKeySha256' IS DISTINCT FROM public.predictive_source_digest(jsonb_build_array(p.feed,projection->>'gsisId')) THEN
          RAISE EXCEPTION 'context-row-refused' USING ERRCODE='23514'; END IF;
      ELSE
        IF public.predictive_source_exact(projection,ARRAY['kind','rawGameId','season','seasonType','week','rawHomeTeam','rawAwayTeam','rawGameday','rawGametime','kickoff']) IS NOT TRUE
            OR projection->>'kind' IS DISTINCT FROM 'raw-schedule' OR (projection->>'seasonType' IN ('REG','POST')) IS NOT TRUE
            OR public.predictive_integer(projection->'season',(scope->>'fromSeason')::integer,(scope->>'throughSeason')::integer) IS NOT TRUE
            OR public.predictive_integer(projection->'week',1,22) IS NOT TRUE OR public.predictive_instant(projection->>'kickoff') IS NOT TRUE
            OR projection->>'rawGameId' IS DISTINCT FROM (projection->>'season')||'_'||lpad(projection->>'week',2,'0')||'_'||(projection->>'rawAwayTeam')||'_'||(projection->>'rawHomeTeam')
            OR NOT EXISTS(SELECT 1 FROM public.predictive_teams WHERE predictive_teams.id='nfl:team:'||(projection->>'rawHomeTeam'))
            OR NOT EXISTS(SELECT 1 FROM public.predictive_teams WHERE predictive_teams.id='nfl:team:'||(projection->>'rawAwayTeam'))
            OR projection->>'rawHomeTeam'=projection->>'rawAwayTeam'
            OR item->>'rawKeySha256' IS DISTINCT FROM public.predictive_source_digest(jsonb_build_array(p.feed,projection->>'rawGameId')) THEN
          RAISE EXCEPTION 'context-row-refused' USING ERRCODE='23514'; END IF;
        IF (projection->>'rawGameday'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$') IS NOT TRUE
            OR (projection->>'rawGametime'~'^([01][0-9]|2[0-3]):[0-5][0-9]$') IS NOT TRUE
            OR left(projection->>'rawGameday',4)::integer NOT IN ((projection->>'season')::integer,(projection->>'season')::integer+1) THEN
          RAISE EXCEPTION 'context-kickoff-refused' USING ERRCODE='23514'; END IF;
        local_time:=((projection->>'rawGameday')||' '||(projection->>'rawGametime'))::timestamp;
        utc_time:=local_time AT TIME ZONE 'America/New_York';
        SELECT count(*) INTO matches FROM (VALUES(utc_time-interval '1 hour'),(utc_time),(utc_time+interval '1 hour')) t(k)
          WHERE k AT TIME ZONE 'America/New_York'=local_time;
        IF matches<>1 OR utc_time<>(projection->>'kickoff')::timestamptz THEN
          RAISE EXCEPTION 'context-kickoff-refused' USING ERRCODE='23514'; END IF;
      END IF;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(rows) e GROUP BY e->>'rawKeySha256'
      HAVING count(DISTINCT e->>'selectedSha256')>1 AND bool_or(e->'projection'<>'null'::jsonb)) OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(rows) e CROSS JOIN LATERAL jsonb_each(
        CASE WHEN e->'projection'->>'kind'='raw-player-identity' THEN e->'projection'->'crosswalk' ELSE '{}'::jsonb END) x
      WHERE x.value<>'null'::jsonb GROUP BY x.key,x.value HAVING count(DISTINCT e->'projection'->>'gsisId')>1) THEN
    RAISE EXCEPTION 'context-conflict-not-withheld' USING ERRCODE='23514'; END IF;
  hash:=public.predictive_context_claims_digest(rows);
  SELECT * INTO prior FROM public.predictive_context_captures WHERE capture_id=c.id;
  IF prior.capture_id IS NOT NULL THEN
    IF prior.request_hash<>r.request_sha256 OR prior.claims<>rows OR prior.season_range IS DISTINCT FROM scope THEN
      RAISE EXCEPTION 'context-capture-conflict' USING ERRCODE='23514'; END IF;
  ELSE
    INSERT INTO public.predictive_context_captures(capture_id,request_hash,season_range,claims,claims_sha256)
      VALUES(c.id,r.request_sha256,scope,rows,hash) RETURNING * INTO prior;
  END IF;
  PERFORM public.predictive_compressed_source_access(p.id,c.captured_at);
  RETURN jsonb_build_object('requestHash',prior.request_hash,'claimsSha256',prior.claims_sha256,'recordedAt',public.predictive_source_time(prior.recorded_at));
END $$;

CREATE FUNCTION public.predictive_context_capture_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE p text; captured timestamptz;
BEGIN
  IF EXISTS(SELECT 1 FROM public.predictive_artifacts a JOIN public.predictive_source_profiles s ON s.id=a.profile_id
      WHERE a.id=NEW.artifact_id AND s.parser_version='nflverse-original-context-qualification-v1') AND NEW.state='published' THEN
    IF NOT EXISTS(SELECT 1 FROM public.predictive_context_captures WHERE capture_id=NEW.id) THEN
      RAISE EXCEPTION 'context-seal-required' USING ERRCODE='23514'; END IF;
    SELECT profile_id INTO p FROM public.predictive_artifacts WHERE id=NEW.artifact_id;
    PERFORM public.predictive_compressed_source_access(p,NEW.captured_at);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER predictive_context_capture_check AFTER INSERT ON public.predictive_captures
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.predictive_context_capture_check();

CREATE FUNCTION public.predictive_context_run_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.code_version='nflverse-original-context-claims-v1' AND (NEW.status<>'published' OR NEW.artifact_count<>1 OR NEW.capture_count<>1
      OR (SELECT count(*) FROM public.predictive_captures WHERE run_id=NEW.id)<>1 OR NOT EXISTS(
        SELECT 1 FROM public.predictive_context_captures s JOIN public.predictive_captures c ON c.id=s.capture_id
        WHERE c.run_id=NEW.id AND c.state='published' AND c.parsed_rows=NEW.row_count AND jsonb_array_length(s.claims)=NEW.row_count
          AND s.request_hash=NEW.request_sha256 AND public.predictive_context_profile_valid(c.artifact_id))) THEN
    RAISE EXCEPTION 'context-run-seal-required' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER predictive_context_run_check AFTER INSERT ON public.predictive_ingestion_runs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.predictive_context_run_check();

CREATE FUNCTION public.predictive_read_context_capture(id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb; profile text; captured timestamptz;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_replay','MEMBER') THEN RAISE EXCEPTION 'context-not-authorized' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation='public.predictive_context_captures'::regclass AND granted AND mode='ShareLock') THEN
    RAISE EXCEPTION 'context-guard-required' USING ERRCODE='55000'; END IF;
  SELECT jsonb_build_object('captureId',c.id,'runId',c.run_id,'capturedAt',public.predictive_source_time(c.captured_at),
    'ingestedAt',public.predictive_source_time(c.ingested_at),'artifactId',a.id,'profileId',a.profile_id,'wireSha256',b.sha256,
    'wireBytes',b.byte_size,'storageRef',b.storage_ref,'origin',a.origin,'providerEtag',a.provider_etag,'providerLastModified',a.provider_last_modified,
    'releaseUpdatedAt',CASE WHEN a.release_updated_at IS NULL THEN NULL ELSE public.predictive_source_time(a.release_updated_at) END,
    'seasonRange',s.season_range,'claims',s.claims,'claimsSha256',s.claims_sha256,'recordedAt',public.predictive_source_time(s.recorded_at),
    'hasAssociations',EXISTS(SELECT 1 FROM public.predictive_context_associations links WHERE links.capture_id=c.id))
    ,a.profile_id,c.captured_at INTO result,profile,captured FROM public.predictive_context_captures s
    JOIN public.predictive_captures c ON c.id=s.capture_id JOIN public.predictive_artifacts a ON a.id=c.artifact_id
    JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256 WHERE c.id=predictive_read_context_capture.id;
  IF result IS NULL THEN RETURN NULL; END IF;
  PERFORM public.predictive_compressed_source_access(profile,captured);
  RETURN result;
END $$;

-- Independent reconstruction from sealed raw claims and actual database heads.
-- Caller digests certify identity only; they never authorize a revision payload.
CREATE FUNCTION public.predictive_context_revision(profile text,capture text,claim text,kind text,data jsonb,expected text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE source_record text; heads jsonb; head jsonb;
BEGIN
  source_record:='original-context:'||kind||':'||(data->>'rawGameId');
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',o.id,'kind',o.kind,'sourceRecordId',o.source_record_id,
    'predecessorId',o.predecessor_id,'correctionReason',o.correction_reason,'data',o.data)),'[]'::jsonb) INTO heads
    FROM public.predictive_observations o WHERE o.profile_id=profile AND o.kind=predictive_context_revision.kind
      AND o.source_record_id=source_record AND NOT EXISTS(SELECT 1 FROM public.predictive_observations n WHERE n.predecessor_id=o.id);
  IF jsonb_array_length(heads)>1 THEN RAISE EXCEPTION 'context-association-head-refused' USING ERRCODE='23514'; END IF;
  head:=heads->0;
  IF head->>'id' IS DISTINCT FROM expected OR head IS NOT NULL AND head->'data'->>'gameId' IS DISTINCT FROM data->>'gameId' THEN
    RAISE EXCEPTION 'context-association-head-refused' USING ERRCODE='23514'; END IF;
  IF head->'data'=data THEN RETURN head; END IF;
  RETURN jsonb_build_object('id','context-observation:'||public.predictive_source_digest(jsonb_build_array(
    'nflverse-original-schedule-associations-v1',capture,claim,kind,data,head->>'id')),
    'kind',kind,'sourceRecordId',source_record,'predecessorId',head->>'id',
    'correctionReason',CASE WHEN head IS NULL THEN NULL ELSE 'original-context-source-update' END,'data',data);
END $$;

CREATE FUNCTION public.predictive_record_context_associations(id text,basis jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.predictive_captures; a public.predictive_artifacts; s public.predictive_context_captures;
  prior public.predictive_context_associations; item jsonb; row jsonb; p jsonb; schedule jsonb; bridge jsonb;
  checked jsonb:='[]'::jsonb; ids text[]:='{}'; keys text[]:='{}'; games text[]:='{}'; revision jsonb; hash text;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_ingest','MEMBER') THEN RAISE EXCEPTION 'context-not-authorized' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation='public.predictive_context_associations'::regclass
    AND granted AND mode='ShareRowExclusiveLock') THEN RAISE EXCEPTION 'context-guard-required' USING ERRCODE='55000'; END IF;
  SELECT * INTO c FROM public.predictive_captures WHERE predictive_captures.id=predictive_record_context_associations.id;
  SELECT * INTO a FROM public.predictive_artifacts WHERE predictive_artifacts.id=c.artifact_id;
  SELECT * INTO s FROM public.predictive_context_captures WHERE capture_id=c.id;
  IF s.capture_id IS NULL OR NOT public.predictive_context_profile_valid(a.id)
    OR (SELECT feed FROM public.predictive_source_profiles WHERE predictive_source_profiles.id=a.profile_id)<>'schedule'
    OR public.predictive_source_exact(basis,ARRAY['version','captureId','sourceRequestHash','claimsSha256','bindings']) IS NOT TRUE
    OR basis->>'version' IS DISTINCT FROM 'nflverse-original-schedule-associations-v1'
    OR basis->>'captureId' IS DISTINCT FROM c.id OR basis->>'sourceRequestHash' IS DISTINCT FROM s.request_hash
    OR basis->>'claimsSha256' IS DISTINCT FROM s.claims_sha256 OR jsonb_typeof(basis->'bindings') IS DISTINCT FROM 'array'
    OR jsonb_array_length(basis->'bindings') NOT BETWEEN 1 AND 256 OR octet_length(basis::text)>2000000 THEN
    RAISE EXCEPTION 'context-association-envelope-refused' USING ERRCODE='23514'; END IF;
  PERFORM public.predictive_compressed_source_access(a.profile_id,c.captured_at);
  hash:=public.predictive_source_digest(basis);
  SELECT * INTO prior FROM public.predictive_context_associations WHERE capture_id=c.id;
  IF prior.capture_id IS NOT NULL THEN
    IF prior.basis<>basis THEN RAISE EXCEPTION 'context-association-conflict' USING ERRCODE='23514'; END IF;
    RETURN jsonb_build_object('associationSha256',prior.association_sha256,'recordedAt',public.predictive_source_time(prior.recorded_at));
  END IF;
  -- A committed raw capture/artifact cannot acquire later facts. Both must be
  -- created in THIS transaction, with the normal server ingestion-clock trigger.
  IF NOT EXISTS(SELECT 1 FROM public.predictive_captures WHERE predictive_captures.id=c.id AND xmin=pg_current_xact_id()::xid)
    OR NOT EXISTS(SELECT 1 FROM public.predictive_artifacts WHERE predictive_artifacts.id=a.id AND xmin=pg_current_xact_id()::xid)
    OR NOT EXISTS(SELECT 1 FROM public.predictive_ingestion_runs WHERE predictive_ingestion_runs.id=c.run_id AND xmin=pg_current_xact_id()::xid)
    OR EXISTS(SELECT 1 FROM public.predictive_captures WHERE artifact_id=a.id AND predictive_captures.id<>c.id) THEN
    RAISE EXCEPTION 'context-association-new-capture-required' USING ERRCODE='23514'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(basis->'bindings') LOOP
    SELECT value INTO row FROM jsonb_array_elements(s.claims) WHERE value->>'id'=item->>'claimId'; p:=row->'projection';
    IF row IS NULL OR p->>'kind' IS DISTINCT FROM 'raw-schedule' OR row->'failureCode'<>'null'::jsonb
      OR item->>'claimId'=ANY(ids) OR row->>'rawKeySha256'=ANY(keys) OR item->'schedule'->'data'->>'gameId'=ANY(games) THEN
      RAISE EXCEPTION 'context-association-claim-refused' USING ERRCODE='23514'; END IF;
    ids:=array_append(ids,item->>'claimId'); keys:=array_append(keys,row->>'rawKeySha256'); games:=array_append(games,item->'schedule'->'data'->>'gameId');
    schedule:=jsonb_build_object('gameId',item->'schedule'->'data'->>'gameId','rawGameId',p->'rawGameId','season',p->'season',
      'seasonType',p->'seasonType','week',p->'week','kickoff',p->'kickoff','rawGameday',p->'rawGameday','rawGametime',p->'rawGametime',
      'homeTeamId','nfl:team:'||(p->>'rawHomeTeam'),'awayTeamId','nfl:team:'||(p->>'rawAwayTeam'),
      'rawHomeTeam',p->'rawHomeTeam','rawAwayTeam',p->'rawAwayTeam','rawRoof',NULL,'rawSurface',NULL,'rawStadiumId',NULL);
    bridge:=jsonb_build_object('provider','nflverse','rawGameId',p->'rawGameId','gameId',schedule->'gameId');
    IF (schedule->>'gameId'~'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') IS NOT TRUE THEN
      RAISE EXCEPTION 'context-association-identity-refused' USING ERRCODE='23514'; END IF;
    checked:=checked||jsonb_build_array(jsonb_build_object('claimId',row->'id','rowOrdinal',row->'rowOrdinal',
      'rawKeySha256',row->'rawKeySha256','selectedSha256',row->'selectedSha256',
      'expectedScheduleHead',item->'expectedScheduleHead','expectedBridgeHead',item->'expectedBridgeHead',
      'schedule',public.predictive_context_revision(a.profile_id,c.id,row->>'id','schedule',schedule,item->>'expectedScheduleHead'),
      'bridge',public.predictive_context_revision(a.profile_id,c.id,row->>'id','game-bridge',bridge,item->>'expectedBridgeHead')));
  END LOOP;
  SELECT jsonb_agg(value ORDER BY value->>'claimId' COLLATE "C") INTO checked FROM jsonb_array_elements(checked);
  IF basis->'bindings' IS DISTINCT FROM checked THEN RAISE EXCEPTION 'context-association-proof-refused' USING ERRCODE='23514'; END IF;
  -- One logical recording instant for this atomic publication: the fresh
  -- capture's server-stamped ingestion clock is also the native reader cutoff.
  INSERT INTO public.predictive_context_associations(capture_id,artifact_id,basis,association_sha256,recorded_at)
    VALUES(c.id,a.id,basis,hash,c.ingested_at) RETURNING * INTO prior;
  FOR revision IN SELECT value->'schedule' FROM jsonb_array_elements(checked) UNION ALL SELECT value->'bridge' FROM jsonb_array_elements(checked) LOOP
    INSERT INTO public.predictive_games VALUES((revision->'data'->>'gameId')::uuid) ON CONFLICT DO NOTHING;
    INSERT INTO public.predictive_observations(id,kind,profile_id,source_record_id,data,entity_key,source_key,predecessor_id,correction_reason)
      VALUES(revision->>'id',revision->>'kind',a.profile_id,revision->>'sourceRecordId',revision->'data',
        public.predictive_entity_key(revision->>'kind',revision->'data'),
        public.predictive_entity_key(revision->>'kind',revision->'data')||'|'||a.profile_id||'|'||(revision->>'sourceRecordId'),
        revision->>'predecessorId',revision->>'correctionReason') ON CONFLICT ON CONSTRAINT predictive_observations_pkey DO NOTHING;
    IF NOT EXISTS(SELECT 1 FROM public.predictive_observations o WHERE o.id=revision->>'id' AND o.profile_id=a.profile_id AND
      jsonb_build_object('id',o.id,'kind',o.kind,'sourceRecordId',o.source_record_id,'predecessorId',o.predecessor_id,
        'correctionReason',o.correction_reason,'data',o.data)=revision) THEN
      RAISE EXCEPTION 'context-association-observation-conflict' USING ERRCODE='23514'; END IF;
    INSERT INTO public.predictive_artifact_observations VALUES(a.id,revision->>'id');
  END LOOP;
  RETURN jsonb_build_object('associationSha256',hash,'recordedAt',public.predictive_source_time(prior.recorded_at));
END $$;

CREATE FUNCTION public.predictive_context_association_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actual jsonb; expected jsonb; profile text; captured timestamptz;
BEGIN
  SELECT jsonb_agg(observation_id ORDER BY observation_id COLLATE "C") INTO actual
    FROM public.predictive_artifact_observations WHERE artifact_id=NEW.artifact_id;
  SELECT jsonb_agg(id ORDER BY id COLLATE "C") INTO expected FROM (
    SELECT value->'schedule'->>'id' AS id FROM jsonb_array_elements(NEW.basis->'bindings')
    UNION SELECT value->'bridge'->>'id' FROM jsonb_array_elements(NEW.basis->'bindings')) x;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'context-association-set-refused' USING ERRCODE='23514'; END IF;
  SELECT a.profile_id,c.captured_at INTO profile,captured FROM public.predictive_captures c JOIN public.predictive_artifacts a ON a.id=c.artifact_id WHERE c.id=NEW.capture_id;
  PERFORM public.predictive_compressed_source_access(profile,captured);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER predictive_context_association_check AFTER INSERT ON public.predictive_context_associations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.predictive_context_association_check();

CREATE FUNCTION public.predictive_read_context_associations(id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE raw jsonb; result jsonb;
BEGIN
  -- This accessor also enforces the shared guard and fresh current rights.
  raw:=public.predictive_read_context_capture(id);
  IF raw IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation='public.predictive_context_associations'::regclass
    AND granted AND mode='ShareLock') THEN RAISE EXCEPTION 'context-guard-required' USING ERRCODE='55000'; END IF;
  SELECT jsonb_build_object('raw',raw||jsonb_build_object('requestHash',c.request_hash),
    'basis',s.basis,'associationSha256',s.association_sha256,'recordedAt',public.predictive_source_time(s.recorded_at),
    'heads',coalesce((SELECT jsonb_agg(jsonb_build_object('id',o.id,'kind',o.kind,'sourceRecordId',o.source_record_id,
      'predecessorId',o.predecessor_id,'correctionReason',o.correction_reason,'data',o.data) ORDER BY o.id COLLATE "C")
      FROM public.predictive_observations o WHERE o.id IN (
        SELECT value->>'expectedScheduleHead' FROM jsonb_array_elements(s.basis->'bindings')
        UNION SELECT value->>'expectedBridgeHead' FROM jsonb_array_elements(s.basis->'bindings'))),'[]'::jsonb),
    'observationIds',(SELECT jsonb_agg(l.observation_id ORDER BY l.observation_id COLLATE "C")
      FROM public.predictive_artifact_observations l WHERE l.artifact_id=s.artifact_id),
    'revisions',(SELECT jsonb_agg(jsonb_build_object('id',o.id,'kind',o.kind,'sourceRecordId',o.source_record_id,
      'predecessorId',o.predecessor_id,'correctionReason',o.correction_reason,'data',o.data) ORDER BY o.id COLLATE "C")
      FROM public.predictive_artifact_observations l JOIN public.predictive_observations o ON o.id=l.observation_id WHERE l.artifact_id=s.artifact_id)) INTO result
    FROM public.predictive_context_associations s JOIN public.predictive_context_captures c ON c.capture_id=s.capture_id
    WHERE s.capture_id=predictive_read_context_associations.id;
  RETURN result;
END $$;

-- Exact sealed links only. The raw/native route stays closed for every other
-- observation and for earlier, already-committed raw artifacts.
CREATE FUNCTION public.predictive_context_canonical_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.predictive_artifacts a JOIN public.predictive_source_profiles p ON p.id=a.profile_id
      WHERE a.id=NEW.artifact_id AND p.parser_version='nflverse-original-context-qualification-v1') AND NOT EXISTS(
      SELECT 1 FROM public.predictive_context_associations s CROSS JOIN LATERAL jsonb_array_elements(s.basis->'bindings') b
      WHERE s.artifact_id=NEW.artifact_id AND NEW.observation_id IN (b->'schedule'->>'id',b->'bridge'->>'id')) THEN
    RAISE EXCEPTION 'context-canonical-association-not-qualified' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER predictive_context_canonical_guard BEFORE INSERT ON public.predictive_artifact_observations
 FOR EACH ROW EXECUTE FUNCTION public.predictive_context_canonical_guard();

REVOKE ALL ON FUNCTION public.predictive_context_immutable(),public.predictive_context_profile_valid(text),
 public.predictive_context_guard(),public.predictive_record_context_capture(text,jsonb,jsonb),public.predictive_context_capture_check(),public.predictive_context_run_check(),
 public.predictive_read_context_capture(text),public.predictive_context_access(text,timestamptz),public.predictive_context_claims_digest(jsonb),public.predictive_context_canonical_guard(),public.predictive_training_read_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.predictive_context_guard(),public.predictive_record_context_capture(text,jsonb,jsonb) TO predictive_ingest;
GRANT EXECUTE ON FUNCTION public.predictive_read_context_capture(text),public.predictive_training_read_guard() TO predictive_replay;
GRANT EXECUTE ON FUNCTION public.predictive_context_access(text,timestamptz) TO predictive_ingest,predictive_replay;
REVOKE ALL ON FUNCTION public.predictive_context_revision(text,text,text,text,jsonb,text),
 public.predictive_record_context_associations(text,jsonb),public.predictive_context_association_check(),public.predictive_context_association_immutable() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.predictive_record_context_associations(text,jsonb) TO predictive_ingest;
REVOKE ALL ON FUNCTION public.predictive_read_context_associations(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.predictive_read_context_associations(text) TO predictive_replay;
