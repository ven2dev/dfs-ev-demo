-- Complete, immutable run metadata. No dataset, pin or numeric training payload
-- is authorized here. Dataset verification/sealing is a separate forward step.
CREATE FUNCTION public.predictive_training_identity(v jsonb, ascii_only boolean DEFAULT true) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_typeof(v)='string' AND public.predictive_text(v)
  AND (v #>> '{}') !~ '[|]' AND (NOT ascii_only OR (v #>> '{}') ~ '^[!-~]+$') $$;

CREATE FUNCTION public.predictive_training_request(req jsonb, snapshot_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE sel jsonb; slot jsonb; slots jsonb:='[]'; ids jsonb; model jsonb; split jsonb; population jsonb; t timestamptz;
BEGIN
  IF public.predictive_source_exact(req,ARRAY['version','fittingRunId','evaluationPlanId','foldId','fitCutoff','selection','modelIdentity','splitPolicy','population','slots']) IS NOT TRUE
      OR req->>'version' IS DISTINCT FROM 'qb-training-read-v1'
      OR public.predictive_training_identity(req->'fittingRunId') IS NOT TRUE
      OR public.predictive_training_identity(req->'evaluationPlanId') IS NOT TRUE
      OR public.predictive_training_identity(req->'foldId') IS NOT TRUE
      OR public.predictive_instant(req->>'fitCutoff') IS NOT TRUE THEN
    RAISE EXCEPTION 'training-request-refused' USING ERRCODE='23514'; END IF;
  t:=(req->>'fitCutoff')::timestamptz;
  IF t>snapshot_time THEN RAISE EXCEPTION 'training-future-cutoff' USING ERRCODE='23514'; END IF;
  sel:=req->'selection';
  IF public.predictive_source_exact(sel,ARRAY['market','stat','candidate','featureVersion','labelVersion','historyPolicy','historyPolicySha256','profileIds']) IS NOT TRUE
      OR sel->>'market' IS DISTINCT FROM 'player_pass_yds' OR sel->>'stat' IS DISTINCT FROM 'passing_yards'
      OR sel->>'candidate' IS NULL OR sel->>'candidate' NOT IN ('stats-v1:player_pass_yds','player-opponent-v1:player_pass_yds')
      OR sel->>'featureVersion' IS DISTINCT FROM 'passing-yards-source-v1' OR sel->>'labelVersion' IS DISTINCT FROM 'source-final-label-v1'
      OR sel->>'historyPolicy' IS DISTINCT FROM 'qb-passing-history-three-season-v1'
      OR sel->>'historyPolicySha256' IS DISTINCT FROM '11a1286800334c1ceaf965868b98883a482caae3cf1869c1c54a3c9a592dae59' THEN
    RAISE EXCEPTION 'training-version-refused' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(sel->'profileIds') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'training-profile-bounds-refused' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(sel->'profileIds') NOT BETWEEN 1 AND 16
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(sel->'profileIds') p WHERE public.predictive_training_identity(p) IS NOT TRUE)
      OR (SELECT count(DISTINCT p) FROM jsonb_array_elements(sel->'profileIds') p)<>jsonb_array_length(sel->'profileIds') THEN
    RAISE EXCEPTION 'training-profile-bounds-refused' USING ERRCODE='23514'; END IF;
  SELECT jsonb_agg(p ORDER BY (p #>> '{}') COLLATE "C") INTO ids FROM jsonb_array_elements(sel->'profileIds') p;
  sel:=jsonb_set(sel,'{profileIds}',ids);
  model:=req->'modelIdentity'; split:=req->'splitPolicy'; population:=req->'population';
  IF public.predictive_source_exact(model,ARRAY['modelVersion','codeCommit','configurationSha256']) IS NOT TRUE
      OR public.predictive_training_identity(model->'modelVersion') IS NOT TRUE
      OR jsonb_typeof(model->'codeCommit') IS DISTINCT FROM 'string' OR model->>'codeCommit' !~ '^[a-f0-9]{40}$'
      OR jsonb_typeof(model->'configurationSha256') IS DISTINCT FROM 'string' OR model->>'configurationSha256' !~ '^[a-f0-9]{64}$'
      OR public.predictive_source_exact(split,ARRAY['version','evaluationMode','aggregationPolicyId','aggregationPolicySha256']) IS NOT TRUE
      OR split->>'version' IS DISTINCT FROM 'target-event-disjoint-v1'
      OR split->>'evaluationMode' IS NULL OR split->>'evaluationMode' NOT IN ('fixed-holdout','walk-forward')
      OR public.predictive_training_identity(split->'aggregationPolicyId') IS NOT TRUE
      OR jsonb_typeof(split->'aggregationPolicySha256') IS DISTINCT FROM 'string' OR split->>'aggregationPolicySha256' !~ '^[a-f0-9]{64}$'
      OR public.predictive_source_exact(population,ARRAY['status','enumerationOrigin','enumerationSha256']) IS NOT TRUE
      OR population->>'status' IS DISTINCT FROM 'unqualified'
      OR public.predictive_training_identity(population->'enumerationOrigin') IS NOT TRUE
      OR jsonb_typeof(population->'enumerationSha256') IS DISTINCT FROM 'string' OR population->>'enumerationSha256' !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'training-policy-identity-refused' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(req->'slots') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'training-slot-bounds-refused' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(req->'slots') NOT BETWEEN 1 AND 1024 THEN RAISE EXCEPTION 'training-slot-bounds-refused' USING ERRCODE='23514'; END IF;
  FOR slot IN SELECT value FROM jsonb_array_elements(req->'slots') LOOP
    IF public.predictive_source_exact(slot,ARRAY['datasetId','partition','playerId','gameId','season','seasonType','kickoff','kickoffObservationId','featureCutoff','labelsAsOf','featureRef','labelRef']) IS NOT TRUE
        OR public.predictive_training_identity(slot->'datasetId') IS NOT TRUE
        OR public.predictive_training_identity(slot->'kickoffObservationId',false) IS NOT TRUE
        OR public.predictive_identity(slot->'playerId','player') IS NOT TRUE OR public.predictive_identity(slot->'gameId','game') IS NOT TRUE
        OR slot->>'partition' IS NULL OR slot->>'partition' NOT IN ('training','evaluation')
        OR slot->>'seasonType' IS NULL OR slot->>'seasonType' NOT IN ('REG','POST')
        OR public.predictive_integer(slot->'season',1999,2100) IS NOT TRUE
        OR public.predictive_instant(slot->>'kickoff') IS NOT TRUE OR public.predictive_instant(slot->>'featureCutoff') IS NOT TRUE
        OR public.predictive_instant(slot->>'labelsAsOf') IS NOT TRUE
        OR (slot->'featureRef'<>'null'::jsonb AND public.predictive_training_identity(slot->'featureRef',false) IS NOT TRUE)
        OR (slot->'labelRef'<>'null'::jsonb AND public.predictive_training_identity(slot->'labelRef',false) IS NOT TRUE) THEN
      RAISE EXCEPTION 'training-slot-refused' USING ERRCODE='23514'; END IF;
    IF (slot->>'featureCutoff')::timestamptz>snapshot_time OR (slot->>'labelsAsOf')::timestamptz>snapshot_time THEN
      RAISE EXCEPTION 'training-future-cutoff' USING ERRCODE='23514'; END IF;
    IF (slot->>'featureCutoff')::timestamptz>=(slot->>'kickoff')::timestamptz THEN
      RAISE EXCEPTION 'training-feature-not-pregame' USING ERRCODE='23514'; END IF;
    IF slot->>'partition'='training' AND ((slot->>'labelsAsOf')::timestamptz>t OR (slot->>'kickoff')::timestamptz>=t) THEN
      RAISE EXCEPTION 'training-label-after-fit' USING ERRCODE='23514'; END IF;
    IF slot->>'partition'='evaluation' AND (slot->>'featureCutoff')::timestamptz<t THEN
      RAISE EXCEPTION 'training-evaluation-before-fit' USING ERRCODE='23514'; END IF;
    slots:=slots || jsonb_build_array(jsonb_set(slot,'{season}',to_jsonb((slot->>'season')::numeric::integer)));
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(req->'slots') s GROUP BY s->>'gameId' HAVING count(DISTINCT s->>'partition')>1) THEN
    RAISE EXCEPTION 'training-evaluation-event-overlap' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(req->'slots') s GROUP BY s->>'partition',s->>'playerId',s->>'gameId' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'training-duplicate-target' USING ERRCODE='23514'; END IF;
  IF (SELECT count(DISTINCT s->>'datasetId') FROM jsonb_array_elements(req->'slots') s)>32
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(req->'slots') s GROUP BY s->>'datasetId' HAVING count(*)>256) THEN
    RAISE EXCEPTION 'training-dataset-bounds-refused' USING ERRCODE='23514'; END IF;
  SELECT jsonb_agg(s ORDER BY CASE s->>'partition' WHEN 'training' THEN 0 ELSE 1 END,
    s->>'featureCutoff' COLLATE "C",s->>'playerId' COLLATE "C",s->>'gameId' COLLATE "C") INTO slots FROM jsonb_array_elements(slots) s;
  RETURN jsonb_set(jsonb_set(req,'{selection}',sel),'{slots}',slots);
END
$$;

CREATE TABLE public.predictive_training_run_identities (
  id_sha256 text PRIMARY KEY CHECK(id_sha256~'^[a-f0-9]{64}$'),
  request_sha256 text NOT NULL CHECK(request_sha256~'^[a-f0-9]{64}$'),
  plan_sha256 text NOT NULL CHECK(plan_sha256~'^[a-f0-9]{64}$'),
  fold_sha256 text NOT NULL CHECK(fold_sha256~'^[a-f0-9]{64}$'),
  plan_contract_sha256 text NOT NULL CHECK(plan_contract_sha256~'^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  UNIQUE(plan_sha256,fold_sha256)
);
CREATE TABLE public.predictive_training_runs (
  id text PRIMARY KEY CHECK(id~'^[!-~]+$' AND length(id) BETWEEN 1 AND 256 AND id!~'[|]'),
  identity_sha256 text NOT NULL UNIQUE REFERENCES public.predictive_training_run_identities(id_sha256),
  body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
  body_sha256 text NOT NULL CHECK(body_sha256~'^[a-f0-9]{64}$'),
  snapshot_at timestamptz NOT NULL
);
CREATE TABLE public.predictive_training_run_events (
  run_id text NOT NULL REFERENCES public.predictive_training_runs(id),
  game_id uuid NOT NULL,
  partition text NOT NULL CHECK(partition IN ('training','evaluation')),
  PRIMARY KEY(run_id,game_id), UNIQUE(run_id,game_id,partition)
);
CREATE TABLE public.predictive_training_run_slots (
  run_id text NOT NULL REFERENCES public.predictive_training_runs(id),
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 1023),
  dataset_id text NOT NULL CHECK(dataset_id~'^[!-~]+$' AND length(dataset_id) BETWEEN 1 AND 256 AND dataset_id!~'[|]'),
  partition text NOT NULL CHECK(partition IN ('training','evaluation')),
  game_id uuid NOT NULL, player_id text NOT NULL CHECK(player_id~'^00-[0-9]{7}$'),
  selection jsonb NOT NULL CHECK(jsonb_typeof(selection)='object'),
  PRIMARY KEY(run_id,ordinal), UNIQUE(run_id,partition,player_id,game_id),
  FOREIGN KEY(run_id,game_id,partition) REFERENCES public.predictive_training_run_events(run_id,game_id,partition)
);
CREATE TABLE public.predictive_training_run_profiles (
  run_id text NOT NULL REFERENCES public.predictive_training_runs(id),
  profile_id text NOT NULL REFERENCES public.predictive_source_profiles(id),
  use_kind text NOT NULL CHECK(use_kind IN ('model-input','outcome-label')),
  PRIMARY KEY(run_id,profile_id,use_kind)
);
CREATE TABLE public.predictive_training_retention_audits (
  event_id text PRIMARY KEY REFERENCES public.predictive_retention_events(id),
  removed_counts jsonb NOT NULL CHECK(jsonb_typeof(removed_counts)='object'),
  removed_ids_digest text NOT NULL CHECK(removed_ids_digest~'^[a-f0-9]{64}$'),
  removed_run_ids jsonb CHECK(removed_run_ids IS NULL OR jsonb_typeof(removed_run_ids)='array')
);

-- Extend the existing guard without copying its evidence table list.
ALTER FUNCTION public.predictive_training_read_guard() RENAME TO predictive_training_evidence_guard;
DO $revoke$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_replay') THEN
    REVOKE ALL ON FUNCTION public.predictive_training_evidence_guard() FROM predictive_replay;
  END IF;
END $revoke$;
CREATE FUNCTION public.predictive_training_read_guard() RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text;
BEGIN
  t:=public.predictive_training_evidence_guard();
  LOCK TABLE public.predictive_training_run_identities,public.predictive_training_runs,public.predictive_training_run_events,
    public.predictive_training_run_slots,public.predictive_training_run_profiles,public.predictive_training_retention_audits IN SHARE MODE;
  RETURN public.predictive_source_time(date_trunc('milliseconds',clock_timestamp()));
END
$$;

CREATE FUNCTION public.predictive_training_kickoff(slot jsonb, access_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE ids text[]; chosen text; d public.predictive_decisions; o public.predictive_observations; t timestamptz; deps jsonb;
BEGIN
  t:=(slot->>'featureCutoff')::timestamptz;
  SELECT array_agg(h.id ORDER BY h.id COLLATE "C") INTO ids FROM public.predictive_observations h
    WHERE h.entity_key='schedule:' || (slot->>'gameId') AND public.predictive_observation_usable(h.id,t)
      AND NOT EXISTS(SELECT 1 FROM public.predictive_observations n WHERE n.predecessor_id=h.id AND public.predictive_observation_usable(n.id,t));
  IF coalesce(cardinality(ids),0)=0 THEN RAISE EXCEPTION 'training-kickoff-missing' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM public.predictive_observations h WHERE h.id=ANY(ids) AND h.kind<>'schedule') THEN
    RAISE EXCEPTION 'training-kickoff-absent' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM public.predictive_observations h WHERE h.id=ANY(ids) AND
    (NOT public.predictive_rights_allow(h.profile_id,t,t,'internal-research') OR NOT public.predictive_rights_allow(h.profile_id,t,t,'model-input')
      OR NOT public.predictive_rights_allow(h.profile_id,access_time,access_time,'internal-research')
      OR NOT public.predictive_rights_allow(h.profile_id,access_time,access_time,'model-input'))) THEN
    RAISE EXCEPTION 'training-kickoff-rights-refused' USING ERRCODE='23514'; END IF;
  IF cardinality(ids)=1 THEN chosen:=ids[1];
  ELSE
    SELECT x.* INTO d FROM public.predictive_decisions x JOIN public.predictive_ingestion_runs r ON r.id=x.run_id
      WHERE r.status='published' AND x.kind='reconciliation' AND x.entity_key='reconciliation:schedule:' || (slot->>'gameId') AND x.decided_at<=t
        AND NOT EXISTS(SELECT 1 FROM public.predictive_decisions n WHERE n.predecessor_id=x.id AND n.decided_at<=t);
    IF NOT FOUND OR (SELECT count(*) FROM public.predictive_decisions x JOIN public.predictive_ingestion_runs r ON r.id=x.run_id
      WHERE r.status='published' AND x.kind='reconciliation' AND x.entity_key='reconciliation:schedule:' || (slot->>'gameId') AND x.decided_at<=t
        AND NOT EXISTS(SELECT 1 FROM public.predictive_decisions n WHERE n.predecessor_id=x.id AND n.decided_at<=t))<>1
        OR d.outcome->>'result' IS DISTINCT FROM 'selected'
        OR ids IS DISTINCT FROM ARRAY(SELECT observation_id FROM public.predictive_decision_inputs WHERE decision_id=d.id ORDER BY observation_id COLLATE "C") THEN
      RAISE EXCEPTION 'training-kickoff-ambiguous' USING ERRCODE='23514'; END IF;
    chosen:=d.outcome->>'selectedObservationId';
  END IF;
  SELECT * INTO o FROM public.predictive_observations WHERE id=chosen;
  IF o.id IS NULL OR NOT o.id=ANY(ids) OR o.id IS DISTINCT FROM slot->>'kickoffObservationId'
      OR o.data->'season' IS DISTINCT FROM slot->'season' OR o.data->'seasonType' IS DISTINCT FROM slot->'seasonType'
      OR o.data->'kickoff' IS DISTINCT FROM slot->'kickoff' THEN
    RAISE EXCEPTION 'training-kickoff-reference-mismatch' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM public.predictive_observations rival WHERE rival.kind='schedule' AND rival.data->'rawGameId'=o.data->'rawGameId'
      AND rival.game_id<>o.game_id AND public.predictive_observation_usable(rival.id,t)
      AND NOT EXISTS(SELECT 1 FROM public.predictive_observations n WHERE n.predecessor_id=rival.id AND public.predictive_observation_usable(n.id,t))) THEN
    RAISE EXCEPTION 'training-kickoff-ambiguous' USING ERRCODE='23514'; END IF;
  deps:=public.predictive_source_dependencies(ids,'schedule',t);
  RETURN jsonb_build_object('observationId',o.id,'dependencies',deps,'decisionId',d.id);
