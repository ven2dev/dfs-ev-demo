-- DRAFT 0019, reserved for #118. Finalize against #106's frozen 0001-0018.
-- Kept outside the ordered migration chain until that prefix is published.
-- Digest-only refusal history does not certify bytes or authorize fitting.
CREATE TABLE public.predictive_training_invalidation_addresses (
  address_sha256 text PRIMARY KEY CHECK(address_sha256~'^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK(kind IN ('run','dataset')),
  identity_sha256 text NOT NULL CHECK(identity_sha256~'^[a-f0-9]{64}$'),
  body jsonb NOT NULL CHECK(public.predictive_source_exact(body,ARRAY['version','kind','identitySha256','runIdentitySha256','datasetIdentitySha256','inventorySha256','manifestSha256'])),
  registered_at timestamptz NOT NULL CHECK(isfinite(registered_at) AND registered_at=date_trunc('milliseconds',registered_at)),
  UNIQUE(kind,identity_sha256),
  CHECK((body->>'version'='qb-training-invalidation-address-v1' AND body->>'kind'=kind
    AND body->>'identitySha256'=identity_sha256 AND body->>'runIdentitySha256'~'^[a-f0-9]{64}$'
    AND body->>'inventorySha256'~'^[a-f0-9]{64}$' AND public.predictive_source_digest(body)=address_sha256
    AND ((kind='run' AND body->>'runIdentitySha256'=identity_sha256 AND body->'datasetIdentitySha256'='null'::jsonb AND body->'manifestSha256'='null'::jsonb)
      OR (kind='dataset' AND body->>'datasetIdentitySha256'=identity_sha256 AND body->>'manifestSha256'~'^[a-f0-9]{64}$'))) IS TRUE)
);
CREATE TABLE public.predictive_training_invalidations (
  ordinal bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY CHECK(ordinal BETWEEN 1 AND 9007199254740991),
  event_sha256 text NOT NULL UNIQUE CHECK(event_sha256~'^[a-f0-9]{64}$'),
  address_sha256 text NOT NULL REFERENCES public.predictive_training_invalidation_addresses(address_sha256),
  body jsonb NOT NULL CHECK(public.predictive_source_exact(body,ARRAY['version','addressSha256','reason','operation','failureCode','origin','causeSha256'])),
  recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
  CHECK((body->>'version'='qb-training-invalidation-v1' AND body->>'addressSha256'=address_sha256
    AND body->>'reason' IN ('rights-unavailable','evidence-removed','evidence-expired','evidence-integrity-failed','evidence-inaccessible')
    AND body->>'operation' IN ('run-metadata','run-readiness','shard-verify','dataset-prepare','dataset-manifest','dataset-page','dataset-pin','retention')
    AND body->>'origin' IN ('reader-reported','database-confirmed','authorized-retention')
    AND body->>'causeSha256'~'^[a-f0-9]{64}$' AND public.predictive_source_digest(body)=event_sha256) IS TRUE)
);
CREATE INDEX predictive_training_invalidations_address_ordinal ON public.predictive_training_invalidations(address_sha256,ordinal);

-- Minimal addresses survive deletion; no live-evidence FK can obstruct it.
-- Registration is atomic with the original run/manifest, not caller asserted.
CREATE FUNCTION public.predictive_training_invalidation_register(scope text,entity text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.predictive_training_runs; d public.predictive_training_datasets; address_body jsonb; previous jsonb;
BEGIN
  IF scope='run' THEN
    SELECT * INTO STRICT r FROM public.predictive_training_runs WHERE id=entity;
  ELSIF scope='dataset' THEN
    SELECT * INTO STRICT d FROM public.predictive_training_datasets WHERE id=entity;
    SELECT * INTO STRICT r FROM public.predictive_training_runs WHERE id=d.run_id;
  ELSE RAISE EXCEPTION 'training-invalidation-target-refused' USING ERRCODE='23514'; END IF;
  IF public.predictive_source_digest(r.body)<>r.body_sha256 OR (scope='dataset' AND public.predictive_source_digest(d.body)<>d.body_sha256) THEN
    RAISE EXCEPTION 'training-invalidation-registration-integrity-refused' USING ERRCODE='23514'; END IF;
  address_body:=jsonb_build_object('version','qb-training-invalidation-address-v1','kind',scope,
    'identitySha256',public.predictive_source_digest(to_jsonb(entity)),
    'runIdentitySha256',public.predictive_source_digest(to_jsonb(r.id)),
    'datasetIdentitySha256',CASE WHEN scope='dataset' THEN public.predictive_source_digest(to_jsonb(d.id)) END,
    'inventorySha256',r.body_sha256,'manifestSha256',CASE WHEN scope='dataset' THEN d.body_sha256 END);
  SELECT a.body INTO previous FROM public.predictive_training_invalidation_addresses a
    WHERE a.kind=scope AND a.identity_sha256=address_body->>'identitySha256';
  IF previous IS NOT NULL AND previous IS DISTINCT FROM address_body THEN
    RAISE EXCEPTION 'training-invalidation-address-conflict' USING ERRCODE='23514'; END IF;
  INSERT INTO public.predictive_training_invalidation_addresses VALUES(public.predictive_source_digest(address_body),scope,address_body->>'identitySha256',address_body,date_trunc('milliseconds',clock_timestamp()))
    ON CONFLICT(kind,identity_sha256) DO NOTHING;
END
$$;
CREATE FUNCTION public.predictive_training_invalidation_register_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='predictive_training_runs' THEN PERFORM public.predictive_training_invalidation_register('run',NEW.id);
  ELSIF TG_TABLE_NAME='predictive_training_datasets' THEN PERFORM public.predictive_training_invalidation_register('dataset',NEW.id);
  ELSE RAISE EXCEPTION 'training-invalidation-target-refused' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;
DO $backfill$ DECLARE item record; BEGIN
  FOR item IN SELECT id FROM public.predictive_training_runs ORDER BY id COLLATE "C" LOOP
    PERFORM public.predictive_training_invalidation_register('run',item.id);
  END LOOP;
  FOR item IN SELECT id FROM public.predictive_training_datasets ORDER BY id COLLATE "C" LOOP
    PERFORM public.predictive_training_invalidation_register('dataset',item.id);
  END LOOP;
END $backfill$;
CREATE TRIGGER predictive_training_invalidation_register AFTER INSERT ON public.predictive_training_runs
  FOR EACH ROW EXECUTE FUNCTION public.predictive_training_invalidation_register_trigger();
CREATE TRIGGER predictive_training_invalidation_register AFTER INSERT ON public.predictive_training_datasets
  FOR EACH ROW EXECUTE FUNCTION public.predictive_training_invalidation_register_trigger();

CREATE FUNCTION public.predictive_training_invalidation_target(target jsonb) RETURNS public.predictive_training_invalidation_addresses
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.predictive_training_invalidation_addresses;
BEGIN
  IF public.predictive_source_exact(target,ARRAY['kind','id','sha256']) IS NOT TRUE
      OR target->>'kind' IS NULL OR target->>'kind' NOT IN ('run','dataset')
      OR public.predictive_training_identity(target->'id') IS NOT TRUE
      OR (target->'sha256'<>'null'::jsonb AND (jsonb_typeof(target->'sha256') IS DISTINCT FROM 'string' OR target->>'sha256'!~'^[a-f0-9]{64}$')) THEN
    RAISE EXCEPTION 'training-invalidation-target-refused' USING ERRCODE='23514'; END IF;
  SELECT * INTO a FROM public.predictive_training_invalidation_addresses x WHERE x.kind=target->>'kind'
    AND x.identity_sha256=public.predictive_source_digest(target->'id');
  IF a.address_sha256 IS NULL THEN RAISE EXCEPTION 'training-invalidation-target-unknown' USING ERRCODE='23514'; END IF;
  IF target->'sha256'<>'null'::jsonb AND target->>'sha256' IS DISTINCT FROM
      (CASE a.kind WHEN 'run' THEN a.body->>'inventorySha256' ELSE a.body->>'manifestSha256' END) THEN
    RAISE EXCEPTION 'training-invalidation-target-mismatch' USING ERRCODE='23514'; END IF;
  RETURN a;
END
$$;
CREATE FUNCTION public.predictive_training_invalidation_reason(code text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT CASE
    WHEN code IN ('training-run-rights-refused','training-dataset-rights-refused','training-kickoff-rights-refused','source-consumer-rights-refused','predictive-source-plan-rights-profile-invalid') THEN 'rights-unavailable'
    WHEN code IN ('training-run-evidence-removed','training-dataset-evidence-removed') THEN 'evidence-removed'
    WHEN code IN ('training-shard-feature-expired','training-dataset-feature-expired') THEN 'evidence-expired'
    WHEN code IN ('artifact-integrity-failed','stored-observation-mismatch','stored-source-row-mismatch','stored-source-consumer-mismatch','training-shard-evidence-mismatch','training-shard-kickoff-mismatch','training-inventory-integrity-refused','training-dataset-integrity-refused') THEN 'evidence-integrity-failed'
    WHEN code IN ('artifact-file-refused','artifact-root-refused','artifact-reference-refused','artifact-unreadable') THEN 'evidence-inaccessible'
  END
$$;
CREATE FUNCTION public.predictive_training_invalidation_receipt(event public.predictive_training_invalidations) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT event.body || jsonb_build_object('ordinal',event.ordinal,'eventSha256',event.event_sha256,
    'recordedAt',public.predictive_source_time(event.recorded_at),'address',a.body)
  FROM public.predictive_training_invalidation_addresses a WHERE a.address_sha256=event.address_sha256
$$;
ALTER TABLE public.predictive_training_invalidations ADD CONSTRAINT predictive_training_invalidation_failure_contract CHECK((
  (body->>'operation'='retention' AND body->>'origin'='authorized-retention' AND
    ((body->>'failureCode'='retention-evidence-removed' AND body->>'reason'='evidence-removed')
      OR (body->>'failureCode'='retention-evidence-expired' AND body->>'reason'='evidence-expired')))
  OR (body->>'operation'<>'retention' AND body->>'origin' IN ('reader-reported','database-confirmed')
    AND body->>'reason'=public.predictive_training_invalidation_reason(body->>'failureCode'))
) IS TRUE);
CREATE FUNCTION public.predictive_training_invalidation_append(address text,operation text,code text,reason text,origin text,cause text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE body jsonb; hash text; event public.predictive_training_invalidations; reused boolean:=false;
BEGIN
  -- Private helper: only the checked recorder and authorized deletion hooks
  -- call it. Serializing one address makes the quota and dedup atomic.
  PERFORM pg_advisory_xact_lock(520056,hashtext(address));
  body:=jsonb_build_object('version','qb-training-invalidation-v1','addressSha256',address,'operation',operation,
    'failureCode',code,'reason',reason,'origin',origin,'causeSha256',cause);
  hash:=public.predictive_source_digest(body);
  SELECT * INTO event FROM public.predictive_training_invalidations WHERE event_sha256=hash;
  IF event.event_sha256 IS NOT NULL THEN reused:=true;
  ELSE
    IF origin<>'authorized-retention' AND (SELECT count(*) FROM public.predictive_training_invalidations WHERE address_sha256=address)>=256 THEN
      RAISE EXCEPTION 'training-invalidation-quota-refused' USING ERRCODE='23514'; END IF;
    INSERT INTO public.predictive_training_invalidations(event_sha256,address_sha256,body,recorded_at)
      VALUES(hash,address,body,date_trunc('milliseconds',clock_timestamp())) RETURNING * INTO event;
  END IF;
  RETURN public.predictive_training_invalidation_receipt(event) || jsonb_build_object('reused',reused);
END
$$;

CREATE FUNCTION public.predictive_record_training_invalidation(req jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.predictive_training_invalidation_addresses; reason text; code text; uses jsonb:='[]'; origin text:='reader-reported';
  r public.predictive_training_runs; d public.predictive_training_datasets; body jsonb; cause jsonb; t timestamptz;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_replay','MEMBER') THEN RAISE EXCEPTION 'training-invalidation-not-authorized' USING ERRCODE='42501'; END IF;
  IF public.predictive_source_exact(req,ARRAY['version','target','operation','failureCode']) IS NOT TRUE
      OR req->>'version' IS DISTINCT FROM 'qb-training-invalidation-v1'
      OR req->>'operation' IS NULL OR req->>'operation' NOT IN ('run-metadata','run-readiness','shard-verify','dataset-prepare','dataset-manifest','dataset-page','dataset-pin') THEN
    RAISE EXCEPTION 'training-invalidation-request-refused' USING ERRCODE='23514'; END IF;
  code:=req->>'failureCode'; reason:=public.predictive_training_invalidation_reason(code);
  IF reason IS NULL THEN RAISE EXCEPTION 'training-invalidation-request-refused' USING ERRCODE='23514'; END IF;
  PERFORM public.predictive_training_read_guard();
  a:=public.predictive_training_invalidation_target(req->'target'); t:=clock_timestamp();
  IF a.kind='run' THEN
    SELECT * INTO r FROM public.predictive_training_runs WHERE id=req->'target'->>'id'; body:=r.body;
  ELSE
    SELECT * INTO d FROM public.predictive_training_datasets WHERE id=req->'target'->>'id'; body:=d.body;
  END IF;
  IF jsonb_typeof(body->'protectedUses')='array' THEN uses:=body->'protectedUses'; END IF;
  -- A submitted file failure is a diagnostic assertion by the owner reader;
  -- SQL cannot verify private filesystem bytes. Confirm only what SQL sees.
  IF reason='evidence-removed' AND body IS NULL THEN origin:='database-confirmed'; END IF;
  IF reason='evidence-integrity-failed' AND body IS NOT NULL AND public.predictive_source_digest(body) IS DISTINCT FROM
      (CASE a.kind WHEN 'run' THEN a.body->>'inventorySha256' ELSE a.body->>'manifestSha256' END) THEN origin:='database-confirmed'; END IF;
  IF reason='rights-unavailable' AND EXISTS(SELECT 1 FROM jsonb_array_elements(uses) u WHERE
      NOT public.predictive_rights_allow(u->>'profile',t,t,'internal-research') OR NOT public.predictive_rights_allow(u->>'profile',t,t,u->>'use')) THEN
    origin:='database-confirmed'; END IF;
  IF reason='evidence-expired' AND ((a.kind='dataset' AND EXISTS(SELECT 1 FROM public.predictive_training_dataset_consumers x
      JOIN public.predictive_source_consumers c ON c.id=x.consumer_id WHERE x.dataset_id=d.id AND c.kind='feature'
        AND c.recorded_at+interval '90 days'<=t AND NOT public.predictive_training_dataset_active(d.id)))
      OR (a.kind='run' AND EXISTS(SELECT 1 FROM public.predictive_training_run_slots s JOIN public.predictive_source_consumers c
        ON c.id=s.selection->'selection'->>'featureId' WHERE s.run_id=r.id AND s.selection->'feature'->>'state'<>'expired'
          AND c.recorded_at+interval '90 days'<=t AND NOT public.predictive_training_consumer_pinned(c.id,t)))) THEN
    origin:='database-confirmed'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id COLLATE "C"),'[]') INTO cause FROM (
    SELECT rd.id,rd.allowed_uses,public.predictive_source_time(rd.effective_from) AS effective_from,
      public.predictive_source_time(rd.effective_to) AS effective_to,public.predictive_source_time(rd.decided_at) AS decided_at
    FROM public.predictive_rights_decisions rd WHERE rd.profile_id IN (SELECT u->>'profile' FROM jsonb_array_elements(uses) u)) x;
  RETURN public.predictive_training_invalidation_append(a.address_sha256,req->>'operation',code,reason,origin,
    public.predictive_source_digest(jsonb_build_object('rights',cause,'bodyPresent',body IS NOT NULL,
      'observedBodySha256',CASE WHEN body IS NOT NULL THEN public.predictive_source_digest(body) END)));
END
$$;

CREATE FUNCTION public.predictive_training_invalidation_history(req jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.predictive_training_invalidation_addresses; after_id bigint; through_id bigint; maximum bigint; cap integer; entries jsonb; next_id bigint;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_replay','MEMBER') THEN RAISE EXCEPTION 'training-invalidation-not-authorized' USING ERRCODE='42501'; END IF;
  IF public.predictive_source_exact(req,ARRAY['version','target','afterOrdinal','throughOrdinal','limit']) IS NOT TRUE
      OR req->>'version' IS DISTINCT FROM 'qb-training-invalidation-v1' OR public.predictive_integer(req->'limit',1,64) IS NOT TRUE
      OR (req->'afterOrdinal'<>'null'::jsonb AND public.predictive_integer(req->'afterOrdinal',0,9007199254740991) IS NOT TRUE)
      OR (req->'throughOrdinal'<>'null'::jsonb AND public.predictive_integer(req->'throughOrdinal',0,9007199254740991) IS NOT TRUE)
      OR (req->'afterOrdinal'<>'null'::jsonb AND req->'throughOrdinal'='null'::jsonb) THEN
    RAISE EXCEPTION 'training-invalidation-history-request-refused' USING ERRCODE='23514'; END IF;
  a:=public.predictive_training_invalidation_target(req->'target'); cap:=(req->>'limit')::integer;
  SELECT coalesce(max(ordinal),0) INTO maximum FROM public.predictive_training_invalidations WHERE address_sha256=a.address_sha256;
  after_id:=coalesce((req->>'afterOrdinal')::bigint,0); through_id:=coalesce((req->>'throughOrdinal')::bigint,maximum);
  IF after_id>through_id OR through_id>maximum OR (after_id>0 AND NOT EXISTS(SELECT 1 FROM public.predictive_training_invalidations
      WHERE address_sha256=a.address_sha256 AND ordinal=after_id)) THEN
    RAISE EXCEPTION 'training-invalidation-history-request-refused' USING ERRCODE='23514'; END IF;
  SELECT coalesce(jsonb_agg(public.predictive_training_invalidation_receipt(e) ORDER BY e.ordinal),'[]'),max(e.ordinal) INTO entries,next_id
    FROM (SELECT * FROM public.predictive_training_invalidations WHERE address_sha256=a.address_sha256 AND ordinal>after_id AND ordinal<=through_id
      ORDER BY ordinal LIMIT cap) e;
  IF NOT EXISTS(SELECT 1 FROM public.predictive_training_invalidations WHERE address_sha256=a.address_sha256 AND ordinal>coalesce(next_id,through_id) AND ordinal<=through_id) THEN next_id:=NULL; END IF;
  RETURN jsonb_build_object('version','qb-training-invalidation-v1','addressSha256',a.address_sha256,'throughOrdinal',through_id,'entries',entries,'nextAfterOrdinal',next_id);
END
$$;

-- Independent deletion hook: no retention-procedure copy or changed legacy
-- count/digest. Audit commits/rolls back with the authorized removal itself.
CREATE FUNCTION public.predictive_training_invalidation_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE event public.predictive_retention_events; address text; parent text; removal_kind text; reason text; code text; cause text;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_retention_owner','MEMBER') THEN RAISE EXCEPTION 'training-retention-not-authorized' USING ERRCODE='42501'; END IF;
  SELECT e.* INTO STRICT event FROM public.predictive_retention_authorizations x JOIN public.predictive_retention_events e ON e.id=x.retention_event_id
    WHERE x.txid=pg_current_xact_id();
  removal_kind:=CASE TG_TABLE_NAME WHEN 'predictive_training_runs' THEN 'run' WHEN 'predictive_training_datasets' THEN 'dataset' END;
  IF removal_kind IS NULL THEN RAISE EXCEPTION 'training-invalidation-target-refused' USING ERRCODE='23514'; END IF;
  SELECT address_sha256 INTO STRICT address FROM public.predictive_training_invalidation_addresses a WHERE a.kind=removal_kind AND a.identity_sha256=public.predictive_source_digest(to_jsonb(OLD.id));
  reason:=CASE event.scope_descriptor->>'kind' WHEN 'feature-run-expiry' THEN 'evidence-expired' ELSE 'evidence-removed' END;
  code:=CASE reason WHEN 'evidence-expired' THEN 'retention-evidence-expired' ELSE 'retention-evidence-removed' END;
  cause:=public.predictive_source_digest(jsonb_build_object('eventSha256',public.predictive_source_digest(to_jsonb(event.id)),
    'scopeSha256',public.predictive_source_digest(event.scope_descriptor),'removedAddressSha256',address));
  PERFORM public.predictive_training_invalidation_append(address,'retention',code,reason,'authorized-retention',cause);
  IF removal_kind='dataset' THEN
    SELECT a.address_sha256 INTO STRICT parent FROM public.predictive_training_invalidation_addresses a
      WHERE a.kind='run' AND a.identity_sha256=public.predictive_source_digest(to_jsonb(OLD.run_id));
    PERFORM public.predictive_training_invalidation_append(parent,'retention',code,reason,'authorized-retention',cause);
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER predictive_training_invalidation_delete BEFORE DELETE ON public.predictive_training_runs
  FOR EACH ROW EXECUTE FUNCTION public.predictive_training_invalidation_delete();
CREATE TRIGGER predictive_training_invalidation_delete BEFORE DELETE ON public.predictive_training_datasets
  FOR EACH ROW EXECUTE FUNCTION public.predictive_training_invalidation_delete();

DO $immutable$ DECLARE rel text; BEGIN
  FOREACH rel IN ARRAY ARRAY['predictive_training_invalidation_addresses','predictive_training_invalidations'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.predictive_retention_audit_immutable()',rel || '_immutable',rel);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_retention_audit_immutable()',rel || '_no_truncate',rel);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',rel);
  END LOOP;
END $immutable$;
REVOKE ALL ON SEQUENCE public.predictive_training_invalidations_ordinal_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION public.predictive_training_invalidation_register(text,text),public.predictive_training_invalidation_register_trigger(),
  public.predictive_training_invalidation_target(jsonb),public.predictive_training_invalidation_reason(text),
  public.predictive_training_invalidation_receipt(public.predictive_training_invalidations),
  public.predictive_training_invalidation_append(text,text,text,text,text,text),public.predictive_training_invalidation_delete(),
  public.predictive_record_training_invalidation(jsonb),public.predictive_training_invalidation_history(jsonb) FROM PUBLIC;
DO $grants$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_replay') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_record_training_invalidation(jsonb),public.predictive_training_invalidation_history(jsonb) TO predictive_replay;
  END IF;
END $grants$;
