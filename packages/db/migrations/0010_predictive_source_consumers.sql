-- QB consumers cite CSV bindings/decisions explicitly; no CSV row is made an
-- ordinary observation. Released observation-only consumer contracts stay intact.
CREATE TABLE public.predictive_source_consumers (
  id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 256 AND length(btrim(id))>0 AND id !~ '[[:cntrl:]|]'),
  kind text NOT NULL CHECK(kind IN ('feature','label')),
  player_id text NOT NULL CHECK(player_id ~ '^00-[0-9]{7}$'),
  game_id uuid NOT NULL REFERENCES public.predictive_games(id),
  predecessor_id text REFERENCES public.predictive_source_consumers(id) DEFERRABLE INITIALLY DEFERRED,
  recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
  cutoff timestamptz NOT NULL CHECK(isfinite(cutoff) AND cutoff<=recorded_at),
  mode text NOT NULL CHECK(mode IN ('production-research','synthetic-proof')),
  body jsonb NOT NULL,
  body_sha256 text NOT NULL REFERENCES public.predictive_blobs(sha256),
  execution_digest text NOT NULL CHECK(execution_digest ~ '^[a-f0-9]{64}$'),
  CHECK(predecessor_id IS DISTINCT FROM id AND (kind='label' OR predecessor_id IS NULL))
);
CREATE UNIQUE INDEX predictive_source_consumers_label_root ON public.predictive_source_consumers(player_id,game_id) WHERE kind='label' AND predecessor_id IS NULL;
CREATE UNIQUE INDEX predictive_source_consumers_label_successor ON public.predictive_source_consumers(predecessor_id) WHERE predecessor_id IS NOT NULL;
CREATE INDEX predictive_source_consumers_recorded ON public.predictive_source_consumers(recorded_at);
CREATE TABLE public.predictive_source_consumer_bindings (
  consumer_id text NOT NULL REFERENCES public.predictive_source_consumers(id),
  binding_id text NOT NULL REFERENCES public.predictive_source_bindings(id), PRIMARY KEY(consumer_id,binding_id)
);
CREATE INDEX predictive_source_consumer_bindings_reverse ON public.predictive_source_consumer_bindings(binding_id,consumer_id);
CREATE TABLE public.predictive_source_consumer_source_decisions (
  consumer_id text NOT NULL REFERENCES public.predictive_source_consumers(id),
  decision_id text NOT NULL REFERENCES public.predictive_source_decisions(id), PRIMARY KEY(consumer_id,decision_id)
);
CREATE INDEX predictive_source_consumer_source_decisions_reverse ON public.predictive_source_consumer_source_decisions(decision_id,consumer_id);
CREATE TABLE public.predictive_source_consumer_observations (
  consumer_id text NOT NULL REFERENCES public.predictive_source_consumers(id),
  observation_id text NOT NULL REFERENCES public.predictive_observations(id), PRIMARY KEY(consumer_id,observation_id)
);
CREATE INDEX predictive_source_consumer_observations_reverse ON public.predictive_source_consumer_observations(observation_id,consumer_id);
CREATE TABLE public.predictive_source_consumer_decisions (
  consumer_id text NOT NULL REFERENCES public.predictive_source_consumers(id),
  decision_id text NOT NULL REFERENCES public.predictive_decisions(id), PRIMARY KEY(consumer_id,decision_id)
);
CREATE TABLE public.predictive_source_consumer_rights (
  consumer_id text NOT NULL REFERENCES public.predictive_source_consumers(id),
  rights_decision_id text NOT NULL REFERENCES public.predictive_rights_decisions(id), PRIMARY KEY(consumer_id,rights_decision_id)
);

CREATE FUNCTION public.predictive_source_consumer_profiles(req jsonb) RETURNS text[]
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT ARRAY(SELECT DISTINCT p COLLATE "C" FROM (
    SELECT jsonb_array_elements_text(req->'profileIds') AS p
    UNION SELECT x->>'profileId' FROM public.predictive_source_bindings b CROSS JOIN LATERAL jsonb_array_elements(b.plan->'binding'->'dependencies') x
      WHERE b.profile_id IN (SELECT jsonb_array_elements_text(req->'profileIds')) AND b.recorded_at<=(req->>'cutoff')::timestamptz
    UNION SELECT o.profile_id FROM public.predictive_observations o WHERE o.id IN (SELECT jsonb_array_elements_text(req->'observations'))
    UNION SELECT o.profile_id FROM public.predictive_observations o CROSS JOIN LATERAL jsonb_array_elements_text(req->'entityKeys') k
      WHERE k LIKE 'player-game-stats:%' AND o.entity_key LIKE 'participation-evidence:' || substr(k,19) || ':%'
        AND public.predictive_observation_usable(o.id,(req->>'cutoff')::timestamptz)
    UNION SELECT x->>'profileId' FROM public.predictive_source_decisions d CROSS JOIN LATERAL jsonb_array_elements(d.plan->'nativeInputs') x
      WHERE d.plan->'witness'->'profileIds'=req->'profileIds' AND d.entity_key IN (SELECT jsonb_array_elements_text(req->'entityKeys'))
        AND d.recorded_at<=(req->>'cutoff')::timestamptz
  ) scoped ORDER BY 1)
