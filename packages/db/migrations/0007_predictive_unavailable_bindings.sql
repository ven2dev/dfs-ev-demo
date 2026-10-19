-- Preserve the v1 checker for historical audit. New bindings use v2, which
-- pins rights even on unavailable plans and reconstructs every failure witness.
ALTER FUNCTION public.predictive_source_plan_check(jsonb,timestamptz,boolean) RENAME TO predictive_source_plan_check_v1;

CREATE FUNCTION public.predictive_source_plan_v2(req jsonb, rights_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE p public.predictive_source_profiles; t timestamptz; raw_key text;
  caps jsonb; cap jsonb; source_rows jsonb:='[]'; row_refs jsonb:='[]'; stats jsonb;
  reason text; candidate jsonb; deps jsonb:='[]'; links jsonb:='[]'; decisions jsonb:='[]'; rights_ids jsonb;
  ids text[]; rivals text[]; role_name text; fact text; game text; team text; opponent text; player text; chosen text;
  schedule jsonb; parts text[]; decision_ids text[]; values_count integer; bad boolean; data jsonb; b jsonb;
  d public.predictive_decisions;
BEGIN
  raw_key:=public.predictive_source_request_key(req); t:=(req->>'cutoff')::timestamptz;
  SELECT * INTO p FROM public.predictive_source_profiles WHERE id=req->>'profileId';
  IF rights_time IS NULL OR NOT isfinite(rights_time) OR t>rights_time OR p.id IS NULL OR p.provider<>'nflverse'
      OR p.parser_version<>'nflverse-csv-qualification-v1' OR p.allowlist_version<>'predictive-raw-allowlist-v1'
      OR p.feed NOT IN ('player','team') OR (p.feed='player') IS DISTINCT FROM (req->'rawPlayerId'<>'null'::jsonb)
      OR public.predictive_rights_allow(p.id,rights_time,rights_time,'internal-research') IS NOT TRUE THEN
    RAISE EXCEPTION 'predictive-source-plan-rights-profile-invalid' USING ERRCODE='23514'; END IF;

  WITH eligible AS (SELECT c.*,dense_rank() OVER (ORDER BY c.captured_at DESC) AS rank
    FROM public.predictive_captures c JOIN public.predictive_artifacts a ON a.id=c.artifact_id
    JOIN public.predictive_blobs bl ON bl.sha256=a.blob_sha256 JOIN public.predictive_ingestion_runs r ON r.id=c.run_id
    WHERE a.profile_id=p.id AND a.scope_kind='season-file' AND a.scope_season=2026 AND a.scope_filter IS NULL AND bl.media_type='text/csv'
      AND c.state='published' AND r.status='published' AND c.available_at<=t AND c.ingested_at<=t)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'runId',c.run_id,'artifactId',c.artifact_id,
    'capturedAt',public.predictive_source_time(c.captured_at),'availableAt',public.predictive_source_time(c.available_at),
    'ingestedAt',public.predictive_source_time(c.ingested_at),'parsedRows',c.parsed_rows,'sha256',a.blob_sha256,
    'storageRef',bl.storage_ref,'byteSize',bl.byte_size) ORDER BY c.ingested_at,c.id COLLATE "C"),'[]')
    INTO caps FROM eligible c JOIN public.predictive_artifacts a ON a.id=c.artifact_id
    JOIN public.predictive_blobs bl ON bl.sha256=a.blob_sha256 WHERE c.rank=1;
  IF jsonb_array_length(caps)>256 THEN RAISE EXCEPTION 'predictive-source-plan-bounds-refused' USING ERRCODE='23514'; END IF;

  <<normalization>> BEGIN
    IF caps='[]'::jsonb THEN
      reason:=CASE WHEN EXISTS (SELECT 1 FROM public.predictive_retention_events
        WHERE scope_descriptor->>'kind'='source' AND scope_descriptor->'profileIds' ? p.id
          AND (scope_descriptor->>'capturedFrom' IS NULL OR (scope_descriptor->>'capturedFrom')::timestamptz<=t))
        THEN 'retained-evidence-removed' ELSE 'source-capture-missing' END;
      EXIT normalization;
    END IF;
    IF (SELECT count(DISTINCT x->>'sha256') FROM jsonb_array_elements(caps) x)>1 THEN
      reason:='source-capture-ambiguous'; EXIT normalization; END IF;
    cap:=caps->0; caps:=jsonb_build_array(cap);
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'rowOrdinal',s.row_ordinal,'rawKeySha256',s.raw_key_sha256,
        'selectedSha256',s.selected_sha256,'projection',s.projection,'failureCode',s.failure_code) ORDER BY s.row_ordinal),'[]'),
      coalesce(jsonb_agg(jsonb_build_object('id',s.id,'rowOrdinal',s.row_ordinal,'selectedSha256',s.selected_sha256) ORDER BY s.row_ordinal),'[]')
      INTO source_rows,row_refs FROM public.predictive_source_stats_rows s WHERE s.capture_id=cap->>'id' AND s.raw_key_sha256=raw_key;
    IF source_rows='[]'::jsonb THEN reason:='source-row-missing'; EXIT normalization;
    ELSIF (SELECT count(DISTINCT x->>'selectedSha256') FROM jsonb_array_elements(source_rows) x)>1 THEN
      reason:='source-row-ambiguous'; EXIT normalization;
    ELSIF source_rows->0->>'failureCode' IS NOT NULL THEN reason:='source-row-refused'; EXIT normalization; END IF;
    stats:=source_rows->0->'projection';

    FOREACH role_name IN ARRAY ARRAY['game-bridge','team-alias','opponent-alias'] LOOP
      fact:=CASE role_name WHEN 'game-bridge' THEN 'game-bridge:nflverse:' || (stats->>'rawGameId')
        WHEN 'team-alias' THEN 'team-alias:nflverse:' || (stats->>'rawTeam') ELSE 'team-alias:nflverse:' || (stats->>'rawOpponent') END;
      SELECT coalesce(array_agg(o.id ORDER BY o.id COLLATE "C"),'{}') INTO ids FROM public.predictive_observations o
        WHERE o.entity_key=fact AND public.predictive_source_is_head(o.id,t,rights_time);
      deps:=deps || public.predictive_source_dependencies(ids,role_name,t);
      SELECT count(DISTINCT CASE role_name WHEN 'game-bridge' THEN o.data->>'gameId' ELSE o.data->>'teamId' END),
        min(CASE role_name WHEN 'game-bridge' THEN o.data->>'gameId' ELSE o.data->>'teamId' END)
        INTO values_count,chosen FROM public.predictive_observations o WHERE o.id=ANY(ids) AND o.kind=CASE role_name WHEN 'game-bridge' THEN 'game-bridge' ELSE 'team-alias' END
          AND (role_name='game-bridge' OR ((o.data->>'effectiveFromSeason')::integer <= (stats->>'season')::integer
            AND (o.data->>'effectiveToSeason')::integer >= (stats->>'season')::integer));
      IF EXISTS (SELECT 1 FROM public.predictive_observations o WHERE o.id=ANY(ids) AND o.kind='source-row-absent') OR values_count>1 THEN
        reason:=role_name || '-conflict'; EXIT normalization;
      ELSIF values_count=0 THEN reason:=role_name || '-missing'; EXIT normalization; END IF;
      IF role_name='game-bridge' THEN
        game:=chosen;
        SELECT coalesce(array_agg(o.id ORDER BY o.id COLLATE "C"),'{}') INTO rivals FROM public.predictive_observations o
          WHERE o.kind='game-bridge' AND o.data->>'provider'=p.provider AND o.game_id=game::uuid
            AND o.data->>'rawGameId'<>stats->>'rawGameId' AND public.predictive_source_is_head(o.id,t,rights_time);
        IF cardinality(rivals)>0 THEN deps:=deps || public.predictive_source_dependencies(rivals,role_name,t);
          reason:='game-bridge-conflict'; EXIT normalization; END IF;
      ELSIF role_name='team-alias' THEN team:=chosen; ELSE opponent:=chosen; END IF;
    END LOOP;

    SELECT coalesce(array_agg(o.id ORDER BY o.id COLLATE "C"),'{}') INTO ids FROM public.predictive_observations o
      WHERE o.entity_key='schedule:' || game AND public.predictive_source_is_head(o.id,t,rights_time);
    IF EXISTS (SELECT 1 FROM public.predictive_observations o WHERE o.id=ANY(ids) AND o.kind='source-row-absent') THEN
      deps:=deps || public.predictive_source_dependencies(ids,'schedule',t); reason:='normalization-schedule-absent'; EXIT normalization; END IF;
    SELECT coalesce(array_agg(o.id ORDER BY o.id COLLATE "C"),'{}') INTO ids FROM public.predictive_observations o WHERE o.id=ANY(ids) AND o.kind='schedule';
    SELECT EXISTS (SELECT 1 FROM public.predictive_observations s JOIN public.predictive_observations a
      ON a.kind='schedule' AND a.raw_game_id=s.raw_game_id AND a.game_id<>s.game_id
      WHERE s.id=ANY(ids) AND public.predictive_source_is_head(a.id,t,rights_time)) INTO bad;
    IF bad THEN
      SELECT array_agg(o.id ORDER BY o.id COLLATE "C") INTO rivals FROM public.predictive_observations o WHERE o.kind='schedule'
        AND o.raw_game_id IN (SELECT s.raw_game_id FROM public.predictive_observations s WHERE s.id=ANY(ids))
        AND public.predictive_source_is_head(o.id,t,rights_time);
      deps:=deps || public.predictive_source_dependencies(rivals,'schedule',t); reason:='normalization-schedule-ambiguous'; EXIT normalization;
    END IF;
    deps:=deps || public.predictive_source_dependencies(ids,'schedule',t);
    IF cardinality(ids)=0 THEN reason:='normalization-schedule-missing'; EXIT normalization;
    ELSIF cardinality(ids)=1 THEN chosen:=ids[1];
    ELSE
      SELECT array_agg(x.id ORDER BY x.id COLLATE "C") INTO decision_ids FROM public.predictive_decisions x
        JOIN public.predictive_ingestion_runs r ON r.id=x.run_id WHERE x.entity_key='reconciliation:schedule:' || game AND x.kind='reconciliation'
        AND r.status='published' AND x.decided_at<=t
        AND NOT EXISTS (SELECT 1 FROM public.predictive_decisions n WHERE n.predecessor_id=x.id AND n.decided_at<=t);
      IF cardinality(decision_ids) IS DISTINCT FROM 1 THEN reason:='normalization-schedule-ambiguous'; EXIT normalization; END IF;
      SELECT * INTO d FROM public.predictive_decisions WHERE id=decision_ids[1];
      IF d.outcome->>'result' IS DISTINCT FROM 'selected' OR (d.outcome->>'selectedObservationId')<>ALL(ids)
          OR (SELECT array_agg(i.observation_id ORDER BY i.observation_id COLLATE "C") FROM public.predictive_decision_inputs i WHERE i.decision_id=d.id) IS DISTINCT FROM ids THEN
        reason:='normalization-schedule-ambiguous'; EXIT normalization; END IF;
      chosen:=d.outcome->>'selectedObservationId';
      decisions:=jsonb_build_array(jsonb_build_object('id',d.id,'kind',d.kind,'entityKey',d.entity_key,'policyId',d.policy_id,'mode',d.mode,
        'decidedAt',public.predictive_source_time(d.decided_at),'predecessorId',d.predecessor_id,'outcome',d.outcome,'inputs',
        (SELECT jsonb_agg(jsonb_build_object('observationId',i.observation_id,'role',i.role) ORDER BY i.observation_id COLLATE "C") FROM public.predictive_decision_inputs i WHERE i.decision_id=d.id)));
    END IF;
    SELECT o.data INTO schedule FROM public.predictive_observations o WHERE o.id=chosen;
    parts:=string_to_array(stats->>'rawGameId','_');
    IF schedule->'season' IS DISTINCT FROM stats->'season' OR schedule->'week' IS DISTINCT FROM stats->'week'
        OR schedule->'seasonType' IS DISTINCT FROM stats->'seasonType' OR team=opponent
        OR (schedule->>'homeTeamId') IS DISTINCT FROM (CASE WHEN (stats->>'rawTeam')=parts[4] THEN team ELSE opponent END)
        OR (schedule->>'awayTeamId') IS DISTINCT FROM (CASE WHEN (stats->>'rawTeam')=parts[3] THEN team ELSE opponent END) THEN
      reason:='source-schedule-context-conflict'; EXIT normalization; END IF;
    data:=jsonb_build_object('gameId',game,'rawGameId',stats->'rawGameId','teamId',team,'rawTeam',stats->'rawTeam',
      'season',stats->'season','seasonType',stats->'seasonType','missing',stats->'missing') || (stats->'values');
    IF p.feed='player' THEN
      SELECT coalesce(array_agg(o.id ORDER BY o.id COLLATE "C"),'{}') INTO ids FROM public.predictive_observations o
        WHERE o.entity_key='player-bridge:gsis:' || (stats->>'rawPlayerId') AND public.predictive_source_is_head(o.id,t,rights_time);
      deps:=deps || public.predictive_source_dependencies(ids,'player-bridge',t);
      SELECT count(DISTINCT o.player_id),min(o.player_id) INTO values_count,player FROM public.predictive_observations o
        WHERE o.id=ANY(ids) AND o.kind='player-bridge' AND (o.data->>'effectiveFrom')::timestamptz <= (schedule->>'kickoff')::timestamptz
        AND (schedule->>'kickoff')::timestamptz < (o.data->>'effectiveTo')::timestamptz;
      IF EXISTS (SELECT 1 FROM public.predictive_observations o WHERE o.id=ANY(ids) AND o.kind='source-row-absent') OR values_count>1 THEN
        reason:='player-bridge-conflict'; EXIT normalization;
      ELSIF values_count=0 THEN reason:='player-bridge-missing'; EXIT normalization; END IF;
      SELECT coalesce(array_agg(o.id ORDER BY o.id COLLATE "C"),'{}') INTO rivals FROM public.predictive_observations o
        WHERE o.kind='player-bridge' AND o.player_id=player AND o.data->>'provider'='gsis'
        AND (o.data->>'rawPlayerId') IS DISTINCT FROM (stats->>'rawPlayerId')
        AND (o.data->>'effectiveFrom')::timestamptz <= (schedule->>'kickoff')::timestamptz
        AND (schedule->>'kickoff')::timestamptz < (o.data->>'effectiveTo')::timestamptz AND public.predictive_source_is_head(o.id,t,rights_time);
      IF cardinality(rivals)>0 THEN deps:=deps || public.predictive_source_dependencies(rivals,'player-bridge',t);
        reason:='player-bridge-conflict'; EXIT normalization; END IF;
      SELECT coalesce(jsonb_agg(jsonb_build_object('id',k.id,'statsProfileId',k.stats_profile_id,'bridgeProfileId',k.bridge_profile_id,
        'provider',k.provider,'decidedAt',public.predictive_source_time(k.decided_at)) ORDER BY k.id COLLATE "C"),'[]') INTO links
        FROM public.predictive_profile_identity_links k WHERE k.stats_profile_id=p.id AND k.provider='gsis' AND k.decided_at<=t
        AND EXISTS (SELECT 1 FROM public.predictive_observations o WHERE o.id=ANY(ids) AND o.kind='player-bridge'
          AND o.profile_id=k.bridge_profile_id AND o.player_id=player AND (o.data->>'effectiveFrom')::timestamptz <= (schedule->>'kickoff')::timestamptz
          AND (schedule->>'kickoff')::timestamptz < (o.data->>'effectiveTo')::timestamptz);
      IF links='[]'::jsonb THEN reason:='player-bridge-link-missing'; EXIT normalization; END IF;
      data:=data || jsonb_build_object('playerId',player,'rawPlayerId',stats->'rawPlayerId','playerIdProvider','gsis');
    END IF;
    candidate:=jsonb_build_object('kind',CASE p.feed WHEN 'player' THEN 'player-game-stats' ELSE 'team-game-stats' END,'data',data);
  END normalization;

  SELECT coalesce(jsonb_agg(x ORDER BY x->>'role' COLLATE "C",x->>'observationId' COLLATE "C"),'[]') INTO deps FROM jsonb_array_elements(deps) x;
  SELECT jsonb_agg(to_jsonb(public.predictive_rights_in_force(id,rights_time,rights_time))
    ORDER BY public.predictive_rights_in_force(id,rights_time,rights_time) COLLATE "C") INTO rights_ids FROM (
    SELECT p.id UNION SELECT x->>'profileId' FROM jsonb_array_elements(deps) x) profiles(id);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(deps) x WHERE public.predictive_rights_allow(x->>'profileId',rights_time,rights_time,'internal-research') IS NOT TRUE) THEN
    RAISE EXCEPTION 'predictive-source-plan-rights-profile-invalid' USING ERRCODE='23514'; END IF;
  b:=jsonb_build_object('version','nflverse-stats-normalization-plan-v2','cutoff',req->'cutoff','sourceRequest',req,
    'sourceInputDigest',public.predictive_source_digest(jsonb_build_object('version','nflverse-csv-source-claims-v1','request',req,'captures',caps,'rows',source_rows)),
    'sourceProfileId',p.id,'rawSourceKey',CASE WHEN source_rows='[]'::jsonb THEN NULL ELSE raw_key END,
    'sourceCaptures',caps,'sourceRows',row_refs,'parserVersion','nflverse-csv-qualification-v1','projectionVersion','nflverse-raw-stats-v1',
    'dependencies',deps,'identityLinks',links,'decisions',decisions,'rightsDecisionIds',rights_ids);
  RETURN jsonb_build_object('status',CASE WHEN reason IS NULL THEN 'planned-source-normalization' ELSE 'unavailable-source-normalization' END,
    'reason',reason,'candidate',candidate,'dataDigest',public.predictive_source_digest(candidate),'binding',b,
    'planDigest',public.predictive_source_digest(jsonb_build_object('reason',reason,'candidate',candidate,'binding',b)),
    'observationsPublished',false,'featuresPublished',false,'labelsFinalized',false,'populationCoverage','unqualified');
