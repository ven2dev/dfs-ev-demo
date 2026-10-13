-- Exact compressed wire storage and deletion lifecycle only. No compressed
-- claim/publication reader is qualified by this prefix. Existing history stays
-- unchanged; a later forward migration must activate a verified codec envelope.
ALTER TABLE public.predictive_blobs DROP CONSTRAINT predictive_blobs_media_type_check;
ALTER TABLE public.predictive_blobs DROP CONSTRAINT predictive_blobs_check;
ALTER TABLE public.predictive_blobs ADD CONSTRAINT predictive_blobs_media_type_check
  CHECK (media_type IN ('application/json','text/csv','application/gzip'));
ALTER TABLE public.predictive_blobs ADD CONSTRAINT predictive_blobs_check
  CHECK (storage_ref = sha256 || CASE media_type
    WHEN 'application/json' THEN '.json' WHEN 'text/csv' THEN '.csv' ELSE '.csv.gz' END);
ALTER TABLE public.predictive_blob_removals DROP CONSTRAINT predictive_blob_removals_storage_ref_check;
ALTER TABLE public.predictive_blob_removals ADD CONSTRAINT predictive_blob_removals_storage_ref_check
  CHECK (storage_ref ~ '^[a-f0-9]{64}\.(json|csv|csv\.gz)$');

-- Preserve the execute-only API, role/isolation/session-lock checks and ACLs.
CREATE OR REPLACE FUNCTION public.predictive_blob_reference_guard(reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF reference IS NULL OR reference !~ '^[a-f0-9]{64}\.(json|csv|csv\.gz)$' THEN
    RAISE EXCEPTION 'predictive-blob-reference-refused' USING ERRCODE = '23514';
  END IF;
  PERFORM public.predictive_blob_lock_guard(substr(reference, 1, 64));
END
$$;

-- Gzip never inherits the caller-timed synthetic JSON exception, regardless of
-- parser/profile naming. Ordinary CSV/JSON retain their v11 clock contract.
CREATE OR REPLACE FUNCTION public.predictive_source_ingestion_clock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE profile_id text; profile_purpose text; media text; parser text;
BEGIN
  SELECT p.id, p.purpose, b.media_type, p.parser_version INTO profile_id, profile_purpose, media, parser
    FROM public.predictive_artifacts a JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256
    JOIN public.predictive_source_profiles p ON p.id=a.profile_id WHERE a.id=NEW.artifact_id;
  IF profile_id IS NULL THEN RETURN NEW; END IF;
  IF profile_purpose = 'synthetic-test' AND media <> 'application/gzip'
      AND NOT (media = 'text/csv' AND parser = 'nflverse-csv-qualification-v1') THEN
    IF NOT public.predictive_harness_session() THEN
      RAISE EXCEPTION 'predictive-synthetic-outside-harness' USING ERRCODE = '23514';
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(520053, hashtext(profile_id));
    NEW.ingested_at := date_trunc('milliseconds', clock_timestamp());
  END IF;
  RETURN NEW;
END
$$;

-- Reject published gzip and every canonical observation link, including an
-- unknown parser or synthetic profile. Merely storing bytes is not qualification.
CREATE FUNCTION public.predictive_compressed_capture_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'incomplete' AND EXISTS (
    SELECT 1 FROM public.predictive_artifacts a JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256
    WHERE a.id=NEW.artifact_id AND b.media_type='application/gzip') THEN
    RAISE EXCEPTION 'predictive-compressed-publication-not-qualified' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.predictive_compressed_capture_guard() FROM PUBLIC;
CREATE TRIGGER predictive_compressed_capture_guard BEFORE INSERT ON public.predictive_captures
  FOR EACH ROW EXECUTE FUNCTION public.predictive_compressed_capture_guard();

CREATE OR REPLACE FUNCTION public.predictive_source_canonical_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.predictive_artifacts a JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256
      JOIN public.predictive_source_profiles p ON p.id=a.profile_id WHERE a.id=NEW.artifact_id
      AND (b.media_type='application/gzip' OR
        (p.parser_version='nflverse-csv-qualification-v1' AND (b.media_type='text/csv' OR p.purpose<>'synthetic-test')))) THEN
    RAISE EXCEPTION 'predictive-source-canonical-binding-required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