$$;
CREATE FUNCTION public.predictive_source_consumer_access_at(req jsonb,t timestamptz) RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE profiles text[]; profile_name text; raw record; plan jsonb;
BEGIN
  IF public.predictive_source_exact(req,ARRAY['profileIds','cutoff','observations','entityKeys','use']) IS NOT TRUE
      OR req->>'use' IS NULL OR req->>'use' NOT IN ('model-input','outcome-label') OR (req->>'cutoff')::timestamptz>t
      OR jsonb_typeof(req->'observations')<>'array' OR jsonb_array_length(req->'observations')>8192 THEN
    RAISE EXCEPTION 'source-consumer-access-request-refused' USING ERRCODE='23514'; END IF;
  PERFORM public.predictive_source_witness_at(jsonb_build_object('profileIds',req->'profileIds','entityKeys',req->'entityKeys','cutoff',req->'cutoff'),t);
  profiles:=public.predictive_source_consumer_profiles(req);
  -- A new context head can stale a binding before being recorded. Authorize
  -- the freshly reconstructed plan's profiles too, before the reader opens it.
  FOR raw IN SELECT DISTINCT (b.plan->'binding'->'sourceRequest')-'cutoff' AS request
    FROM public.predictive_source_bindings b WHERE b.profile_id IN (SELECT jsonb_array_elements_text(req->'profileIds'))
      AND b.recorded_at<=(req->>'cutoff')::timestamptz LOOP
    plan:=public.predictive_source_plan_v2(raw.request || jsonb_build_object('cutoff',req->'cutoff'),t);
    profiles:=profiles || ARRAY(SELECT x->>'profileId' FROM jsonb_array_elements(plan->'binding'->'dependencies') x);
  END LOOP;
  profiles:=ARRAY(SELECT DISTINCT p COLLATE "C" FROM unnest(profiles) p ORDER BY 1);
  FOREACH profile_name IN ARRAY profiles LOOP
    IF public.predictive_rights_allow(profile_name,t,t,'internal-research') IS NOT TRUE OR public.predictive_rights_allow(profile_name,t,t,req->>'use') IS NOT TRUE THEN
      RAISE EXCEPTION 'source-consumer-rights-refused' USING ERRCODE='23514'; END IF;
  END LOOP;
  RETURN profiles;
