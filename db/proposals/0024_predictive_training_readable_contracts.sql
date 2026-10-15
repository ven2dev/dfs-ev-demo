-- Draft for reserved 0024. Integrate frozen #106 0021 before promotion.
-- Full effective definitions replace the old runtime string seams.
-- CREATE OR REPLACE preserves the existing execute-only ACLs.

CREATE OR REPLACE FUNCTION public.predictive_retention_execute(event_id text, event_reason text, event_authority text, event_decided_at timestamp with time zone, event_scope jsonb, event_audit_level text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  profiles text[]; captured_from timestamptz; captured_before timestamptz; as_of timestamptz;
  arts text[] := '{}'; caps text[] := '{}'; obs text[] := '{}'; decs text[] := '{}'; labs text[] := '{}';
  runs text[] := '{}'; pins text[] := '{}'; blobs text[] := '{}'; refs text[]; source_rows text[] := '{}'; bindings text[] := '{}'; revisions text[] := '{}'; binding_links integer; source_decs text[] := '{}'; source_decision_links integer; consumers text[]:='{}'; consumer_links integer;
  removed_kinds text[]; removed_ids text[]; counts jsonb; ids_digest text; links integer; inputs integer; dependencies integer; unpins integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'predictive_retention_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'predictive-retention-not-authorized' USING ERRCODE = '42501';
  END IF;
  IF event_decided_at IS NULL OR event_decided_at > pg_catalog.now() OR NOT public.predictive_retention_scope_valid(event_reason, event_scope) THEN
    RAISE EXCEPTION 'predictive-retention-invalid' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(520052,1);
  LOCK TABLE public.predictive_source_bindings,public.predictive_source_stats_revisions,public.predictive_source_decisions,public.predictive_source_consumers IN SHARE ROW EXCLUSIVE MODE;
  IF event_scope->>'kind' = 'source' THEN
    profiles := ARRAY(SELECT jsonb_array_elements_text(event_scope->'profileIds'));
    IF EXISTS (SELECT 1 FROM unnest(profiles) p WHERE NOT EXISTS (SELECT 1 FROM public.predictive_source_profiles sp WHERE sp.id = p)) THEN
      RAISE EXCEPTION 'predictive-retention-invalid' USING ERRCODE = '23514';
    END IF;
    captured_from := (event_scope->>'capturedFrom')::timestamptz; captured_before := (event_scope->>'capturedBefore')::timestamptz;
    -- An artifact with any capture in range is removed whole, bytes and captures.
    arts := ARRAY(SELECT DISTINCT a.id FROM public.predictive_artifacts a JOIN public.predictive_captures c ON c.artifact_id = a.id
      WHERE a.profile_id = ANY(profiles) AND (captured_from IS NULL OR c.captured_at >= captured_from)
        AND (captured_before IS NULL OR c.captured_at < captured_before));
    caps := ARRAY(SELECT c.id FROM public.predictive_captures c WHERE c.artifact_id = ANY(arts));
    obs := ARRAY(WITH RECURSIVE chain AS (
        SELECT o.id FROM public.predictive_observations o JOIN public.predictive_artifact_observations l ON l.observation_id = o.id
        WHERE l.artifact_id = ANY(arts) AND o.profile_id = ANY(profiles)
        UNION SELECT n.id FROM public.predictive_observations n JOIN chain ON n.predecessor_id = chain.id)
      SELECT id FROM chain);
    decs := ARRAY(WITH RECURSIVE chain AS (
        SELECT DISTINCT i.decision_id AS id FROM public.predictive_decision_inputs i WHERE i.observation_id = ANY(obs)
        UNION SELECT n.id FROM public.predictive_decisions n JOIN chain ON n.predecessor_id = chain.id)
      SELECT id FROM chain);
    labs := ARRAY(WITH RECURSIVE chain AS (
        SELECT l.id FROM public.predictive_outcome_labels l WHERE l.completion_decision_id = ANY(decs) OR l.participation_decision_id = ANY(decs)
          OR l.reconciliation_decision_id = ANY(decs) OR l.selected_observation_id = ANY(obs) OR l.post_window_capture_id = ANY(caps)
          OR l.player_bridge_observation_id = ANY(obs)
        UNION SELECT n.id FROM public.predictive_outcome_labels n JOIN chain ON n.predecessor_id = chain.id)
      SELECT id FROM chain);
    runs := ARRAY(SELECT DISTINCT d.feature_run_id FROM public.predictive_feature_run_dependencies d
      WHERE d.observation_id = ANY(obs) OR d.decision_id = ANY(decs));
  ELSE
    as_of := (event_scope->>'asOf')::timestamptz;
    IF as_of > pg_catalog.now() THEN RAISE EXCEPTION 'predictive-retention-invalid' USING ERRCODE = '23514'; END IF;
    runs := ARRAY(SELECT f.id FROM public.predictive_feature_runs f WHERE public.predictive_feature_run_expired(f.id, as_of));
  END IF;
  source_rows := ARRAY(SELECT s.id FROM public.predictive_source_stats_rows s WHERE s.capture_id = ANY(caps));
  bindings := ARRAY(WITH affected AS (
      SELECT b.profile_id,b.raw_key_sha256 FROM public.predictive_source_bindings b WHERE
        (b.profile_id=ANY(profiles) AND NOT EXISTS (SELECT 1 FROM public.predictive_source_binding_captures x WHERE x.binding_id=b.id))
        OR EXISTS (SELECT 1 FROM public.predictive_source_binding_captures x WHERE x.binding_id=b.id AND x.capture_id=ANY(caps))
        OR EXISTS (SELECT 1 FROM public.predictive_source_binding_rows x WHERE x.binding_id=b.id AND x.row_id=ANY(source_rows))
        OR EXISTS (SELECT 1 FROM public.predictive_source_binding_dependencies x WHERE x.binding_id=b.id
          AND (x.observation_id=ANY(obs) OR x.capture_id=ANY(caps) OR x.artifact_id=ANY(arts)))
        OR EXISTS (SELECT 1 FROM public.predictive_source_binding_decisions x WHERE x.binding_id=b.id AND x.decision_id=ANY(decs)))
    SELECT DISTINCT b.id FROM public.predictive_source_bindings b JOIN affected a USING(profile_id,raw_key_sha256));
  revisions := ARRAY(SELECT r.id FROM public.predictive_source_stats_revisions r WHERE EXISTS (
    SELECT 1 FROM public.predictive_source_bindings b WHERE b.id=ANY(bindings) AND b.profile_id=r.profile_id AND b.raw_key_sha256=r.source_record_id));
  -- Delete the entire affected decision scope, including ancestors. Removing
  -- a native-evidence successor must never revive its earlier positive record.
  source_decs := ARRAY(WITH affected AS (
    SELECT DISTINCT d.kind,d.entity_key,d.scope_digest FROM public.predictive_source_decisions d WHERE
      EXISTS (SELECT 1 FROM public.predictive_source_decision_bindings x WHERE x.decision_id=d.id AND x.binding_id=ANY(bindings))
      OR EXISTS (SELECT 1 FROM public.predictive_source_decision_inputs x WHERE x.decision_id=d.id AND x.observation_id=ANY(obs))
      OR (event_scope->>'kind'='source' AND NOT EXISTS (SELECT 1 FROM public.predictive_source_decision_bindings x WHERE x.decision_id=d.id)
        AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(d.plan->'witness'->'profileIds') p WHERE p=ANY(profiles)))
    ) SELECT d.id FROM public.predictive_source_decisions d JOIN affected a USING(kind,entity_key,scope_digest));
  consumers:=ARRAY(WITH affected AS (
    SELECT c.id,c.kind,c.player_id,c.game_id FROM public.predictive_source_consumers c WHERE
      EXISTS (SELECT 1 FROM public.predictive_source_consumer_bindings x WHERE x.consumer_id=c.id AND x.binding_id=ANY(bindings))
      OR EXISTS (SELECT 1 FROM public.predictive_source_consumer_source_decisions x WHERE x.consumer_id=c.id AND x.decision_id=ANY(source_decs))
      OR EXISTS (SELECT 1 FROM public.predictive_source_consumer_observations x WHERE x.consumer_id=c.id AND x.observation_id=ANY(obs))
      OR EXISTS (SELECT 1 FROM public.predictive_source_consumer_decisions x WHERE x.consumer_id=c.id AND x.decision_id=ANY(decs))
      OR (event_scope->>'kind'='source' AND NOT EXISTS (SELECT 1 FROM public.predictive_source_consumer_bindings x WHERE x.consumer_id=c.id)
        AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.body->'manifest'->'profileIds') p WHERE p=ANY(profiles)))
      OR (event_scope->>'kind'='feature-run-expiry' AND c.kind='feature' AND c.recorded_at+interval '90 days'<=as_of AND NOT public.predictive_training_consumer_pinned(c.id,clock_timestamp()))
    ) SELECT DISTINCT c.id FROM public.predictive_source_consumers c JOIN affected a ON c.id=a.id
      OR (a.kind='label' AND c.kind='label' AND c.player_id=a.player_id AND c.game_id=a.game_id));
  pins := ARRAY(SELECT p.id FROM public.predictive_feature_run_pins p WHERE p.feature_run_id = ANY(runs));
  blobs := ARRAY(SELECT DISTINCT b.sha256 FROM public.predictive_blobs b
    WHERE (b.sha256 IN (SELECT a.blob_sha256 FROM public.predictive_artifacts a WHERE a.id = ANY(arts))
        OR b.sha256 IN (SELECT f.bundle_blob_sha256 FROM public.predictive_feature_runs f WHERE f.id = ANY(runs))
        OR b.sha256 IN (SELECT c.body_sha256 FROM public.predictive_source_consumers c WHERE c.id=ANY(consumers)))
      AND NOT EXISTS (SELECT 1 FROM public.predictive_artifacts a WHERE a.blob_sha256 = b.sha256 AND NOT a.id = ANY(arts))
      AND NOT EXISTS (SELECT 1 FROM public.predictive_feature_runs f WHERE f.bundle_blob_sha256 = b.sha256 AND NOT f.id = ANY(runs))
      AND NOT EXISTS (SELECT 1 FROM public.predictive_source_consumers c WHERE c.body_sha256=b.sha256 AND NOT c.id=ANY(consumers)));
  refs := ARRAY(SELECT b.storage_ref FROM public.predictive_blobs b WHERE b.sha256 = ANY(blobs) ORDER BY b.storage_ref COLLATE "C");

  -- Parallel arrays, never a temp table: a caller could pre-create a pg_temp
  -- relation that this definer function would then use.
  SELECT coalesce(array_agg(k ORDER BY k COLLATE "C", v COLLATE "C"), '{}'), coalesce(array_agg(v ORDER BY k COLLATE "C", v COLLATE "C"), '{}')
    INTO removed_kinds, removed_ids FROM (
      SELECT 'observation', v FROM unnest(obs) v UNION ALL SELECT 'artifact', v FROM unnest(arts) v
      UNION ALL SELECT 'capture', v FROM unnest(caps) v UNION ALL SELECT 'decision', v FROM unnest(decs) v
      UNION ALL SELECT 'label', v FROM unnest(labs) v UNION ALL SELECT 'feature-run', v FROM unnest(runs) v
      UNION ALL SELECT 'pin', v FROM unnest(pins) v UNION ALL SELECT 'blob', v FROM unnest(blobs) v
      UNION ALL SELECT 'source-stats-row', v FROM unnest(source_rows) v
      UNION ALL SELECT 'source-binding', v FROM unnest(bindings) v UNION ALL SELECT 'source-stats-revision', v FROM unnest(revisions) v
      UNION ALL SELECT 'source-decision', v FROM unnest(source_decs) v
      UNION ALL SELECT 'source-consumer',v FROM unnest(consumers) v) t(k, v);
  -- The canonical JSON array of {"id","kind"} pairs ordered by (kind, id),
  -- mirrored by retentionIdsDigest() in persistence.ts. JSON escaping keeps it
  -- unambiguous whatever an identifier contains.
  SELECT encode(sha256(convert_to('[' || coalesce(string_agg('{"id":' || to_json(r.v)::text || ',"kind":' || to_json(r.k)::text || '}', ','
      ORDER BY r.n), '') || ']', 'UTF8')), 'hex')
    INTO ids_digest FROM unnest(removed_kinds, removed_ids) WITH ORDINALITY r(k, v, n);
  SELECT count(*) INTO links FROM public.predictive_artifact_observations l WHERE l.observation_id = ANY(obs) OR l.artifact_id = ANY(arts);
  SELECT count(*) INTO inputs FROM public.predictive_decision_inputs i WHERE i.decision_id = ANY(decs);
  SELECT count(*) INTO dependencies FROM public.predictive_feature_run_dependencies d WHERE d.feature_run_id = ANY(runs);
  SELECT count(*) INTO unpins FROM public.predictive_feature_run_unpins u WHERE u.pin_id = ANY(pins);
  counts := jsonb_build_object('observations', cardinality(obs), 'artifacts', cardinality(arts), 'captures', cardinality(caps),
    'decisions', cardinality(decs), 'labels', cardinality(labs), 'featureRuns', cardinality(runs), 'pins', cardinality(pins),
    'blobs', cardinality(blobs), 'links', links, 'decisionInputs', inputs, 'featureRunDependencies', dependencies, 'unpins', unpins);

  -- Preserve old zero-row event counts/digests for backup re-apply parity.
  IF cardinality(source_rows) > 0 THEN counts := counts || jsonb_build_object('sourceStatsRows', cardinality(source_rows)); END IF;
  IF cardinality(bindings)>0 THEN
    SELECT sum(n)::integer INTO binding_links FROM (
      SELECT count(*) AS n FROM public.predictive_source_binding_captures WHERE binding_id=ANY(bindings)
      UNION ALL SELECT count(*) FROM public.predictive_source_binding_rows WHERE binding_id=ANY(bindings)
      UNION ALL SELECT count(*) FROM public.predictive_source_binding_dependencies WHERE binding_id=ANY(bindings)
      UNION ALL SELECT count(*) FROM public.predictive_source_binding_links WHERE binding_id=ANY(bindings)
      UNION ALL SELECT count(*) FROM public.predictive_source_binding_decisions WHERE binding_id=ANY(bindings)
      UNION ALL SELECT count(*) FROM public.predictive_source_binding_rights WHERE binding_id=ANY(bindings)) x;
    counts:=counts || jsonb_build_object('sourceBindings',cardinality(bindings),'sourceStatsRevisions',cardinality(revisions),'sourceBindingLinks',binding_links);
  END IF;
  IF cardinality(source_decs)>0 THEN
    SELECT sum(n)::integer INTO source_decision_links FROM (
      SELECT count(*) AS n FROM public.predictive_source_decision_bindings WHERE decision_id=ANY(source_decs)
      UNION ALL SELECT count(*) FROM public.predictive_source_decision_inputs WHERE decision_id=ANY(source_decs)
      UNION ALL SELECT count(*) FROM public.predictive_source_decision_rights WHERE decision_id=ANY(source_decs)) x;
    counts:=counts || jsonb_build_object('sourceDecisions',cardinality(source_decs),'sourceDecisionLinks',source_decision_links);
  END IF;
  IF cardinality(consumers)>0 THEN
    SELECT sum(n)::integer INTO consumer_links FROM (
      SELECT count(*) AS n FROM public.predictive_source_consumer_bindings WHERE consumer_id=ANY(consumers)
      UNION ALL SELECT count(*) FROM public.predictive_source_consumer_source_decisions WHERE consumer_id=ANY(consumers)
      UNION ALL SELECT count(*) FROM public.predictive_source_consumer_observations WHERE consumer_id=ANY(consumers)
      UNION ALL SELECT count(*) FROM public.predictive_source_consumer_decisions WHERE consumer_id=ANY(consumers)
      UNION ALL SELECT count(*) FROM public.predictive_source_consumer_rights WHERE consumer_id=ANY(consumers)) links;
    counts:=counts || jsonb_build_object('sourceConsumers',cardinality(consumers),'sourceConsumerLinks',consumer_links);
  END IF;
  INSERT INTO public.predictive_retention_events (id,reason,authority,decided_at,scope_descriptor,audit_level,removed_counts,removed_ids_digest,executed_at)
    VALUES (event_id, event_reason, event_authority, event_decided_at, event_scope, event_audit_level, counts, ids_digest, pg_catalog.now());
  INSERT INTO public.predictive_retention_authorizations (txid, retention_event_id) VALUES (pg_catalog.pg_current_xact_id(), event_id);
  DELETE FROM public.predictive_source_consumer_bindings WHERE consumer_id=ANY(consumers);
  DELETE FROM public.predictive_source_consumer_source_decisions WHERE consumer_id=ANY(consumers);
  DELETE FROM public.predictive_source_consumer_observations WHERE consumer_id=ANY(consumers);
  DELETE FROM public.predictive_source_consumer_decisions WHERE consumer_id=ANY(consumers);
  DELETE FROM public.predictive_source_consumer_rights WHERE consumer_id=ANY(consumers);
  DELETE FROM public.predictive_source_consumers WHERE id=ANY(consumers);
  DELETE FROM public.predictive_source_decision_bindings WHERE decision_id=ANY(source_decs);
  DELETE FROM public.predictive_source_decision_inputs WHERE decision_id=ANY(source_decs);
  DELETE FROM public.predictive_source_decision_rights WHERE decision_id=ANY(source_decs);
  DELETE FROM public.predictive_source_decisions WHERE id=ANY(source_decs);
  DELETE FROM public.predictive_source_binding_captures WHERE binding_id=ANY(bindings);
  DELETE FROM public.predictive_source_binding_rows WHERE binding_id=ANY(bindings);
  DELETE FROM public.predictive_source_binding_dependencies WHERE binding_id=ANY(bindings);
  DELETE FROM public.predictive_source_binding_links WHERE binding_id=ANY(bindings);
  DELETE FROM public.predictive_source_binding_decisions WHERE binding_id=ANY(bindings);
  DELETE FROM public.predictive_source_binding_rights WHERE binding_id=ANY(bindings);
  DELETE FROM public.predictive_source_bindings WHERE id=ANY(bindings);
  DELETE FROM public.predictive_source_stats_revisions WHERE id=ANY(revisions);
  DELETE FROM public.predictive_feature_run_unpins WHERE pin_id = ANY(pins);
  DELETE FROM public.predictive_feature_run_pins WHERE id = ANY(pins);
  DELETE FROM public.predictive_feature_run_dependencies WHERE feature_run_id = ANY(runs);
  DELETE FROM public.predictive_feature_runs WHERE id = ANY(runs);
  DELETE FROM public.predictive_outcome_labels WHERE id = ANY(labs);
  DELETE FROM public.predictive_decision_inputs WHERE decision_id = ANY(decs);
  DELETE FROM public.predictive_decisions WHERE id = ANY(decs);
  DELETE FROM public.predictive_artifact_observations WHERE observation_id = ANY(obs) OR artifact_id = ANY(arts);
  DELETE FROM public.predictive_observations WHERE id = ANY(obs);
  DELETE FROM public.predictive_source_stats_rows WHERE id = ANY(source_rows);
  DELETE FROM public.predictive_captures WHERE id = ANY(caps);
  DELETE FROM public.predictive_artifacts WHERE id = ANY(arts);
  DELETE FROM public.predictive_blobs WHERE sha256 = ANY(blobs);
  INSERT INTO public.predictive_blob_removals (storage_ref, queued_at) SELECT r, pg_catalog.now() FROM unnest(refs) r ON CONFLICT DO NOTHING;
  IF event_audit_level = 'full' THEN
    INSERT INTO public.predictive_retention_tombstones (retention_event_id, target_kind, target_id)
      SELECT event_id, r.k, r.v FROM unnest(removed_kinds, removed_ids) r(k, v);
  END IF;
  DELETE FROM public.predictive_retention_authorizations WHERE txid = pg_catalog.pg_current_xact_id();
  -- Blob references are returned to the caller for file removal, never stored
  -- for digest-only events.
  RETURN jsonb_build_object('eventId', event_id, 'removedCounts', counts, 'removedIdsDigest', ids_digest, 'removedBlobRefs', to_jsonb(refs));
