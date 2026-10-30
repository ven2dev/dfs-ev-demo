-- Mutable #165 proposal; apply after #138 and 163_effective_rights.sql only in
-- a registered disposable database. No frozen schema or consumer delivery grant.
-- Pattern: immutable artifact registry, upload first, short atomic publication.

CREATE FUNCTION fs138.valid_model_identity(identity jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT coalesce(jsonb_typeof(identity)='object' AND identity-'code' = '{
  "format":"qb-model-run-v1",
  "designation":"uncalibrated-interim-hit-rate",
  "modelVersion":"empirical-integer-v1",
  "featureVersion":"qb-passing-yards-feature-v1",
  "labelVersion":"qb-passing-yards-label-v1",
  "historyPolicy":"prior-eligible-reg-max16-min2-cutoff1h-v1",
  "scoringPolicy":"qb-empirical-evaluation-v1",
  "adapter":{"id":"qb-passing-yards-materialized","version":"empirical-feature-adapter-v1"},
  "preregistration":{"commit":"6aa7953dfd0df0c9bf879c2be64e94eaa2c55a3f",
   "path":"docs/feature-store-spike-preregistration.md",
   "sha256":"dc6bf2e044bcbdd6de4b1d6f91db9c623f630ad1eaf7bf1b8abdfe1f3c05c97d"}
 }'::jsonb
 AND jsonb_typeof(identity->'code')='object'
 AND (identity->'code')-ARRAY['gitSha','contentSha256']='{}'::jsonb
 AND jsonb_typeof(identity->'code'->'gitSha')='string'
 AND jsonb_typeof(identity->'code'->'contentSha256')='string'
 AND identity->'code'->>'gitSha' ~ '^[a-f0-9]{40}$'
 AND identity->'code'->>'contentSha256' ~ '^[a-f0-9]{64}$',false)
$$;

CREATE TABLE fs138.model_runs (
 run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 identity jsonb NOT NULL CHECK(fs138.valid_model_identity(identity)),
 recorded_at timestamptz NOT NULL,
 rights_receipt jsonb NOT NULL CHECK(jsonb_typeof(rights_receipt)='object')
);
CREATE TRIGGER model_run_clock BEFORE INSERT ON fs138.model_runs
 FOR EACH ROW EXECUTE FUNCTION fs138.stamp_recorded_at();

CREATE TABLE fs138.model_run_datasets (
 run_id uuid NOT NULL REFERENCES fs138.model_runs,
 dataset_id uuid NOT NULL REFERENCES fs138.dataset_manifests,
 evidence_mode text NOT NULL CHECK(evidence_mode IN ('strict-point-in-time-v1','retrospective-reconstruction-v1')),
 file_sha256 fs138.sha256 NOT NULL,
 content_sha256 fs138.sha256 NOT NULL,
 spec jsonb NOT NULL,
 row_count integer NOT NULL CHECK(row_count>=0),
 dataset_recorded_at timestamptz NOT NULL,
 PRIMARY KEY(run_id,dataset_id), UNIQUE(run_id,evidence_mode)
);
CREATE INDEX model_dataset_reverse ON fs138.model_run_datasets(dataset_id,run_id);
CREATE TABLE fs138.model_artifacts (
 run_id uuid NOT NULL REFERENCES fs138.model_runs,
 slot text NOT NULL CHECK(slot IN ('descriptor','strict-point-in-time-v1','retrospective-reconstruction-v1')),
 dataset_id uuid,
 object_key text NOT NULL,
 file_sha256 fs138.sha256 NOT NULL,
 byte_size integer NOT NULL CHECK(byte_size BETWEEN 0 AND 268435456),
 PRIMARY KEY(run_id,slot), UNIQUE(run_id,object_key),
 FOREIGN KEY(run_id,dataset_id) REFERENCES fs138.model_run_datasets,
 CHECK((slot='descriptor')=(dataset_id IS NULL)),
 CHECK(object_key=CASE WHEN slot='descriptor' THEN 'models/' ELSE 'audits/' END||file_sha256)
);
CREATE INDEX model_artifact_address ON fs138.model_artifacts(object_key);
REVOKE ALL ON fs138.model_runs,fs138.model_run_datasets,fs138.model_artifacts FROM PUBLIC,fs138_reader,fs138_pipeline_writer;
GRANT SELECT ON fs138.model_runs,fs138.model_run_datasets,fs138.model_artifacts TO fs138_pipeline_writer;

