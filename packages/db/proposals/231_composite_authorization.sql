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
