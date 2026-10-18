-- Mutable #138 step-5 proposal. Applied AFTER 138_feature_store.sql in the
-- same disposable transaction; no ordered migrations or legacy objects change.
ALTER TABLE fs138.feature_values DROP CONSTRAINT feature_values_supersedes_id_fkey;
ALTER TABLE fs138.feature_values ADD FOREIGN KEY(supersedes_id) REFERENCES fs138.feature_values ON DELETE SET NULL;
ALTER TABLE fs138.outcome_labels DROP CONSTRAINT outcome_labels_supersedes_id_fkey;
ALTER TABLE fs138.outcome_labels ADD FOREIGN KEY(supersedes_id) REFERENCES fs138.outcome_labels ON DELETE SET NULL;

CREATE TABLE fs138.dataset_manifests (
 dataset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 code_sha text NOT NULL CHECK(code_sha ~ '^[a-f0-9]{40}$'),
 implementation_sha256 fs138.sha256 NOT NULL,
 spec jsonb NOT NULL,
 input_sha256 fs138.sha256 NOT NULL,
 file_sha256 fs138.sha256 NOT NULL,
 content_sha256 fs138.sha256 NOT NULL,
 object_key text NOT NULL CHECK(object_key='datasets/'||file_sha256),
 byte_size integer NOT NULL CHECK(byte_size>=0),
 row_count integer NOT NULL CHECK(row_count>=0),
 exclusions jsonb NOT NULL,
 rights_receipt jsonb NOT NULL,
 recorded_at timestamptz NOT NULL,
 invalidated_at timestamptz
);
CREATE TABLE fs138.dataset_members (
 dataset_id uuid NOT NULL REFERENCES fs138.dataset_manifests,
 feature_id uuid NOT NULL REFERENCES fs138.feature_values,
 label_id uuid NOT NULL REFERENCES fs138.outcome_labels,
 PRIMARY KEY(dataset_id,feature_id), UNIQUE(dataset_id,label_id)
);
CREATE INDEX dataset_feature_reverse ON fs138.dataset_members(feature_id,dataset_id);
CREATE INDEX dataset_label_reverse ON fs138.dataset_members(label_id,dataset_id);
CREATE TABLE fs138.dataset_inputs (
 dataset_id uuid NOT NULL REFERENCES fs138.dataset_manifests,
 snapshot_id uuid NOT NULL REFERENCES fs138.source_snapshots,
 PRIMARY KEY(dataset_id,snapshot_id)
);
CREATE INDEX dataset_inputs_reverse ON fs138.dataset_inputs(snapshot_id,dataset_id);
CREATE TABLE fs138.deletion_events (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 recorded_at timestamptz NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 512),
 grace_seconds double precision NOT NULL CHECK(grace_seconds BETWEEN 0 AND 86400),
 snapshot_ids uuid[] NOT NULL, feature_ids uuid[] NOT NULL,
 label_ids uuid[] NOT NULL,dataset_ids uuid[] NOT NULL
);
CREATE TABLE fs138.object_removals (
 object_key text PRIMARY KEY CHECK(object_key ~ '^(raw|datasets)/[a-f0-9]{64}$'),
 event_id uuid NOT NULL REFERENCES fs138.deletion_events,
 remove_after timestamptz NOT NULL,
 completed_at timestamptz
);
CREATE TRIGGER dataset_clock BEFORE INSERT ON fs138.dataset_manifests
 FOR EACH ROW EXECUTE FUNCTION fs138.stamp_recorded_at();
CREATE TRIGGER deletion_clock BEFORE INSERT ON fs138.deletion_events
 FOR EACH ROW EXECUTE FUNCTION fs138.stamp_recorded_at();

-- Writer-only short row locks, never reader locks. Lock all inputs in stable
-- order, then recheck tombstones after waits; deletion cannot slip past a seal.
CREATE FUNCTION fs138.lock_active_snapshots(ids uuid[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE n integer;
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501'; END IF;
 PERFORM s.snapshot_id FROM fs138.source_snapshots s
 WHERE s.snapshot_id=ANY(ids) AND s.deleted_at IS NULL ORDER BY s.snapshot_id FOR SHARE;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>cardinality(ids) THEN RAISE EXCEPTION 'source-deleted-or-missing' USING ERRCODE='23514'; END IF;
 RETURN true;
END $$;

-- An address queued for mandatory deletion cannot be republished after a
-- pre-transaction file write. The writer-only address lock serializes with the
-- cleaner, and completed tombstones remain to refuse accidental reintroduction.
CREATE FUNCTION fs138.refuse_removed_object() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,fs138 AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.object_key,138));
 IF EXISTS(SELECT 1 FROM fs138.object_removals WHERE object_key=NEW.object_key) THEN
  RAISE EXCEPTION 'object-address-deleted' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER snapshot_object_guard BEFORE INSERT ON fs138.source_snapshots
 FOR EACH ROW EXECUTE FUNCTION fs138.refuse_removed_object();
