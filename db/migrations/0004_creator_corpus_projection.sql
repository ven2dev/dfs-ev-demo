-- Creator-corpus projection (#90). The owner's private files remain source
-- truth. Permanent owner events and gate registrations are append-only; API
-- evidence is a replace-or-delete snapshot with its own 30-day lifecycle.

CREATE FUNCTION public.corpus_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'corpus-append-only' USING ERRCODE = '23514';
END
$$;

CREATE FUNCTION public.corpus_api_replace_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'corpus-api-replace-required' USING ERRCODE = '23514';
END
$$;

CREATE TABLE public.corpus_imports (
  import_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  imported_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp())
    CHECK (isfinite(imported_at) AND imported_at = date_trunc('milliseconds', imported_at)),
  importer_version varchar(64) NOT NULL CHECK (importer_version ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  rule_version varchar(8) NOT NULL CHECK (rule_version ~ '^v[0-9]{1,3}$'),
  registration_fingerprint varchar(64) NOT NULL CHECK (registration_fingerprint ~ '^[a-f0-9]{64}$'),
  gate_fingerprint varchar(64) NOT NULL CHECK (gate_fingerprint ~ '^[a-f0-9]{64}$'),
  capture_input_fingerprint varchar(64) NOT NULL CHECK (capture_input_fingerprint ~ '^[a-f0-9]{64}$'),
  decision_input_fingerprint varchar(64) NOT NULL CHECK (decision_input_fingerprint ~ '^[a-f0-9]{64}$'),
  discovery_input_fingerprint varchar(64) NOT NULL CHECK (discovery_input_fingerprint ~ '^[a-f0-9]{64}$'),
  capture_event_count integer NOT NULL CHECK (capture_event_count >= 0),
  decision_event_count integer NOT NULL CHECK (decision_event_count >= 0),
  api_video_count integer NOT NULL CHECK (api_video_count >= 0),
  UNIQUE (importer_version, rule_version, registration_fingerprint, gate_fingerprint,
    capture_input_fingerprint, decision_input_fingerprint, discovery_input_fingerprint)
);

CREATE TABLE public.corpus_capture_events (
  creator_key varchar(32) NOT NULL CHECK (creator_key ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  log_position integer NOT NULL CHECK (log_position > 0),
  event_fingerprint varchar(64) NOT NULL CHECK (event_fingerprint ~ '^[a-f0-9]{64}$'),
  video_id varchar(11) NOT NULL CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  event_kind varchar(11) NOT NULL CHECK (event_kind IN ('captured','replaced','unavailable')),
  published_date date NOT NULL,
  published_date_precision varchar(3) NOT NULL CHECK (published_date_precision = 'day'),
  published_date_provenance varchar(48) NOT NULL
    CHECK (published_date_provenance = 'owner-confirmed-video-page-pacific-date'),
  transcript_source varchar(32) NOT NULL CHECK (transcript_source = 'manual-owner-paste'),
  usage_status varchar(32) NOT NULL CHECK (usage_status = 'internal-research-only'),
  caption_kind varchar(14) CHECK (caption_kind IN ('unknown','auto-generated','uploaded')),
  transcript_sha256 varchar(64) CHECK (transcript_sha256 ~ '^[a-f0-9]{64}$'),
  transcript_characters integer CHECK (transcript_characters > 0 AND transcript_characters <= 512000),
  captured_at timestamptz NOT NULL
    CHECK (isfinite(captured_at) AND captured_at = date_trunc('milliseconds', captured_at)),
  first_import_id bigint NOT NULL REFERENCES public.corpus_imports(import_id),
  PRIMARY KEY (creator_key, log_position),
  CHECK ((event_kind = 'unavailable' AND caption_kind IS NULL AND transcript_sha256 IS NULL AND transcript_characters IS NULL)
    OR (event_kind IN ('captured','replaced') AND caption_kind IS NOT NULL
      AND transcript_sha256 IS NOT NULL AND transcript_characters IS NOT NULL))
);

CREATE INDEX corpus_capture_events_video_idx
  ON public.corpus_capture_events (creator_key, video_id, log_position DESC);

CREATE TABLE public.corpus_decision_events (
  creator_key varchar(32) NOT NULL CHECK (creator_key ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  file_position integer NOT NULL CHECK (file_position > 0),
  event_fingerprint varchar(64) NOT NULL CHECK (event_fingerprint ~ '^[a-f0-9]{64}$'),
  video_id varchar(11) NOT NULL CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  decision_kind varchar(7) NOT NULL CHECK (decision_kind IN ('include','exclude','clear')),
  reason varchar(500) NOT NULL CHECK (length(btrim(reason)) > 0 AND reason !~ '[[:cntrl:]]'),
  rule_version varchar(8) NOT NULL CHECK (rule_version ~ '^v[0-9]{1,3}$'),
  decided_at timestamptz NOT NULL
    CHECK (isfinite(decided_at) AND decided_at = date_trunc('milliseconds', decided_at)),
  first_import_id bigint NOT NULL REFERENCES public.corpus_imports(import_id),
  PRIMARY KEY (creator_key, file_position)
);

CREATE INDEX corpus_decision_events_video_idx
  ON public.corpus_decision_events (creator_key, video_id, decided_at DESC, file_position DESC);

CREATE TABLE public.corpus_gate_registrations (
  commitment_digest varchar(64) PRIMARY KEY CHECK (commitment_digest ~ '^[a-f0-9]{64}$'),
  commitment_algorithm varchar(16) NOT NULL CHECK (commitment_algorithm = 'sha256'),
  commitment_version integer NOT NULL CHECK (commitment_version > 0),
  eligible_creator_count integer NOT NULL CHECK (eligible_creator_count BETWEEN 1 AND 20),
  minimum_reviewed_gradable_picks_overall integer NOT NULL CHECK (minimum_reviewed_gradable_picks_overall > 0),
  minimum_reviewed_gradable_picks_per_creator integer NOT NULL CHECK (minimum_reviewed_gradable_picks_per_creator > 0),
  maximum_feature_count integer NOT NULL CHECK (maximum_feature_count > 0),
  start_season integer NOT NULL CHECK (start_season BETWEEN 1920 AND 9999),
  start_week integer NOT NULL CHECK (start_week BETWEEN 1 AND 18),
  end_season integer NOT NULL CHECK (end_season BETWEEN 1920 AND 9999),
  end_week integer NOT NULL CHECK (end_week BETWEEN 1 AND 18),
  collection_season_type varchar(7) NOT NULL CHECK (collection_season_type = 'regular'),
  rule_version varchar(8) NOT NULL CHECK (rule_version ~ '^v[0-9]{1,3}$'),
  registered_at timestamptz NOT NULL
    CHECK (isfinite(registered_at) AND registered_at = date_trunc('milliseconds', registered_at)),
  imported_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp())
    CHECK (isfinite(imported_at) AND imported_at = date_trunc('milliseconds', imported_at)
      AND imported_at >= registered_at),
  first_import_id bigint NOT NULL UNIQUE REFERENCES public.corpus_imports(import_id),
  CHECK (end_season > start_season OR (end_season = start_season AND end_week >= start_week)),
  CHECK (minimum_reviewed_gradable_picks_overall >= minimum_reviewed_gradable_picks_per_creator)
);

CREATE TABLE public.corpus_api_videos (
  creator_key varchar(32) NOT NULL CHECK (creator_key ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  video_id varchar(11) NOT NULL CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  published_at timestamptz NOT NULL
    CHECK (isfinite(published_at) AND published_at = date_trunc('milliseconds', published_at)),
  duration_seconds integer CHECK (duration_seconds >= 0),
  live_broadcast_content varchar(8) NOT NULL CHECK (live_broadcast_content IN ('none','upcoming','live')),
  api_fetched_at timestamptz NOT NULL
    CHECK (isfinite(api_fetched_at) AND api_fetched_at = date_trunc('milliseconds', api_fetched_at)
      AND api_fetched_at >= published_at),
  season integer CHECK (season BETWEEN 1920 AND 9999),
  week integer CHECK (week BETWEEN 1 AND 18),
  season_week_provenance varchar(64) NOT NULL
    CHECK (season_week_provenance ~ '^[a-z0-9][a-z0-9.-]{2,63}$'),
  classification_status varchar(12) NOT NULL
    CHECK (classification_status IN ('candidate','needs-review','excluded')),
  classification_reasons varchar(64)[] NOT NULL
    CHECK (cardinality(classification_reasons) BETWEEN 1 AND 18
      AND array_position(classification_reasons, NULL) IS NULL
      AND classification_reasons <@ ARRAY[
        'prop-and-nfl-signal-in-title','invalid-published-at','outside-registered-regular-season',
        'after-registered-end-week','not-yet-vod','short-form','other-league-in-title','fantasy-in-title',
        'no-prop-signal','no-nfl-signal','duration-unknown','mixed-league-title','title-week-mismatch',
        'multiple-week-references','nfl-signal-team-name-only','nfl-signal-description-only',
        'picks-without-prop-signal','prop-signal-description-only'
      ]::varchar(64)[]),
  classification_rule_version varchar(8) NOT NULL CHECK (classification_rule_version ~ '^v[0-9]{1,3}$'),
  review_status varchar(12) NOT NULL CHECK (review_status IN ('present','needs-review','excluded')),
  snapshot_import_id bigint NOT NULL REFERENCES public.corpus_imports(import_id),
  PRIMARY KEY (creator_key, video_id),
  CHECK ((season IS NULL) = (week IS NULL))
);

CREATE INDEX corpus_api_videos_expiry_idx ON public.corpus_api_videos (api_fetched_at);
CREATE INDEX corpus_api_videos_slot_idx
  ON public.corpus_api_videos (creator_key, season, week, review_status);

CREATE TRIGGER corpus_imports_immutable BEFORE UPDATE OR DELETE ON public.corpus_imports
  FOR EACH ROW EXECUTE FUNCTION public.corpus_append_only();
CREATE TRIGGER corpus_capture_events_immutable BEFORE UPDATE OR DELETE ON public.corpus_capture_events
  FOR EACH ROW EXECUTE FUNCTION public.corpus_append_only();
CREATE TRIGGER corpus_decision_events_immutable BEFORE UPDATE OR DELETE ON public.corpus_decision_events
  FOR EACH ROW EXECUTE FUNCTION public.corpus_append_only();
CREATE TRIGGER corpus_gate_registrations_immutable BEFORE UPDATE OR DELETE ON public.corpus_gate_registrations
  FOR EACH ROW EXECUTE FUNCTION public.corpus_append_only();
CREATE TRIGGER corpus_imports_no_truncate BEFORE TRUNCATE ON public.corpus_imports
  FOR EACH STATEMENT EXECUTE FUNCTION public.corpus_append_only();
CREATE TRIGGER corpus_capture_events_no_truncate BEFORE TRUNCATE ON public.corpus_capture_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.corpus_append_only();
CREATE TRIGGER corpus_decision_events_no_truncate BEFORE TRUNCATE ON public.corpus_decision_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.corpus_append_only();
CREATE TRIGGER corpus_gate_registrations_no_truncate BEFORE TRUNCATE ON public.corpus_gate_registrations
  FOR EACH STATEMENT EXECUTE FUNCTION public.corpus_append_only();
CREATE TRIGGER corpus_api_videos_no_update BEFORE UPDATE ON public.corpus_api_videos
  FOR EACH ROW EXECUTE FUNCTION public.corpus_api_replace_only();
CREATE TRIGGER corpus_api_videos_no_truncate BEFORE TRUNCATE ON public.corpus_api_videos
  FOR EACH STATEMENT EXECUTE FUNCTION public.corpus_api_replace_only();

COMMENT ON TABLE public.corpus_imports IS 'Append-only audit of validated local creator-corpus snapshot publications; contains fingerprints and counts, never source content.';
COMMENT ON TABLE public.corpus_capture_events IS 'Append-only projection of owner capture events; transcript text, notes and reasons remain only in the private source log.';
COMMENT ON TABLE public.corpus_decision_events IS 'Append-only projection of owner include, exclude and clear decisions in source order.';
COMMENT ON TABLE public.corpus_gate_registrations IS 'Immutable public readiness-gate registrations; private creator keys and salts are never stored.';
COMMENT ON TABLE public.corpus_api_videos IS 'Current refresh-or-delete YouTube API evidence and derived classification; complete creator snapshots are replaced atomically.';
COMMENT ON FUNCTION public.corpus_append_only() IS 'Refuses UPDATE, DELETE and TRUNCATE on permanent creator-corpus audit tables.';
COMMENT ON FUNCTION public.corpus_api_replace_only() IS 'Refuses in-place mutation and TRUNCATE of API evidence; importers replace rows with DELETE plus INSERT.';

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. Table and
-- sequence privileges are explicit too, even though their defaults are closed.
REVOKE ALL ON FUNCTION public.corpus_append_only(), public.corpus_api_replace_only() FROM PUBLIC;
REVOKE ALL ON public.corpus_imports, public.corpus_capture_events, public.corpus_decision_events,
  public.corpus_gate_registrations, public.corpus_api_videos FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.corpus_imports_import_id_seq FROM PUBLIC;

-- The role is created only by the disposable/local database setup before this
-- migration. Hosted setup (#95) deliberately does not create it, so empty
-- shared tables grant no hosted mutation path.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'corpus_importer') THEN
    GRANT SELECT, INSERT ON public.corpus_imports, public.corpus_capture_events,
      public.corpus_decision_events, public.corpus_gate_registrations TO corpus_importer;
    GRANT SELECT, INSERT, DELETE ON public.corpus_api_videos TO corpus_importer;
    GRANT USAGE, SELECT ON SEQUENCE public.corpus_imports_import_id_seq TO corpus_importer;
  END IF;
END
$grants$;
