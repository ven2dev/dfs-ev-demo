-- Draft for reserved 0023; finalize after the frozen #106 0021 integration.
-- These lookups retain the existing JSON equality and correction semantics.
CREATE INDEX predictive_training_observation_entity ON public.predictive_observations(entity_key,id);
CREATE INDEX predictive_training_schedule_raw_game ON public.predictive_observations((data->'rawGameId'),game_id,id)
  WHERE kind='schedule';
CREATE INDEX predictive_training_capture_artifact_clock ON public.predictive_captures(artifact_id,ingested_at,id);
-- The released predictive_artifact_observations_reverse_idx already covers
-- observation -> artifact traversal; do not duplicate that index.

-- An explicit single-address adjacency lookup prevents materializing a
-- league-wide union of all edges each time a small dataset is reconstructed.
-- Every branch starts with a primary/leading-key or indexed address predicate.
CREATE FUNCTION public.predictive_training_reference_edges(source_kind text,source_id text,snapshot_at timestamptz)
RETURNS TABLE(kind text,id text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  CASE source_kind
  WHEN 'source-consumer' THEN RETURN QUERY
    SELECT 'source-consumer',c.predecessor_id FROM public.predictive_source_consumers c WHERE c.id=source_id AND c.predecessor_id IS NOT NULL
    UNION ALL SELECT 'source-binding',x.binding_id FROM public.predictive_source_consumer_bindings x WHERE x.consumer_id=source_id
    UNION ALL SELECT 'source-decision',x.decision_id FROM public.predictive_source_consumer_source_decisions x WHERE x.consumer_id=source_id
    UNION ALL SELECT 'observation',x.observation_id FROM public.predictive_source_consumer_observations x WHERE x.consumer_id=source_id
    UNION ALL SELECT 'decision',x.decision_id FROM public.predictive_source_consumer_decisions x WHERE x.consumer_id=source_id
    UNION ALL SELECT 'rights',x.rights_decision_id FROM public.predictive_source_consumer_rights x WHERE x.consumer_id=source_id
    UNION ALL SELECT 'blob',c.body_sha256 FROM public.predictive_source_consumers c WHERE c.id=source_id
    UNION ALL SELECT 'capture',c.body->>'postWindowCaptureId' FROM public.predictive_source_consumers c WHERE c.id=source_id AND c.kind='label';
  WHEN 'source-binding' THEN RETURN QUERY
    SELECT 'source-binding',b.predecessor_id FROM public.predictive_source_bindings b WHERE b.id=source_id AND b.predecessor_id IS NOT NULL
    UNION ALL SELECT 'source-revision',b.revision_id FROM public.predictive_source_bindings b WHERE b.id=source_id AND b.revision_id IS NOT NULL
    UNION ALL SELECT 'capture',x.capture_id FROM public.predictive_source_binding_captures x WHERE x.binding_id=source_id
    UNION ALL SELECT 'source-row',x.row_id FROM public.predictive_source_binding_rows x WHERE x.binding_id=source_id
    UNION ALL SELECT 'observation',x.observation_id FROM public.predictive_source_binding_dependencies x WHERE x.binding_id=source_id
    UNION ALL SELECT 'capture',x.capture_id FROM public.predictive_source_binding_dependencies x WHERE x.binding_id=source_id
    UNION ALL SELECT 'artifact',x.artifact_id FROM public.predictive_source_binding_dependencies x WHERE x.binding_id=source_id
    UNION ALL SELECT 'identity-link',x.link_id FROM public.predictive_source_binding_links x WHERE x.binding_id=source_id
    UNION ALL SELECT 'decision',x.decision_id FROM public.predictive_source_binding_decisions x WHERE x.binding_id=source_id
    UNION ALL SELECT 'rights',x.rights_decision_id FROM public.predictive_source_binding_rights x WHERE x.binding_id=source_id;
  WHEN 'source-revision' THEN RETURN QUERY
    SELECT 'source-revision',r.predecessor_id FROM public.predictive_source_stats_revisions r WHERE r.id=source_id AND r.predecessor_id IS NOT NULL;
  WHEN 'source-row' THEN RETURN QUERY
    SELECT 'capture',r.capture_id FROM public.predictive_source_stats_rows r WHERE r.id=source_id;
  WHEN 'source-decision' THEN RETURN QUERY
    SELECT 'source-decision',d.predecessor_id FROM public.predictive_source_decisions d WHERE d.id=source_id AND d.predecessor_id IS NOT NULL
    UNION ALL SELECT 'source-binding',x.binding_id FROM public.predictive_source_decision_bindings x WHERE x.decision_id=source_id
    UNION ALL SELECT 'observation',x.observation_id FROM public.predictive_source_decision_inputs x WHERE x.decision_id=source_id
    UNION ALL SELECT 'rights',x.rights_decision_id FROM public.predictive_source_decision_rights x WHERE x.decision_id=source_id;
  WHEN 'decision' THEN RETURN QUERY
    SELECT 'decision',d.predecessor_id FROM public.predictive_decisions d WHERE d.id=source_id AND d.predecessor_id IS NOT NULL
    UNION ALL SELECT 'observation',x.observation_id FROM public.predictive_decision_inputs x WHERE x.decision_id=source_id
    UNION ALL SELECT 'ingestion-run',d.run_id FROM public.predictive_decisions d WHERE d.id=source_id;
  WHEN 'observation' THEN RETURN QUERY
    SELECT 'observation',o.predecessor_id FROM public.predictive_observations o WHERE o.id=source_id AND o.predecessor_id IS NOT NULL
    UNION ALL SELECT 'artifact',x.artifact_id FROM public.predictive_artifact_observations x WHERE x.observation_id=source_id
      AND EXISTS(SELECT 1 FROM public.predictive_captures c WHERE c.artifact_id=x.artifact_id AND c.ingested_at<=snapshot_at);
  WHEN 'artifact' THEN RETURN QUERY
    SELECT 'blob',a.blob_sha256 FROM public.predictive_artifacts a WHERE a.id=source_id
    UNION ALL SELECT 'capture',c.id FROM public.predictive_captures c WHERE c.artifact_id=source_id AND c.ingested_at<=snapshot_at;
  WHEN 'capture' THEN RETURN QUERY
    SELECT 'compressed-publication',p.capture_id FROM public.predictive_compressed_publications p WHERE p.capture_id=source_id
    UNION ALL SELECT 'compressed-inspection',i.capture_id FROM public.predictive_compressed_inspections i WHERE i.capture_id=source_id
    UNION ALL SELECT 'artifact',c.artifact_id FROM public.predictive_captures c WHERE c.id=source_id
    UNION ALL SELECT 'ingestion-run',c.run_id FROM public.predictive_captures c WHERE c.id=source_id;
  WHEN 'ingestion-run' THEN RETURN QUERY
    SELECT 'rights',r.rights_decision_id FROM public.predictive_run_rights r WHERE r.run_id=source_id;
  WHEN 'rights' THEN RETURN QUERY
    SELECT 'rights',r.predecessor_id FROM public.predictive_rights_decisions r WHERE r.id=source_id AND r.predecessor_id IS NOT NULL;
  ELSE RETURN;
  END CASE;
END
$$;
REVOKE ALL ON FUNCTION public.predictive_training_reference_edges(text,text,timestamptz) FROM PUBLIC;

CREATE FUNCTION public.predictive_training_reference_profiles(source_kind text,source_id text)
RETURNS TABLE(profile text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  CASE source_kind
  WHEN 'artifact' THEN RETURN QUERY SELECT a.profile_id FROM public.predictive_artifacts a WHERE a.id=source_id;
  WHEN 'observation' THEN RETURN QUERY SELECT o.profile_id FROM public.predictive_observations o WHERE o.id=source_id;
  WHEN 'source-binding' THEN RETURN QUERY SELECT b.profile_id FROM public.predictive_source_bindings b WHERE b.id=source_id;
  WHEN 'rights' THEN RETURN QUERY SELECT r.profile_id FROM public.predictive_rights_decisions r WHERE r.id=source_id;
  WHEN 'identity-link' THEN RETURN QUERY
    SELECT x.stats_profile_id FROM public.predictive_profile_identity_links x WHERE x.id=source_id
    UNION ALL SELECT x.bridge_profile_id FROM public.predictive_profile_identity_links x WHERE x.id=source_id;
  ELSE RETURN;
  END CASE;
END
$$;
REVOKE ALL ON FUNCTION public.predictive_training_reference_profiles(text,text) FROM PUBLIC;

-- Carry use provenance in the single traversal; shared ancestors can have both
-- model-input and outcome-label obligations. UNION breaks all graph cycles.
-- No future captures or successors expand a historical manifest's closure.
CREATE OR REPLACE FUNCTION public.predictive_training_dataset_closure(run_name text,dataset text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  WITH RECURSIVE inventory AS (SELECT snapshot_at FROM public.predictive_training_runs WHERE id=$1),
  rows AS (SELECT s.selection FROM public.predictive_training_run_slots s WHERE s.run_id=$1 AND s.dataset_id=$2),
  roots(kind,id) AS (
    SELECT 'source-consumer',id FROM rows r CROSS JOIN LATERAL
      (VALUES(r.selection->'selection'->>'featureId'),(r.selection->'selection'->>'labelId')) x(id) WHERE id IS NOT NULL
    UNION SELECT 'observation',x->>'observationId' FROM rows r CROSS JOIN LATERAL jsonb_array_elements(r.selection->'kickoff'->'dependencies') x
    UNION SELECT 'decision',selection->'kickoff'->>'decisionId' FROM rows WHERE selection->'kickoff'->>'decisionId' IS NOT NULL),
  protected(kind,id,use_kind) AS (
    SELECT r.kind,r.id,CASE WHEN r.kind='source-consumer' AND EXISTS(
      SELECT 1 FROM public.predictive_source_consumers c WHERE c.id=r.id AND c.kind='label') THEN 'outcome-label' ELSE 'model-input' END FROM roots r
    UNION SELECT e.kind,e.id,c.use_kind FROM protected c CROSS JOIN inventory i
      CROSS JOIN LATERAL public.predictive_training_reference_edges(c.kind,c.id,i.snapshot_at) e),
  bounded AS (SELECT kind,id FROM (SELECT DISTINCT kind,id FROM protected) refs ORDER BY kind COLLATE "C",id COLLATE "C" LIMIT 65537)
  SELECT jsonb_build_object(
    'references',coalesce((SELECT jsonb_agg(jsonb_build_object('kind',kind,'id',id) ORDER BY kind COLLATE "C",id COLLATE "C") FROM bounded),'[]'),
    'protectedUses',coalesce((SELECT jsonb_agg(jsonb_build_object('profile',profile,'use',use_kind) ORDER BY profile COLLATE "C",use_kind COLLATE "C")
      FROM (SELECT DISTINCT p.profile,c.use_kind FROM protected c
        CROSS JOIN LATERAL public.predictive_training_reference_profiles(c.kind,c.id) p) uses),'[]'),
    'blobs',coalesce((SELECT jsonb_agg(jsonb_build_object('sha256',b.sha256,'storageRef',b.storage_ref,'byteSize',b.byte_size,'mediaType',b.media_type)
      ORDER BY b.storage_ref COLLATE "C") FROM bounded c JOIN public.predictive_blobs b ON c.kind='blob' AND c.id=b.sha256),'[]'))
$$;