END
$$;
CREATE FUNCTION public.predictive_source_consumer_access(req jsonb) RETURNS text[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT (pg_catalog.pg_has_role(session_user,'predictive_replay','MEMBER') OR pg_catalog.pg_has_role(session_user,'predictive_recorder','MEMBER')) THEN
    RAISE EXCEPTION 'source-consumer-not-authorized' USING ERRCODE='42501'; END IF;
  RETURN public.predictive_source_consumer_access_at(req,date_trunc('milliseconds',pg_catalog.clock_timestamp()));
END
$$;

-- Reproduce the reader's current decision at a historical cutoff. Record IDs,
-- basis, selection and missing/stale/withheld reasons are all checked, not just
-- the statistical revision. A recapture can reuse a revision yet stale a head.
CREATE FUNCTION public.predictive_source_consumer_input_at(item jsonb,profiles jsonb,at_cutoff text,t timestamptz) RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE witness jsonb; req jsonb; plan jsonb; d public.predictive_source_decisions; k text; expected_id text; reason text; selected jsonb;
BEGIN
  IF public.predictive_source_exact(item,ARRAY['entityKey','witness','reconciliationId','participationId','reconciliationReason','participationReason','selected']) IS NOT TRUE THEN
    RAISE EXCEPTION 'source-consumer-input-refused' USING ERRCODE='23514'; END IF;
  witness:=public.predictive_source_witness_at(jsonb_build_object('profileIds',profiles,'entityKeys',jsonb_build_array(item->'entityKey'),'cutoff',at_cutoff),t);
  IF item->'witness' IS DISTINCT FROM witness THEN RAISE EXCEPTION 'source-consumer-witness-refused' USING ERRCODE='23514'; END IF;
  FOREACH k IN ARRAY ARRAY['reconciliation','participation'] LOOP
    IF k='participation' AND item->>'entityKey' NOT LIKE 'player-game-stats:%' THEN
      IF item->>'participationId' IS NOT NULL OR item->>'participationReason' IS NOT NULL THEN RAISE EXCEPTION 'source-consumer-participation-refused' USING ERRCODE='23514'; END IF;
      CONTINUE;
    END IF;
    req:=jsonb_build_object('kind',k,'profileIds',profiles,'entityKey',item->'entityKey','cutoff',at_cutoff);
    plan:=public.predictive_source_decision_plan_at(req,t);
    SELECT current.* INTO d FROM public.predictive_source_decisions current WHERE current.kind=k AND current.entity_key=item->>'entityKey'
      AND current.scope_digest=public.predictive_source_digest(profiles) AND current.recorded_at<=at_cutoff::timestamptz
      AND NOT EXISTS (SELECT 1 FROM public.predictive_source_decisions next WHERE next.predecessor_id=current.id AND next.recorded_at<=at_cutoff::timestamptz);
    expected_id:=NULL; reason:=NULL;
    IF d.id IS NULL THEN reason:='source-decision-missing';
    ELSIF public.predictive_source_decision_basis(d.plan) IS DISTINCT FROM public.predictive_source_decision_basis(plan) THEN reason:='source-decision-stale';
    ELSIF plan->>'state'='withheld' THEN reason:='source-evidence-withheld';
    ELSE expected_id:=d.id; END IF;
    IF item->>(k || 'Id') IS DISTINCT FROM expected_id OR item->>(k || 'Reason') IS DISTINCT FROM reason THEN
      RAISE EXCEPTION 'source-consumer-decision-refused' USING ERRCODE='23514'; END IF;
    IF k='reconciliation' AND expected_id IS NOT NULL THEN selected:=d.plan->'selected'; END IF;
  END LOOP;
  IF item->'selected' IS DISTINCT FROM coalesce(selected,'null'::jsonb) THEN RAISE EXCEPTION 'source-consumer-selection-refused' USING ERRCODE='23514'; END IF;
END
$$;

CREATE FUNCTION public.predictive_source_consumer_validate(body jsonb,rights_time timestamptz,created timestamptz) RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE m jsonb; req jsonb; profiles text[]; item jsonb; computed jsonb; d public.predictive_decisions;
  r public.predictive_source_stats_revisions; b public.predictive_source_bindings; c public.predictive_captures;
  bridge public.predictive_observations; eligible timestamptz; key text; game jsonb; summary jsonb; group_name text; field text; sources text[];
BEGIN
  m:=body->'manifest';
  IF public.predictive_source_exact(m,ARRAY['version','use','cutoff','profileIds','sources','observations','decisions']) IS NOT TRUE
      OR m->>'version'<>'source-consumer-v1' OR jsonb_typeof(m->'sources')<>'array' OR jsonb_array_length(m->'sources')>64
      OR jsonb_array_length(m->'sources')<>(SELECT count(DISTINCT x->>'entityKey') FROM jsonb_array_elements(m->'sources') x) THEN
    RAISE EXCEPTION 'source-consumer-manifest-refused' USING ERRCODE='23514'; END IF;
  req:=jsonb_build_object('profileIds',m->'profileIds','cutoff',m->'cutoff','observations',m->'observations',
    'entityKeys',coalesce((SELECT jsonb_agg(x->'entityKey' ORDER BY x->>'entityKey' COLLATE "C") FROM jsonb_array_elements(m->'sources') x),'[]'), 'use',m->'use');
  profiles:=public.predictive_source_consumer_access_at(req,rights_time);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(m->'observations') id WHERE public.predictive_observation_usable(id,(m->>'cutoff')::timestamptz) IS NOT TRUE)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(m->'decisions') id WHERE public.predictive_decision_current(id,(m->>'cutoff')::timestamptz) IS NOT TRUE)
      OR EXISTS (SELECT 1 FROM public.predictive_decision_inputs x WHERE x.decision_id IN (SELECT jsonb_array_elements_text(m->'decisions'))
        AND x.observation_id NOT IN (SELECT jsonb_array_elements_text(m->'observations'))) THEN
    RAISE EXCEPTION 'source-consumer-native-refused' USING ERRCODE='23514'; END IF;
  FOR item IN SELECT x FROM jsonb_array_elements(m->'sources') x LOOP
    PERFORM public.predictive_source_consumer_input_at(item,m->'profileIds',m->>'cutoff',rights_time);
  END LOOP;
  IF body->>'kind'='feature' THEN
    IF public.predictive_source_exact(body,ARRAY['kind','bundle','manifest','inputDigest']) IS NOT TRUE OR m->>'use'<>'model-input'
        OR body->'bundle'->>'featureVersion'<>'passing-yards-source-v1' OR body->'bundle'->>'usage'<>'internal-research'
        OR body->'bundle'->'request'->>'cutoff' IS DISTINCT FROM m->>'cutoff'
        OR (body->'bundle'->>'computedAt')::timestamptz<(m->>'cutoff')::timestamptz
        OR (body->'bundle'->>'computedAt')::timestamptz>created
        OR body->'bundle'->>'status' NOT IN ('ready-inputs','unavailable-inputs') THEN
      RAISE EXCEPTION 'source-feature-body-refused' USING ERRCODE='23514'; END IF;
    IF m->'observations' IS DISTINCT FROM coalesce((SELECT jsonb_agg(id ORDER BY id COLLATE "C") FROM (
          SELECT DISTINCT x->>'observationId' AS id FROM jsonb_array_elements(body->'bundle'->'dependencies') x) ids),'[]'::jsonb)
        OR m->'decisions' IS DISTINCT FROM coalesce((SELECT jsonb_agg(id ORDER BY id COLLATE "C") FROM (
          SELECT DISTINCT x->>'decisionId' AS id FROM jsonb_array_elements((body->'bundle'->'completions') ||
            (body->'bundle'->'participations') || (body->'bundle'->'reconciliations')) x) ids),'[]'::jsonb)
        OR (body->'bundle'->>'status'='ready-inputs') IS DISTINCT FROM (body->'bundle'->'reasons'='[]'::jsonb)
        OR body->'bundle'->>'inputDigest' IS DISTINCT FROM body->>'inputDigest' THEN
      RAISE EXCEPTION 'source-feature-manifest-refused' USING ERRCODE='23514'; END IF;
    -- Every displayed stats slot must use the selected CSV payload. A caller
    -- cannot drop its manifest entry or substitute an ordinary provider row.
    FOREACH group_name IN ARRAY ARRAY['player','team','opponent'] LOOP
      FOR summary IN SELECT x FROM jsonb_array_elements(coalesce(nullif(body->'bundle'->group_name,'null'::jsonb),'[]')) x LOOP
        FOR game IN SELECT x FROM jsonb_array_elements(summary->'games') x LOOP
          key:=CASE WHEN group_name='player' THEN 'player-game-stats:' || (game->>'gameId') || ':' || (body->'bundle'->'request'->>'playerId')
            ELSE 'team-game-stats:' || (game->>'gameId') || ':' || (game->>'teamId') END;
          SELECT x INTO item FROM jsonb_array_elements(m->'sources') x WHERE x->>'entityKey'=key;
          SELECT * INTO r FROM public.predictive_source_stats_revisions WHERE id=item->'selected'->>'revisionId';
          IF item IS NULL OR r.id IS NULL OR r.data->'attempts' IS DISTINCT FROM game->'attempts' OR r.data->'passingYards' IS DISTINCT FROM game->'passingYards'
              OR r.data->'teamId' IS DISTINCT FROM game->'teamId' OR r.data->'season' IS DISTINCT FROM game->'season'
              OR r.data->'seasonType' IS DISTINCT FROM game->'seasonType' OR game->>'gameId'=body->'bundle'->'request'->>'gameId' THEN
            RAISE EXCEPTION 'source-feature-slot-refused' USING ERRCODE='23514'; END IF;
          IF group_name='player' AND NOT EXISTS (SELECT 1 FROM public.predictive_source_decisions p WHERE p.id=item->>'participationId'
              AND p.plan->'outcome'->>'state'='offensive-participant') THEN RAISE EXCEPTION 'source-feature-participation-refused' USING ERRCODE='23514'; END IF;
        END LOOP;
        IF (summary->>'attemptsSum')::numeric IS DISTINCT FROM (SELECT coalesce(sum((x->>'attempts')::numeric),0) FROM jsonb_array_elements(summary->'games') x)
            OR (summary->>'passingYardsSum')::numeric IS DISTINCT FROM (SELECT coalesce(sum((x->>'passingYards')::numeric),0) FROM jsonb_array_elements(summary->'games') x) THEN
          RAISE EXCEPTION 'source-feature-summary-refused' USING ERRCODE='23514'; END IF;
      END LOOP;
    END LOOP;
    computed:=(body-'inputDigest'-'bundle') || jsonb_build_object('bundle',(body->'bundle')-'computedAt'-'inputDigest');
  ELSIF body->>'kind'='label' THEN
    IF public.predictive_source_exact(body,ARRAY['kind','version','playerId','gameId','seasonType','stat','value','completionDecisionId','eligibleFinalAt',
        'postWindowCaptureId','playerBridgeObservationId','manifest','inputDigest']) IS NOT TRUE OR m->>'use'<>'outcome-label'
        OR body->>'version'<>'source-final-label-v1' OR body->>'stat'<>'passing_yards' OR jsonb_array_length(m->'sources')<>1 THEN
      RAISE EXCEPTION 'source-label-body-refused' USING ERRCODE='23514'; END IF;
    item:=m->'sources'->0; key:='player-game-stats:' || (body->>'gameId') || ':' || (body->>'playerId');
    IF item->>'entityKey' IS DISTINCT FROM key OR item->>'reconciliationId' IS NULL OR item->>'participationId' IS NULL THEN
      RAISE EXCEPTION 'source-label-decision-refused' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.predictive_source_decisions p WHERE p.id=item->>'participationId' AND p.plan->'outcome'->>'state'='offensive-participant') THEN
      RAISE EXCEPTION 'source-label-participation-refused' USING ERRCODE='23514'; END IF;
    -- No evidence arriving between planning and recording may finalize an old
    -- decision. Current rights are separate from historical cutoff evidence.
    PERFORM public.predictive_source_witness_check(item->'witness',created,true);
    FOR field IN SELECT unnest(ARRAY['reconciliation','participation']) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.predictive_source_decisions p WHERE p.id=item->>(field || 'Id') AND NOT EXISTS (
        SELECT 1 FROM public.predictive_source_decisions n WHERE n.predecessor_id=p.id AND n.recorded_at<=created)) THEN
        RAISE EXCEPTION 'source-label-decision-stale' USING ERRCODE='23514'; END IF;
      IF public.predictive_source_decision_basis((SELECT plan FROM public.predictive_source_decisions WHERE id=item->>(field || 'Id')))
          IS DISTINCT FROM public.predictive_source_decision_basis(public.predictive_source_decision_plan_at(jsonb_build_object('kind',field,
            'entityKey',key,'profileIds',m->'profileIds','cutoff',public.predictive_source_time(created)),rights_time)) THEN
        RAISE EXCEPTION 'source-label-decision-stale' USING ERRCODE='23514'; END IF;
    END LOOP;
    SELECT * INTO d FROM public.predictive_decisions WHERE id=body->>'completionDecisionId';
    IF d.id IS NULL OR d.kind<>'completion' OR d.entity_key<>'completion:' || (body->>'gameId') OR d.outcome->>'state'<>'completed'
        OR public.predictive_decision_current(d.id,created) IS NOT TRUE OR d.id NOT IN (SELECT jsonb_array_elements_text(m->'decisions')) THEN
      RAISE EXCEPTION 'source-label-completion-refused' USING ERRCODE='23514'; END IF;
    eligible:=public.predictive_label_eligible_final_at((d.outcome->>'completionObservedAt')::timestamptz);
    SELECT * INTO r FROM public.predictive_source_stats_revisions WHERE id=item->'selected'->>'revisionId';
    SELECT * INTO b FROM public.predictive_source_bindings WHERE id=item->'selected'->>'bindingId';
    SELECT * INTO c FROM public.predictive_captures WHERE id=body->>'postWindowCaptureId';
    IF r.id IS NULL OR r.kind<>'player-game-stats' OR r.data->'seasonType' IS DISTINCT FROM body->'seasonType'
        OR r.data->'passingYards'='null'::jsonb OR r.data->'passingYards' IS DISTINCT FROM body->'value'
        OR (body->>'eligibleFinalAt')::timestamptz IS DISTINCT FROM eligible OR created<eligible
        OR c.id IS NULL OR c.state<>'published' OR NOT c.body_complete OR NOT c.header_verified OR NOT c.parser_succeeded
        OR c.captured_at<eligible OR c.ingested_at>created OR jsonb_array_length(b.plan->'binding'->'sourceCaptures')<>1
        OR b.plan->'binding'->'sourceCaptures'->0->>'id' IS DISTINCT FROM c.id THEN
      RAISE EXCEPTION 'source-label-post-window-refused' USING ERRCODE='23514'; END IF;
    SELECT * INTO bridge FROM public.predictive_observations WHERE id=body->>'playerBridgeObservationId';
    IF bridge.id IS NULL OR bridge.kind<>'player-bridge' OR bridge.data->>'rawPlayerId' IS DISTINCT FROM r.data->>'rawPlayerId'
        OR bridge.data->>'provider' IS DISTINCT FROM r.data->>'playerIdProvider' OR bridge.data->>'playerId' IS DISTINCT FROM body->>'playerId'
        OR NOT EXISTS (SELECT 1 FROM public.predictive_source_binding_dependencies x WHERE x.binding_id=b.id AND x.observation_id=bridge.id AND x.role='player-bridge') THEN
      RAISE EXCEPTION 'source-label-identity-refused' USING ERRCODE='23514'; END IF;
    -- witness/plan kernels independently recheck the selected binding's bridge
    -- currentness, ambiguity, linked profile and effective kickoff window.
    computed:=body-'inputDigest';
  ELSE RAISE EXCEPTION 'source-consumer-kind-refused' USING ERRCODE='23514'; END IF;
  IF body->>'inputDigest' IS DISTINCT FROM public.predictive_source_digest(computed) THEN RAISE EXCEPTION 'source-consumer-digest-refused' USING ERRCODE='23514'; END IF;
  RETURN profiles;