END
$$;

CREATE FUNCTION public.predictive_training_run_read(run_id text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.predictive_training_runs; x record; body jsonb;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_replay','MEMBER') THEN RAISE EXCEPTION 'training-read-not-authorized' USING ERRCODE='42501'; END IF;
  PERFORM public.predictive_training_read_guard();
  SELECT * INTO r FROM public.predictive_training_runs WHERE id=run_id;
  IF r.id IS NULL THEN
    IF EXISTS(SELECT 1 FROM public.predictive_training_run_identities WHERE id_sha256=public.predictive_source_digest(to_jsonb(run_id))) THEN
      RAISE EXCEPTION 'training-run-evidence-removed' USING ERRCODE='23514'; END IF;
    RETURN NULL;
  END IF;
  IF public.predictive_source_digest(r.body)<>r.body_sha256 OR r.body->>'snapshotAt' IS DISTINCT FROM public.predictive_source_time(r.snapshot_at)
      OR r.body->'rows' IS DISTINCT FROM (SELECT jsonb_agg(selection ORDER BY ordinal) FROM public.predictive_training_run_slots WHERE predictive_training_run_slots.run_id=r.id)
      OR public.predictive_source_digest(r.body->'request') IS DISTINCT FROM r.body->>'requestSha256'
      OR r.id IS DISTINCT FROM r.body->'request'->>'fittingRunId'
      OR public.predictive_source_set_equal(r.body->'protectedUses',coalesce((SELECT jsonb_agg(jsonb_build_object('profile',profile_id,'use',use_kind))
        FROM public.predictive_training_run_profiles WHERE predictive_training_run_profiles.run_id=r.id),'[]')) IS NOT TRUE
      OR public.predictive_source_set_equal((SELECT jsonb_agg(DISTINCT jsonb_build_object('gameId',game_id,'partition',partition))
        FROM public.predictive_training_run_events WHERE predictive_training_run_events.run_id=r.id),
        (SELECT jsonb_agg(DISTINCT jsonb_build_object('gameId',game_id,'partition',partition))
        FROM public.predictive_training_run_slots WHERE predictive_training_run_slots.run_id=r.id)) IS NOT TRUE THEN
    RAISE EXCEPTION 'training-inventory-integrity-refused' USING ERRCODE='23514'; END IF;
  FOR x IN SELECT profile_id,use_kind FROM public.predictive_training_run_profiles WHERE predictive_training_run_profiles.run_id=r.id LOOP
    IF NOT public.predictive_rights_allow(x.profile_id,clock_timestamp(),clock_timestamp(),'internal-research')
        OR NOT public.predictive_rights_allow(x.profile_id,clock_timestamp(),clock_timestamp(),x.use_kind) THEN
      RAISE EXCEPTION 'training-run-rights-refused' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR x IN SELECT DISTINCT id FROM public.predictive_training_run_slots s CROSS JOIN LATERAL (
    VALUES(s.selection->'selection'->>'featureId'),(s.selection->'selection'->>'labelId')) refs(id) WHERE s.run_id=r.id AND id IS NOT NULL LOOP
    IF public.predictive_source_consumer_check(x.id) IS NULL THEN RAISE EXCEPTION 'training-run-evidence-removed' USING ERRCODE='23514'; END IF;
  END LOOP;
  -- Full consumer checks may take time. Recheck every protected profile at
  -- delivery, including scheduled expiry/revocation not blocked by table locks.
  IF EXISTS(WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS t)
    SELECT 1 FROM public.predictive_training_run_profiles p CROSS JOIN clock c WHERE p.run_id=r.id
      AND (NOT public.predictive_rights_allow(p.profile_id,c.t,c.t,'internal-research')
        OR NOT public.predictive_rights_allow(p.profile_id,c.t,c.t,p.use_kind))) THEN
    RAISE EXCEPTION 'training-run-rights-refused' USING ERRCODE='23514'; END IF;
  body:=r.body || jsonb_build_object('inventorySha256',r.body_sha256);
  RETURN body;
