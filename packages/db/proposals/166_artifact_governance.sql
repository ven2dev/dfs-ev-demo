-- Mutable #166 proposal, applied after #138, #163 effective rights and #165.
-- Pattern: lineage-driven invalidation and the existing durable removal queue.
-- Apply only in a registered disposable database; no frozen migration rollout.

ALTER TABLE fs138.model_runs
 ADD invalidated_at timestamptz,
 ADD deletion_event_id uuid REFERENCES fs138.deletion_events,
 ADD CONSTRAINT model_run_invalidation_receipt CHECK (
  (invalidated_at IS NULL) = (deletion_event_id IS NULL));
ALTER TABLE fs138.deletion_events ADD run_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE fs138.object_removals DROP CONSTRAINT object_removals_object_key_check;
ALTER TABLE fs138.object_removals ADD CHECK (
 object_key ~ '^(raw|datasets|models|audits)/[a-f0-9]{64}$');

-- Governance may append the first invalidation, never rewrite publication or
-- clear/replace its withdrawal receipt. Writers receive no general UPDATE grant.
CREATE FUNCTION fs138.preserve_model_publication() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,fs138 AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['invalidated_at','deletion_event_id']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['invalidated_at','deletion_event_id'])
 OR (OLD.invalidated_at IS NOT NULL AND
    (NEW.invalidated_at,NEW.deletion_event_id) IS DISTINCT FROM
    (OLD.invalidated_at,OLD.deletion_event_id)) THEN
  RAISE EXCEPTION 'model-publication-immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER model_publication_immutable BEFORE UPDATE ON fs138.model_runs
 FOR EACH ROW EXECUTE FUNCTION fs138.preserve_model_publication();

-- Private common closure. Entry points have validated requests and source
-- deletion already holds source rows. Dataset exclusion precedes discovery of
-- runs, so a publisher waiting on these rows cannot escape the closure.
CREATE FUNCTION fs138.invalidate_dataset_dependents(
 p_datasets uuid[],p_snapshots uuid[],p_features uuid[],p_labels uuid[],
 p_reason text,p_grace double precision) RETURNS fs138.deletion_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE receipt fs138.deletion_events; affected_runs uuid[]; addresses text[]; address text;
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN
  RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501';
 END IF;
 PERFORM d.dataset_id FROM fs138.dataset_manifests d
 WHERE d.dataset_id=ANY(p_datasets) ORDER BY d.dataset_id FOR UPDATE;
 IF (SELECT count(*) FROM fs138.dataset_manifests d WHERE d.dataset_id=ANY(p_datasets))<>cardinality(p_datasets) THEN
  RAISE EXCEPTION 'deletion-dataset-set-refused' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(array_agg(DISTINCT p.run_id ORDER BY p.run_id),'{}') INTO affected_runs
 FROM fs138.model_run_datasets p WHERE p.dataset_id=ANY(p_datasets);
 PERFORM r.run_id FROM fs138.model_runs r WHERE r.run_id=ANY(affected_runs)
 ORDER BY r.run_id FOR UPDATE;
 SELECT coalesce(array_agg(keys.object_key ORDER BY keys.object_key),'{}') INTO addresses FROM (
  SELECT s.object_key FROM fs138.source_snapshots s WHERE s.snapshot_id=ANY(p_snapshots)
  UNION SELECT d.object_key FROM fs138.dataset_manifests d WHERE d.dataset_id=ANY(p_datasets)
  UNION SELECT a.object_key FROM fs138.model_artifacts a WHERE a.run_id=ANY(affected_runs)
 ) keys;
 -- Acquire the complete sorted set before queue/status writes. This preserves
 -- source -> dataset -> run -> address order shared with publication.
 FOREACH address IN ARRAY addresses LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 END LOOP;
 INSERT INTO fs138.deletion_events(reason,grace_seconds,snapshot_ids,feature_ids,label_ids,dataset_ids,run_ids)
 VALUES(p_reason,p_grace,p_snapshots,p_features,p_labels,p_datasets,affected_runs) RETURNING * INTO receipt;
 UPDATE fs138.model_runs SET invalidated_at=receipt.recorded_at,deletion_event_id=receipt.event_id
 WHERE run_id=ANY(affected_runs) AND invalidated_at IS NULL;
 UPDATE fs138.dataset_manifests SET invalidated_at=coalesce(invalidated_at,receipt.recorded_at)
 WHERE dataset_id=ANY(p_datasets);
 DELETE FROM fs138.dataset_members WHERE dataset_id=ANY(p_datasets);
 INSERT INTO fs138.object_removals(object_key,event_id,remove_after)
 SELECT key,receipt.event_id,clock_timestamp()+make_interval(secs=>p_grace) FROM unnest(addresses) key
 ON CONFLICT(object_key) DO UPDATE SET event_id=EXCLUDED.event_id,
  remove_after=greatest(fs138.object_removals.remove_after,EXCLUDED.remove_after),
  completed_at=NULL,outcome=NULL;
 RETURN receipt;