END
$$;

CREATE FUNCTION public.predictive_record_source_consumer(record_id text,expected_head text,proposed jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t timestamptz; profiles text[]; rights jsonb; mode text; sha text; execution text; old public.predictive_source_consumers;
  head text; player text; game uuid; m jsonb;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'predictive_recorder','MEMBER') THEN RAISE EXCEPTION 'source-consumer-recorder-not-authorized' USING ERRCODE='42501'; END IF;
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'source-consumer-recorder-isolation-refused' USING ERRCODE='25001'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(520052,1);
  LOCK TABLE public.predictive_source_profiles,public.predictive_rights_decisions,public.predictive_ingestion_runs,public.predictive_artifacts,
    public.predictive_blobs,public.predictive_captures,public.predictive_source_stats_rows,public.predictive_observations,public.predictive_artifact_observations,
    public.predictive_profile_identity_links,public.predictive_decisions,public.predictive_decision_inputs,public.predictive_source_bindings,
    public.predictive_source_stats_revisions,public.predictive_source_decisions IN SHARE MODE;
  t:=date_trunc('milliseconds',pg_catalog.clock_timestamp()); m:=proposed->'manifest';
  profiles:=public.predictive_source_consumer_validate(proposed,t,t);
  mode:=CASE WHEN EXISTS (SELECT 1 FROM public.predictive_source_profiles WHERE id=ANY(profiles) AND purpose='synthetic-test') THEN 'synthetic-proof' ELSE 'production-research' END;
  IF mode='synthetic-proof' AND NOT public.predictive_harness_session() THEN RAISE EXCEPTION 'predictive-synthetic-outside-harness' USING ERRCODE='23514'; END IF;
  player:=CASE WHEN proposed->>'kind'='feature' THEN proposed->'bundle'->'request'->>'playerId' ELSE proposed->>'playerId' END;
  game:=(CASE WHEN proposed->>'kind'='feature' THEN proposed->'bundle'->'request'->>'gameId' ELSE proposed->>'gameId' END)::uuid;
  SELECT * INTO old FROM public.predictive_source_consumers WHERE id=record_id;
  IF old.id IS NOT NULL THEN RAISE EXCEPTION 'source-consumer-id-conflict' USING ERRCODE='23514'; END IF;
  IF proposed->>'kind'='label' THEN
    SELECT id INTO head FROM public.predictive_source_consumers p WHERE p.kind='label' AND p.player_id=player AND p.game_id=game
      AND NOT EXISTS (SELECT 1 FROM public.predictive_source_consumers n WHERE n.predecessor_id=p.id);
    IF head IS DISTINCT FROM expected_head THEN RAISE EXCEPTION 'source-label-head-conflict' USING ERRCODE='23514'; END IF;
  ELSIF expected_head IS NOT NULL THEN RAISE EXCEPTION 'source-feature-predecessor-refused' USING ERRCODE='23514'; END IF;
  rights:=coalesce((SELECT jsonb_agg(r ORDER BY r COLLATE "C") FROM (SELECT DISTINCT public.predictive_rights_in_force(p,t,t) AS r FROM unnest(profiles) p) approved),'[]');
  sha:=public.predictive_source_digest(proposed);
  IF NOT EXISTS (SELECT 1 FROM public.predictive_blobs WHERE sha256=sha AND storage_ref=sha || '.json' AND media_type='application/json') THEN
    RAISE EXCEPTION 'source-consumer-blob-refused' USING ERRCODE='23514'; END IF;
  execution:=public.predictive_source_digest(jsonb_build_object('bodySha256',sha,'rightsDecisions',rights,'recordedAt',public.predictive_source_time(t)));
  INSERT INTO public.predictive_source_consumers VALUES(record_id,proposed->>'kind',player,game,head,t,(m->>'cutoff')::timestamptz,mode,proposed,sha,execution);
  INSERT INTO public.predictive_source_consumer_bindings SELECT record_id,b.id FROM public.predictive_source_bindings b
    WHERE b.profile_id IN (SELECT jsonb_array_elements_text(m->'profileIds')) AND b.recorded_at<=(m->>'cutoff')::timestamptz;
  INSERT INTO public.predictive_source_consumer_source_decisions SELECT record_id,d.id FROM public.predictive_source_decisions d
    WHERE d.plan->'witness'->'profileIds'=m->'profileIds' AND d.entity_key IN (SELECT x->>'entityKey' FROM jsonb_array_elements(m->'sources') x)
      AND d.recorded_at<=(m->>'cutoff')::timestamptz;
  INSERT INTO public.predictive_source_consumer_observations SELECT record_id,id FROM (
    SELECT jsonb_array_elements_text(m->'observations') AS id
    UNION SELECT x.observation_id FROM public.predictive_source_consumer_source_decisions s JOIN public.predictive_source_decision_inputs x ON x.decision_id=s.decision_id
      WHERE s.consumer_id=record_id) ids;
  INSERT INTO public.predictive_source_consumer_decisions SELECT record_id,jsonb_array_elements_text(m->'decisions');
  INSERT INTO public.predictive_source_consumer_rights SELECT record_id,jsonb_array_elements_text(rights);
  RETURN jsonb_build_object('id',record_id,'kind',proposed->'kind','predecessorId',head,'recordedAt',public.predictive_source_time(t),
    'mode',mode,'body',proposed,'bodySha256',sha,'executionDigest',execution,'rightsDecisions',rights);
