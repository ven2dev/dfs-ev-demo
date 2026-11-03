-- #229 Step 1: single-owner GC handoff; apply after #166, never a frozen migration.
-- Design basis/alternatives: docs/229-late-put-recovery-roadmap.md.
-- Existing sorted address locks remain the serialization boundary.
ALTER TABLE fs138.object_removals
 ADD COLUMN recovery_until timestamptz,
 ADD COLUMN recovery_due timestamptz,
 ADD COLUMN recovery_step smallint NOT NULL DEFAULT 0 CHECK(recovery_step BETWEEN 0 AND 6);
CREATE INDEX removal_recovery_due ON fs138.object_removals(recovery_due,object_key)
 WHERE completed_at IS NOT NULL AND recovery_until IS NOT NULL;

-- The existing pending lane must also skip permanent completed tombstones.
CREATE INDEX removal_pending_addresses ON fs138.object_removals(object_key)
 WHERE completed_at IS NULL;

-- Writer-only handoff for the queue trigger and locked pending recheck.
-- Caller deletion functions already hold the complete sorted address-lock set.
CREATE FUNCTION fs138.adopt_removal_observation(address text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE enrolled timestamptz;
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN
  RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501'; END IF;
 IF address IS NULL OR address !~ '^(models|audits)/[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'object-address-refused' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 IF NOT EXISTS(SELECT FROM fs138.object_removals WHERE object_key=address) THEN RETURN false; END IF;
 SELECT first_seen INTO enrolled FROM fs138.orphan_observations WHERE object_key=address;
 IF enrolled IS NULL THEN RETURN false; END IF;
 UPDATE fs138.object_removals SET
  recovery_until=greatest(recovery_until,enrolled+interval '24 hours'),
  recovery_due=CASE WHEN completed_at IS NOT NULL THEN coalesce(recovery_due,clock_timestamp()) ELSE recovery_due END,
  remove_after=greatest(remove_after,enrolled+interval '300 seconds')
 WHERE object_key=address;
 DELETE FROM fs138.orphan_observations WHERE object_key=address;
 RETURN true;
END $$;

-- AFTER is essential for UPSERT: BEFORE INSERT would consume the observation
-- before the conflicting row receives its horizon. All updates here are in the
-- deletion transaction; an error rolls both the queue intent and handoff back.
CREATE FUNCTION fs138.adopt_queued_observation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
BEGIN
 IF NEW.object_key ~ '^(models|audits)/' THEN
  PERFORM fs138.adopt_removal_observation(NEW.object_key);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER removal_observation_handoff AFTER INSERT OR UPDATE OF event_id
 ON fs138.object_removals FOR EACH ROW EXECUTE FUNCTION fs138.adopt_queued_observation();

-- Private scheduling helper: callers hold the address lock. Scans/repeated
-- events never reset the step or horizon. NULL due means initial completion.
CREATE FUNCTION fs138.schedule_removal_recovery(address text,advance boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE at_time timestamptz:=clock_timestamp();
BEGIN
 UPDATE fs138.object_removals SET
  recovery_due=CASE WHEN recovery_until<=at_time THEN NULL
   ELSE least(recovery_until,at_time+make_interval(secs=>least(3600,60*power(2,recovery_step))::double precision)) END,
  recovery_step=CASE WHEN recovery_until<=at_time THEN 0 ELSE least(6,recovery_step+1) END,
  recovery_until=CASE WHEN recovery_until<=at_time THEN NULL ELSE recovery_until END
 WHERE object_key=address AND completed_at IS NOT NULL AND recovery_until IS NOT NULL
 AND (advance OR recovery_due IS NULL);
END $$;
REVOKE ALL ON FUNCTION fs138.schedule_removal_recovery(text,boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION fs138.removal_recheck(address text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN
  RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501';
 END IF;
 IF address IS NULL OR address !~ '^(raw|datasets|models|audits)/[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'object-address-refused' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 IF NOT EXISTS(SELECT 1 FROM fs138.object_removals o
  WHERE o.object_key=address AND o.completed_at IS NULL AND o.remove_after<=clock_timestamp()) THEN RETURN false; END IF;
 IF address ~ '^(models|audits)/' THEN PERFORM fs138.adopt_removal_observation(address); END IF;
 -- Adoption can extend grace, so re-read it under the same lock.
 IF NOT EXISTS(SELECT FROM fs138.object_removals WHERE object_key=address
  AND completed_at IS NULL AND remove_after<=clock_timestamp()) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM fs138.source_snapshots s WHERE s.object_key=address AND s.deleted_at IS NULL)
 OR EXISTS(SELECT 1 FROM fs138.dataset_manifests d WHERE d.object_key=address AND d.invalidated_at IS NULL)
 OR EXISTS(SELECT 1 FROM fs138.model_artifacts a JOIN fs138.model_runs r USING(run_id)
  WHERE a.object_key=address AND r.invalidated_at IS NULL) THEN
  UPDATE fs138.object_removals SET completed_at=clock_timestamp(),outcome='shared-retained' WHERE object_key=address;
  PERFORM fs138.schedule_removal_recovery(address,false);
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
 -- The mandatory tombstone owns this address, including its retained horizon.
 IF address ~ '^(models|audits)/' AND EXISTS(SELECT FROM fs138.object_removals WHERE object_key=address) THEN RETURN false; END IF;
 IF address ~ '^(models|audits)/' THEN
  -- Only unowned model/audit observations reach scoped orphan cleanup.
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
 RETURN observed_at IS NOT NULL AND
  observed_at+make_interval(secs=>grace_seconds)<=clock_timestamp();
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
 -- The mandatory tombstone owns this address, including its retained horizon.
 IF address ~ '^(models|audits)/' AND EXISTS(SELECT FROM fs138.object_removals WHERE object_key=address) THEN RETURN false; END IF;
 DELETE FROM fs138.orphan_observations o WHERE o.object_key=address
 AND o.first_seen+make_interval(secs=>retirement_seconds)<=clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM fs138.model_artifacts a JOIN fs138.model_runs r USING(run_id)
  WHERE a.object_key=address AND r.invalidated_at IS NULL);
 GET DIAGNOSTICS retired=ROW_COUNT;
 RETURN retired=1;
END $$;

REVOKE ALL ON FUNCTION fs138.adopt_removal_observation(text),fs138.adopt_queued_observation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fs138.adopt_removal_observation(text) TO fs138_pipeline_writer;
-- CREATE OR REPLACE preserves the existing recheck/orphan/retirement grants.

-- Both ordinary completion paths start the same backoff, including shared files.
CREATE OR REPLACE FUNCTION fs138.ack_removal(address text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
BEGIN
 IF NOT fs138.removal_recheck(address) THEN
  RAISE EXCEPTION 'removal-not-authorized' USING ERRCODE='23514'; END IF;
 UPDATE fs138.object_removals SET completed_at=clock_timestamp(),outcome='removed' WHERE object_key=address;
 PERFORM fs138.schedule_removal_recovery(address,false);
END $$;

CREATE FUNCTION fs138.recovery_removal_recheck(address text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN
  RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501'; END IF;
 IF address IS NULL OR address !~ '^(models|audits)/[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'object-address-refused' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 -- Queue-time handoff supplies recovery metadata. No legacy discovery runs here.
 IF NOT EXISTS(SELECT FROM fs138.object_removals WHERE object_key=address
  AND completed_at IS NOT NULL AND recovery_until IS NOT NULL
  AND recovery_due<=clock_timestamp() AND remove_after<=clock_timestamp()) THEN RETURN false; END IF;
 IF EXISTS(SELECT FROM fs138.source_snapshots WHERE object_key=address AND deleted_at IS NULL)
 OR EXISTS(SELECT FROM fs138.dataset_manifests WHERE object_key=address AND invalidated_at IS NULL)
 OR EXISTS(SELECT FROM fs138.model_artifacts a JOIN fs138.model_runs r USING(run_id)
  WHERE a.object_key=address AND r.invalidated_at IS NULL) THEN
  UPDATE fs138.object_removals SET outcome='shared-retained' WHERE object_key=address;
  -- No DELETE is allowed; advance/retire metadata so shared rows cannot pin pages.
  PERFORM fs138.schedule_removal_recovery(address,true);
  RETURN false;
 END IF;
 RETURN true;
END $$;

CREATE FUNCTION fs138.ack_recovery_removal(address text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
BEGIN
 IF NOT fs138.recovery_removal_recheck(address) THEN
  RAISE EXCEPTION 'recovery-not-authorized' USING ERRCODE='23514'; END IF;
 -- DELETE succeeded while the same address lock was held. The last expired
 -- revisit retires only scheduling metadata; the permanent tombstone stays.
 PERFORM fs138.schedule_removal_recovery(address,true);
END $$;
REVOKE ALL ON FUNCTION fs138.recovery_removal_recheck(text),fs138.ack_recovery_removal(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fs138.recovery_removal_recheck(text),fs138.ack_recovery_removal(text) TO fs138_pipeline_writer;