END $$;

CREATE OR REPLACE FUNCTION fs138.delete_sources(ids uuid[],reason text,grace_seconds double precision DEFAULT 300)
RETURNS fs138.deletion_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE receipt fs138.deletion_events; affected_datasets uuid[]; affected_features uuid[]; affected_labels uuid[];
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN
  RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501';
 END IF;
 IF ids IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 1024
 OR cardinality(ids)<>(SELECT count(DISTINCT id) FROM unnest(ids) id)
 OR reason IS NULL OR length(reason) NOT BETWEEN 1 AND 512
 OR grace_seconds IS NULL OR NOT(grace_seconds BETWEEN 0 AND 86400) THEN
  RAISE EXCEPTION 'deletion-request-refused' USING ERRCODE='23514';
 END IF;
 PERFORM s.snapshot_id FROM fs138.source_snapshots s WHERE s.snapshot_id=ANY(ids) ORDER BY s.snapshot_id FOR UPDATE;
 IF (SELECT count(*) FROM fs138.source_snapshots s WHERE s.snapshot_id=ANY(ids))<>cardinality(ids) THEN
  RAISE EXCEPTION 'deletion-snapshot-set-refused' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(array_agg(DISTINCT i.feature_id ORDER BY i.feature_id),'{}') INTO affected_features
 FROM fs138.feature_inputs i WHERE i.snapshot_id=ANY(ids);
 SELECT coalesce(array_agg(DISTINCT i.label_id ORDER BY i.label_id),'{}') INTO affected_labels
 FROM fs138.label_inputs i WHERE i.snapshot_id=ANY(ids);
 SELECT coalesce(array_agg(x.dataset_id ORDER BY x.dataset_id),'{}') INTO affected_datasets FROM (
  SELECT i.dataset_id FROM fs138.dataset_inputs i WHERE i.snapshot_id=ANY(ids)
  UNION SELECT m.dataset_id FROM fs138.dataset_members m
   WHERE m.feature_id=ANY(affected_features) OR m.label_id=ANY(affected_labels)
 ) x;
 receipt:=fs138.invalidate_dataset_dependents(affected_datasets,ids,affected_features,affected_labels,reason,grace_seconds);
 UPDATE fs138.source_snapshots SET deleted_at=coalesce(deleted_at,receipt.recorded_at),source_manifest='{}'
 WHERE snapshot_id=ANY(ids);
 DELETE FROM fs138.feature_inputs WHERE feature_id=ANY(affected_features);
 DELETE FROM fs138.label_inputs WHERE label_id=ANY(affected_labels);
 DELETE FROM fs138.feature_values WHERE feature_id=ANY(affected_features);
 DELETE FROM fs138.outcome_labels WHERE label_id=ANY(affected_labels);
 DELETE FROM fs138.norm_schedule WHERE snapshot_id=ANY(ids);
 DELETE FROM fs138.norm_player_game_stats WHERE snapshot_id=ANY(ids);
 DELETE FROM fs138.norm_identity WHERE snapshot_id=ANY(ids);
 DELETE FROM fs138.norm_participation WHERE snapshot_id=ANY(ids);
 -- Provider-value cleanup cannot consume the byte grace before this API ends.
 UPDATE fs138.object_removals SET remove_after=greatest(remove_after,clock_timestamp()+make_interval(secs=>grace_seconds))
 WHERE event_id=receipt.event_id;
 RETURN receipt;
END $$;