END
$function$;

CREATE OR REPLACE FUNCTION public.predictive_training_retention_hook()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE event public.predictive_retention_events; ids text[]; counts jsonb; pairs jsonb;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_retention_owner','MEMBER') OR NEW.txid<>pg_current_xact_id() THEN
    RAISE EXCEPTION 'training-retention-not-authorized' USING ERRCODE='42501'; END IF;
  SELECT * INTO STRICT event FROM public.predictive_retention_events WHERE id=NEW.retention_event_id;
  LOCK TABLE public.predictive_training_runs,public.predictive_training_run_events,public.predictive_training_run_slots,
    public.predictive_training_run_profiles IN SHARE ROW EXCLUSIVE MODE;
  SELECT array_agg(r.id ORDER BY r.id COLLATE "C") INTO ids FROM public.predictive_training_runs r WHERE
    (event.scope_descriptor->>'kind'='source' AND EXISTS(SELECT 1 FROM public.predictive_training_run_profiles p WHERE p.run_id=r.id
      AND (p.profile_id IN (SELECT jsonb_array_elements_text(event.scope_descriptor->'profileIds')) OR EXISTS(SELECT 1 FROM public.predictive_training_datasets d CROSS JOIN LATERAL jsonb_array_elements(d.body->'protectedUses') u WHERE d.run_id=r.id AND u->>'profile' IN (SELECT jsonb_array_elements_text(event.scope_descriptor->'profileIds'))))))
    OR (event.scope_descriptor->>'kind'='feature-run-expiry' AND NOT EXISTS(SELECT 1 FROM public.predictive_training_datasets d WHERE d.run_id=r.id AND public.predictive_training_dataset_active(d.id) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.body->'protectedUses') p WHERE NOT public.predictive_rights_allow(p->>'profile',clock_timestamp(),clock_timestamp(),'internal-research') OR NOT public.predictive_rights_allow(p->>'profile',clock_timestamp(),clock_timestamp(),p->>'use'))) AND EXISTS(SELECT 1 FROM public.predictive_training_run_slots s
      JOIN public.predictive_source_consumers c ON c.id=s.selection->'selection'->>'featureId' WHERE s.run_id=r.id AND c.kind='feature'
        AND c.recorded_at+interval '90 days'<=(event.scope_descriptor->>'asOf')::timestamptz));
  IF coalesce(cardinality(ids),0)=0 THEN RETURN NEW; END IF;
  counts:=jsonb_build_object('runs',cardinality(ids),'slots',(SELECT count(*) FROM public.predictive_training_run_slots WHERE run_id=ANY(ids)),
    'events',(SELECT count(*) FROM public.predictive_training_run_events WHERE run_id=ANY(ids)),
    'profiles',(SELECT count(*) FROM public.predictive_training_run_profiles WHERE run_id=ANY(ids)));
  SELECT jsonb_agg(jsonb_build_object('id',id,'kind','training-run') ORDER BY id COLLATE "C") INTO pairs FROM unnest(ids) id;
  INSERT INTO public.predictive_training_retention_audits VALUES(event.id,counts,public.predictive_source_digest(pairs),
    CASE WHEN event.audit_level='full' THEN to_jsonb(ids) END);
  DELETE FROM public.predictive_training_run_profiles WHERE run_id=ANY(ids);
  DELETE FROM public.predictive_training_run_slots WHERE run_id=ANY(ids);
  DELETE FROM public.predictive_training_run_events WHERE run_id=ANY(ids);
  DELETE FROM public.predictive_training_runs WHERE id=ANY(ids);
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.predictive_prepare_training_run(input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE req jsonb; sel jsonb; slot jsonb; row_data jsonb; rows jsonb:='[]'; kickoff jsonb; f public.predictive_source_consumers; l public.predictive_source_consumers;
  checked jsonb; feature_state text; label_state text; label_reason text; feature_ref jsonb; label_ref jsonb; profiles jsonb:='[]';
  ordinal integer:=0; t timestamptz; request_sha text; identity_sha text; plan_sha text; fold_sha text; contract_sha text; existing public.predictive_training_run_identities;
  body jsonb; result jsonb; superseded_as_of boolean; superseded_now boolean; head_count integer; use_kind text; p text; counts jsonb; reuse jsonb;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_recorder','MEMBER') OR NOT pg_has_role(session_user,'predictive_replay','MEMBER') THEN
    RAISE EXCEPTION 'training-recorder-not-authorized' USING ERRCODE='42501'; END IF;
  -- Same ordering as publication/retention. Serialize run preparation, then
  -- acquire evidence guards before clocks and lock the inventory for writes.
  PERFORM pg_advisory_xact_lock(520052,1);
  PERFORM public.predictive_training_read_guard();
  LOCK TABLE public.predictive_training_run_identities,public.predictive_training_runs,public.predictive_training_run_events,
    public.predictive_training_run_slots,public.predictive_training_run_profiles IN SHARE ROW EXCLUSIVE MODE;
  t:=date_trunc('milliseconds',clock_timestamp()); req:=public.predictive_training_request(input,t); sel:=req->'selection';
  request_sha:=public.predictive_source_digest(req); identity_sha:=public.predictive_source_digest(req->'fittingRunId');
  plan_sha:=public.predictive_source_digest(req->'evaluationPlanId'); fold_sha:=public.predictive_source_digest(req->'foldId');
  contract_sha:=public.predictive_source_digest(jsonb_build_object('selection',sel,'modelIdentity',req->'modelIdentity','splitPolicy',req->'splitPolicy'));
  SELECT * INTO existing FROM public.predictive_training_run_identities WHERE id_sha256=identity_sha;
  IF existing.id_sha256 IS NOT NULL THEN
    IF existing.request_sha256<>request_sha THEN RAISE EXCEPTION 'training-run-id-conflict' USING ERRCODE='23514'; END IF;
    result:=public.predictive_training_run_read(req->>'fittingRunId');
    RETURN result || jsonb_build_object('reused',true);
  END IF;
  IF EXISTS(SELECT 1 FROM public.predictive_training_run_identities WHERE plan_sha256=plan_sha AND fold_sha256=fold_sha) THEN
    RAISE EXCEPTION 'training-fold-id-conflict' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM public.predictive_training_run_identities WHERE plan_sha256=plan_sha AND plan_contract_sha256<>contract_sha) THEN
    RAISE EXCEPTION 'training-plan-policy-conflict' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM public.predictive_training_run_identities i WHERE i.plan_sha256=plan_sha
      AND NOT EXISTS(SELECT 1 FROM public.predictive_training_runs r WHERE r.identity_sha256=i.id_sha256)) THEN
    RAISE EXCEPTION 'training-plan-history-removed' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM public.predictive_training_runs)>=32 THEN RAISE EXCEPTION 'training-inventory-count-bounds-refused' USING ERRCODE='23514'; END IF;
  IF req->'splitPolicy'->>'evaluationMode'='fixed-holdout' AND EXISTS(SELECT 1 FROM public.predictive_training_run_events e
    JOIN public.predictive_training_runs r ON r.id=e.run_id JOIN public.predictive_training_run_identities i ON i.id_sha256=r.identity_sha256
    CROSS JOIN jsonb_array_elements(req->'slots') s WHERE i.plan_sha256=plan_sha AND e.game_id=(s->>'gameId')::uuid) THEN
    RAISE EXCEPTION 'training-fixed-holdout-event-reuse' USING ERRCODE='23514'; END IF;
  FOR p IN SELECT jsonb_array_elements_text(sel->'profileIds') LOOP
    profiles:=profiles || jsonb_build_array(jsonb_build_object('profile',p,'use','model-input'));
  END LOOP;
  FOR slot IN SELECT value FROM jsonb_array_elements(req->'slots') LOOP
    kickoff:=public.predictive_training_kickoff(slot,t);
    profiles:=profiles || coalesce((SELECT jsonb_agg(jsonb_build_object('profile',x->>'profileId','use','model-input'))
      FROM jsonb_array_elements(kickoff->'dependencies') x),'[]');
    f:=NULL; l:=NULL;
    IF slot->'featureRef'<>'null'::jsonb THEN SELECT * INTO f FROM public.predictive_source_consumers WHERE id=slot->>'featureRef';
    ELSE SELECT * INTO f FROM public.predictive_source_consumers c WHERE c.kind='feature' AND c.player_id=slot->>'playerId'
      AND c.game_id=(slot->>'gameId')::uuid AND c.cutoff=(slot->>'featureCutoff')::timestamptz AND c.recorded_at<=t
      AND c.body->'bundle'->'request'->>'candidate'=sel->>'candidate' AND c.body->'bundle'->>'featureVersion'=sel->>'featureVersion'
      AND c.body->'manifest'->'profileIds'=sel->'profileIds' ORDER BY c.recorded_at DESC,c.id COLLATE "C" DESC LIMIT 1; END IF;
    feature_state:='missing'; feature_ref:=NULL;
    IF f.id IS NOT NULL THEN
      checked:=public.predictive_source_consumer_check(f.id);
      IF f.kind<>'feature' OR f.player_id IS DISTINCT FROM slot->>'playerId' OR f.game_id IS DISTINCT FROM (slot->>'gameId')::uuid
          OR f.cutoff IS DISTINCT FROM (slot->>'featureCutoff')::timestamptz OR f.recorded_at>t
          OR f.body->'bundle'->'request'->>'candidate' IS DISTINCT FROM sel->>'candidate'
          OR f.body->'bundle'->>'featureVersion' IS DISTINCT FROM sel->>'featureVersion' OR f.body->'manifest'->'profileIds' IS DISTINCT FROM sel->'profileIds'
          OR (f.body->'bundle'->'target'<>'null'::jsonb AND (f.body->'bundle'->'target'->'kickoff' IS DISTINCT FROM slot->'kickoff'
            OR f.body->'bundle'->'target'->'season' IS DISTINCT FROM slot->'season' OR f.body->'bundle'->'target'->'seasonType' IS DISTINCT FROM slot->'seasonType')) THEN
        RAISE EXCEPTION 'training-feature-reference-mismatch' USING ERRCODE='23514'; END IF;
      feature_state:=CASE WHEN f.recorded_at+interval '90 days'<=t AND NOT public.predictive_training_consumer_pinned(f.id,t) THEN 'expired'
        WHEN f.body->'bundle'->>'status'='ready-inputs' THEN 'usable' ELSE 'unavailable' END;
      feature_ref:= (checked-'body'-'mode'-'kind'-'rightsDecisions') || jsonb_build_object('inputDigest',f.body->>'inputDigest');
      profiles:=profiles || coalesce((SELECT jsonb_agg(jsonb_build_object('profile',r.profile_id,'use','model-input')) FROM public.predictive_source_consumer_rights x
        JOIN public.predictive_rights_decisions r ON r.id=x.rights_decision_id WHERE x.consumer_id=f.id),'[]');
    END IF;
    IF slot->'labelRef'<>'null'::jsonb THEN SELECT * INTO l FROM public.predictive_source_consumers WHERE id=slot->>'labelRef';
    ELSE
      SELECT count(*) INTO head_count FROM public.predictive_source_consumers c WHERE c.kind='label' AND c.player_id=slot->>'playerId'
        AND c.game_id=(slot->>'gameId')::uuid AND c.recorded_at<=(slot->>'labelsAsOf')::timestamptz
        AND NOT EXISTS(SELECT 1 FROM public.predictive_source_consumers n WHERE n.predecessor_id=c.id AND n.recorded_at<=(slot->>'labelsAsOf')::timestamptz);
      IF head_count>1 THEN RAISE EXCEPTION 'training-label-lineage-ambiguous' USING ERRCODE='23514'; END IF;
      SELECT * INTO l FROM public.predictive_source_consumers c WHERE c.kind='label' AND c.player_id=slot->>'playerId'
        AND c.game_id=(slot->>'gameId')::uuid AND c.recorded_at<=(slot->>'labelsAsOf')::timestamptz
        AND NOT EXISTS(SELECT 1 FROM public.predictive_source_consumers n WHERE n.predecessor_id=c.id AND n.recorded_at<=(slot->>'labelsAsOf')::timestamptz);
    END IF;
    label_state:='missing'; label_reason:='label-not-recorded'; label_ref:=NULL; superseded_as_of:=false; superseded_now:=false;
    IF l.id IS NOT NULL THEN
      checked:=public.predictive_source_consumer_check(l.id);
      IF l.kind<>'label' OR l.player_id IS DISTINCT FROM slot->>'playerId' OR l.game_id IS DISTINCT FROM (slot->>'gameId')::uuid
          OR l.recorded_at>(slot->>'labelsAsOf')::timestamptz OR l.body->'seasonType' IS DISTINCT FROM slot->'seasonType'
          OR l.body->>'stat' IS DISTINCT FROM sel->>'stat' OR l.body->>'version' IS DISTINCT FROM sel->>'labelVersion' THEN
        RAISE EXCEPTION 'training-label-reference-mismatch' USING ERRCODE='23514'; END IF;
      IF l.body->'manifest'->'profileIds'=sel->'profileIds' THEN
        label_state:='usable'; label_reason:=NULL;
        label_ref:=(checked-'body'-'mode'-'kind'-'rightsDecisions') || jsonb_build_object('inputDigest',l.body->>'inputDigest');
        superseded_as_of:=EXISTS(SELECT 1 FROM public.predictive_source_consumers n WHERE n.predecessor_id=l.id AND n.recorded_at<=(slot->>'labelsAsOf')::timestamptz);
        superseded_now:=EXISTS(SELECT 1 FROM public.predictive_source_consumers n WHERE n.predecessor_id=l.id AND n.recorded_at<=t);
      ELSE
        IF slot->'labelRef'<>'null'::jsonb THEN RAISE EXCEPTION 'training-label-reference-mismatch' USING ERRCODE='23514'; END IF;
        label_reason:='label-profile-mismatch';
      END IF;
      profiles:=profiles || coalesce((SELECT jsonb_agg(jsonb_build_object('profile',r.profile_id,'use','outcome-label')) FROM public.predictive_source_consumer_rights x
        JOIN public.predictive_rights_decisions r ON r.id=x.rights_decision_id WHERE x.consumer_id=l.id),'[]');
    END IF;
    row_data:=jsonb_build_object('ordinal',ordinal,'slot',slot,'kickoff',kickoff,
      'history',jsonb_build_object('policy',sel->>'historyPolicy','definitionSha256',sel->>'historyPolicySha256',
        'fromSeason',(slot->>'season')::integer-2,'throughSeason',(slot->>'season')::integer,'windows',jsonb_build_array(4,8,16),'maximumSlots',16),
      'selection',jsonb_build_object('ordinal',ordinal,'featureId',f.id,'labelId',l.id,'labelSupersededAsOf',superseded_as_of,'labelSupersededAtSnapshot',superseded_now),
      'feature',jsonb_build_object('state',feature_state,'reason',CASE feature_state WHEN 'missing' THEN 'feature-not-recorded'
        WHEN 'expired' THEN 'feature-expired' WHEN 'unavailable' THEN 'feature-inputs-unavailable' END,'reference',feature_ref,
        'reasons',coalesce(f.body->'bundle'->'reasons','[]'),'quality',coalesce(f.body->'bundle'->'quality','[]')),
      'label',jsonb_build_object('state',label_state,'reason',label_reason,'reference',label_ref,'supersededAsOf',superseded_as_of,'supersededAtSnapshot',superseded_now));
    rows:=rows || jsonb_build_array(row_data); ordinal:=ordinal+1;
  END LOOP;
  -- Context outside the selected feed scope and missing consumers still count
  -- toward the agreed run-wide profile ceiling, rather than bypassing it.
  IF (SELECT count(DISTINCT x->>'profile') FROM jsonb_array_elements(profiles) x)>16 THEN
    RAISE EXCEPTION 'training-profile-bounds-refused' USING ERRCODE='23514'; END IF;
  FOR p,use_kind IN SELECT DISTINCT x->>'profile',x->>'use' FROM jsonb_array_elements(profiles) x LOOP
    IF NOT public.predictive_rights_allow(p,clock_timestamp(),clock_timestamp(),'internal-research')
        OR NOT public.predictive_rights_allow(p,clock_timestamp(),clock_timestamp(),use_kind) THEN
      RAISE EXCEPTION 'training-run-rights-refused' USING ERRCODE='23514'; END IF;
  END LOOP;
  SELECT jsonb_agg(jsonb_build_object('partition',partition,'slots',n,'targetEvents',events,'usableFeatures',features,'usableLabels',labels,
    'missingFeatures',missing_features,'unavailableFeatures',unavailable_features,'expiredFeatures',expired_features,'missingLabels',missing_labels)
    ORDER BY CASE partition WHEN 'training' THEN 0 ELSE 1 END)
    INTO counts FROM (SELECT partition,count(x)::integer AS n,count(DISTINCT x->'slot'->>'gameId')::integer AS events,
      count(x) FILTER(WHERE x->'feature'->>'state'='usable')::integer AS features,count(x) FILTER(WHERE x->'label'->>'state'='usable')::integer AS labels,
      count(x) FILTER(WHERE x->'feature'->>'state'='missing')::integer AS missing_features,
      count(x) FILTER(WHERE x->'feature'->>'state'='unavailable')::integer AS unavailable_features,
      count(x) FILTER(WHERE x->'feature'->>'state'='expired')::integer AS expired_features,
      count(x) FILTER(WHERE x->'label'->>'state'='missing')::integer AS missing_labels
      FROM unnest(ARRAY['training','evaluation']) partition LEFT JOIN jsonb_array_elements(rows) x ON x->'slot'->>'partition'=partition GROUP BY partition) c;
  SELECT jsonb_agg(x ORDER BY x->>'profile' COLLATE "C",x->>'use' COLLATE "C") INTO profiles FROM (SELECT DISTINCT value AS x FROM jsonb_array_elements(profiles)) p;
  reuse:=jsonb_build_object('priorRuns',(SELECT count(*) FROM public.predictive_training_run_identities WHERE plan_sha256=plan_sha),
    'targetEventsInRun',(SELECT count(DISTINCT s->>'gameId') FROM jsonb_array_elements(req->'slots') s),
    'playerGameTargetsInRun',jsonb_array_length(req->'slots'),
    'reusedTargetEvents',(SELECT count(DISTINCT s->>'gameId') FROM jsonb_array_elements(req->'slots') s
      JOIN public.predictive_training_run_events e ON e.game_id=(s->>'gameId')::uuid
      JOIN public.predictive_training_runs r ON r.id=e.run_id JOIN public.predictive_training_run_identities i ON i.id_sha256=r.identity_sha256 WHERE i.plan_sha256=plan_sha),
    'reusedPlayerGameTargets',(SELECT count(DISTINCT jsonb_build_array(s->>'playerId',s->>'gameId')) FROM jsonb_array_elements(req->'slots') s
      JOIN public.predictive_training_run_slots old ON old.game_id=(s->>'gameId')::uuid AND old.player_id=s->>'playerId'
      JOIN public.predictive_training_runs r ON r.id=old.run_id JOIN public.predictive_training_run_identities i ON i.id_sha256=r.identity_sha256 WHERE i.plan_sha256=plan_sha),
    'interpretation','repeated-events-are-correlated');
  body:=jsonb_build_object('version','qb-training-run-inventory-v1','status','inventory-sealed','fittingReady',false,'populationCoverage','unqualified',
    'snapshotAt',public.predictive_source_time(t),'request',req,'requestSha256',request_sha,'rows',rows,'counts',counts,'protectedUses',profiles,'reuseDisclosure',reuse);
  body:=body || jsonb_build_object('pinEligibility',jsonb_build_object('version','source-feature-pin-eligibility-v1','featureIds',coalesce((SELECT jsonb_agg(id ORDER BY id COLLATE "C") FROM (SELECT DISTINCT x->'selection'->>'featureId' AS id FROM jsonb_array_elements(rows) x WHERE public.predictive_training_consumer_pinned(x->'selection'->>'featureId',t)) pinned),'[]'))); IF octet_length(public.predictive_source_canonical_json(body))>8000000 THEN RAISE EXCEPTION 'training-inventory-byte-bounds-refused' USING ERRCODE='23514'; END IF;
  INSERT INTO public.predictive_training_run_identities VALUES(identity_sha,request_sha,plan_sha,fold_sha,contract_sha,t);
  INSERT INTO public.predictive_training_runs VALUES(req->>'fittingRunId',identity_sha,body,public.predictive_source_digest(body),t);
  INSERT INTO public.predictive_training_run_events SELECT DISTINCT req->>'fittingRunId',(s->>'gameId')::uuid,s->>'partition' FROM jsonb_array_elements(req->'slots') s;
  INSERT INTO public.predictive_training_run_slots SELECT req->>'fittingRunId',(r->>'ordinal')::integer,r->'slot'->>'datasetId',r->'slot'->>'partition',
    (r->'slot'->>'gameId')::uuid,r->'slot'->>'playerId',r FROM jsonb_array_elements(rows) r;
  INSERT INTO public.predictive_training_run_profiles SELECT DISTINCT req->>'fittingRunId',x->>'profile',x->>'use' FROM jsonb_array_elements(profiles) x;
  RETURN public.predictive_training_run_read(req->>'fittingRunId') || jsonb_build_object('reused',false);
