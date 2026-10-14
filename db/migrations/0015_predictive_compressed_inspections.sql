-- Codec diagnostics only: 0013 still refuses published gzip and canonical links.
-- SQL validates the envelope; the guarded reader reproduces it from wire bytes.
CREATE FUNCTION public.predictive_compressed_proof_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE k text;
BEGIN
  IF public.predictive_source_exact(p,ARRAY['codecVersion','feed','season','wireSha256','wireBytes','decodedSha256','decodedBytes',
      'headerSha256','selectedRecordsSha256','rows','inScopeRows','outOfScopeRows','limits','inspection','publicationSupported','featuresPublished','labelsFinalized']) IS NOT TRUE
      OR p->>'codecVersion' IS DISTINCT FROM 'nflverse-gzip-csv-inspection-v1'
      OR p->>'feed' IS NULL OR p->>'feed' NOT IN ('player','team','roster')
      OR p->'season' NOT IN ('2025'::jsonb,'2026'::jsonb)
      OR p->>'inspection' IS DISTINCT FROM 'complete-codec-proof-only'
      OR p->'publicationSupported' IS DISTINCT FROM 'false'::jsonb
      OR p->'featuresPublished' IS DISTINCT FROM 'false'::jsonb OR p->'labelsFinalized' IS DISTINCT FROM 'false'::jsonb
      OR p->'limits' IS DISTINCT FROM '{"wireBytes":8000000,"decodedBytes":20000000,"rows":80000,"recordBytes":65536,"elapsedMs":30000}'::jsonb THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['wireSha256','decodedSha256','headerSha256','selectedRecordsSha256'] LOOP
    IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR p->>k !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  END LOOP;
  IF public.predictive_integer(p->'wireBytes',1,8000000) IS NOT TRUE
      OR public.predictive_integer(p->'decodedBytes',1,20000000) IS NOT TRUE
      OR public.predictive_integer(p->'rows',1,80000) IS NOT TRUE
      OR public.predictive_integer(p->'inScopeRows',0,80000) IS NOT TRUE
      OR public.predictive_integer(p->'outOfScopeRows',0,80000) IS NOT TRUE THEN RETURN false; END IF;
  RETURN (p->>'inScopeRows')::integer+(p->>'outOfScopeRows')::integer=(p->>'rows')::integer;
END
$$;
CREATE TABLE public.predictive_compressed_inspections (
  capture_id text PRIMARY KEY REFERENCES public.predictive_captures(id),
  proof jsonb NOT NULL CHECK(public.predictive_compressed_proof_valid(proof)),
  recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at))
);
CREATE TRIGGER predictive_compressed_inspections_immutable BEFORE UPDATE OR DELETE ON public.predictive_compressed_inspections
  FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER predictive_compressed_inspections_no_truncate BEFORE TRUNCATE ON public.predictive_compressed_inspections
  FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();

