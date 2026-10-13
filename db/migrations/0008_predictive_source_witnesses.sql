-- One binding-aware evidence contract for downstream research consumers.
-- Revisions alone are not heads: an unchanged recapture can reuse a revision,
-- and a raw lineage can move to an unrecorded canonical destination. Discover
-- every recorded raw chain in the explicit profiles BEFORE applying the entity
-- filter. This is recorded-lineage coverage, never a qualified population.
--
-- This kernel proves database metadata, not filesystem bytes. Application reads
-- must still verify the exact CSV/JSON files before using its witness. It does
-- not activate the released feature/decision/label writers or authorize uses
-- other than internal research. Those writers must adopt this same contract in
-- a subsequent forward migration, together with their use-specific rights.
CREATE FUNCTION public.predictive_source_witness_at(req jsonb, rights_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE profiles text[]; entities text[]; t timestamptz; reason text;
  heads jsonb := '[]'; withheld jsonb := '[]'; missing jsonb := '[]'; fields jsonb;
  raw record; event record; head public.predictive_source_bindings; plan jsonb; fact text; lineage text;
  destinations jsonb; routing text; failure text; n integer;
BEGIN
  IF public.predictive_source_exact(req,ARRAY['profileIds','entityKeys','cutoff']) IS NOT TRUE
      OR jsonb_typeof(req->'profileIds') IS DISTINCT FROM 'array' OR jsonb_typeof(req->'entityKeys') IS DISTINCT FROM 'array'
      OR jsonb_array_length(req->'profileIds') NOT BETWEEN 1 AND 16 OR jsonb_array_length(req->'entityKeys')>64
      OR EXISTS (SELECT 1 FROM jsonb_array_elements((req->'profileIds') || (req->'entityKeys')) x WHERE jsonb_typeof(x)<>'string')
      OR public.predictive_instant(req->>'cutoff') IS NOT TRUE OR rights_time IS NULL OR NOT isfinite(rights_time) THEN
    RAISE EXCEPTION 'predictive-source-witness-request-refused' USING ERRCODE='23514'; END IF;
  profiles:=ARRAY(SELECT x FROM jsonb_array_elements_text(req->'profileIds') x);
  entities:=ARRAY(SELECT x FROM jsonb_array_elements_text(req->'entityKeys') x);
  IF profiles IS DISTINCT FROM ARRAY(SELECT DISTINCT x COLLATE "C" FROM unnest(profiles) x ORDER BY 1)
      OR entities IS DISTINCT FROM ARRAY(SELECT DISTINCT x COLLATE "C" FROM unnest(entities) x ORDER BY 1)
      OR EXISTS (SELECT 1 FROM unnest(profiles) x WHERE length(x) NOT BETWEEN 1 AND 256 OR length(btrim(x))=0 OR x ~ '[[:cntrl:]|]')
      OR EXISTS (SELECT 1 FROM unnest(entities) x WHERE x !~ '^(player-game-stats|team-game-stats):[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}:'
        OR CASE split_part(x,':',1) WHEN 'player-game-stats' THEN split_part(x,':',3) !~ '^00-[0-9]{7}$' OR cardinality(string_to_array(x,':'))<>3
          ELSE NOT EXISTS (SELECT 1 FROM public.predictive_teams tm WHERE tm.id=regexp_replace(x,'^[^:]+:[^:]+:','')) END) THEN
    RAISE EXCEPTION 'predictive-source-witness-request-refused' USING ERRCODE='23514'; END IF;
  t:=(req->>'cutoff')::timestamptz;
  IF t>rights_time THEN RAISE EXCEPTION 'source-binding-future-cutoff-refused' USING ERRCODE='23514'; END IF;

  <<evidence>> BEGIN
    IF EXISTS (SELECT 1 FROM unnest(profiles) p WHERE NOT EXISTS (SELECT 1 FROM public.predictive_source_profiles s WHERE s.id=p)) THEN
      reason:='source-profile-missing'; EXIT evidence; END IF;
    IF EXISTS (SELECT 1 FROM public.predictive_source_profiles s WHERE s.id=ANY(profiles) AND
      (s.provider<>'nflverse' OR s.feed NOT IN ('player','team') OR s.parser_version<>'nflverse-csv-qualification-v1'
        OR s.allowlist_version<>'predictive-raw-allowlist-v1')) THEN reason:='source-profile-refused'; EXIT evidence; END IF;
    IF EXISTS (SELECT 1 FROM unnest(profiles) p WHERE public.predictive_rights_allow(p,rights_time,rights_time,'internal-research') IS NOT TRUE) THEN
      reason:='rights-not-in-force'; EXIT evidence; END IF;

    SELECT count(*) INTO n FROM public.predictive_source_bindings b WHERE b.profile_id=ANY(profiles) AND b.recorded_at<=t;
    IF n>8192 OR EXISTS (SELECT 1 FROM public.predictive_source_bindings b WHERE b.profile_id=ANY(profiles) AND b.recorded_at<=t
        GROUP BY b.profile_id,b.raw_key_sha256 HAVING count(*)>256)
      OR (SELECT count(*) FROM (SELECT DISTINCT b.profile_id,b.raw_key_sha256 FROM public.predictive_source_bindings b
        WHERE b.profile_id=ANY(profiles) AND b.recorded_at<=t) x)>256 THEN
      RAISE EXCEPTION 'source-fact-bounds-refused' USING ERRCODE='23514'; END IF;
    -- Check ALL historical context rights before examining plans. A revoked
    -- ancestor cannot be read to argue that its chain is irrelevant to a filter.
    IF EXISTS (SELECT 1 FROM public.predictive_source_bindings b CROSS JOIN LATERAL jsonb_array_elements(b.plan->'binding'->'dependencies') x
        WHERE b.profile_id=ANY(profiles) AND b.recorded_at<=t
          AND public.predictive_rights_allow(x->>'profileId',rights_time,rights_time,'internal-research') IS NOT TRUE) THEN
      reason:='rights-not-in-force'; EXIT evidence; END IF;
    FOR event IN SELECT b.* FROM public.predictive_source_bindings b WHERE b.profile_id=ANY(profiles) AND b.recorded_at<=t LOOP
      PERFORM public.predictive_source_plan_check(event.plan,event.recorded_at,false);
    END LOOP;

    FOR raw IN SELECT b.profile_id,b.raw_key_sha256,(b.plan->'binding'->'sourceRequest')-'cutoff' AS request
      FROM public.predictive_source_bindings b WHERE b.profile_id=ANY(profiles) AND b.recorded_at<=t
      GROUP BY b.profile_id,b.raw_key_sha256,(b.plan->'binding'->'sourceRequest')-'cutoff'
      ORDER BY b.profile_id COLLATE "C",b.raw_key_sha256 COLLATE "C",(b.plan->'binding'->'sourceRequest')-'cutoff' LOOP
      IF raw.profile_id IS DISTINCT FROM raw.request->>'profileId'
          OR raw.raw_key_sha256 IS DISTINCT FROM public.predictive_source_request_key(raw.request || jsonb_build_object('cutoff',req->'cutoff')) THEN
        RAISE EXCEPTION 'stored-source-binding-mismatch' USING ERRCODE='23514'; END IF;
      SELECT b.* INTO STRICT head FROM public.predictive_source_bindings b WHERE b.profile_id=raw.profile_id AND b.raw_key_sha256=raw.raw_key_sha256
        AND b.recorded_at<=t AND NOT EXISTS (SELECT 1 FROM public.predictive_source_bindings next WHERE next.predecessor_id=b.id AND next.recorded_at<=t);
      plan:=public.predictive_source_plan_v2(raw.request || jsonb_build_object('cutoff',req->'cutoff'),rights_time);
      lineage:='source-stats:' || public.predictive_source_digest(jsonb_build_array(raw.profile_id,raw.raw_key_sha256));
      failure:=CASE WHEN public.predictive_source_plan_basis(head.plan) IS DISTINCT FROM public.predictive_source_plan_basis(plan)
        THEN 'source-binding-stale' WHEN head.revision_id IS NULL THEN coalesce(head.plan->>'reason','source-binding-withheld') END;
      IF failure IS NOT NULL THEN
        SELECT coalesce(jsonb_agg(to_jsonb(key) ORDER BY key COLLATE "C"),'[]') INTO destinations FROM (
          SELECT r.entity_key AS key FROM public.predictive_source_bindings b JOIN public.predictive_source_stats_revisions r ON r.id=b.revision_id
            WHERE b.profile_id=raw.profile_id AND b.raw_key_sha256=raw.raw_key_sha256 AND b.recorded_at<=t
          UNION SELECT (plan->'candidate'->>'kind') || ':' || (plan->'candidate'->'data'->>'gameId') || ':' ||
            coalesce(plan->'candidate'->'data'->>'playerId',plan->'candidate'->'data'->>'teamId') WHERE plan->'candidate'<>'null'::jsonb
        ) keys WHERE cardinality(entities)=0 OR key=ANY(entities);
        routing:=CASE WHEN plan->'candidate'='null'::jsonb THEN 'unresolved' ELSE 'known-destinations' END;
        IF routing='unresolved' OR cardinality(entities)=0 OR jsonb_array_length(destinations)>0 THEN
          withheld:=withheld || jsonb_build_array(jsonb_build_object('lineageKey',lineage,'profileId',raw.profile_id,'bindingId',head.id,
            'reason',failure,'routing',routing,'entityKeys',destinations)); END IF;
      ELSE
        SELECT r.entity_key INTO STRICT fact FROM public.predictive_source_stats_revisions r WHERE r.id=head.revision_id;
        IF cardinality(entities)=0 OR fact=ANY(entities) THEN
          heads:=heads || jsonb_build_array(jsonb_build_object('profileId',raw.profile_id,'lineageKey',lineage,'entityKey',fact,
            'bindingId',head.id,'revisionId',head.revision_id,'headToken',public.predictive_source_digest(jsonb_build_object(
              'bindingId',head.id,'revisionId',head.revision_id,'planDigest',head.plan->>'planDigest')))); END IF;
      END IF;
    END LOOP;
    SELECT coalesce(jsonb_agg(x ORDER BY x->>'lineageKey' COLLATE "C"),'[]') INTO heads FROM jsonb_array_elements(heads) x;
    SELECT coalesce(jsonb_agg(x ORDER BY x->>'lineageKey' COLLATE "C"),'[]') INTO withheld FROM jsonb_array_elements(withheld) x;
    SELECT coalesce(jsonb_agg(to_jsonb(key) ORDER BY key COLLATE "C"),'[]') INTO missing FROM unnest(entities) key
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(heads) h WHERE h->>'entityKey'=key)
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(withheld) w WHERE w->>'routing'='unresolved' OR w->'entityKeys' ? key);
  END evidence;
  fields:=jsonb_build_object('version','source-consumer-witness-v1','profileIds',to_jsonb(profiles),'entityKeys',to_jsonb(entities),
    'coverage','recorded-lineages-only','heads',heads,'withheld',withheld,'reason',reason,'missingEntityKeys',missing);
  RETURN fields || jsonb_build_object('cutoff',req->'cutoff','evidenceDigest',public.predictive_source_digest(fields));