END
$$;

CREATE FUNCTION public.predictive_source_plan_basis(plan jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT jsonb_build_object('reason',$1->'reason','candidate',$1->'candidate',
  'binding',($1->'binding')-ARRAY['version','cutoff','sourceInputDigest','rightsDecisionIds','sourceRequest'],
  'request',($1->'binding'->'sourceRequest')-'cutoff') $$;

CREATE FUNCTION public.predictive_source_plan_check(proposed jsonb, rights_time timestamptz, require_current boolean) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE req jsonb:=proposed->'binding'->'sourceRequest'; expected jsonb; current_plan jsonb;
BEGIN
  IF require_current IS NULL THEN RAISE EXCEPTION 'predictive-source-plan-invalid' USING ERRCODE='23514'; END IF;
  IF proposed->'binding'->>'version'='nflverse-stats-normalization-plan-v1' AND NOT require_current THEN
    PERFORM public.predictive_source_plan_check_v1(proposed,rights_time,false); RETURN; END IF;
  IF proposed->'binding'->>'version' IS DISTINCT FROM 'nflverse-stats-normalization-plan-v2' THEN
    RAISE EXCEPTION 'predictive-source-plan-version-invalid' USING ERRCODE='23514'; END IF;
  expected:=public.predictive_source_plan_v2(req,rights_time);
  IF proposed IS DISTINCT FROM expected THEN RAISE EXCEPTION 'predictive-source-plan-witness-invalid' USING ERRCODE='23514'; END IF;
  IF require_current THEN
    current_plan:=public.predictive_source_plan_v2(jsonb_set(req,'{cutoff}',to_jsonb(public.predictive_source_time(rights_time))),rights_time);
    IF public.predictive_source_plan_basis(proposed) IS DISTINCT FROM public.predictive_source_plan_basis(current_plan) THEN
      RAISE EXCEPTION 'predictive-source-plan-stale' USING ERRCODE='23514'; END IF;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.predictive_source_plan_v2(jsonb,timestamptz),public.predictive_source_plan_basis(jsonb),
  public.predictive_source_plan_check(jsonb,timestamptz,boolean) FROM PUBLIC;

-- Capture-less states cannot prove they fall outside a provider deletion window.
-- Conservatively remove their complete raw lineage whenever that source is scoped.
CREATE OR REPLACE FUNCTION public.predictive_retention_execute(event_id text, event_reason text, event_authority text, event_decided_at timestamptz,
  event_scope jsonb, event_audit_level text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  profiles text[]; captured_from timestamptz; captured_before timestamptz; as_of timestamptz;
  arts text[] := '{}'; caps text[] := '{}'; obs text[] := '{}'; decs text[] := '{}'; labs text[] := '{}';
  runs text[] := '{}'; pins text[] := '{}'; blobs text[] := '{}'; refs text[]; source_rows text[] := '{}'; bindings text[] := '{}'; revisions text[] := '{}'; binding_links integer;
  removed_kinds text[]; removed_ids text[]; counts jsonb; ids_digest text; links integer; inputs integer; dependencies integer; unpins integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'predictive_retention_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'predictive-retention-not-authorized' USING ERRCODE = '42501';
  END IF;
  IF event_decided_at IS NULL OR event_decided_at > pg_catalog.now() OR NOT public.predictive_retention_scope_valid(event_reason, event_scope) THEN
    RAISE EXCEPTION 'predictive-retention-invalid' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(520052,1);
  LOCK TABLE public.predictive_source_bindings,public.predictive_source_stats_revisions IN SHARE ROW EXCLUSIVE MODE;
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
  pins := ARRAY(SELECT p.id FROM public.predictive_feature_run_pins p WHERE p.feature_run_id = ANY(runs));
  blobs := ARRAY(SELECT DISTINCT b.sha256 FROM public.predictive_blobs b
    WHERE (b.sha256 IN (SELECT a.blob_sha256 FROM public.predictive_artifacts a WHERE a.id = ANY(arts))
        OR b.sha256 IN (SELECT f.bundle_blob_sha256 FROM public.predictive_feature_runs f WHERE f.id = ANY(runs)))
      AND NOT EXISTS (SELECT 1 FROM public.predictive_artifacts a WHERE a.blob_sha256 = b.sha256 AND NOT a.id = ANY(arts))
      AND NOT EXISTS (SELECT 1 FROM public.predictive_feature_runs f WHERE f.bundle_blob_sha256 = b.sha256 AND NOT f.id = ANY(runs)));
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
      UNION ALL SELECT 'source-binding', v FROM unnest(bindings) v UNION ALL SELECT 'source-stats-revision', v FROM unnest(revisions) v) t(k, v);
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
  INSERT INTO public.predictive_retention_events (id,reason,authority,decided_at,scope_descriptor,audit_level,removed_counts,removed_ids_digest,executed_at)
    VALUES (event_id, event_reason, event_authority, event_decided_at, event_scope, event_audit_level, counts, ids_digest, pg_catalog.now());
  INSERT INTO public.predictive_retention_authorizations (txid, retention_event_id) VALUES (pg_catalog.pg_current_xact_id(), event_id);
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
$$;

-- A real CSV profile cannot bypass staging by wrapping generated revisions in
-- JSON. The separately guarded synthetic JSON harness retains its proof path.
CREATE OR REPLACE FUNCTION public.predictive_source_canonical_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.predictive_artifacts a JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256
      JOIN public.predictive_source_profiles p ON p.id=a.profile_id WHERE a.id=NEW.artifact_id
      AND p.parser_version='nflverse-csv-qualification-v1' AND (b.media_type='text/csv' OR p.purpose<>'synthetic-test')) THEN
    RAISE EXCEPTION 'predictive-source-canonical-binding-required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;