CREATE FUNCTION public.predictive_record_compressed_inspection(id text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.predictive_captures; a public.predictive_artifacts; b public.predictive_blobs; profile public.predictive_source_profiles; prior jsonb;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_ingest','MEMBER') THEN RAISE EXCEPTION 'compressed-inspection-not-authorized' USING ERRCODE='42501'; END IF;
  IF public.predictive_compressed_proof_valid(p) IS NOT TRUE THEN RAISE EXCEPTION 'compressed-inspection-envelope-refused' USING ERRCODE='23514'; END IF;
  SELECT * INTO c FROM public.predictive_captures WHERE predictive_captures.id=predictive_record_compressed_inspection.id;
  SELECT * INTO a FROM public.predictive_artifacts WHERE predictive_artifacts.id=c.artifact_id;
  SELECT * INTO b FROM public.predictive_blobs WHERE sha256=a.blob_sha256;
  SELECT * INTO profile FROM public.predictive_source_profiles WHERE predictive_source_profiles.id=a.profile_id;
  IF c.id IS NULL OR c.state<>'incomplete' OR b.media_type<>'application/gzip'
      OR NOT(c.body_complete AND c.header_verified AND c.parser_succeeded) OR c.parsed_rows<>(p->>'rows')::integer
      OR b.sha256<>p->>'wireSha256' OR b.byte_size<>(p->>'wireBytes')::integer
      OR a.scope_kind<>'season-file' OR a.scope_filter IS NOT NULL OR a.scope_season<>(p->>'season')::integer
      OR profile.feed<>p->>'feed' OR profile.header_profile_sha256 IS DISTINCT FROM p->>'headerSha256' THEN
    RAISE EXCEPTION 'compressed-inspection-capture-mismatch' USING ERRCODE='23514'; END IF;
  PERFORM public.predictive_blob_reference_guard(b.storage_ref);
  PERFORM pg_advisory_xact_lock(520053,hashtext(profile.id));
  IF NOT public.predictive_rights_allow(profile.id,clock_timestamp(),clock_timestamp(),'internal-research')
      OR NOT public.predictive_rights_allow(profile.id,c.captured_at,c.captured_at,'internal-research') THEN
    RAISE EXCEPTION 'compressed-inspection-rights-refused' USING ERRCODE='23514'; END IF;
  SELECT proof INTO prior FROM public.predictive_compressed_inspections WHERE capture_id=c.id;
  IF prior IS NOT NULL THEN
    IF prior IS DISTINCT FROM p THEN RAISE EXCEPTION 'compressed-inspection-conflict' USING ERRCODE='23514'; END IF;
    RETURN prior;
  END IF;
  INSERT INTO public.predictive_compressed_inspections VALUES(c.id,p,date_trunc('milliseconds',clock_timestamp()));
  RETURN p;
END
$$;

ALTER FUNCTION public.predictive_training_read_guard() RENAME TO predictive_training_inventory_guard;
DO $revoke$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_replay') THEN
    REVOKE ALL ON FUNCTION public.predictive_training_inventory_guard() FROM predictive_replay;
  END IF;
END $revoke$;
CREATE FUNCTION public.predictive_training_read_guard() RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM public.predictive_training_inventory_guard();
  LOCK TABLE public.predictive_compressed_inspections IN SHARE MODE;
  RETURN public.predictive_source_time(date_trunc('milliseconds',clock_timestamp()));
END
$$;

CREATE FUNCTION public.predictive_read_compressed_inspections(ids text[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb; rel text; item record; t timestamptz:=clock_timestamp();
BEGIN
  IF NOT pg_has_role(session_user,'predictive_replay','MEMBER') THEN RAISE EXCEPTION 'compressed-inspection-not-authorized' USING ERRCODE='42501'; END IF;
  IF ids IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 64 OR array_ndims(ids)<>1
      OR EXISTS(SELECT 1 FROM unnest(ids) x WHERE x IS NULL OR length(x) NOT BETWEEN 1 AND 256 OR x~'[[:cntrl:]]')
      OR (SELECT count(DISTINCT x) FROM unnest(ids) x)<>cardinality(ids) THEN
    RAISE EXCEPTION 'compressed-inspection-request-refused' USING ERRCODE='23514'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN
    RAISE EXCEPTION 'compressed-inspection-transaction-refused' USING ERRCODE='25000'; END IF;
  FOREACH rel IN ARRAY ARRAY['predictive_compressed_inspections','predictive_captures','predictive_artifacts','predictive_blobs','predictive_rights_decisions','predictive_source_profiles'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation=to_regclass('public.'||rel)
        AND locktype='relation' AND mode='ShareLock' AND granted) THEN
      RAISE EXCEPTION 'compressed-inspection-guard-required' USING ERRCODE='55000'; END IF;
  END LOOP;
  FOR item IN SELECT a.profile_id,c.captured_at FROM public.predictive_compressed_inspections i
      JOIN public.predictive_captures c ON c.id=i.capture_id JOIN public.predictive_artifacts a ON a.id=c.artifact_id WHERE i.capture_id=ANY(ids) LOOP
    IF NOT public.predictive_rights_allow(item.profile_id,t,t,'internal-research')
        OR NOT public.predictive_rights_allow(item.profile_id,item.captured_at,item.captured_at,'internal-research') THEN
      RAISE EXCEPTION 'compressed-inspection-rights-refused' USING ERRCODE='23514'; END IF;
  END LOOP;
  SELECT jsonb_agg(jsonb_build_object('captureId',i.capture_id,'proof',i.proof,'reference',b.storage_ref,
    'sha256',b.sha256,'byteSize',b.byte_size) ORDER BY i.capture_id COLLATE "C") INTO result
    FROM public.predictive_compressed_inspections i JOIN public.predictive_captures c ON c.id=i.capture_id
    JOIN public.predictive_artifacts a ON a.id=c.artifact_id JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256 WHERE i.capture_id=ANY(ids);
  IF coalesce(jsonb_array_length(result),0)<>cardinality(ids) THEN RAISE EXCEPTION 'compressed-inspection-missing' USING ERRCODE='23514'; END IF;
  RETURN result;
END
$$;

-- Dependent metadata follows the existing authorized capture deletion closure.
-- No second retention procedure or CASCADE; capture tombstones audit its identity.
CREATE FUNCTION public.predictive_compressed_capture_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.predictive_compressed_inspections WHERE capture_id=OLD.id) THEN
    IF NOT pg_has_role(session_user,'predictive_retention_owner','MEMBER')
        OR NOT EXISTS(SELECT 1 FROM public.predictive_retention_authorizations WHERE txid=pg_current_xact_id()) THEN
      RAISE EXCEPTION 'compressed-inspection-deletion-not-authorized' USING ERRCODE='42501'; END IF;
    DELETE FROM public.predictive_compressed_inspections WHERE capture_id=OLD.id;
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER predictive_compressed_capture_delete BEFORE DELETE ON public.predictive_captures
  FOR EACH ROW EXECUTE FUNCTION public.predictive_compressed_capture_delete();
REVOKE ALL ON FUNCTION public.predictive_compressed_proof_valid(jsonb),public.predictive_record_compressed_inspection(text,jsonb),
  public.predictive_training_read_guard(),public.predictive_read_compressed_inspections(text[]),public.predictive_compressed_capture_delete() FROM PUBLIC;
DO $grants$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_ingest') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_record_compressed_inspection(text,jsonb) TO predictive_ingest;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_replay') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_training_read_guard(),public.predictive_read_compressed_inspections(text[]) TO predictive_replay;
  END IF;
END $grants$;