CREATE TRIGGER dataset_object_guard BEFORE INSERT ON fs138.dataset_manifests
 FOR EACH ROW EXECUTE FUNCTION fs138.refuse_removed_object();

CREATE FUNCTION fs138.delete_sources(ids uuid[],reason text,grace_seconds double precision DEFAULT 300)
RETURNS fs138.deletion_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE receipt fs138.deletion_events; address text;
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501'; END IF;
 IF ids IS NULL OR cardinality(ids)=0 OR cardinality(ids)>1024 OR reason IS NULL OR length(reason) NOT BETWEEN 1 AND 512
   OR grace_seconds IS NULL OR NOT(grace_seconds BETWEEN 0 AND 86400) THEN RAISE EXCEPTION 'deletion-request-refused' USING ERRCODE='23514'; END IF;
 PERFORM snapshot_id FROM fs138.source_snapshots WHERE snapshot_id=ANY(ids) ORDER BY snapshot_id FOR UPDATE;
 IF (SELECT count(*) FROM fs138.source_snapshots WHERE snapshot_id=ANY(ids))<>cardinality(ids) THEN
  RAISE EXCEPTION 'deletion-snapshot-set-refused' USING ERRCODE='23514'; END IF;
 SELECT coalesce(array_agg(DISTINCT feature_id ORDER BY feature_id),'{}') INTO receipt.feature_ids FROM fs138.feature_inputs WHERE snapshot_id=ANY(ids);
 SELECT coalesce(array_agg(DISTINCT label_id ORDER BY label_id),'{}') INTO receipt.label_ids FROM fs138.label_inputs WHERE snapshot_id=ANY(ids);
 SELECT coalesce(array_agg(DISTINCT dataset_id ORDER BY dataset_id),'{}') INTO receipt.dataset_ids FROM (
  SELECT dataset_id FROM fs138.dataset_inputs WHERE snapshot_id=ANY(ids)
  UNION SELECT dataset_id FROM fs138.dataset_members WHERE feature_id=ANY(receipt.feature_ids) OR label_id=ANY(receipt.label_ids)
 ) d;
 INSERT INTO fs138.deletion_events(reason,grace_seconds,snapshot_ids,feature_ids,label_ids,dataset_ids)
 VALUES(reason,grace_seconds,ids,receipt.feature_ids,receipt.label_ids,receipt.dataset_ids) RETURNING * INTO receipt;
 -- Same source-row-then-address order as publication. Address locks are writer
 -- coordination only; no file read or delivery holds database locks.
 FOR address IN SELECT object_key FROM fs138.source_snapshots WHERE snapshot_id=ANY(ids)
  UNION SELECT object_key FROM fs138.dataset_manifests WHERE dataset_id=ANY(receipt.dataset_ids) ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
  INSERT INTO fs138.object_removals VALUES(address,receipt.event_id,receipt.recorded_at+make_interval(secs=>grace_seconds),NULL)
   ON CONFLICT(object_key) DO UPDATE SET remove_after=greatest(fs138.object_removals.remove_after,EXCLUDED.remove_after);
 END LOOP;
 UPDATE fs138.source_snapshots SET deleted_at=coalesce(deleted_at,receipt.recorded_at) WHERE snapshot_id=ANY(ids);
 UPDATE fs138.dataset_manifests SET invalidated_at=coalesce(invalidated_at,receipt.recorded_at) WHERE dataset_id=ANY(receipt.dataset_ids);
 DELETE FROM fs138.dataset_members WHERE dataset_id=ANY(receipt.dataset_ids);
 DELETE FROM fs138.feature_inputs WHERE feature_id=ANY(receipt.feature_ids);
 DELETE FROM fs138.label_inputs WHERE label_id=ANY(receipt.label_ids);
 DELETE FROM fs138.feature_values WHERE feature_id=ANY(receipt.feature_ids);
 DELETE FROM fs138.outcome_labels WHERE label_id=ANY(receipt.label_ids);
 DELETE FROM fs138.norm_schedule WHERE snapshot_id=ANY(ids);
 DELETE FROM fs138.norm_player_game_stats WHERE snapshot_id=ANY(ids);
 DELETE FROM fs138.norm_identity WHERE snapshot_id=ANY(ids);
 DELETE FROM fs138.norm_participation WHERE snapshot_id=ANY(ids);
 -- Raw metadata remains as a tombstone and audit identity, not provider values.
 UPDATE fs138.source_snapshots SET source_manifest='{}' WHERE snapshot_id=ANY(ids);
 -- Start the byte grace after invalidation work, not before a large deletion
 -- consumes it. This API is called as a short autocommit job statement.
 UPDATE fs138.object_removals SET remove_after=greatest(remove_after,clock_timestamp()+make_interval(secs=>grace_seconds))
 WHERE object_key IN(SELECT object_key FROM fs138.source_snapshots WHERE snapshot_id=ANY(ids)
  UNION SELECT object_key FROM fs138.dataset_manifests WHERE dataset_id=ANY(receipt.dataset_ids));
 RETURN receipt;
