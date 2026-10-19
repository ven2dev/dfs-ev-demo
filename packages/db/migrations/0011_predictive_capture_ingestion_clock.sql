-- Ordinary JSON evidence is also consumed by the CSV feature/label path.
-- Its receipt time must not be caller-controlled. Preserve captured_at and
-- available_at as source provenance, but stamp new non-synthetic receipts after
-- the profile publication lock. Existing rows/history are never rewritten.
-- The only caller-timed exception is non-CSV synthetic evidence from the
-- disposable harness; the original qualified CSV clock contract stays intact.
CREATE OR REPLACE FUNCTION public.predictive_source_ingestion_clock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE profile_id text; profile_purpose text; media text; parser text;
BEGIN
  SELECT p.id, p.purpose, b.media_type, p.parser_version INTO profile_id, profile_purpose, media, parser
    FROM public.predictive_artifacts a JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256
    JOIN public.predictive_source_profiles p ON p.id=a.profile_id WHERE a.id=NEW.artifact_id;
  IF profile_id IS NULL THEN RETURN NEW; END IF; -- existing FK checks refuse a missing artifact/profile
  IF profile_purpose = 'synthetic-test' AND NOT (media = 'text/csv' AND parser = 'nflverse-csv-qualification-v1') THEN
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