CREATE FUNCTION fs138.delete_datasets(ids uuid[],reason text,grace_seconds double precision DEFAULT 300)
RETURNS fs138.deletion_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE receipt fs138.deletion_events;
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN
  RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501';
 END IF;
 IF ids IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 1024
 OR cardinality(ids)<>(SELECT count(DISTINCT id) FROM unnest(ids) id)
 OR reason IS NULL OR length(reason) NOT BETWEEN 1 AND 512
 OR grace_seconds IS NULL OR NOT(grace_seconds BETWEEN 0 AND 86400) THEN
  RAISE EXCEPTION 'deletion-request-refused' USING ERRCODE='23514';
 END IF;
 receipt:=fs138.invalidate_dataset_dependents(ids,'{}','{}','{}',reason,grace_seconds);
 -- Explicit dataset deletion keeps sources, derived values and unrelated pins.
 UPDATE fs138.object_removals SET remove_after=greatest(remove_after,clock_timestamp()+make_interval(secs=>grace_seconds))
 WHERE event_id=receipt.event_id;
 RETURN receipt;
END $$;

-- Stable refusal SQLSTATEs are consumed by the pipeline without message parsing.
-- Raw/dataset callers retain their existing address-refusal contract.
CREATE OR REPLACE FUNCTION fs138.lock_object_for_publication(address text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN
  RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501';
 END IF;
 IF address IS NULL OR address !~ '^(raw|datasets|models|audits)/[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'object-address-refused' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 IF EXISTS(SELECT 1 FROM fs138.object_removals o WHERE o.object_key=address) THEN
  IF address ~ '^(models|audits)/' THEN
   RAISE EXCEPTION 'model-object-deleted' USING ERRCODE='P1662';
  END IF;
  RAISE EXCEPTION 'object-address-deleted' USING ERRCODE='23514';
 END IF;
 IF address ~ '^(raw|datasets)/' THEN
  DELETE FROM fs138.orphan_observations WHERE object_key=address;
 END IF;
END $$;

-- Both #165 guard calls stay: before HEADs and inside direct SQL publication.
-- Lock status rows even when invalidated, then sample current rights after all
-- waits. Rights refusal precedes historical-status errors and never returns a run.
CREATE OR REPLACE FUNCTION fs138.guard_model_publication(ids uuid[],addresses text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE snapshots uuid[]; address text; checked_at timestamptz; receipt jsonb; allowed boolean;
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN
  RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501';
 END IF;
 IF ids IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 2
 OR cardinality(ids)<>(SELECT count(DISTINCT id) FROM unnest(ids) id)
 OR addresses IS NULL OR cardinality(addresses) NOT BETWEEN 2 AND 3
 OR cardinality(addresses)<>(SELECT count(DISTINCT key) FROM unnest(addresses) key)
 OR EXISTS(SELECT 1 FROM unnest(addresses) key WHERE key !~ '^(models|audits)/[a-f0-9]{64}$') THEN
  RAISE EXCEPTION 'model-publication-spec-refused' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(array_agg(DISTINCT i.snapshot_id ORDER BY i.snapshot_id),'{}') INTO snapshots
 FROM fs138.dataset_inputs i WHERE i.dataset_id=ANY(ids);
 IF cardinality(snapshots)=0 THEN
  RAISE EXCEPTION 'model-dataset-lineage-missing' USING ERRCODE='23514';
 END IF;
 PERFORM s.snapshot_id FROM fs138.source_snapshots s WHERE s.snapshot_id=ANY(snapshots) ORDER BY s.snapshot_id FOR SHARE;
 PERFORM d.dataset_id FROM fs138.dataset_manifests d WHERE d.dataset_id=ANY(ids) ORDER BY d.dataset_id FOR SHARE;
 FOREACH address IN ARRAY (SELECT array_agg(key ORDER BY key) FROM unnest(addresses) key) LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 END LOOP;
 checked_at:=clock_timestamp();
 WITH profiles AS (SELECT DISTINCT s.profile_id FROM fs138.source_snapshots s WHERE s.snapshot_id=ANY(snapshots)),
 decisions AS MATERIALIZED (
  SELECT p.profile_id,e.decision_id,e.allowed_uses FROM profiles p
  LEFT JOIN LATERAL fs138.effective_rights(p.profile_id,checked_at,checked_at) e ON true
 ) SELECT coalesce(bool_and(decision_id IS NOT NULL AND 'research'=ANY(allowed_uses)),false),
  jsonb_build_object('checkedAt',checked_at,'decisions',jsonb_agg(jsonb_build_object(
   'profileId',profile_id,'decisionId',decision_id) ORDER BY profile_id)) INTO allowed,receipt FROM decisions;
 IF NOT allowed THEN
  RAISE EXCEPTION 'model-current-rights-refused' USING ERRCODE='P1665';
 END IF;
 IF EXISTS(SELECT 1 FROM fs138.model_runs r
  WHERE 'models/'||r.descriptor_sha256=ANY(addresses) AND r.invalidated_at IS NOT NULL)
 OR EXISTS(SELECT 1 FROM fs138.dataset_manifests d WHERE d.dataset_id=ANY(ids) AND d.invalidated_at IS NOT NULL) THEN
  RAISE EXCEPTION 'model-publication-invalidated' USING ERRCODE='P1661';
 END IF;
 IF (SELECT count(*) FROM fs138.dataset_manifests d WHERE d.dataset_id=ANY(ids))<>cardinality(ids) THEN
  RAISE EXCEPTION 'model-dataset-missing-or-invalidated' USING ERRCODE='23514';
 END IF;
 IF (SELECT count(*) FROM fs138.source_snapshots s WHERE s.snapshot_id=ANY(snapshots) AND s.deleted_at IS NULL)<>cardinality(snapshots) THEN
  RAISE EXCEPTION 'source-deleted-or-missing' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM fs138.dataset_manifests d WHERE d.dataset_id=ANY(ids) AND (
  d.spec->>'featureVersion' IS DISTINCT FROM 'qb-passing-yards-feature-v1'
  OR d.spec->>'labelVersion' IS DISTINCT FROM 'qb-passing-yards-label-v1'
  OR d.spec->>'historyPolicy' IS DISTINCT FROM 'prior-eligible-reg-max16-min2-cutoff1h-v1'
  OR d.spec->>'mode' IS NULL OR d.spec->>'mode' NOT IN ('strict-point-in-time-v1','retrospective-reconstruction-v1')
 )) THEN
  RAISE EXCEPTION 'model-dataset-version-refused' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM fs138.object_removals o WHERE o.object_key=ANY(addresses)) THEN
  RAISE EXCEPTION 'model-object-deleted' USING ERRCODE='P1662';
 END IF;
 RETURN receipt;
