-- Share successful reconstruction within guarded training transactions.
-- Existing source evidence, clocks, association checks and finality stay intact.
-- No caller certificates/GUCs are trusted. Only owner-created transaction-local
-- state under the complete evidence guard can reuse successful reconstruction.
CREATE FUNCTION public.predictive_training_memo_ready() RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE names text[]:=ARRAY[
  'predictive_artifact_observations','predictive_artifacts','predictive_blobs','predictive_captures',
  'predictive_decision_inputs','predictive_decisions','predictive_games','predictive_ingestion_runs',
  'predictive_observations','predictive_profile_identity_links','predictive_retention_events',
  'predictive_rights_decisions','predictive_run_rights','predictive_source_profiles',
  'predictive_source_binding_captures','predictive_source_binding_decisions','predictive_source_binding_dependencies',
  'predictive_source_binding_links','predictive_source_binding_rights','predictive_source_binding_rows',
  'predictive_source_bindings','predictive_source_stats_revisions','predictive_source_stats_rows',
  'predictive_source_consumer_bindings','predictive_source_consumer_decisions','predictive_source_consumer_observations',
  'predictive_source_consumer_rights','predictive_source_consumer_source_decisions','predictive_source_consumers',
  'predictive_source_decision_bindings','predictive_source_decision_inputs','predictive_source_decision_rights',
  'predictive_source_decisions','predictive_teams','predictive_compressed_inspections','predictive_compressed_publications'];
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
END $$;