END
$$;

CREATE FUNCTION public.predictive_source_consumer_check(record_id text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.predictive_source_consumers; profiles text[]; rights jsonb; expected jsonb; actual jsonb; m jsonb; t timestamptz;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'predictive_replay','MEMBER') THEN RAISE EXCEPTION 'source-consumer-replay-not-authorized' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM public.predictive_source_consumers WHERE id=record_id;
  IF c.id IS NULL THEN RETURN NULL; END IF;
  t:=date_trunc('milliseconds',pg_catalog.clock_timestamp()); m:=c.body->'manifest';
  profiles:=public.predictive_source_consumer_validate(c.body,t,c.recorded_at);
  rights:=coalesce((SELECT jsonb_agg(r ORDER BY r COLLATE "C") FROM (SELECT DISTINCT public.predictive_rights_in_force(p,c.recorded_at,c.recorded_at) AS r
    FROM unnest(profiles) p) x),'[]');
  expected:=jsonb_build_object(
    'bindings',ARRAY(SELECT b.id FROM public.predictive_source_bindings b WHERE b.profile_id IN (SELECT jsonb_array_elements_text(m->'profileIds'))
      AND b.recorded_at<=c.cutoff ORDER BY b.id COLLATE "C"),
    'sourceDecisions',ARRAY(SELECT d.id FROM public.predictive_source_decisions d WHERE d.plan->'witness'->'profileIds'=m->'profileIds'
      AND d.entity_key IN (SELECT x->>'entityKey' FROM jsonb_array_elements(m->'sources') x) AND d.recorded_at<=c.cutoff ORDER BY d.id COLLATE "C"),
    'observations',ARRAY(SELECT DISTINCT id COLLATE "C" FROM (
      SELECT jsonb_array_elements_text(m->'observations') AS id UNION SELECT x.observation_id FROM public.predictive_source_decisions d
      JOIN public.predictive_source_decision_inputs x ON x.decision_id=d.id WHERE d.plan->'witness'->'profileIds'=m->'profileIds'
        AND d.entity_key IN (SELECT x->>'entityKey' FROM jsonb_array_elements(m->'sources') x) AND d.recorded_at<=c.cutoff) x ORDER BY 1),
    'decisions',m->'decisions','rights',rights);
  actual:=jsonb_build_object(
    'bindings',ARRAY(SELECT binding_id FROM public.predictive_source_consumer_bindings WHERE consumer_id=c.id ORDER BY binding_id COLLATE "C"),
    'sourceDecisions',ARRAY(SELECT decision_id FROM public.predictive_source_consumer_source_decisions WHERE consumer_id=c.id ORDER BY decision_id COLLATE "C"),
    'observations',ARRAY(SELECT observation_id FROM public.predictive_source_consumer_observations WHERE consumer_id=c.id ORDER BY observation_id COLLATE "C"),
    'decisions',ARRAY(SELECT decision_id FROM public.predictive_source_consumer_decisions WHERE consumer_id=c.id ORDER BY decision_id COLLATE "C"),
    'rights',ARRAY(SELECT rights_decision_id FROM public.predictive_source_consumer_rights WHERE consumer_id=c.id ORDER BY rights_decision_id COLLATE "C"));
  IF actual IS DISTINCT FROM expected OR c.body_sha256<>public.predictive_source_digest(c.body)
      OR c.execution_digest<>public.predictive_source_digest(jsonb_build_object('bodySha256',c.body_sha256,'rightsDecisions',rights,'recordedAt',public.predictive_source_time(c.recorded_at))) THEN
    RAISE EXCEPTION 'stored-source-consumer-mismatch' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('id',c.id,'kind',c.kind,'predecessorId',c.predecessor_id,'recordedAt',public.predictive_source_time(c.recorded_at),
    'mode',c.mode,'body',c.body,'bodySha256',c.body_sha256,'executionDigest',c.execution_digest,'rightsDecisions',rights);