END $$;

-- SQL safety for the addresses enqueued above. Cleaner orchestration and its
-- four-statement CI budget follow in step 3; existing callers are already safe.
CREATE OR REPLACE FUNCTION fs138.removal_recheck(address text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN
  RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 IF NOT EXISTS(SELECT 1 FROM fs138.object_removals o
  WHERE o.object_key=address AND o.completed_at IS NULL AND o.remove_after<=clock_timestamp()) THEN RETURN false; END IF;
 IF address ~ '^(models|audits)/'
 AND EXISTS(SELECT 1 FROM fs138.orphan_observations o WHERE o.object_key=address) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM fs138.source_snapshots s WHERE s.object_key=address AND s.deleted_at IS NULL)
 OR EXISTS(SELECT 1 FROM fs138.dataset_manifests d WHERE d.object_key=address AND d.invalidated_at IS NULL)
 OR EXISTS(SELECT 1 FROM fs138.model_artifacts a JOIN fs138.model_runs r USING(run_id)
  WHERE a.object_key=address AND r.invalidated_at IS NULL) THEN
  UPDATE fs138.object_removals SET completed_at=clock_timestamp(),outcome='shared-retained' WHERE object_key=address;
  RETURN false;
 END IF;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION fs138.orphan_recheck(address text,grace_seconds double precision DEFAULT 300) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE observed_at timestamptz;
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN
  RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501';
 END IF;
 IF address IS NULL OR address !~ '^(raw|datasets|models|audits)/[a-f0-9]{64}$'
 OR grace_seconds IS NULL OR NOT(grace_seconds BETWEEN 0 AND 86400) THEN
  RAISE EXCEPTION 'orphan-request-refused' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 IF address ~ '^(models|audits)/' THEN
  -- A pending mandatory intent does not clear observation or force refusal:
  -- this sweep owns the observed address and deletes bytes after orphan grace.
  IF EXISTS(SELECT 1 FROM fs138.model_artifacts a JOIN fs138.model_runs r USING(run_id)
   WHERE a.object_key=address AND r.invalidated_at IS NULL) THEN RETURN false; END IF;
 ELSE
  -- Preserve existing raw/dataset ownership and discovery behavior.
  IF EXISTS(SELECT 1 FROM fs138.object_removals o WHERE o.object_key=address)
  OR EXISTS(SELECT 1 FROM fs138.source_snapshots s WHERE s.object_key=address)
  OR EXISTS(SELECT 1 FROM fs138.dataset_manifests d WHERE d.object_key=address) THEN
   DELETE FROM fs138.orphan_observations WHERE object_key=address; RETURN false;
  END IF;
  INSERT INTO fs138.orphan_observations VALUES(address,clock_timestamp()) ON CONFLICT DO NOTHING;
 END IF;
 SELECT o.first_seen INTO observed_at FROM fs138.orphan_observations o WHERE o.object_key=address;
 RETURN coalesce(observed_at+make_interval(secs=>grace_seconds)<=clock_timestamp(),false);