END
$function$;

CREATE OR REPLACE FUNCTION public.predictive_training_memo_ready()
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE names text[];
  guarded integer; written boolean; relation oid; protected oid[];
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RETURN false; END IF;
  relation:=to_regclass('pg_temp.predictive_training_memo');
  IF relation IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
        WHERE c.oid=relation AND c.relkind='r' AND c.relpersistence='t' AND r.rolname=current_user) THEN
      RAISE EXCEPTION 'training-memo-owner-refused' USING ERRCODE='42501';
    END IF;
    SELECT ARRAY(SELECT jsonb_array_elements_text(key)::oid) INTO protected FROM pg_temp.predictive_training_memo
      WHERE kind='state' AND key_sha256='state';
    IF protected IS NULL THEN RAISE EXCEPTION 'training-memo-state-refused' USING ERRCODE='55000'; END IF;
    -- Initial SHARE locks and this owner-created temp relation have the same
    -- savepoint lifetime. Rolling back before those locks drops the relation.
    -- Only new write-capable locks need inspection on each subsequent use.
    RETURN NOT EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.granted AND l.relation=ANY(protected)
      AND l.mode IN ('RowExclusiveLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock'));
  END IF;
  SELECT array_agg(relation_name ORDER BY relation_name COLLATE "C") INTO names
    FROM public.predictive_training_relations() WHERE memo_dependency;
  -- Stronger write-capable locks disable memoization, including same-session
  -- writes after an earlier hit. Such locks persist to transaction end (or a
  -- rolled-back savepoint); an old result cannot hide newly written evidence.
  SELECT count(DISTINCT c.relname) FILTER(WHERE l.mode='ShareLock'),
    coalesce(bool_or(l.mode IN ('RowExclusiveLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')),false)
    INTO guarded,written FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE l.pid=pg_backend_pid() AND l.granted AND n.nspname='public' AND c.relname=ANY(names);
  IF guarded<>cardinality(names) OR written THEN RETURN false; END IF;
  CREATE TEMP TABLE predictive_training_memo(kind text NOT NULL,key_sha256 text NOT NULL,key jsonb NOT NULL,value jsonb NOT NULL,
    PRIMARY KEY(kind,key_sha256)) ON COMMIT DROP;
  REVOKE ALL ON pg_temp.predictive_training_memo FROM PUBLIC;
  SELECT array_agg(c.oid) INTO protected FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY(names);
  INSERT INTO pg_temp.predictive_training_memo VALUES('state','state',to_jsonb(protected),'[0,0]');
  RETURN true;
END $function$;