END
$$;

-- Private checker for future recorder functions: a rehashed omission is refused
-- against recomputed SQL metadata. Current use additionally requires the exact
-- same bindings now, with no withheld or missing requested entity. Query time
-- alone does not change the evidence digest. Full population is still unproven.
CREATE FUNCTION public.predictive_source_witness_check(proposed jsonb, rights_time timestamptz, require_current boolean) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE req jsonb; expected jsonb; current_witness jsonb;
BEGIN
  IF require_current IS NULL THEN RAISE EXCEPTION 'predictive-source-witness-invalid' USING ERRCODE='23514'; END IF;
  req:=jsonb_build_object('profileIds',proposed->'profileIds','entityKeys',proposed->'entityKeys','cutoff',proposed->'cutoff');
  expected:=public.predictive_source_witness_at(req,rights_time);
  IF proposed IS DISTINCT FROM expected THEN RAISE EXCEPTION 'predictive-source-witness-invalid' USING ERRCODE='23514'; END IF;
  IF require_current THEN
    current_witness:=public.predictive_source_witness_at(jsonb_set(req,'{cutoff}',to_jsonb(public.predictive_source_time(rights_time))),rights_time);
    IF current_witness->>'reason' IS NOT NULL OR current_witness->'withheld'<>'[]'::jsonb
        OR current_witness->'missingEntityKeys'<>'[]'::jsonb OR current_witness->'heads'='[]'::jsonb
        OR proposed->>'evidenceDigest' IS DISTINCT FROM current_witness->>'evidenceDigest' THEN
      RAISE EXCEPTION 'predictive-source-witness-not-current' USING ERRCODE='23514'; END IF;
  END IF;
END
$$;

-- Replay/recorder access uses the database's clock; callers cannot backdate
-- rights. Internal kernels remain unavailable to application roles and PUBLIC.
CREATE FUNCTION public.predictive_source_witness(req jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT (pg_catalog.pg_has_role(session_user,'predictive_replay','MEMBER')
      OR pg_catalog.pg_has_role(session_user,'predictive_recorder','MEMBER')) THEN
    RAISE EXCEPTION 'predictive-source-witness-not-authorized' USING ERRCODE='42501'; END IF;
  RETURN public.predictive_source_witness_at(req,pg_catalog.date_trunc('milliseconds',pg_catalog.clock_timestamp()));
END
$$;
REVOKE ALL ON FUNCTION public.predictive_source_witness_at(jsonb,timestamptz),
  public.predictive_source_witness_check(jsonb,timestamptz,boolean),public.predictive_source_witness(jsonb) FROM PUBLIC;
DO $grants$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['predictive_replay','predictive_recorder'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.predictive_source_witness(jsonb) TO %I',role_name); END IF;
  END LOOP;
END
$grants$;