END $$;

CREATE OR REPLACE FUNCTION fs138.retire_model_observation(address text,retirement_seconds double precision) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE retired integer;
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN
  RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501';
 END IF;
 IF address IS NULL OR address !~ '^(models|audits)/[a-f0-9]{64}$'
 OR retirement_seconds IS NULL OR NOT(retirement_seconds>0 AND retirement_seconds<=31536000) THEN
  RAISE EXCEPTION 'orphan-retirement-refused' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 DELETE FROM fs138.orphan_observations o WHERE o.object_key=address
 AND o.first_seen+make_interval(secs=>retirement_seconds)<=clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM fs138.model_artifacts a JOIN fs138.model_runs r USING(run_id)
  WHERE a.object_key=address AND r.invalidated_at IS NULL);
 GET DIAGNOSTICS retired=ROW_COUNT;
 RETURN retired=1;
END $$;

REVOKE ALL ON FUNCTION fs138.preserve_model_publication(),
 fs138.invalidate_dataset_dependents(uuid[],uuid[],uuid[],uuid[],text,double precision),
 fs138.delete_datasets(uuid[],text,double precision) FROM PUBLIC,fs138_reader,fs138_pipeline_writer;
GRANT EXECUTE ON FUNCTION fs138.delete_datasets(uuid[],text,double precision) TO fs138_pipeline_writer;
-- CREATE OR REPLACE retains the original narrow grants on existing APIs.
-- No general reader/app artifact-table grants.

