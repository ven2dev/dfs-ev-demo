-- Binding-aware research decisions. Released observation-only decisions remain
-- immutable and cannot cite these rows. Feature/label activation stays gated
-- until their recorders, readers and retention adopt the same source contract.
CREATE TABLE public.predictive_source_decisions (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256 AND length(btrim(id))>0 AND id !~ '[[:cntrl:]|]'),
  kind text NOT NULL CHECK (kind IN ('reconciliation','participation')),
  entity_key text NOT NULL,
  scope_digest text NOT NULL CHECK (scope_digest ~ '^[a-f0-9]{64}$'),
  predecessor_id text,
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
  cutoff timestamptz NOT NULL CHECK (isfinite(cutoff) AND cutoff<=recorded_at),
  plan jsonb NOT NULL,
  UNIQUE (id,kind,entity_key,scope_digest),
  FOREIGN KEY (predecessor_id,kind,entity_key,scope_digest) REFERENCES public.predictive_source_decisions(id,kind,entity_key,scope_digest) DEFERRABLE INITIALLY DEFERRED,
  CHECK (predecessor_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX predictive_source_decisions_root ON public.predictive_source_decisions(kind,entity_key,scope_digest) WHERE predecessor_id IS NULL;
CREATE UNIQUE INDEX predictive_source_decisions_successor ON public.predictive_source_decisions(predecessor_id) WHERE predecessor_id IS NOT NULL;
CREATE INDEX predictive_source_decisions_scope ON public.predictive_source_decisions(kind,entity_key,scope_digest,recorded_at);
CREATE TABLE public.predictive_source_decision_bindings (
  decision_id text NOT NULL REFERENCES public.predictive_source_decisions(id),
  binding_id text NOT NULL REFERENCES public.predictive_source_bindings(id), PRIMARY KEY (decision_id,binding_id)
);
CREATE INDEX predictive_source_decision_bindings_reverse ON public.predictive_source_decision_bindings(binding_id,decision_id);
CREATE TABLE public.predictive_source_decision_inputs (
  decision_id text NOT NULL REFERENCES public.predictive_source_decisions(id),
  observation_id text NOT NULL REFERENCES public.predictive_observations(id), PRIMARY KEY (decision_id,observation_id)
);
CREATE INDEX predictive_source_decision_inputs_reverse ON public.predictive_source_decision_inputs(observation_id,decision_id);
CREATE TABLE public.predictive_source_decision_rights (
  decision_id text NOT NULL REFERENCES public.predictive_source_decisions(id),
  rights_decision_id text NOT NULL REFERENCES public.predictive_rights_decisions(id), PRIMARY KEY (decision_id,rights_decision_id)
);

CREATE FUNCTION public.predictive_source_decision_plan_at(req jsonb, rights_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE witness jsonb; inputs jsonb:='[]'; selected jsonb; outcome jsonb; fields jsonb; ids text[]:='{}'; profiles text[];
  t timestamptz; prefix text; state text:='evaluated'; mode text; n integer; same boolean; chosen text;
  claims text[]; conflict boolean; positive boolean;
BEGIN
  IF public.predictive_source_exact(req,ARRAY['kind','profileIds','entityKey','cutoff']) IS NOT TRUE
      OR req->>'kind' IS NULL OR req->>'kind' NOT IN ('reconciliation','participation')
      OR (req->>'kind'='participation' AND (req->>'entityKey') NOT LIKE 'player-game-stats:%') THEN
    RAISE EXCEPTION 'source-decision-request-refused' USING ERRCODE='23514'; END IF;
  witness:=public.predictive_source_witness_at(jsonb_build_object('profileIds',req->'profileIds',
    'entityKeys',jsonb_build_array(req->'entityKey'),'cutoff',req->'cutoff'),rights_time);
  IF witness->>'reason' IS NOT NULL THEN RAISE EXCEPTION 'source-decision-access-refused' USING ERRCODE='23514'; END IF;
  t:=(req->>'cutoff')::timestamptz;
  IF req->>'kind'='participation' THEN
    prefix:='participation-evidence:' || substr(req->>'entityKey',length('player-game-stats:')+1) || ':';
    SELECT coalesce(array_agg(o.id ORDER BY o.id COLLATE "C"),'{}') INTO ids FROM public.predictive_observations o
      WHERE o.entity_key LIKE prefix || '%' AND public.predictive_observation_usable(o.id,t)
        AND NOT EXISTS (SELECT 1 FROM public.predictive_observations next WHERE next.predecessor_id=o.id AND public.predictive_observation_usable(next.id,t));
    IF cardinality(ids)>256 THEN RAISE EXCEPTION 'source-decision-native-bounds-refused' USING ERRCODE='23514'; END IF;
    IF EXISTS (SELECT 1 FROM public.predictive_observations o WHERE o.id=ANY(ids)
        AND public.predictive_rights_allow(o.profile_id,rights_time,rights_time,'internal-research') IS NOT TRUE) THEN
      RAISE EXCEPTION 'source-decision-access-refused' USING ERRCODE='23514'; END IF;
    SELECT coalesce(jsonb_agg(x ORDER BY x->>'observationId' COLLATE "C"),'[]') INTO inputs
      FROM jsonb_array_elements(public.predictive_source_dependencies(ids,'participation-evidence',t)) x;
  END IF;
  -- Include historical normalization context, not just the numerical head.
  profiles:=ARRAY(SELECT DISTINCT p COLLATE "C" FROM (
    SELECT jsonb_array_elements_text(req->'profileIds') AS p
    UNION SELECT x->>'profileId' FROM public.predictive_source_bindings b CROSS JOIN LATERAL jsonb_array_elements(b.plan->'binding'->'dependencies') x
      WHERE b.profile_id IN (SELECT jsonb_array_elements_text(req->'profileIds')) AND b.recorded_at<=t
    UNION SELECT o.profile_id FROM public.predictive_observations o WHERE o.id=ANY(ids)) scoped ORDER BY 1);
  mode:=CASE WHEN EXISTS (SELECT 1 FROM public.predictive_source_profiles p WHERE p.id=ANY(profiles) AND p.purpose='synthetic-test')
    THEN 'synthetic-proof' ELSE 'production-research' END;
  IF witness->'withheld'<>'[]'::jsonb THEN state:='withheld';
  ELSIF req->>'kind'='reconciliation' THEN
    SELECT count(*),count(DISTINCT r.data)<=1 INTO n,same FROM jsonb_array_elements(witness->'heads') h
      JOIN public.predictive_source_stats_revisions r ON r.id=h->>'revisionId';
    IF n=1 OR (n>1 AND same) THEN
      SELECT h INTO selected FROM jsonb_array_elements(witness->'heads') h
        JOIN public.predictive_source_stats_revisions r ON r.id=h->>'revisionId' ORDER BY r.source_key COLLATE "C" LIMIT 1;
      chosen:=selected->>'revisionId'; END IF;
    outcome:=jsonb_build_object('result',CASE WHEN n=0 THEN 'insufficient-sources' WHEN chosen IS NOT NULL THEN 'selected' ELSE 'conflict' END,
      'selectedObservationId',chosen,'rule',CASE WHEN n=0 THEN 'no-candidates' WHEN n=1 THEN 'single-source' WHEN same THEN 'sources-agree' ELSE 'material-discrepancy' END);
  ELSE
    SELECT coalesce(bool_or(grouped.n>1 OR grouped.absent),false) INTO conflict FROM (
      SELECT split_part(o.entity_key,':',4),count(*) AS n,bool_or(o.kind='source-row-absent') AS absent
      FROM public.predictive_observations o WHERE o.id=ANY(ids) GROUP BY 1) grouped;
    SELECT coalesce(array_agg(DISTINCT o.data->>'claim'),'{}') INTO claims FROM public.predictive_observations o WHERE o.id=ANY(ids) AND o.kind='participation-evidence';
    SELECT count(*)>0 AND coalesce(bool_and(coalesce((r.data->>'attempts')::integer,0)>0 OR coalesce((r.data->>'carries')::integer,0)>0
      OR coalesce((r.data->>'targets')::integer,0)>0),false) INTO positive FROM jsonb_array_elements(witness->'heads') h
      JOIN public.predictive_source_stats_revisions r ON r.id=h->>'revisionId';
    IF positive AND NOT 'offensive-participant'=ANY(claims) THEN claims:=array_append(claims,'offensive-participant'); END IF;
    outcome:=jsonb_build_object('state',CASE WHEN conflict OR cardinality(claims)>1 THEN 'conflicting'
      WHEN cardinality(claims)=1 THEN claims[1] ELSE 'unresolved' END);
  END IF;
  fields:=jsonb_build_object('version','source-decision-plan-v1','kind',req->'kind','entityKey',req->'entityKey',
    'policyId',CASE WHEN req->>'kind'='participation' THEN 'participation-v1' ELSE 'reconciliation-v1' END,'mode',mode,
    'witness',witness,'nativeInputs',inputs,'state',state,'outcome',outcome,'selected',selected);
  RETURN fields || jsonb_build_object('planDigest',public.predictive_source_digest(fields));
END
$$;
CREATE FUNCTION public.predictive_source_decision_basis(plan jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT ($1-'planDigest'-'witness') || jsonb_build_object('witness',($1->'witness')-'cutoff') $$;

CREATE FUNCTION public.predictive_source_decision_plan(req jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT (pg_catalog.pg_has_role(session_user,'predictive_replay','MEMBER') OR pg_catalog.pg_has_role(session_user,'predictive_recorder','MEMBER')) THEN
    RAISE EXCEPTION 'source-decision-not-authorized' USING ERRCODE='42501'; END IF;
  RETURN public.predictive_source_decision_plan_at(req,date_trunc('milliseconds',pg_catalog.clock_timestamp()));
END
$$;
CREATE FUNCTION public.predictive_record_source_decision(decision_id text,expected_head text,proposed jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE req jsonb; t timestamptz; expected jsonb; current_plan jsonb; old public.predictive_source_decisions; head public.predictive_source_decisions;
  scope text; profiles text[];
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'predictive_recorder','MEMBER') THEN
    RAISE EXCEPTION 'source-decision-recorder-not-authorized' USING ERRCODE='42501'; END IF;
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'source-decision-recorder-isolation-refused' USING ERRCODE='25001'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(520052,1);
  LOCK TABLE public.predictive_source_profiles,public.predictive_rights_decisions,public.predictive_ingestion_runs,
    public.predictive_artifacts,public.predictive_blobs,public.predictive_captures,public.predictive_source_stats_rows,
    public.predictive_observations,public.predictive_artifact_observations,public.predictive_profile_identity_links,
    public.predictive_decisions,public.predictive_decision_inputs,public.predictive_source_bindings,public.predictive_source_stats_revisions IN SHARE MODE;
  t:=date_trunc('milliseconds',pg_catalog.clock_timestamp());
  req:=jsonb_build_object('kind',proposed->'kind','entityKey',proposed->'entityKey',
    'profileIds',proposed->'witness'->'profileIds','cutoff',proposed->'witness'->'cutoff');
  expected:=public.predictive_source_decision_plan_at(req,t);
  IF proposed IS DISTINCT FROM expected THEN RAISE EXCEPTION 'source-decision-plan-invalid' USING ERRCODE='23514'; END IF;
  IF proposed->>'mode'='synthetic-proof' AND NOT public.predictive_harness_session() THEN
    RAISE EXCEPTION 'predictive-synthetic-outside-harness' USING ERRCODE='23514'; END IF;
  SELECT * INTO old FROM public.predictive_source_decisions WHERE id=decision_id;
  IF old.id IS NOT NULL THEN
    IF old.plan IS DISTINCT FROM proposed OR old.predecessor_id IS DISTINCT FROM expected_head THEN
      RAISE EXCEPTION 'source-decision-id-conflict' USING ERRCODE='23514'; END IF;
    RETURN jsonb_build_object('id',old.id,'predecessorId',old.predecessor_id,'recordedAt',public.predictive_source_time(old.recorded_at),'plan',old.plan,'reused',true);
  END IF;
  current_plan:=public.predictive_source_decision_plan_at(jsonb_set(req,'{cutoff}',to_jsonb(public.predictive_source_time(t))),t);
  IF public.predictive_source_decision_basis(proposed) IS DISTINCT FROM public.predictive_source_decision_basis(current_plan) THEN
    RAISE EXCEPTION 'source-decision-plan-stale' USING ERRCODE='23514'; END IF;
  scope:=public.predictive_source_digest(req->'profileIds');
  SELECT d.* INTO head FROM public.predictive_source_decisions d WHERE d.kind=req->>'kind' AND d.entity_key=req->>'entityKey' AND d.scope_digest=scope
    AND NOT EXISTS (SELECT 1 FROM public.predictive_source_decisions next WHERE next.predecessor_id=d.id);
  IF head.id IS DISTINCT FROM expected_head THEN RAISE EXCEPTION 'source-decision-head-conflict' USING ERRCODE='23514'; END IF;
  IF head.cutoff>(req->>'cutoff')::timestamptz OR head.recorded_at>t THEN
    RAISE EXCEPTION 'source-decision-cutoff-order-refused' USING ERRCODE='23514'; END IF;
  INSERT INTO public.predictive_source_decisions(id,kind,entity_key,scope_digest,predecessor_id,recorded_at,cutoff,plan)
    VALUES(decision_id,req->>'kind',req->>'entityKey',scope,head.id,t,(req->>'cutoff')::timestamptz,proposed);
  -- All visible history is required to reproduce the witness and to establish
  -- access before bytes. Citing only selected heads would lose that closure.
  INSERT INTO public.predictive_source_decision_bindings SELECT decision_id,b.id FROM public.predictive_source_bindings b
    WHERE b.profile_id IN (SELECT jsonb_array_elements_text(req->'profileIds')) AND b.recorded_at<=(req->>'cutoff')::timestamptz;
  INSERT INTO public.predictive_source_decision_inputs SELECT decision_id,x->>'observationId' FROM jsonb_array_elements(proposed->'nativeInputs') x;
  profiles:=ARRAY(SELECT DISTINCT p FROM (
    SELECT jsonb_array_elements_text(req->'profileIds') AS p
    UNION SELECT x->>'profileId' FROM public.predictive_source_bindings b CROSS JOIN LATERAL jsonb_array_elements(b.plan->'binding'->'dependencies') x
      WHERE b.profile_id IN (SELECT jsonb_array_elements_text(req->'profileIds')) AND b.recorded_at<=(req->>'cutoff')::timestamptz
    UNION SELECT x->>'profileId' FROM jsonb_array_elements(proposed->'nativeInputs') x) scoped);
  INSERT INTO public.predictive_source_decision_rights SELECT decision_id,public.predictive_rights_in_force(p,t,t) FROM unnest(profiles) p;
  RETURN jsonb_build_object('id',decision_id,'predecessorId',head.id,'recordedAt',public.predictive_source_time(t),'plan',proposed,'reused',false);
END
$$;

DO $immutable$
DECLARE rel text;
BEGIN
  FOREACH rel IN ARRAY ARRAY['predictive_source_decisions','predictive_source_decision_bindings','predictive_source_decision_inputs','predictive_source_decision_rights'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only()',rel || '_immutable',rel);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only()',rel || '_no_truncate',rel);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',rel);
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='predictive_replay') THEN EXECUTE format('GRANT SELECT ON public.%I TO predictive_replay',rel); END IF;
  END LOOP;
END
$immutable$;
REVOKE ALL ON FUNCTION public.predictive_source_decision_plan_at(jsonb,timestamptz),public.predictive_source_decision_basis(jsonb),
  public.predictive_source_decision_plan(jsonb),public.predictive_record_source_decision(text,text,jsonb) FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='predictive_replay') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_source_decision_plan(jsonb) TO predictive_replay; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='predictive_recorder') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_source_decision_plan(jsonb),public.predictive_record_source_decision(text,text,jsonb) TO predictive_recorder; END IF;
END
$grants$;

-- Retention extends its audit and removes every decision descendant. Empty
-- additions preserve the released legacy counts/digest on backup re-apply.
ALTER TABLE public.predictive_retention_tombstones DROP CONSTRAINT predictive_retention_tombstones_target_kind_check;
ALTER TABLE public.predictive_retention_tombstones ADD CONSTRAINT predictive_retention_tombstones_target_kind_check
  CHECK (target_kind IN ('observation','artifact','capture','decision','label','feature-run','pin','blob','source-stats-row','source-binding','source-stats-revision','source-decision'));
CREATE OR REPLACE FUNCTION public.predictive_retention_execute(event_id text, event_reason text, event_authority text, event_decided_at timestamptz,
  event_scope jsonb, event_audit_level text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  profiles text[]; captured_from timestamptz; captured_before timestamptz; as_of timestamptz;
  arts text[] := '{}'; caps text[] := '{}'; obs text[] := '{}'; decs text[] := '{}'; labs text[] := '{}';
  runs text[] := '{}'; pins text[] := '{}'; blobs text[] := '{}'; refs text[]; source_rows text[] := '{}'; bindings text[] := '{}'; revisions text[] := '{}'; binding_links integer; source_decs text[] := '{}'; source_decision_links integer;
  removed_kinds text[]; removed_ids text[]; counts jsonb; ids_digest text; links integer; inputs integer; dependencies integer; unpins integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'predictive_retention_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'predictive-retention-not-authorized' USING ERRCODE = '42501';
  END IF;
  IF event_decided_at IS NULL OR event_decided_at > pg_catalog.now() OR NOT public.predictive_retention_scope_valid(event_reason, event_scope) THEN
    RAISE EXCEPTION 'predictive-retention-invalid' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(520052,1);
  LOCK TABLE public.predictive_source_bindings,public.predictive_source_stats_revisions,public.predictive_source_decisions IN SHARE ROW EXCLUSIVE MODE;
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
      UNION ALL SELECT 'source-binding', v FROM unnest(bindings) v UNION ALL SELECT 'source-stats-revision', v FROM unnest(revisions) v
      UNION ALL SELECT 'source-decision', v FROM unnest(source_decs) v) t(k, v);
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
  INSERT INTO public.predictive_retention_events (id,reason,authority,decided_at,scope_descriptor,audit_level,removed_counts,removed_ids_digest,executed_at)
    VALUES (event_id, event_reason, event_authority, event_decided_at, event_scope, event_audit_level, counts, ids_digest, pg_catalog.now());
  INSERT INTO public.predictive_retention_authorizations (txid, retention_event_id) VALUES (pg_catalog.pg_current_xact_id(), event_id);
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
