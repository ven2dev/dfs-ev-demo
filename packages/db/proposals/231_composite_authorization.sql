-- #231 proposal, applied after #166 on registered local fixtures only.
-- Pattern: metadata-only point-in-time selection, followed by composite
-- authorize/use/recheck. This resolver is not permission to use feature values.
-- No ordered migration, new evidence table or reader coordination lock.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='fs231_model_reader') THEN
  CREATE ROLE fs231_model_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END $$;
-- Membership satisfies #166's role guard without inheriting broad table SELECT
-- or a SET ROLE escape. Grant this capability to a LOGIN with SET FALSE too.
GRANT fs138_reader TO fs231_model_reader WITH INHERIT FALSE, SET FALSE;
GRANT USAGE ON SCHEMA fs138 TO fs231_model_reader;

CREATE FUNCTION fs138.resolve_model_context(p_player text,p_game text,p_feature_version text,
 p_history_policy text,p_mode text,p_known_as_of timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE selected record; visible_head record; current_head record; inputs uuid[];
 observed_at timestamptz:=statement_timestamp();
BEGIN
 IF NOT(pg_has_role(session_user,'fs138_reader','member')
  OR pg_has_role(session_user,'fs138_pipeline_writer','member')) THEN
  RAISE EXCEPTION 'model-reader-role-required' USING ERRCODE='42501';
 END IF;
 -- A fresh statement snapshot permits Q2 to see intervening withdrawal. The
 -- trusted caller owns an idle dedicated connection, as in #166.
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'model-read-session-refused' USING ERRCODE='P1667';
 END IF;
 IF p_player IS NULL OR btrim(p_player)='' OR p_game IS NULL OR btrim(p_game)=''
 OR p_known_as_of IS NULL OR NOT isfinite(p_known_as_of) THEN
  RAISE EXCEPTION 'model-context-request-refused' USING ERRCODE='P2311';
 END IF;
 IF p_feature_version IS DISTINCT FROM 'qb-passing-yards-feature-v1'
 OR p_history_policy IS DISTINCT FROM 'prior-eligible-reg-max16-min2-cutoff1h-v1'
 OR p_mode IS NULL OR p_mode NOT IN ('strict-point-in-time-v1','retrospective-reconstruction-v1') THEN
  RAISE EXCEPTION 'model-context-unsupported-version' USING ERRCODE='P2312';
 END IF;
 IF p_known_as_of>observed_at THEN
  RAISE EXCEPTION 'model-context-future-knowledge' USING ERRCODE='P2313';
 END IF;

 -- Explicit columns exclude history and history_gaps: this capability releases
 -- only identity, knowledge/selection metadata and dependency IDs before Q1.
 SELECT f.feature_id,f.job_id,f.player_id,f.game_id,f.stat,f.season,f.cutoff,
  f.checkpoint,f.computed_at,f.feature_version,f.history_policy,f.evidence_mode,
  f.sample_size,f.flags INTO selected
 FROM fs138.feature_values f JOIN fs138.job_runs j USING(job_id)
 WHERE (f.player_id,f.game_id,f.stat,f.feature_version,f.history_policy,f.evidence_mode)=
  (p_player,p_game,'passing_yards',p_feature_version,p_history_policy,p_mode)
 AND f.computed_at<=p_known_as_of AND f.checkpoint<=p_known_as_of AND j.status='succeeded'
 AND f.state='usable' AND f.sample_size BETWEEN 2 AND 16 AND f.cutoff IS NOT NULL
 ORDER BY f.checkpoint DESC,f.computed_at DESC,f.feature_id DESC LIMIT 1;

 -- Keep visible selection separate from current freshness. A later-known value
 -- may flag the pinned value, but cannot replace it in this request.
 SELECT f.feature_id,f.state,f.sample_size,f.reasons INTO visible_head
 FROM fs138.feature_values f JOIN fs138.job_runs j USING(job_id)
 WHERE (f.player_id,f.game_id,f.stat,f.feature_version,f.history_policy,f.evidence_mode)=
  (p_player,p_game,'passing_yards',p_feature_version,p_history_policy,p_mode)
 AND f.computed_at<=p_known_as_of AND f.checkpoint<=p_known_as_of AND j.status='succeeded'
 ORDER BY f.checkpoint DESC,f.computed_at DESC,f.feature_id DESC LIMIT 1;
 IF selected.feature_id IS NULL THEN
  IF visible_head.sample_size<2 THEN
   RAISE EXCEPTION 'model-context-insufficient-history' USING ERRCODE='P2314';
  END IF;
  RAISE EXCEPTION 'model-context-unavailable' USING ERRCODE='P2315';
 END IF;

 SELECT f.feature_id,f.state,f.reasons,f.checkpoint,f.computed_at INTO current_head
 FROM fs138.feature_values f JOIN fs138.job_runs j USING(job_id)
 WHERE (f.player_id,f.game_id,f.stat,f.feature_version,f.history_policy,f.evidence_mode)=
  (p_player,p_game,'passing_yards',p_feature_version,p_history_policy,p_mode)
 AND f.computed_at<=observed_at AND f.checkpoint<=observed_at AND j.status='succeeded'
 ORDER BY f.checkpoint DESC,f.computed_at DESC,f.feature_id DESC LIMIT 1;
 SELECT coalesce(array_agg(i.snapshot_id ORDER BY i.snapshot_id),'{}') INTO inputs
 FROM fs138.feature_inputs i WHERE i.feature_id=selected.feature_id;
 IF cardinality(inputs)=0 THEN
  RAISE EXCEPTION 'model-context-lineage-refused' USING ERRCODE='P2316';
 END IF;

 RETURN jsonb_build_object(
  'request',jsonb_build_object('playerId',p_player,'gameId',p_game,'featureVersion',p_feature_version,
   'historyPolicy',p_history_policy,'evidenceMode',p_mode,'knownAsOf',p_known_as_of),
  'feature',jsonb_build_object('featureId',selected.feature_id,'jobId',selected.job_id,
   'playerId',selected.player_id,'gameId',selected.game_id,'stat',selected.stat,'season',selected.season,
   'cutoff',selected.cutoff,'checkpoint',selected.checkpoint,'computedAt',selected.computed_at,
   'featureVersion',selected.feature_version,'historyPolicy',selected.history_policy,
   'evidenceMode',selected.evidence_mode,'sampleSize',selected.sample_size,'flags',selected.flags),
  'snapshotIds',inputs,
  'selection',jsonb_build_object('visibleHeadId',visible_head.feature_id,
   'lastValid',visible_head.feature_id<>selected.feature_id,'reasons',visible_head.reasons),
  'freshness',jsonb_build_object('observedAt',observed_at,'headId',current_head.feature_id,
   'checkpoint',current_head.checkpoint,'computedAt',current_head.computed_at,
   'superseded',current_head.feature_id<>selected.feature_id,
   'stale',current_head.feature_id<>selected.feature_id AND current_head.state='unavailable',
   'reasons',current_head.reasons));
END $$;
REVOKE ALL ON FUNCTION fs138.resolve_model_context(text,text,text,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fs138.resolve_model_context(text,text,text,text,text,timestamptz)
 TO fs231_model_reader,fs138_reader,fs138_pipeline_writer;

-- One implementation for both public boundaries keeps authorization batched.
-- The private core is executable only by its definer. Narrow readers cannot
-- omit a context through this function or call the model-only wrapper.
CREATE FUNCTION fs138.authorize_model_scope(p_run uuid,p_slots text[],p_with_pins boolean,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
DECLARE publication fs138.model_runs; context jsonb; snapshots uuid[]; model_inputs uuid[];
 checked_at timestamptz:=statement_timestamp(); allowed boolean; receipt jsonb; datasets jsonb; artifacts jsonb;
 feature_history jsonb; request jsonb; result jsonb;
BEGIN
 IF NOT(pg_has_role(session_user,'fs138_reader','member')
  OR pg_has_role(session_user,'fs138_pipeline_writer','member')) THEN
  RAISE EXCEPTION 'model-reader-role-required' USING ERRCODE='42501';
 END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'model-read-session-refused' USING ERRCODE='P1667';
 END IF;
 IF p_run IS NULL OR p_with_pins IS NULL OR p_slots IS NULL OR cardinality(p_slots) NOT BETWEEN 1 AND 3
 OR cardinality(p_slots)<>(SELECT count(DISTINCT s) FROM unnest(p_slots) s)
 OR EXISTS(SELECT 1 FROM unnest(p_slots) s WHERE s IS NULL OR s NOT IN
  ('descriptor','strict-point-in-time-v1','retrospective-reconstruction-v1')) THEN
  RAISE EXCEPTION 'model-read-request-refused' USING ERRCODE='P1663';
 END IF;
 SELECT r.* INTO publication FROM fs138.model_runs r WHERE r.run_id=p_run;
 IF NOT FOUND THEN RAISE EXCEPTION 'model-read-missing' USING ERRCODE='P1664'; END IF;
 IF publication.invalidated_at IS NOT NULL
 OR (SELECT count(*) FROM fs138.model_run_datasets p WHERE p.run_id=p_run) NOT BETWEEN 1 AND 2
 OR EXISTS(SELECT 1 FROM fs138.model_run_datasets p LEFT JOIN fs138.dataset_manifests d USING(dataset_id)
  WHERE p.run_id=p_run AND (d.dataset_id IS NULL OR d.invalidated_at IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM fs138.dataset_inputs i WHERE i.dataset_id=p.dataset_id))) THEN
  RAISE EXCEPTION 'model-read-status-refused' USING ERRCODE='P1666';
 END IF;
 SELECT coalesce(array_agg(DISTINCT i.snapshot_id ORDER BY i.snapshot_id),'{}') INTO model_inputs
 FROM fs138.model_run_datasets p JOIN fs138.dataset_inputs i USING(dataset_id) WHERE p.run_id=p_run;
 snapshots:=model_inputs;

 IF p_context IS NOT NULL THEN
  IF jsonb_typeof(p_context) IS DISTINCT FROM 'object'
  OR jsonb_typeof(p_context->'request') IS DISTINCT FROM 'object'
  OR jsonb_typeof(p_context->'feature') IS DISTINCT FROM 'object'
  OR jsonb_typeof(p_context->'snapshotIds') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'model-context-reference-refused' USING ERRCODE='P2317';
  END IF;
  request:=p_context->'request';
  context:=fs138.resolve_model_context(request->>'playerId',request->>'gameId',request->>'featureVersion',
   request->>'historyPolicy',request->>'evidenceMode',(request->>'knownAsOf')::timestamptz);
  -- Re-resolve independently at both boundaries. Compare all immutable metadata
  -- and the complete sorted lineage; ignore old freshness observations only.
  -- A missing/pruned/deleted selection cannot silently fall back to an older one.
  IF context->'request' IS DISTINCT FROM request
  OR context->'feature' IS DISTINCT FROM p_context->'feature'
  OR context->'snapshotIds' IS DISTINCT FROM p_context->'snapshotIds' THEN
   RAISE EXCEPTION 'model-context-reference-refused' USING ERRCODE='P2317';
  END IF;
  SELECT array_agg(DISTINCT id ORDER BY id) INTO snapshots FROM (
   SELECT unnest(model_inputs) id
   UNION ALL SELECT i.snapshot_id FROM fs138.feature_inputs i
    WHERE i.feature_id=(context->'feature'->>'featureId')::uuid
  ) union_inputs;
 END IF;

 IF EXISTS(SELECT 1 FROM unnest(snapshots) id LEFT JOIN fs138.source_snapshots s ON s.snapshot_id=id
  WHERE s.snapshot_id IS NULL OR s.deleted_at IS NOT NULL) THEN
  RAISE EXCEPTION 'model-read-status-refused' USING ERRCODE='P1666';
 END IF;
 IF context IS NOT NULL AND EXISTS(
  SELECT 1 FROM fs138.feature_inputs i LEFT JOIN fs138.source_snapshots s USING(snapshot_id)
  LEFT JOIN fs138.job_runs j ON j.job_id=s.job_id
  WHERE i.feature_id=(context->'feature'->>'featureId')::uuid AND j.status IS DISTINCT FROM 'succeeded') THEN
  RAISE EXCEPTION 'model-context-lineage-refused' USING ERRCODE='P2316';
 END IF;
 WITH profiles AS (SELECT DISTINCT s.profile_id FROM fs138.source_snapshots s WHERE s.snapshot_id=ANY(snapshots)),
 decisions AS MATERIALIZED (
  SELECT p.profile_id,e.decision_id,e.allowed_uses FROM profiles p
  LEFT JOIN LATERAL fs138.effective_rights(p.profile_id,checked_at,checked_at) e ON true
 ) SELECT coalesce(bool_and(decision_id IS NOT NULL AND 'research'=ANY(allowed_uses)),false),
  jsonb_build_object('checkedAt',checked_at,'decisions',coalesce(jsonb_agg(jsonb_build_object(
   'profileId',profile_id,'decisionId',decision_id) ORDER BY profile_id),'[]'::jsonb)) INTO allowed,receipt FROM decisions;
 IF NOT allowed THEN RAISE EXCEPTION 'model-current-rights-refused' USING ERRCODE='P1665'; END IF;
 IF (SELECT count(*) FROM fs138.model_artifacts a WHERE a.run_id=p_run AND a.slot=ANY(p_slots))<>cardinality(p_slots) THEN
  RAISE EXCEPTION 'model-read-missing' USING ERRCODE='P1664';
 END IF;
 result:=jsonb_build_object('authorization',receipt);
 IF context IS NOT NULL THEN result:=result||jsonb_build_object('context',context); END IF;
 IF NOT p_with_pins THEN RETURN result; END IF;

 SELECT jsonb_agg(jsonb_build_object('datasetId',p.dataset_id,'mode',p.evidence_mode,
  'fileSha256',p.file_sha256,'contentSha256',p.content_sha256,'spec',p.spec,
  'rowCount',p.row_count,'recordedAt',p.dataset_recorded_at) ORDER BY p.evidence_mode)
 INTO datasets FROM fs138.model_run_datasets p WHERE p.run_id=p_run;
 SELECT jsonb_agg(jsonb_build_object('slot',a.slot,'datasetId',a.dataset_id,'objectKey',a.object_key,
  'fileSha256',a.file_sha256,'byteSize',a.byte_size) ORDER BY a.slot)
 INTO artifacts FROM fs138.model_artifacts a WHERE a.run_id=p_run AND a.slot=ANY(p_slots);
 result:=result||jsonb_build_object('run',jsonb_build_object('runId',publication.run_id,
  'descriptorSha256',publication.descriptor_sha256,'identity',publication.identity,
  'recordedAt',publication.recorded_at,'rightsReceipt',publication.rights_receipt),'datasets',datasets,'artifacts',artifacts);
 -- No per-example expansion or verification here. The trusted producer already
 -- qualified this immutable bounded history; bytes leave SQL only after Q1.
 IF context IS NOT NULL THEN
  SELECT f.history INTO feature_history FROM fs138.feature_values f
   WHERE f.feature_id=(context->'feature'->>'featureId')::uuid;
  result:=result||jsonb_build_object('history',feature_history);
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION fs138.authorize_model_scope(uuid,text[],boolean,jsonb) FROM PUBLIC;

-- Preserve the #166 signature/grants and model-only two-statement contract.
CREATE OR REPLACE FUNCTION fs138.authorize_model_read(p_run uuid,p_slots text[],p_with_pins boolean)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
 SELECT fs138.authorize_model_scope(p_run,p_slots,p_with_pins,NULL)
$$;

CREATE FUNCTION fs138.authorize_model_context_read(p_run uuid,p_slots text[],p_with_pins boolean,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,fs138 AS $$
BEGIN
 IF p_context IS NULL OR jsonb_typeof(p_context) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'model-context-reference-refused' USING ERRCODE='P2317';
 END IF;
 RETURN fs138.authorize_model_scope(p_run,p_slots,p_with_pins,p_context);
END $$;
REVOKE ALL ON FUNCTION fs138.authorize_model_context_read(uuid,text[],boolean,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fs138.authorize_model_context_read(uuid,text[],boolean,jsonb)
 TO fs231_model_reader,fs138_reader,fs138_pipeline_writer;