END $$;

CREATE FUNCTION fs138.prune_derived() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE fids uuid[]; lids uuid[];
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501'; END IF;
 -- FK checks protect concurrent pins. A conflicting seal/prune transaction
 -- fails atomically and can retry, instead of erasing newly pinned values.
 SELECT coalesce(array_agg(feature_id),'{}') INTO fids FROM (
  SELECT f.feature_id,row_number() OVER(PARTITION BY player_id,game_id,stat,feature_version,evidence_mode ORDER BY checkpoint DESC,computed_at DESC,feature_id DESC) AS rn,
   row_number() OVER(PARTITION BY player_id,game_id,stat,feature_version,evidence_mode,state ORDER BY checkpoint DESC,computed_at DESC,feature_id DESC) AS valid_rn,state
  FROM fs138.feature_values f
 ) f WHERE rn>1 AND NOT(state='usable' AND valid_rn=1)
  AND NOT EXISTS(SELECT 1 FROM fs138.dataset_members m WHERE m.feature_id=f.feature_id);
 SELECT coalesce(array_agg(label_id),'{}') INTO lids FROM (
  SELECT l.label_id,row_number() OVER(PARTITION BY player_id,game_id,stat,label_version,evidence_mode ORDER BY label_cutoff DESC,known_at DESC,label_id DESC) AS rn,
   row_number() OVER(PARTITION BY player_id,game_id,stat,label_version,evidence_mode,state ORDER BY label_cutoff DESC,known_at DESC,label_id DESC) AS valid_rn,state
  FROM fs138.outcome_labels l
 ) l WHERE rn>1 AND NOT(state='usable' AND valid_rn=1)
  AND NOT EXISTS(SELECT 1 FROM fs138.dataset_members m WHERE m.label_id=l.label_id);
 DELETE FROM fs138.feature_inputs WHERE feature_id=ANY(fids);
 DELETE FROM fs138.label_inputs WHERE label_id=ANY(lids);
 DELETE FROM fs138.feature_values WHERE feature_id=ANY(fids);
 DELETE FROM fs138.outcome_labels WHERE label_id=ANY(lids);
 RETURN jsonb_build_object('featureIds',fids,'labelIds',lids);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fs138 FROM PUBLIC;
