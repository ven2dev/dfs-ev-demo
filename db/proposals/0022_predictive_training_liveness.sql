-- Draft for the reserved 0022 slot. Not part of the ordered migration chain.
-- Integrate #106's frozen 0021 before promoting this file or its catalog.

-- One explicit inventory for the evidence guard and memo dependency subset.
-- Forward context migrations must extend this inventory when they add reads.
CREATE FUNCTION public.predictive_training_relations()
RETURNS TABLE(relation_name text,memo_dependency boolean)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
  VALUES
    ('predictive_artifact_observations',true),
    ('predictive_artifacts',true),
    ('predictive_blob_removals',false),
    ('predictive_blobs',true),
    ('predictive_captures',true),
    ('predictive_compressed_inspections',true),
    ('predictive_compressed_publications',true),
    ('predictive_compressed_retention_audits',false),
    ('predictive_decision_inputs',true),
    ('predictive_decisions',true),
    ('predictive_feature_run_dependencies',false),
    ('predictive_feature_run_pins',false),
    ('predictive_feature_run_unpins',false),
    ('predictive_feature_runs',false),
    ('predictive_games',true),
    ('predictive_ingestion_runs',true),
    ('predictive_observations',true),
    ('predictive_outcome_labels',false),
    ('predictive_profile_identity_links',true),
    ('predictive_retention_authorizations',false),
    ('predictive_retention_events',true),
    ('predictive_retention_tombstones',false),
    ('predictive_rights_decisions',true),
    ('predictive_run_rights',true),
    ('predictive_source_binding_captures',true),
    ('predictive_source_binding_decisions',true),
    ('predictive_source_binding_dependencies',true),
    ('predictive_source_binding_links',true),
    ('predictive_source_binding_rights',true),
    ('predictive_source_binding_rows',true),
    ('predictive_source_bindings',true),
    ('predictive_source_consumer_bindings',true),
    ('predictive_source_consumer_decisions',true),
    ('predictive_source_consumer_observations',true),
    ('predictive_source_consumer_rights',true),
    ('predictive_source_consumer_source_decisions',true),
    ('predictive_source_consumers',true),
    ('predictive_source_decision_bindings',true),
    ('predictive_source_decision_inputs',true),
    ('predictive_source_decision_rights',true),
    ('predictive_source_decisions',true),
    ('predictive_source_profiles',true),
    ('predictive_source_stats_revisions',true),
    ('predictive_source_stats_rows',true),
    ('predictive_teams',true),
    ('predictive_training_dataset_consumers',false),
    ('predictive_training_dataset_identities',false),
    ('predictive_training_dataset_pins',false),
    ('predictive_training_dataset_releases',false),
    ('predictive_training_dataset_retention_audits',false),
    ('predictive_training_datasets',false),
    ('predictive_training_pin_identities',false),
    ('predictive_training_retention_audits',false),
    ('predictive_training_run_events',false),
    ('predictive_training_run_identities',false),
    ('predictive_training_run_profiles',false),
    ('predictive_training_run_slots',false),
    ('predictive_training_runs',false)
$$;
REVOKE ALL ON FUNCTION public.predictive_training_relations() FROM PUBLIC;

-- Readers take the shared form of the writer/retention lock before ANY table
-- lock. Writers already acquire its exclusive form first. Readers remain
-- concurrent; no caller-controlled configuration or lock list is accepted.
-- Replace the live guard outright, rather than adding another wrapper layer.
CREATE OR REPLACE FUNCTION public.predictive_training_read_guard() RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE targets text;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_replay','MEMBER') THEN
    RAISE EXCEPTION 'training-read-not-authorized' USING ERRCODE='42501'; END IF;
  IF current_setting('transaction_isolation')<>'read committed'
      OR current_setting('transaction_read_only')<>'off' THEN
    RAISE EXCEPTION 'training-read-transaction-refused' USING ERRCODE='25000'; END IF;
  PERFORM pg_advisory_xact_lock_shared(520052,1);
  SELECT string_agg(format('public.%I',relation_name),',' ORDER BY relation_name COLLATE "C") INTO targets
    FROM public.predictive_training_relations();
  EXECUTE 'LOCK TABLE ' || targets || ' IN SHARE MODE';
  RETURN public.predictive_source_time(date_trunc('milliseconds',clock_timestamp()));
END
$$;

-- Retention may widen a label deletion to its entire target lineage, including
-- consumers using profiles not named by the request. Follow the ACTUAL deleted
-- consumer rather than predicting that widened set from dataset profile uses.
-- Existing dataset deletion triggers erase pins/links and record per-dataset
-- removal audits plus parent-run invalidations in the same transaction.
CREATE FUNCTION public.predictive_training_consumer_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT pg_has_role(session_user,'predictive_retention_owner','MEMBER')
      OR NOT EXISTS(SELECT 1 FROM public.predictive_retention_authorizations
        WHERE txid=pg_current_xact_id()) THEN
    RAISE EXCEPTION 'training-retention-not-authorized' USING ERRCODE='42501'; END IF;
  DELETE FROM public.predictive_training_datasets d WHERE EXISTS(
    SELECT 1 FROM public.predictive_training_dataset_consumers x WHERE x.dataset_id=d.id AND x.consumer_id=OLD.id);
  RETURN OLD;
END
$$;
REVOKE ALL ON FUNCTION public.predictive_training_consumer_delete() FROM PUBLIC;
CREATE TRIGGER predictive_training_consumer_delete BEFORE DELETE ON public.predictive_source_consumers
  FOR EACH ROW EXECUTE FUNCTION public.predictive_training_consumer_delete();