ALTER TABLE fs138.orphan_observations DROP CONSTRAINT orphan_observations_object_key_check;
ALTER TABLE fs138.orphan_observations ADD CHECK(object_key ~ '^(raw|datasets|models|audits)/[a-f0-9]{64}$');

CREATE OR REPLACE FUNCTION fs138.lock_object_for_publication(address text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501'; END IF;
 IF address IS NULL OR address !~ '^(raw|datasets|models|audits)/[a-f0-9]{64}$' THEN RAISE EXCEPTION 'object-address-refused' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 IF EXISTS(SELECT 1 FROM fs138.object_removals WHERE object_key=address) THEN RAISE EXCEPTION 'object-address-deleted' USING ERRCODE='23514'; END IF;
 -- Preserve existing raw/dataset semantics. Model staging stays enrolled until
 -- a reference actually commits; calling the guard alone cannot lose cleanup.
 IF address ~ '^(raw|datasets)/' THEN
  DELETE FROM fs138.orphan_observations WHERE object_key=address;
 END IF;
END $$;

-- The trusted pipeline HEADs every object before this autocommit call, passes
-- only absent addresses, then uploads. SQL cannot inspect external object bytes.
CREATE FUNCTION fs138.enroll_model_objects(addresses text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE address text;
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501'; END IF;
 IF addresses IS NULL OR cardinality(addresses)>3 OR EXISTS(
  SELECT 1 FROM unnest(addresses) a WHERE a IS NULL OR a !~ '^(models|audits)/[a-f0-9]{64}$'
 ) THEN RAISE EXCEPTION 'model-addresses-refused' USING ERRCODE='23514'; END IF;
 FOR address IN SELECT DISTINCT unnest(addresses) ORDER BY 1 LOOP
  PERFORM fs138.lock_object_for_publication(address);
  IF NOT EXISTS(SELECT 1 FROM fs138.model_artifacts WHERE object_key=address) THEN
   INSERT INTO fs138.orphan_observations VALUES(address,clock_timestamp()) ON CONFLICT DO NOTHING;
  END IF;
 END LOOP;
END $$;

CREATE FUNCTION fs138.guard_model_publication(ids uuid[],addresses text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE snapshots uuid[]; n integer; address text; checked_at timestamptz; receipt jsonb; allowed boolean;
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501'; END IF;
 IF ids IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 2
  OR cardinality(ids)<>(SELECT count(DISTINCT id) FROM unnest(ids) id)
  OR addresses IS NULL OR cardinality(addresses) NOT BETWEEN 2 AND 3
  OR cardinality(addresses)<>(SELECT count(DISTINCT a) FROM unnest(addresses) a)
  OR EXISTS(SELECT 1 FROM unnest(addresses) a WHERE a !~ '^(models|audits)/[a-f0-9]{64}$') THEN
  RAISE EXCEPTION 'model-publication-spec-refused' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(array_agg(DISTINCT snapshot_id ORDER BY snapshot_id),'{}') INTO snapshots
 FROM fs138.dataset_inputs WHERE dataset_id=ANY(ids);
 IF cardinality(snapshots)=0 THEN RAISE EXCEPTION 'model-dataset-lineage-missing' USING ERRCODE='23514'; END IF;
 -- Same source-then-address order as the existing publisher and cleaner.
 PERFORM fs138.lock_active_snapshots(snapshots);
 PERFORM dataset_id FROM fs138.dataset_manifests WHERE dataset_id=ANY(ids)
  AND invalidated_at IS NULL ORDER BY dataset_id FOR SHARE;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>cardinality(ids) THEN RAISE EXCEPTION 'model-dataset-missing-or-invalidated' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM fs138.dataset_manifests WHERE dataset_id=ANY(ids) AND (
  spec->>'featureVersion' IS DISTINCT FROM 'qb-passing-yards-feature-v1'
  OR spec->>'labelVersion' IS DISTINCT FROM 'qb-passing-yards-label-v1'
  OR spec->>'historyPolicy' IS DISTINCT FROM 'prior-eligible-reg-max16-min2-cutoff1h-v1'
  OR (spec->>'mode') IS NULL OR spec->>'mode' NOT IN ('strict-point-in-time-v1','retrospective-reconstruction-v1')
 )) THEN RAISE EXCEPTION 'model-dataset-version-refused' USING ERRCODE='23514'; END IF;
 -- Sample rights after lock waits. A direct publication caller may have waited
 -- behind the cleaner while a newer rights decision was recorded.
 FOR address IN SELECT unnest(addresses) ORDER BY 1 LOOP
  PERFORM fs138.lock_object_for_publication(address);
 END LOOP;
 checked_at:=clock_timestamp();
 WITH profiles AS(SELECT DISTINCT profile_id FROM fs138.source_snapshots WHERE snapshot_id=ANY(snapshots)),
 decisions AS MATERIALIZED(
  SELECT p.profile_id,r.decision_id,r.allowed_uses FROM profiles p
  LEFT JOIN LATERAL fs138.effective_rights(p.profile_id,checked_at,checked_at) r ON true
 ) SELECT coalesce(bool_and(decision_id IS NOT NULL AND 'research'=ANY(allowed_uses)),false),
  jsonb_build_object('checkedAt',checked_at,'decisions',jsonb_agg(jsonb_build_object(
   'profileId',profile_id,'decisionId',decision_id) ORDER BY profile_id)) INTO allowed,receipt FROM decisions;
 IF NOT allowed THEN RAISE EXCEPTION 'model-current-rights-refused' USING ERRCODE='23514'; END IF;
 RETURN receipt;
END $$;

CREATE FUNCTION fs138.publish_model_run(p_identity jsonb,p_objects jsonb) RETURNS fs138.model_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE ids uuid[]; addresses text[]; receipt jsonb; result fs138.model_runs;
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501'; END IF;
 IF NOT fs138.valid_model_identity(p_identity) OR jsonb_typeof(p_objects) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'model-identity-or-artifacts-refused' USING ERRCODE='23514';
 END IF;
 IF jsonb_array_length(p_objects) NOT BETWEEN 2 AND 3 OR EXISTS(
  SELECT 1 FROM jsonb_array_elements(p_objects) o WHERE jsonb_typeof(o)<>'object'
   OR o-ARRAY['slot','datasetId','objectKey','fileSha256','byteSize']<>'{}'::jsonb
   OR NOT(o ?& ARRAY['slot','datasetId','objectKey','fileSha256','byteSize'])
   OR jsonb_typeof(o->'byteSize')<>'number'
 ) THEN RAISE EXCEPTION 'model-artifacts-refused' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(p_objects) o WHERE o->>'slot'='descriptor')<>1
  OR (SELECT count(DISTINCT o->>'slot') FROM jsonb_array_elements(p_objects) o)<>jsonb_array_length(p_objects)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_objects) o WHERE
   o->>'slot' IS NULL OR o->>'slot' NOT IN ('descriptor','strict-point-in-time-v1','retrospective-reconstruction-v1')
   OR (o->>'slot'='descriptor')<>(o->>'datasetId' IS NULL)
   OR o->>'fileSha256' IS NULL OR o->>'fileSha256' !~ '^[a-f0-9]{64}$'
   OR o->>'objectKey' IS DISTINCT FROM CASE WHEN o->>'slot'='descriptor' THEN 'models/' ELSE 'audits/' END||(o->>'fileSha256')
   OR (o->>'byteSize')::numeric NOT BETWEEN 0 AND 268435456
   OR (o->>'byteSize')::numeric<>trunc((o->>'byteSize')::numeric)
  ) THEN RAISE EXCEPTION 'model-artifacts-refused' USING ERRCODE='23514'; END IF;
 SELECT array_agg(DISTINCT (o->>'datasetId')::uuid ORDER BY (o->>'datasetId')::uuid)
  FILTER(WHERE o->>'datasetId' IS NOT NULL),array_agg(o->>'objectKey' ORDER BY o->>'objectKey')
  INTO ids,addresses FROM jsonb_array_elements(p_objects) o;
 receipt:=fs138.guard_model_publication(ids,addresses);
 -- Report mode belongs to the actual pinned dataset, not a caller's claim.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_objects) o
  JOIN fs138.dataset_manifests d ON d.dataset_id=(o->>'datasetId')::uuid
  WHERE o->>'slot'<>d.spec->>'mode')
  OR cardinality(ids)<>jsonb_array_length(p_objects)-1 THEN
  RAISE EXCEPTION 'model-report-dataset-mode-refused' USING ERRCODE='23514';
 END IF;
 WITH run AS(
  INSERT INTO fs138.model_runs(identity,rights_receipt) VALUES(p_identity,receipt) RETURNING *
 ), pins AS(
  INSERT INTO fs138.model_run_datasets
  SELECT run_id,d.dataset_id,d.spec->>'mode',d.file_sha256,d.content_sha256,d.spec,d.row_count,d.recorded_at
  FROM run CROSS JOIN fs138.dataset_manifests d WHERE dataset_id=ANY(ids)
 ), artifacts AS(
  INSERT INTO fs138.model_artifacts
  SELECT run_id,o.slot,o."datasetId",o."objectKey",o."fileSha256",o."byteSize" FROM run
  CROSS JOIN jsonb_to_recordset(p_objects) o(slot text,"datasetId" uuid,"objectKey" text,"fileSha256" text,"byteSize" integer)
 ) SELECT * INTO result FROM run;
 DELETE FROM fs138.orphan_observations WHERE object_key=ANY(addresses);
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION fs138.orphan_recheck(address text,grace_seconds double precision DEFAULT 300) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE first_seen timestamptz;
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501'; END IF;
 IF address IS NULL OR address !~ '^(raw|datasets|models|audits)/[a-f0-9]{64}$'
  OR grace_seconds IS NULL OR NOT(grace_seconds BETWEEN 0 AND 86400) THEN
  RAISE EXCEPTION 'orphan-request-refused' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 IF EXISTS(SELECT 1 FROM fs138.object_removals WHERE object_key=address)
  OR EXISTS(SELECT 1 FROM fs138.source_snapshots WHERE object_key=address)
  OR EXISTS(SELECT 1 FROM fs138.dataset_manifests WHERE object_key=address)
  OR EXISTS(SELECT 1 FROM fs138.model_artifacts WHERE object_key=address) THEN
  DELETE FROM fs138.orphan_observations WHERE object_key=address; RETURN false;
 END IF;
 -- Only enrolled model/report addresses are owned by this cleanup. Existing
 -- private audits without manifests are not silently claimed by a sweep.
 IF address ~ '^(raw|datasets)/' THEN
  INSERT INTO fs138.orphan_observations VALUES(address,clock_timestamp()) ON CONFLICT DO NOTHING;
 END IF;
 SELECT o.first_seen INTO first_seen FROM fs138.orphan_observations o WHERE object_key=address;
 RETURN coalesce(first_seen+make_interval(secs=>grace_seconds)<=clock_timestamp(),false);
END $$;

REVOKE ALL ON FUNCTION fs138.valid_model_identity(jsonb),fs138.enroll_model_objects(text[]),
 fs138.guard_model_publication(uuid[],text[]),fs138.publish_model_run(jsonb,jsonb) FROM PUBLIC,fs138_reader;
GRANT EXECUTE ON FUNCTION fs138.valid_model_identity(jsonb),fs138.enroll_model_objects(text[]),
 fs138.guard_model_publication(uuid[],text[]),fs138.publish_model_run(jsonb,jsonb) TO fs138_pipeline_writer;
