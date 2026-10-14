-- Qualified raw gzip claims only. No canonical observations, bindings, features
-- or labels are activated. Legacy CSV tables/limits remain unchanged.
ALTER TABLE public.predictive_ingestion_runs DROP CONSTRAINT predictive_ingestion_runs_row_count_check;
ALTER TABLE public.predictive_ingestion_runs ADD CONSTRAINT predictive_ingestion_runs_row_count_check
  CHECK(row_count BETWEEN 0 AND 8192 OR (code_version='nflverse-gzip-csv-source-claims-v1' AND row_count BETWEEN 1 AND 80000));
CREATE TABLE public.predictive_compressed_publications (
  capture_id text PRIMARY KEY REFERENCES public.predictive_captures(id),
  version text NOT NULL CHECK(version='nflverse-gzip-csv-source-claims-v1'),
  request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
  claims_sha256 text NOT NULL CHECK(claims_sha256~'^[a-f0-9]{64}$'),
  claims jsonb NOT NULL CHECK(jsonb_typeof(claims)='array' AND jsonb_array_length(claims) BETWEEN 1 AND 80000),
  recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at))
);
CREATE TABLE public.predictive_compressed_retention_audits (
  event_id text NOT NULL REFERENCES public.predictive_retention_events(id),
  capture_digest text NOT NULL CHECK(capture_digest~'^[a-f0-9]{64}$'),
  removed_rows integer NOT NULL CHECK(removed_rows BETWEEN 1 AND 80000),
  removed_ids_digest text NOT NULL CHECK(removed_ids_digest~'^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
  PRIMARY KEY(event_id,capture_digest)
);
CREATE TRIGGER predictive_compressed_publications_immutable BEFORE UPDATE OR DELETE ON public.predictive_compressed_publications
  FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_compressed_publications_no_truncate BEFORE TRUNCATE ON public.predictive_compressed_publications
  FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_compressed_retention_audits_immutable BEFORE UPDATE OR DELETE ON public.predictive_compressed_retention_audits
  FOR EACH ROW EXECUTE FUNCTION public.predictive_retention_audit_immutable();
CREATE TRIGGER predictive_compressed_retention_audits_no_truncate BEFORE TRUNCATE ON public.predictive_compressed_retention_audits
  FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_retention_audit_immutable();

CREATE FUNCTION public.predictive_compressed_profile_valid(artifact text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT coalesce((SELECT p.provider='nflverse' AND p.purpose IN ('source','synthetic-test')
    AND p.feed IN ('player','team') AND p.parser_version='nflverse-gzip-csv-source-qualification-v1'
    AND p.allowlist_version='predictive-raw-allowlist-v1' AND p.release_tag='stats_'||p.feed
    AND a.scope_season IN (2025,2026) AND a.scope_kind='season-file' AND a.scope_filter IS NULL
    AND a.scope_week IS NULL AND a.scope_game_id IS NULL AND a.retrieval_kind='full'
    AND p.asset_pattern='stats_'||p.feed||'_week_'||a.scope_season||'.csv.gz'
    AND a.origin='https://github.com/nflverse/nflverse-data/releases/download/'||p.release_tag||'/'||p.asset_pattern
    AND p.header_profile_sha256=CASE p.feed WHEN 'player' THEN 'd3b3c633d85281035f40d96b180cb4e6231d8ed54e836896c4a832c4e012f42e'
      ELSE '9e7fda4bb987d8b3d7a8b218a830e1340af30ae832e5eabe7bdaa451dec82d7f' END
    AND p.evidence_kinds=ARRAY[CASE p.feed WHEN 'player' THEN 'player-game-stats' ELSE 'team-game-stats' END]
    AND b.media_type='application/gzip' AND b.byte_size BETWEEN 1 AND 8000000
    FROM public.predictive_artifacts a JOIN public.predictive_source_profiles p ON p.id=a.profile_id
      JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256 WHERE a.id=artifact),false);
$$;

CREATE OR REPLACE FUNCTION public.predictive_compressed_capture_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.state<>'incomplete' AND EXISTS(SELECT 1 FROM public.predictive_artifacts a
    JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256 WHERE a.id=NEW.artifact_id AND b.media_type='application/gzip')
    AND public.predictive_compressed_profile_valid(NEW.artifact_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'predictive-compressed-publication-not-qualified' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;

-- Reuse unchanged legacy numeric/missingness validation for the new year. The
-- original raw key/year remain stored; only this boolean shape check is rebased.
CREATE FUNCTION public.predictive_compressed_projection_valid(data jsonb,feed text,season integer) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF season NOT IN (2025,2026) OR data->>'feed' IS DISTINCT FROM feed
      OR public.predictive_integer(data->'season',season,season) IS NOT TRUE
      OR left(data->>'rawGameId',5) IS DISTINCT FROM season::text||'_' THEN RETURN false; END IF;
  RETURN public.predictive_source_projection_valid(data||jsonb_build_object('season',2026,
    'rawGameId','2026'||substr(data->>'rawGameId',5))) IS TRUE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END
$$;

CREATE FUNCTION public.predictive_compressed_write_guard() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT pg_has_role(session_user,'predictive_ingest','MEMBER') THEN RAISE EXCEPTION 'compressed-publication-not-authorized' USING ERRCODE='42501'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN
    RAISE EXCEPTION 'compressed-publication-transaction-refused' USING ERRCODE='25000'; END IF;
  PERFORM pg_advisory_xact_lock(520052,1);
  LOCK TABLE
    public.predictive_artifact_observations,
    public.predictive_artifacts,
    public.predictive_blob_removals,
    public.predictive_blobs,
    public.predictive_captures,
    public.predictive_decision_inputs,
    public.predictive_decisions,
    public.predictive_feature_run_dependencies,
    public.predictive_feature_run_pins,
    public.predictive_feature_run_unpins,
    public.predictive_feature_runs,
    public.predictive_games,
    public.predictive_ingestion_runs,
    public.predictive_observations,
    public.predictive_outcome_labels,
    public.predictive_profile_identity_links,
    public.predictive_retention_authorizations,
    public.predictive_retention_events,
    public.predictive_retention_tombstones,
    public.predictive_rights_decisions,
    public.predictive_run_rights,
    public.predictive_source_binding_captures,
    public.predictive_source_binding_decisions,
    public.predictive_source_binding_dependencies,
    public.predictive_source_binding_links,
    public.predictive_source_binding_rights,
    public.predictive_source_binding_rows,
    public.predictive_source_bindings,
    public.predictive_source_consumer_bindings,
    public.predictive_source_consumer_decisions,
    public.predictive_source_consumer_observations,
    public.predictive_source_consumer_rights,
    public.predictive_source_consumer_source_decisions,
    public.predictive_source_consumers,
    public.predictive_source_decision_bindings,
    public.predictive_source_decision_inputs,
    public.predictive_source_decision_rights,
    public.predictive_source_decisions,
    public.predictive_source_profiles,
    public.predictive_source_stats_revisions,
    public.predictive_source_stats_rows,
    public.predictive_teams
    IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.predictive_training_run_identities,public.predictive_training_runs,public.predictive_training_run_events,
    public.predictive_training_run_slots,public.predictive_training_run_profiles,public.predictive_training_retention_audits IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.predictive_compressed_inspections IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.predictive_training_dataset_identities,public.predictive_training_datasets,public.predictive_training_dataset_consumers,
    public.predictive_training_pin_identities,public.predictive_training_dataset_pins,public.predictive_training_dataset_releases,
    public.predictive_training_dataset_retention_audits IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.predictive_compressed_publications,public.predictive_compressed_retention_audits IN SHARE ROW EXCLUSIVE MODE;
  RETURN public.predictive_source_time(date_trunc('milliseconds',clock_timestamp()));
END
$$;

CREATE FUNCTION public.predictive_compressed_source_access(profile text,captured timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT (pg_has_role(session_user,'predictive_ingest','MEMBER') OR pg_has_role(session_user,'predictive_replay','MEMBER')) THEN
    RAISE EXCEPTION 'compressed-publication-not-authorized' USING ERRCODE='42501'; END IF;
  IF NOT public.predictive_rights_allow(profile,clock_timestamp(),clock_timestamp(),'internal-research')
      OR NOT public.predictive_rights_allow(profile,captured,captured,'internal-research') THEN
    RAISE EXCEPTION 'compressed-publication-rights-refused' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM public.predictive_retention_events WHERE scope_descriptor->>'kind'='source'
      AND scope_descriptor->'profileIds' ? profile
      AND (scope_descriptor->>'capturedFrom' IS NULL OR captured>=(scope_descriptor->>'capturedFrom')::timestamptz)
      AND (scope_descriptor->>'capturedBefore' IS NULL OR captured<(scope_descriptor->>'capturedBefore')::timestamptz)) THEN
    RAISE EXCEPTION 'compressed-publication-erased-source' USING ERRCODE='23514'; END IF;
END
$$;

CREATE FUNCTION public.predictive_record_compressed_publication(id text,proof jsonb,rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.predictive_captures; a public.predictive_artifacts; p public.predictive_source_profiles; b public.predictive_blobs;
  r public.predictive_ingestion_runs; item jsonb; ordinal integer; raw_key text; seal public.predictive_compressed_publications; hash text;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_ingest','MEMBER') THEN RAISE EXCEPTION 'compressed-publication-not-authorized' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation='public.predictive_compressed_publications'::regclass
      AND mode='ShareRowExclusiveLock' AND granted) THEN RAISE EXCEPTION 'compressed-publication-guard-required' USING ERRCODE='55000'; END IF;
  SELECT * INTO c FROM public.predictive_captures WHERE predictive_captures.id=predictive_record_compressed_publication.id;
  SELECT * INTO a FROM public.predictive_artifacts WHERE predictive_artifacts.id=c.artifact_id;
  SELECT * INTO p FROM public.predictive_source_profiles WHERE predictive_source_profiles.id=a.profile_id;
  SELECT * INTO b FROM public.predictive_blobs WHERE sha256=a.blob_sha256;
  SELECT * INTO r FROM public.predictive_ingestion_runs WHERE predictive_ingestion_runs.id=c.run_id;
  IF public.predictive_compressed_profile_valid(a.id) IS NOT TRUE OR c.state IS DISTINCT FROM 'published' OR r.status IS DISTINCT FROM 'published'
      OR r.code_version IS DISTINCT FROM 'nflverse-gzip-csv-source-claims-v1' OR r.row_count<>c.parsed_rows
      OR NOT(c.body_complete AND c.header_verified AND c.parser_succeeded) OR c.available_at<>c.captured_at OR c.published_at IS NOT NULL
      OR c.publication_evidence IS NOT NULL OR c.captured_at>clock_timestamp() OR c.ingested_at>clock_timestamp()
      OR p.registered_at>clock_timestamp() OR (a.release_updated_at IS NOT NULL AND a.release_updated_at>c.captured_at)
      OR public.predictive_compressed_proof_valid(proof) IS NOT TRUE
      OR proof->>'wireSha256' IS DISTINCT FROM b.sha256 OR (proof->>'wireBytes')::integer<>b.byte_size
      OR proof->>'feed' IS DISTINCT FROM p.feed OR (proof->>'season')::integer<>a.scope_season
      OR proof->>'headerSha256' IS DISTINCT FROM p.header_profile_sha256 OR (proof->>'rows')::integer<>c.parsed_rows
      OR jsonb_typeof(rows) IS DISTINCT FROM 'array' OR jsonb_array_length(rows)<>c.parsed_rows OR c.parsed_rows NOT BETWEEN 1 AND 80000
      OR octet_length(rows::text)>64000000 THEN RAISE EXCEPTION 'compressed-publication-envelope-refused' USING ERRCODE='23514'; END IF;
  PERFORM public.predictive_blob_reference_guard(b.storage_ref);
  PERFORM public.predictive_compressed_source_access(p.id,c.captured_at);
  IF NOT public.predictive_rights_allow(p.id,clock_timestamp(),clock_timestamp(),'internal-research')
      OR NOT public.predictive_rights_allow(p.id,c.captured_at,c.captured_at,'internal-research') THEN
    RAISE EXCEPTION 'compressed-publication-rights-refused' USING ERRCODE='23514'; END IF;
  ordinal:=0;
  FOR item IN SELECT value FROM jsonb_array_elements(rows) LOOP
    ordinal:=ordinal+1;
    IF public.predictive_source_exact(item,ARRAY['id','rowOrdinal','rawKeySha256','selectedSha256','projection','failureCode']) IS NOT TRUE
        OR public.predictive_integer(item->'rowOrdinal',ordinal,ordinal) IS NOT TRUE
        OR item->>'id' IS DISTINCT FROM 'source-row:'||public.predictive_source_digest(jsonb_build_array(c.id,ordinal))
        OR jsonb_typeof(item->'rawKeySha256') IS DISTINCT FROM 'string' OR item->>'rawKeySha256'!~'^[a-f0-9]{64}$'
        OR jsonb_typeof(item->'selectedSha256') IS DISTINCT FROM 'string' OR item->>'selectedSha256'!~'^[a-f0-9]{64}$'
        OR (item->'projection'='null'::jsonb) IS DISTINCT FROM (item->'failureCode'<>'null'::jsonb) THEN
      RAISE EXCEPTION 'compressed-publication-row-refused' USING ERRCODE='23514'; END IF;
    IF item->'projection'='null'::jsonb THEN
      IF item->>'failureCode' NOT IN ('source-stats-context-refused','source-stats-player-refused','source-number-refused',
          'source-stats-denominator-refused','source-stats-scope-refused') THEN RAISE EXCEPTION 'compressed-publication-row-refused' USING ERRCODE='23514'; END IF;
    ELSE
      IF public.predictive_compressed_projection_valid(item->'projection',p.feed,a.scope_season) IS NOT TRUE THEN
        RAISE EXCEPTION 'compressed-publication-row-refused' USING ERRCODE='23514'; END IF;
      raw_key:=public.predictive_source_digest(CASE p.feed WHEN 'player' THEN jsonb_build_array(item->'projection'->>'rawGameId',item->'projection'->>'rawTeam',item->'projection'->>'rawPlayerId')
        ELSE jsonb_build_array(item->'projection'->>'rawGameId',item->'projection'->>'rawTeam') END);
      IF item->>'rawKeySha256'<>raw_key THEN RAISE EXCEPTION 'compressed-publication-row-refused' USING ERRCODE='23514'; END IF;
    END IF;
  END LOOP;
  hash:=public.predictive_source_digest(rows);
  SELECT * INTO seal FROM public.predictive_compressed_publications WHERE capture_id=c.id;
  IF seal.capture_id IS NOT NULL THEN
    IF seal.request_hash<>r.request_sha256 OR seal.claims_sha256<>hash OR seal.claims IS DISTINCT FROM rows
        OR (SELECT i.proof FROM public.predictive_compressed_inspections i WHERE i.capture_id=c.id) IS DISTINCT FROM proof THEN
      RAISE EXCEPTION 'compressed-publication-conflict' USING ERRCODE='23514'; END IF;
  ELSE
    INSERT INTO public.predictive_compressed_inspections VALUES(c.id,proof,date_trunc('milliseconds',clock_timestamp()));
    INSERT INTO public.predictive_compressed_publications VALUES(c.id,'nflverse-gzip-csv-source-claims-v1',r.request_sha256,hash,rows,date_trunc('milliseconds',clock_timestamp())) RETURNING * INTO seal;
  END IF;
  IF NOT public.predictive_rights_allow(p.id,clock_timestamp(),clock_timestamp(),'internal-research') THEN
    RAISE EXCEPTION 'compressed-publication-rights-refused' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('requestHash',seal.request_hash,'claimsSha256',seal.claims_sha256,'recordedAt',public.predictive_source_time(seal.recorded_at));
END
$$;

-- Diagnostics must not become an alternate route around an executed source
-- erasure. Preserve the complete v15 checks before adding scope authorization.
ALTER FUNCTION public.predictive_record_compressed_inspection(text,jsonb) RENAME TO predictive_record_compressed_inspection_v15;
ALTER FUNCTION public.predictive_read_compressed_inspections(text[]) RENAME TO predictive_read_compressed_inspections_v15;
DO $label$ DECLARE source text; old_label text:='predictive_record_compressed_inspection.id'; BEGIN
  source:=pg_get_functiondef('public.predictive_record_compressed_inspection_v15(text,jsonb)'::regprocedure);
  IF (length(source)-length(replace(source,old_label,'')))/length(old_label)<>1 THEN
    RAISE EXCEPTION 'compressed-inspection-prefix-refused'; END IF;
  EXECUTE replace(source,old_label,'predictive_record_compressed_inspection_v15.id');
END $label$;
REVOKE ALL ON FUNCTION public.predictive_record_compressed_inspection_v15(text,jsonb),public.predictive_read_compressed_inspections_v15(text[]) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_ingest') THEN REVOKE ALL ON FUNCTION public.predictive_record_compressed_inspection_v15(text,jsonb) FROM predictive_ingest; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_replay') THEN REVOKE ALL ON FUNCTION public.predictive_read_compressed_inspections_v15(text[]) FROM predictive_replay; END IF;
END $$;
CREATE FUNCTION public.predictive_record_compressed_inspection(id text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb; item record;
BEGIN
  result:=public.predictive_record_compressed_inspection_v15(id,p);
  SELECT a.profile_id,c.captured_at INTO item FROM public.predictive_captures c JOIN public.predictive_artifacts a ON a.id=c.artifact_id WHERE c.id=predictive_record_compressed_inspection.id;
  PERFORM public.predictive_compressed_source_access(item.profile_id,item.captured_at);
  RETURN result;
END
$$;
CREATE FUNCTION public.predictive_read_compressed_inspections(ids text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb; item record;
BEGIN
  result:=public.predictive_read_compressed_inspections_v15(ids);
  FOR item IN SELECT a.profile_id,c.captured_at FROM public.predictive_captures c JOIN public.predictive_artifacts a ON a.id=c.artifact_id WHERE c.id=ANY(ids) LOOP
    PERFORM public.predictive_compressed_source_access(item.profile_id,item.captured_at);
  END LOOP;
  RETURN result;
END
$$;

CREATE FUNCTION public.predictive_compressed_publication_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.state='published' AND EXISTS(SELECT 1 FROM public.predictive_artifacts a JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256
      WHERE a.id=NEW.artifact_id AND b.media_type='application/gzip') AND NOT public.predictive_rights_allow(
      (SELECT profile_id FROM public.predictive_artifacts WHERE id=NEW.artifact_id),clock_timestamp(),clock_timestamp(),'internal-research') THEN
    RAISE EXCEPTION 'compressed-publication-rights-refused' USING ERRCODE='23514'; END IF;
  IF NEW.state='published' AND EXISTS(SELECT 1 FROM public.predictive_artifacts a JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256
      WHERE a.id=NEW.artifact_id AND b.media_type='application/gzip') AND NOT EXISTS(
      SELECT 1 FROM public.predictive_compressed_publications p JOIN public.predictive_compressed_inspections i ON i.capture_id=p.capture_id
      WHERE p.capture_id=NEW.id AND jsonb_array_length(p.claims)=NEW.parsed_rows) THEN
    RAISE EXCEPTION 'compressed-publication-seal-required' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER predictive_compressed_publication_check AFTER INSERT ON public.predictive_captures
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.predictive_compressed_publication_check();

CREATE FUNCTION public.predictive_compressed_run_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.code_version='nflverse-gzip-csv-source-claims-v1' AND (NEW.status<>'published' OR NEW.artifact_count<>1 OR NEW.capture_count<>1
      OR (SELECT count(*) FROM public.predictive_captures WHERE run_id=NEW.id)<>1 OR NOT EXISTS(
        SELECT 1 FROM public.predictive_compressed_publications p JOIN public.predictive_captures c ON c.id=p.capture_id
        WHERE c.run_id=NEW.id AND c.state='published' AND c.parsed_rows=NEW.row_count AND jsonb_array_length(p.claims)=NEW.row_count
          AND p.request_hash=NEW.request_sha256 AND public.predictive_compressed_profile_valid(c.artifact_id))) THEN
    RAISE EXCEPTION 'compressed-publication-run-refused' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER predictive_compressed_run_check AFTER INSERT ON public.predictive_ingestion_runs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.predictive_compressed_run_check();

ALTER FUNCTION public.predictive_training_read_guard() RENAME TO predictive_training_dataset_guard;
REVOKE ALL ON FUNCTION public.predictive_training_dataset_guard() FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_replay') THEN
  REVOKE ALL ON FUNCTION public.predictive_training_dataset_guard() FROM predictive_replay; END IF; END $$;
CREATE FUNCTION public.predictive_training_read_guard() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM public.predictive_training_dataset_guard();
  LOCK TABLE public.predictive_compressed_publications,public.predictive_compressed_retention_audits IN SHARE MODE;
  RETURN public.predictive_source_time(date_trunc('milliseconds',clock_timestamp()));
END
$$;

CREATE FUNCTION public.predictive_read_compressed_publications(ids text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE metadata jsonb; result jsonb; item jsonb; publication public.predictive_compressed_publications;
BEGIN
  metadata:=public.predictive_read_compressed_inspections(ids);
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation='public.predictive_compressed_publications'::regclass AND mode='ShareLock' AND granted) THEN
    RAISE EXCEPTION 'compressed-publication-guard-required' USING ERRCODE='55000'; END IF;
  result:='[]';
  FOR item IN SELECT value FROM jsonb_array_elements(metadata) LOOP
    SELECT p.* INTO publication FROM public.predictive_compressed_publications p JOIN public.predictive_captures c ON c.id=p.capture_id
      JOIN public.predictive_ingestion_runs r ON r.id=c.run_id WHERE p.capture_id=item->>'captureId' AND c.state='published' AND r.status='published'
      AND public.predictive_compressed_profile_valid(c.artifact_id) AND p.request_hash=r.request_sha256;
    IF publication.capture_id IS NULL THEN RAISE EXCEPTION 'compressed-publication-missing' USING ERRCODE='23514'; END IF;
    PERFORM public.predictive_compressed_source_access((SELECT a.profile_id FROM public.predictive_captures c
      JOIN public.predictive_artifacts a ON a.id=c.artifact_id WHERE c.id=publication.capture_id),
      (SELECT captured_at FROM public.predictive_captures WHERE id=publication.capture_id));
    IF public.predictive_source_digest(publication.claims)<>publication.claims_sha256 THEN RAISE EXCEPTION 'compressed-publication-integrity-failed' USING ERRCODE='23514'; END IF;
    result:=result||jsonb_build_array(item||jsonb_build_object('publication',jsonb_build_object('requestHash',publication.request_hash,
      'claimsSha256',publication.claims_sha256,'recordedAt',public.predictive_source_time(publication.recorded_at))));
  END LOOP;
  RETURN result;
END
$$;

CREATE OR REPLACE FUNCTION public.predictive_compressed_capture_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE event_id text; publication public.predictive_compressed_publications; ids jsonb;
BEGIN
  IF EXISTS(SELECT 1 FROM public.predictive_compressed_inspections WHERE capture_id=OLD.id) THEN
    SELECT retention_event_id INTO event_id FROM public.predictive_retention_authorizations WHERE txid=pg_current_xact_id();
    IF NOT pg_has_role(session_user,'predictive_retention_owner','MEMBER') OR event_id IS NULL THEN
      RAISE EXCEPTION 'compressed-inspection-deletion-not-authorized' USING ERRCODE='42501'; END IF;
    SELECT * INTO publication FROM public.predictive_compressed_publications WHERE capture_id=OLD.id;
    IF publication.capture_id IS NOT NULL THEN
      SELECT jsonb_agg(value->>'id' ORDER BY value->>'id' COLLATE "C") INTO ids FROM jsonb_array_elements(publication.claims);
      INSERT INTO public.predictive_compressed_retention_audits VALUES(event_id,public.predictive_source_digest(to_jsonb(OLD.id)),
        jsonb_array_length(publication.claims),public.predictive_source_digest(ids),date_trunc('milliseconds',clock_timestamp()));
      DELETE FROM public.predictive_compressed_publications WHERE capture_id=OLD.id;
    END IF;
    DELETE FROM public.predictive_compressed_inspections WHERE capture_id=OLD.id;
  END IF;
  RETURN OLD;
END
$$;
CREATE FUNCTION public.predictive_compressed_retention_result(event text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_retention_owner','MEMBER') THEN RAISE EXCEPTION 'compressed-retention-not-authorized' USING ERRCODE='42501'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('captureDigest',capture_digest,'removedRows',removed_rows,'removedIdsDigest',removed_ids_digest)
    ORDER BY capture_digest COLLATE "C"),'[]') INTO result FROM public.predictive_compressed_retention_audits WHERE event_id=event;
  RETURN result;
END
$$;

REVOKE ALL ON TABLE public.predictive_compressed_publications,public.predictive_compressed_retention_audits FROM PUBLIC;
REVOKE ALL ON FUNCTION public.predictive_compressed_profile_valid(text),public.predictive_compressed_projection_valid(jsonb,text,integer),
  public.predictive_compressed_write_guard(),public.predictive_record_compressed_publication(text,jsonb,jsonb),
  public.predictive_compressed_source_access(text,timestamptz),
  public.predictive_record_compressed_inspection(text,jsonb),public.predictive_read_compressed_inspections(text[]),
  public.predictive_compressed_publication_check(),public.predictive_compressed_run_check(),public.predictive_training_read_guard(),public.predictive_read_compressed_publications(text[]),
  public.predictive_compressed_retention_result(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_ingest') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_compressed_write_guard(),public.predictive_record_compressed_publication(text,jsonb,jsonb),
      public.predictive_compressed_source_access(text,timestamptz),public.predictive_record_compressed_inspection(text,jsonb) TO predictive_ingest; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_replay') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_training_read_guard(),public.predictive_read_compressed_publications(text[]),
      public.predictive_read_compressed_inspections(text[]) TO predictive_replay; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_retention_owner') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_compressed_retention_result(text) TO predictive_retention_owner; END IF;
END $$;