CREATE FUNCTION public.predictive_training_memo_get(kind_name text,input_key jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT public.predictive_training_memo_ready() THEN RETURN NULL; END IF;
  RETURN (SELECT value FROM pg_temp.predictive_training_memo WHERE kind=kind_name
    AND key_sha256=public.predictive_source_digest(input_key) AND key=input_key);
END $$;
CREATE FUNCTION public.predictive_training_memo_put(kind_name text,input_key jsonb,result jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE sha text; size integer; counters jsonb;
BEGIN
  IF NOT public.predictive_training_memo_ready() THEN RETURN; END IF;
  sha:=public.predictive_source_digest(input_key);
  IF EXISTS(SELECT 1 FROM pg_temp.predictive_training_memo WHERE kind=kind_name AND key_sha256=sha) THEN RETURN; END IF;
  -- A performance hint has a finite memory envelope. Beyond it the unchanged
  -- checker runs normally; correctness never depends on a successful insert.
  size:=octet_length(input_key::text)+octet_length(result::text);
  SELECT value INTO STRICT counters FROM pg_temp.predictive_training_memo WHERE kind='state' AND key_sha256='state';
  IF (counters->>0)::integer<4096 AND (counters->>1)::integer+size<=64000000 THEN
    INSERT INTO pg_temp.predictive_training_memo VALUES(kind_name,sha,input_key,result);
    UPDATE pg_temp.predictive_training_memo SET value=jsonb_build_array((counters->>0)::integer+1,(counters->>1)::integer+size)
      WHERE kind='state' AND key_sha256='state';
  END IF;
END $$;

-- These kernels depend on the access clock only through in-force rights and
-- cutoff<=clock. Every decided/effective/expiry boundary starts a new epoch.
-- The epoch covers ALL profiles, including newly reconstructed/rival context.
-- Guarded rights rows cannot change; scheduled expiry can and must miss cache.
CREATE FUNCTION public.predictive_training_rights_epoch(t timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT jsonb_build_object('boundary',max(x.t)) FROM public.predictive_rights_decisions d
    CROSS JOIN LATERAL (VALUES(d.decided_at),(d.effective_from),(d.effective_to)) x(t) WHERE x.t<=$1
$$;

ALTER FUNCTION public.predictive_source_plan_v2(jsonb,timestamptz) RENAME TO predictive_source_plan_v2_unmemoized;
CREATE FUNCTION public.predictive_source_plan_v2(req jsonb,rights_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE k jsonb; result jsonb;
BEGIN
  IF rights_time IS NULL OR NOT isfinite(rights_time) OR public.predictive_instant(req->>'cutoff') IS NOT TRUE
      OR (req->>'cutoff')::timestamptz>rights_time THEN RETURN public.predictive_source_plan_v2_unmemoized(req,rights_time); END IF;
  k:=jsonb_build_array(req,public.predictive_training_rights_epoch(rights_time));
  result:=public.predictive_training_memo_get('plan-v2-dispatch',k);
  IF result IS NOT NULL THEN RETURN result; END IF;
  result:=public.predictive_source_plan_v2_unmemoized(req,rights_time);
  PERFORM public.predictive_training_memo_put('plan-v2-dispatch',k,result); RETURN result;
END $$;
ALTER FUNCTION public.predictive_source_plan_v3(jsonb,timestamptz) RENAME TO predictive_source_plan_v3_unmemoized;
CREATE FUNCTION public.predictive_source_plan_v3(req jsonb,rights_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE k jsonb; result jsonb;
BEGIN
  IF rights_time IS NULL OR NOT isfinite(rights_time) OR public.predictive_instant(req->>'cutoff') IS NOT TRUE
      OR (req->>'cutoff')::timestamptz>rights_time THEN RETURN public.predictive_source_plan_v3_unmemoized(req,rights_time); END IF;
  k:=jsonb_build_array(req,public.predictive_training_rights_epoch(rights_time));
  result:=public.predictive_training_memo_get('plan-v3',k);
  IF result IS NOT NULL THEN RETURN result; END IF;
  result:=public.predictive_source_plan_v3_unmemoized(req,rights_time);
  PERFORM public.predictive_training_memo_put('plan-v3',k,result); RETURN result;
END $$;

ALTER FUNCTION public.predictive_source_plan_check(jsonb,timestamptz,boolean) RENAME TO predictive_source_plan_check_unmemoized;
CREATE FUNCTION public.predictive_source_plan_check(proposed jsonb,rights_time timestamptz,require_current boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE k jsonb;
BEGIN
  -- Current checks generate a new knowledge cutoff; never collapse those.
  k:=jsonb_build_array(proposed,to_jsonb(rights_time));
  IF require_current IS FALSE AND public.predictive_training_memo_get('historical-plan-check',k) IS NOT NULL THEN RETURN; END IF;
  PERFORM public.predictive_source_plan_check_unmemoized(proposed,rights_time,require_current);
  IF require_current IS FALSE THEN PERFORM public.predictive_training_memo_put('historical-plan-check',k,'true'); END IF;
END $$;

ALTER FUNCTION public.predictive_source_witness_at(jsonb,timestamptz) RENAME TO predictive_source_witness_at_unmemoized;
CREATE FUNCTION public.predictive_source_witness_at(req jsonb,rights_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE k jsonb; result jsonb;
BEGIN
  IF rights_time IS NULL OR NOT isfinite(rights_time) OR public.predictive_instant(req->>'cutoff') IS NOT TRUE
      OR (req->>'cutoff')::timestamptz>rights_time THEN RETURN public.predictive_source_witness_at_unmemoized(req,rights_time); END IF;
  k:=jsonb_build_array(req,public.predictive_training_rights_epoch(rights_time));
  result:=public.predictive_training_memo_get('witness',k);
  IF result IS NOT NULL THEN RETURN result; END IF;
  result:=public.predictive_source_witness_at_unmemoized(req,rights_time);
  PERFORM public.predictive_training_memo_put('witness',k,result); RETURN result;
END $$;

ALTER FUNCTION public.predictive_source_consumer_check(text) RENAME TO predictive_source_consumer_check_unmemoized;
CREATE FUNCTION public.predictive_source_consumer_check(record_id text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t timestamptz; k jsonb; result jsonb; m jsonb;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_replay','MEMBER') THEN RAISE EXCEPTION 'source-consumer-replay-not-authorized' USING ERRCODE='42501'; END IF;
  t:=date_trunc('milliseconds',clock_timestamp());
  k:=jsonb_build_array(record_id,public.predictive_training_rights_epoch(t));
  result:=public.predictive_training_memo_get('consumer',k);
  IF result IS NOT NULL THEN
    -- Always reauthorize the complete reconstructed context at the fresh
    -- database clock. App gates still run before each file and delivery.
    m:=result->'body'->'manifest';
    PERFORM public.predictive_source_consumer_access_at(jsonb_build_object('profileIds',m->'profileIds','cutoff',m->'cutoff',
      'observations',m->'observations','entityKeys',coalesce((SELECT jsonb_agg(x->'entityKey' ORDER BY x->>'entityKey' COLLATE "C")
        FROM jsonb_array_elements(m->'sources') x),'[]'),'use',m->'use'),t);
    RETURN result;
  END IF;
  result:=public.predictive_source_consumer_check_unmemoized(record_id);
  IF result IS NOT NULL THEN PERFORM public.predictive_training_memo_put('consumer',k,result); END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.predictive_training_memo_ready(),public.predictive_training_memo_get(text,jsonb),
  public.predictive_training_memo_put(text,jsonb,jsonb),public.predictive_training_rights_epoch(timestamptz),
  public.predictive_source_plan_v2(jsonb,timestamptz),public.predictive_source_plan_v3(jsonb,timestamptz),
  public.predictive_source_plan_check(jsonb,timestamptz,boolean),public.predictive_source_witness_at(jsonb,timestamptz),
  public.predictive_source_consumer_check(text),public.predictive_source_consumer_check_unmemoized(text) FROM PUBLIC;
DO $reader_grants$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='predictive_replay') THEN
    REVOKE ALL ON FUNCTION public.predictive_source_consumer_check_unmemoized(text) FROM predictive_replay;
    GRANT EXECUTE ON FUNCTION public.predictive_source_consumer_check(text) TO predictive_replay;
  END IF;
END $reader_grants$;
