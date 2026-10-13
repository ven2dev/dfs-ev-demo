-- Local bounded training evidence reads. This is deliberately a conservative
-- table guard, not a scalable hosted reader. SHARE blocks INSERT/UPDATE/DELETE
-- (including direct SQL rights changes), TRUNCATE and retention until COMMIT.
-- Acquire it in READ COMMITTED before any selection or protected byte access.
-- No digest lock is taken by this reader: stable committed blob references
-- prevent cleanup from unlinking them, avoiding table-lock -> digest-lock
-- inversion against publication (digest-lock -> table write). Cleanup itself
-- still holds its digest lock and rechecks the exact reference before unlink.
CREATE INDEX predictive_training_feature_lookup ON public.predictive_source_consumers
  (player_id,game_id,cutoff,recorded_at DESC,id COLLATE "C" DESC) WHERE kind='feature';
CREATE INDEX predictive_training_label_lookup ON public.predictive_source_consumers
  (player_id,game_id,recorded_at DESC,id COLLATE "C" DESC) WHERE kind='label';

CREATE FUNCTION public.predictive_training_read_guard() RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'predictive_replay','MEMBER') THEN
    RAISE EXCEPTION 'training-read-not-authorized' USING ERRCODE='42501';
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed'
      OR pg_catalog.current_setting('transaction_read_only') <> 'off' THEN
    RAISE EXCEPTION 'training-read-transaction-refused' USING ERRCODE='25000';
  END IF;
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
    IN SHARE MODE;
  RETURN public.predictive_source_time(date_trunc('milliseconds',pg_catalog.clock_timestamp()));
END
$$;
REVOKE ALL ON FUNCTION public.predictive_training_read_guard() FROM PUBLIC;
DO $grants$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='predictive_replay') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_training_read_guard() TO predictive_replay;
  END IF;
END $grants$;