END
$$;
REVOKE ALL ON FUNCTION public.predictive_source_consumer_check(text) FROM PUBLIC;
DO $reader_grants$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='predictive_replay') THEN GRANT EXECUTE ON FUNCTION public.predictive_source_consumer_check(text) TO predictive_replay; END IF;
END $reader_grants$;

DO $immutable$
DECLARE rel text;
BEGIN
  FOREACH rel IN ARRAY ARRAY['predictive_source_consumers','predictive_source_consumer_bindings','predictive_source_consumer_source_decisions',
    'predictive_source_consumer_observations','predictive_source_consumer_decisions','predictive_source_consumer_rights'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only()',rel || '_immutable',rel);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only()',rel || '_no_truncate',rel);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',rel);
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='predictive_replay') THEN EXECUTE format('GRANT SELECT ON public.%I TO predictive_replay',rel); END IF;
  END LOOP;
END
$immutable$;
REVOKE ALL ON FUNCTION public.predictive_source_consumer_profiles(jsonb),public.predictive_source_consumer_access_at(jsonb,timestamptz),
  public.predictive_source_consumer_access(jsonb),public.predictive_source_consumer_input_at(jsonb,jsonb,text,timestamptz),
  public.predictive_source_consumer_validate(jsonb,timestamptz,timestamptz),public.predictive_record_source_consumer(text,text,jsonb) FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='predictive_replay') THEN GRANT EXECUTE ON FUNCTION public.predictive_source_consumer_access(jsonb) TO predictive_replay; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='predictive_recorder') THEN GRANT EXECUTE ON FUNCTION public.predictive_source_consumer_access(jsonb),public.predictive_record_source_consumer(text,text,jsonb) TO predictive_recorder; END IF;
END
$grants$;

ALTER TABLE public.predictive_retention_tombstones DROP CONSTRAINT predictive_retention_tombstones_target_kind_check;
ALTER TABLE public.predictive_retention_tombstones ADD CONSTRAINT predictive_retention_tombstones_target_kind_check
 CHECK(target_kind IN ('observation','artifact','capture','decision','label','feature-run','pin','blob','source-stats-row','source-binding','source-stats-revision','source-decision','source-consumer'));
CREATE OR REPLACE FUNCTION public.predictive_retention_execute(event_id text, event_reason text, event_authority text, event_decided_at timestamptz,
  event_scope jsonb, event_audit_level text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
      OR (event_scope->>'kind'='feature-run-expiry' AND c.kind='feature' AND c.recorded_at+interval '90 days'<=as_of)
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
$$;