REVOKE ALL ON fs138.dataset_manifests,fs138.dataset_members,fs138.dataset_inputs,fs138.deletion_events,fs138.object_removals FROM PUBLIC;
GRANT SELECT ON fs138.dataset_manifests,fs138.dataset_members,fs138.dataset_inputs,fs138.deletion_events,fs138.object_removals TO fs138_reader,fs138_pipeline_writer;
GRANT INSERT ON fs138.dataset_manifests,fs138.dataset_members,fs138.dataset_inputs TO fs138_pipeline_writer;
GRANT EXECUTE ON FUNCTION fs138.lock_active_snapshots(uuid[]),fs138.delete_sources(uuid[],text,double precision),fs138.prune_derived() TO fs138_pipeline_writer;
-- Governance has no general UPDATE/DELETE grant. Queue acknowledgement uses
-- narrow role-checked APIs; only the ObjectStore cleaner calls them.
CREATE FUNCTION fs138.removal_recheck(address text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 RETURN EXISTS(SELECT 1 FROM fs138.object_removals WHERE object_key=address AND completed_at IS NULL AND remove_after<=clock_timestamp())
  AND NOT EXISTS(SELECT 1 FROM fs138.source_snapshots WHERE object_key=address AND deleted_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM fs138.dataset_manifests WHERE object_key=address AND invalidated_at IS NULL);
END $$;
CREATE FUNCTION fs138.ack_removal(address text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
BEGIN
 IF NOT fs138.removal_recheck(address) THEN RAISE EXCEPTION 'removal-not-authorized' USING ERRCODE='23514'; END IF;
 UPDATE fs138.object_removals SET completed_at=clock_timestamp() WHERE object_key=address;
END $$;
REVOKE ALL ON FUNCTION fs138.removal_recheck(text),fs138.ack_removal(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fs138.removal_recheck(text),fs138.ack_removal(text) TO fs138_pipeline_writer;

-- Statistics maintenance belongs at the end of the producing derived jobs.
GRANT MAINTAIN ON fs138.feature_values,fs138.outcome_labels,fs138.feature_inputs,fs138.label_inputs TO fs138_pipeline_writer;

CREATE TABLE fs138.orphan_observations (
 object_key text PRIMARY KEY CHECK(object_key ~ '^(raw|datasets)/[a-f0-9]{64}$'),
 first_seen timestamptz NOT NULL
);
REVOKE ALL ON fs138.orphan_observations FROM PUBLIC;
GRANT SELECT ON fs138.orphan_observations TO fs138_pipeline_writer;
CREATE FUNCTION fs138.lock_object_for_publication(address text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501'; END IF;
 IF address IS NULL OR address !~ '^(raw|datasets)/[a-f0-9]{64}$' THEN RAISE EXCEPTION 'object-address-refused' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 IF EXISTS(SELECT 1 FROM fs138.object_removals WHERE object_key=address) THEN RAISE EXCEPTION 'object-address-deleted' USING ERRCODE='23514'; END IF;
 DELETE FROM fs138.orphan_observations WHERE object_key=address;
END $$;
CREATE FUNCTION fs138.orphan_recheck(address text,grace_seconds double precision DEFAULT 300) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE first_seen timestamptz;
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501'; END IF;
 IF address IS NULL OR address !~ '^(raw|datasets)/[a-f0-9]{64}$' OR grace_seconds IS NULL OR NOT(grace_seconds BETWEEN 0 AND 86400) THEN RAISE EXCEPTION 'orphan-request-refused' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 -- Mandatory deletion owns its own grace/receipt, including shared addresses.
 IF EXISTS(SELECT 1 FROM fs138.object_removals WHERE object_key=address)
 OR EXISTS(SELECT 1 FROM fs138.source_snapshots WHERE object_key=address)
 OR EXISTS(SELECT 1 FROM fs138.dataset_manifests WHERE object_key=address) THEN
  DELETE FROM fs138.orphan_observations WHERE object_key=address; RETURN false;
 END IF;
 INSERT INTO fs138.orphan_observations VALUES(address,clock_timestamp()) ON CONFLICT DO NOTHING;
 SELECT o.first_seen INTO first_seen FROM fs138.orphan_observations o WHERE object_key=address;
 RETURN first_seen+make_interval(secs=>grace_seconds)<=clock_timestamp();
END $$;
REVOKE ALL ON FUNCTION fs138.lock_object_for_publication(text),fs138.orphan_recheck(text,double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fs138.lock_object_for_publication(text),fs138.orphan_recheck(text,double precision) TO fs138_pipeline_writer;

-- Upload-first may recreate a completed tombstone before publication refuses
-- it. Re-arm its idempotent cleaner under the same address lock; keep its grace.
CREATE FUNCTION fs138.requeue_removed_object(address text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
BEGIN
 IF NOT pg_has_role(session_user,'fs138_pipeline_writer','member') THEN RAISE EXCEPTION 'pipeline-role-required' USING ERRCODE='42501'; END IF;
 IF address IS NULL OR address !~ '^(raw|datasets)/[a-f0-9]{64}$' THEN RAISE EXCEPTION 'object-address-refused' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 UPDATE fs138.object_removals SET completed_at=NULL WHERE object_key=address;
END $$;
REVOKE ALL ON FUNCTION fs138.requeue_removed_object(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fs138.requeue_removed_object(text) TO fs138_pipeline_writer;