-- The only reader capability: one statement snapshot for the entire run's
-- rights/status. Pin retrieval is part of Q1; Q2 returns only a fresh receipt.
-- STABLE keeps the internal SELECTs on the caller statement's snapshot. There
-- are no writer coordination locks, membership reads or per-example work.
CREATE FUNCTION fs138.authorize_model_read(p_run uuid,p_slots text[],p_with_pins boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE publication fs138.model_runs; snapshots uuid[]; checked_at timestamptz:=statement_timestamp();
 receipt jsonb; allowed boolean; pins jsonb; files jsonb;
BEGIN
 IF NOT(pg_has_role(session_user,'fs138_reader','member')
  OR pg_has_role(session_user,'fs138_pipeline_writer','member')) THEN
  RAISE EXCEPTION 'model-reader-role-required' USING ERRCODE='42501';
 END IF;
 -- The trusted API requires a dedicated idle connection. Do not infer an
 -- explicit transaction from clock differences: Parse/Bind can start a normal
 -- autocommit transaction before statement_timestamp in the extended protocol.
 -- Refuse snapshot isolation, which would hide revocation from Q2.
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'model-read-session-refused' USING ERRCODE='P1667';
 END IF;
 IF p_run IS NULL OR p_with_pins IS NULL OR p_slots IS NULL
 OR cardinality(p_slots) NOT BETWEEN 1 AND 3
 OR cardinality(p_slots)<>(SELECT count(DISTINCT slot) FROM unnest(p_slots) slot)
 OR EXISTS(SELECT 1 FROM unnest(p_slots) slot WHERE slot NOT IN
  ('descriptor','strict-point-in-time-v1','retrospective-reconstruction-v1')) THEN
  RAISE EXCEPTION 'model-read-request-refused' USING ERRCODE='P1663';
 END IF;
 SELECT r.* INTO publication FROM fs138.model_runs r WHERE r.run_id=p_run;
 IF NOT FOUND THEN RAISE EXCEPTION 'model-read-missing' USING ERRCODE='P1664'; END IF;
 SELECT coalesce(array_agg(DISTINCT i.snapshot_id ORDER BY i.snapshot_id),'{}') INTO snapshots
 FROM fs138.model_run_datasets p JOIN fs138.dataset_inputs i USING(dataset_id) WHERE p.run_id=p_run;
 WITH profiles AS (SELECT DISTINCT s.profile_id FROM fs138.source_snapshots s WHERE s.snapshot_id=ANY(snapshots)),
 decisions AS MATERIALIZED (
  SELECT p.profile_id,e.decision_id,e.allowed_uses FROM profiles p
  LEFT JOIN LATERAL fs138.effective_rights(p.profile_id,checked_at,checked_at) e ON true
 ) SELECT coalesce(bool_and(decision_id IS NOT NULL AND 'research'=ANY(allowed_uses)),false),
  jsonb_build_object('checkedAt',checked_at,'decisions',coalesce(jsonb_agg(jsonb_build_object(
   'profileId',profile_id,'decisionId',decision_id) ORDER BY profile_id),'[]'::jsonb)) INTO allowed,receipt FROM decisions;
 IF NOT allowed THEN RAISE EXCEPTION 'model-current-rights-refused' USING ERRCODE='P1665'; END IF;
 IF publication.invalidated_at IS NOT NULL
 OR (SELECT count(*) FROM fs138.model_run_datasets p WHERE p.run_id=p_run) NOT BETWEEN 1 AND 2
 OR EXISTS(SELECT 1 FROM fs138.model_run_datasets p LEFT JOIN fs138.dataset_manifests d USING(dataset_id)
  WHERE p.run_id=p_run AND (d.dataset_id IS NULL OR d.invalidated_at IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM fs138.dataset_inputs i WHERE i.dataset_id=p.dataset_id)))
 OR EXISTS(SELECT 1 FROM unnest(snapshots) id LEFT JOIN fs138.source_snapshots s ON s.snapshot_id=id
  WHERE s.snapshot_id IS NULL OR s.deleted_at IS NOT NULL) THEN
  RAISE EXCEPTION 'model-read-status-refused' USING ERRCODE='P1666';
 END IF;
 IF (SELECT count(*) FROM fs138.model_artifacts a WHERE a.run_id=p_run AND a.slot=ANY(p_slots))<>cardinality(p_slots) THEN
  RAISE EXCEPTION 'model-read-missing' USING ERRCODE='P1664';
 END IF;
 -- A shared-retained tombstone refuses new publication, not delivery of a live
 -- unaffected run. Run/dataset/source status above is the delivery policy.
 IF NOT p_with_pins THEN RETURN jsonb_build_object('authorization',receipt); END IF;
 SELECT jsonb_agg(jsonb_build_object('datasetId',p.dataset_id,'mode',p.evidence_mode,
  'fileSha256',p.file_sha256,'contentSha256',p.content_sha256,'spec',p.spec,
  'rowCount',p.row_count,'recordedAt',p.dataset_recorded_at) ORDER BY p.evidence_mode)
 INTO pins FROM fs138.model_run_datasets p WHERE p.run_id=p_run;
 SELECT jsonb_agg(jsonb_build_object('slot',a.slot,'datasetId',a.dataset_id,'objectKey',a.object_key,
  'fileSha256',a.file_sha256,'byteSize',a.byte_size) ORDER BY a.slot)
 INTO files FROM fs138.model_artifacts a WHERE a.run_id=p_run AND a.slot=ANY(p_slots);
 RETURN jsonb_build_object('run',jsonb_build_object('runId',publication.run_id,
  'descriptorSha256',publication.descriptor_sha256,'identity',publication.identity,
  'recordedAt',publication.recorded_at,'rightsReceipt',publication.rights_receipt),
  'datasets',pins,'artifacts',files,'authorization',receipt);
END $$;
REVOKE ALL ON FUNCTION fs138.authorize_model_read(uuid,text[],boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fs138.authorize_model_read(uuid,text[],boolean) TO fs138_reader,fs138_pipeline_writer;