END
$$;

CREATE FUNCTION public.predictive_prepare_training_run(input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
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
      feature_state:=CASE WHEN f.recorded_at+interval '90 days'<=t THEN 'expired'
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
  IF octet_length(public.predictive_source_canonical_json(body))>8000000 THEN RAISE EXCEPTION 'training-inventory-byte-bounds-refused' USING ERRCODE='23514'; END IF;
  INSERT INTO public.predictive_training_run_identities VALUES(identity_sha,request_sha,plan_sha,fold_sha,contract_sha,t);
  INSERT INTO public.predictive_training_runs VALUES(req->>'fittingRunId',identity_sha,body,public.predictive_source_digest(body),t);
  INSERT INTO public.predictive_training_run_events SELECT DISTINCT req->>'fittingRunId',(s->>'gameId')::uuid,s->>'partition' FROM jsonb_array_elements(req->'slots') s;
  INSERT INTO public.predictive_training_run_slots SELECT req->>'fittingRunId',(r->>'ordinal')::integer,r->'slot'->>'datasetId',r->'slot'->>'partition',
    (r->'slot'->>'gameId')::uuid,r->'slot'->>'playerId',r FROM jsonb_array_elements(rows) r;
  INSERT INTO public.predictive_training_run_profiles SELECT DISTINCT req->>'fittingRunId',x->>'profile',x->>'use' FROM jsonb_array_elements(profiles) x;
  RETURN public.predictive_training_run_read(req->>'fittingRunId') || jsonb_build_object('reused',false);
END
$$;

-- Compose deletion with the existing transaction authorization, rather than
-- copying or altering the six historical retention procedures. Supplemental
-- audit is separate: legacy removal counts/digests remain unchanged. Pending
-- inventories are conservatively erased on any named protected profile; they
-- cannot prove that missing selections lie outside a narrow capture interval.
CREATE FUNCTION public.predictive_training_retention_hook() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE event public.predictive_retention_events; ids text[]; counts jsonb; pairs jsonb;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_retention_owner','MEMBER') OR NEW.txid<>pg_current_xact_id() THEN
    RAISE EXCEPTION 'training-retention-not-authorized' USING ERRCODE='42501'; END IF;
  SELECT * INTO STRICT event FROM public.predictive_retention_events WHERE id=NEW.retention_event_id;
  LOCK TABLE public.predictive_training_runs,public.predictive_training_run_events,public.predictive_training_run_slots,
    public.predictive_training_run_profiles IN SHARE ROW EXCLUSIVE MODE;
  SELECT array_agg(r.id ORDER BY r.id COLLATE "C") INTO ids FROM public.predictive_training_runs r WHERE
    (event.scope_descriptor->>'kind'='source' AND EXISTS(SELECT 1 FROM public.predictive_training_run_profiles p WHERE p.run_id=r.id
      AND p.profile_id IN (SELECT jsonb_array_elements_text(event.scope_descriptor->'profileIds'))))
    OR (event.scope_descriptor->>'kind'='feature-run-expiry' AND EXISTS(SELECT 1 FROM public.predictive_training_run_slots s
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
$$;
CREATE TRIGGER predictive_training_retention_hook AFTER INSERT ON public.predictive_retention_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.predictive_training_retention_hook();

CREATE FUNCTION public.predictive_training_retention_result(event_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT pg_has_role(session_user,'predictive_retention_owner','MEMBER') THEN RAISE EXCEPTION 'training-retention-not-authorized' USING ERRCODE='42501'; END IF;
  RETURN (SELECT jsonb_build_object('removedCounts',removed_counts,'removedIdsDigest',removed_ids_digest)
    FROM public.predictive_training_retention_audits a WHERE a.event_id=predictive_training_retention_result.event_id);
END
$$;

DO $immutable$ DECLARE rel text; BEGIN
  FOREACH rel IN ARRAY ARRAY['predictive_training_run_identities','predictive_training_runs','predictive_training_run_events',
    'predictive_training_run_slots','predictive_training_run_profiles'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only()',rel || '_immutable',rel);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only()',rel || '_no_truncate',rel);
  END LOOP;
END $immutable$;
CREATE TRIGGER predictive_training_retention_audits_immutable BEFORE UPDATE OR DELETE ON public.predictive_training_retention_audits
  FOR EACH ROW EXECUTE FUNCTION public.predictive_retention_audit_immutable();
CREATE TRIGGER predictive_training_retention_audits_no_truncate BEFORE TRUNCATE ON public.predictive_training_retention_audits
  FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_retention_audit_immutable();
REVOKE ALL ON FUNCTION public.predictive_training_identity(jsonb,boolean),public.predictive_training_request(jsonb,timestamptz),
  public.predictive_training_read_guard(),public.predictive_training_kickoff(jsonb,timestamptz),public.predictive_training_run_read(text),
  public.predictive_prepare_training_run(jsonb),public.predictive_training_retention_hook(),public.predictive_training_retention_result(text) FROM PUBLIC;
DO $grants$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_replay') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_training_read_guard(),public.predictive_training_run_read(text) TO predictive_replay;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_recorder') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_prepare_training_run(jsonb) TO predictive_recorder;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_retention_owner') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_training_retention_result(text) TO predictive_retention_owner;
  END IF;
END $grants$;
