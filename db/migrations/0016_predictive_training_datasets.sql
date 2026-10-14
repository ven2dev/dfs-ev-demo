-- Immutable assigned manifests and independent, audited pins. SQL establishes
-- membership/closure; the local adapter verifies bytes in this same transaction.
-- No caller-provided byte certificate or numerical training payload is accepted.
CREATE TABLE public.predictive_training_dataset_identities (
  id_sha256 text PRIMARY KEY CHECK(id_sha256~'^[a-f0-9]{64}$'),
  request_sha256 text NOT NULL CHECK(request_sha256~'^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL
);
CREATE TABLE public.predictive_training_datasets (
  id text PRIMARY KEY CHECK(id~'^[!-~]+$' AND length(id) BETWEEN 1 AND 256 AND id!~'[|]'),
  run_id text NOT NULL REFERENCES public.predictive_training_runs(id),
  identity_sha256 text NOT NULL UNIQUE REFERENCES public.predictive_training_dataset_identities(id_sha256),
  request_sha256 text NOT NULL CHECK(request_sha256~'^[a-f0-9]{64}$'),
  body jsonb NOT NULL, body_sha256 text NOT NULL CHECK(body_sha256~'^[a-f0-9]{64}$'),
  charged_bytes bigint NOT NULL CHECK(charged_bytes BETWEEN 1 AND 268435456),
  recorded_at timestamptz NOT NULL
);
CREATE TABLE public.predictive_training_dataset_consumers (
  dataset_id text NOT NULL REFERENCES public.predictive_training_datasets(id),
  consumer_id text NOT NULL REFERENCES public.predictive_source_consumers(id),
  PRIMARY KEY(dataset_id,consumer_id)
);
CREATE INDEX predictive_training_dataset_consumers_reverse ON public.predictive_training_dataset_consumers(consumer_id,dataset_id);
CREATE TABLE public.predictive_training_pin_identities (
  id_sha256 text PRIMARY KEY CHECK(id_sha256~'^[a-f0-9]{64}$'),
  dataset_sha256 text NOT NULL REFERENCES public.predictive_training_dataset_identities(id_sha256),
  recorded_at timestamptz NOT NULL
);
CREATE TABLE public.predictive_training_dataset_pins (
  id text PRIMARY KEY CHECK(id~'^[!-~]+$' AND length(id) BETWEEN 1 AND 256 AND id!~'[|]'),
  dataset_id text NOT NULL REFERENCES public.predictive_training_datasets(id),
  identity_sha256 text NOT NULL UNIQUE REFERENCES public.predictive_training_pin_identities(id_sha256),
  recorded_at timestamptz NOT NULL
);
CREATE TABLE public.predictive_training_dataset_releases (
  pin_id text PRIMARY KEY REFERENCES public.predictive_training_dataset_pins(id),
  recorded_at timestamptz NOT NULL
);
CREATE TABLE public.predictive_training_dataset_retention_audits (
  event_id text NOT NULL REFERENCES public.predictive_retention_events(id),
  dataset_sha256 text NOT NULL CHECK(dataset_sha256~'^[a-f0-9]{64}$'),
  removed_counts jsonb NOT NULL, removed_ids_digest text NOT NULL CHECK(removed_ids_digest~'^[a-f0-9]{64}$'),
  removed_ids jsonb, PRIMARY KEY(event_id,dataset_sha256)
);

CREATE FUNCTION public.predictive_training_dataset_active(dataset text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.predictive_training_dataset_pins p WHERE p.dataset_id=$1
    AND NOT EXISTS(SELECT 1 FROM public.predictive_training_dataset_releases r WHERE r.pin_id=p.id))
$$;
CREATE FUNCTION public.predictive_training_consumer_pinned(consumer text,at_time timestamptz) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.predictive_training_dataset_consumers x JOIN public.predictive_training_datasets d ON d.id=x.dataset_id
    WHERE x.consumer_id=$1 AND public.predictive_training_dataset_active(d.id)
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.body->'protectedUses') p WHERE
        NOT public.predictive_rights_allow(p->>'profile',$2,$2,'internal-research')
        OR NOT public.predictive_rights_allow(p->>'profile',$2,$2,p->>'use')))
$$;

CREATE FUNCTION public.predictive_training_pinned_consumers(ids text[]) RETURNS text[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT pg_has_role(session_user,'predictive_replay','MEMBER') THEN RAISE EXCEPTION 'training-read-not-authorized' USING ERRCODE='42501'; END IF;
  IF ids IS NULL OR cardinality(ids)>1024 OR array_ndims(ids)>1
      OR EXISTS(SELECT 1 FROM unnest(ids) id WHERE id IS NULL OR length(id) NOT BETWEEN 1 AND 256 OR id~'[[:cntrl:]]') THEN
    RAISE EXCEPTION 'training-consumer-bounds-refused' USING ERRCODE='23514'; END IF;
  PERFORM public.predictive_training_read_guard();
  RETURN ARRAY(SELECT id FROM unnest(ids) id WHERE public.predictive_training_consumer_pinned(id,clock_timestamp()) ORDER BY id COLLATE "C");
END
$$;

-- Conservative replay graph, bounded by the original inventory snapshot.
-- Includes ancestors, association history and complete blobs, never a reduced
-- selected-row-only closure. Future corrections do not expand an old manifest.
CREATE FUNCTION public.predictive_training_dataset_closure(run_name text,dataset text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  WITH RECURSIVE inventory AS (SELECT * FROM public.predictive_training_runs WHERE id=$1),
  rows AS (SELECT s.selection FROM public.predictive_training_run_slots s WHERE s.run_id=$1 AND s.dataset_id=$2),
  roots(kind,id) AS (
    SELECT 'source-consumer',id FROM rows r CROSS JOIN LATERAL
      (VALUES(r.selection->'selection'->>'featureId'),(r.selection->'selection'->>'labelId')) x(id) WHERE id IS NOT NULL
    UNION SELECT 'observation',x->>'observationId' FROM rows r CROSS JOIN LATERAL jsonb_array_elements(r.selection->'kickoff'->'dependencies') x
    UNION SELECT 'decision',selection->'kickoff'->>'decisionId' FROM rows WHERE selection->'kickoff'->>'decisionId' IS NOT NULL),
  edges(parent_kind,parent_id,kind,id) AS (
    SELECT 'source-consumer',id,'source-consumer',predecessor_id FROM public.predictive_source_consumers WHERE predecessor_id IS NOT NULL
    UNION ALL SELECT 'source-consumer',consumer_id,'source-binding',binding_id FROM public.predictive_source_consumer_bindings
    UNION ALL SELECT 'source-consumer',consumer_id,'source-decision',decision_id FROM public.predictive_source_consumer_source_decisions
    UNION ALL SELECT 'source-consumer',consumer_id,'observation',observation_id FROM public.predictive_source_consumer_observations
    UNION ALL SELECT 'source-consumer',consumer_id,'decision',decision_id FROM public.predictive_source_consumer_decisions
    UNION ALL SELECT 'source-consumer',consumer_id,'rights',rights_decision_id FROM public.predictive_source_consumer_rights
    UNION ALL SELECT 'source-consumer',id,'blob',body_sha256 FROM public.predictive_source_consumers
    UNION ALL SELECT 'source-consumer',id,'capture',body->>'postWindowCaptureId' FROM public.predictive_source_consumers WHERE kind='label'
    UNION ALL SELECT 'source-binding',id,'source-binding',predecessor_id FROM public.predictive_source_bindings WHERE predecessor_id IS NOT NULL
    UNION ALL SELECT 'source-binding',id,'source-revision',revision_id FROM public.predictive_source_bindings WHERE revision_id IS NOT NULL
    UNION ALL SELECT 'source-binding',binding_id,'capture',capture_id FROM public.predictive_source_binding_captures
    UNION ALL SELECT 'source-binding',binding_id,'source-row',row_id FROM public.predictive_source_binding_rows
    UNION ALL SELECT 'source-binding',binding_id,'observation',observation_id FROM public.predictive_source_binding_dependencies
    UNION ALL SELECT 'source-binding',binding_id,'capture',capture_id FROM public.predictive_source_binding_dependencies
    UNION ALL SELECT 'source-binding',binding_id,'artifact',artifact_id FROM public.predictive_source_binding_dependencies
    UNION ALL SELECT 'source-binding',binding_id,'identity-link',link_id FROM public.predictive_source_binding_links
    UNION ALL SELECT 'source-binding',binding_id,'decision',decision_id FROM public.predictive_source_binding_decisions
    UNION ALL SELECT 'source-binding',binding_id,'rights',rights_decision_id FROM public.predictive_source_binding_rights
    UNION ALL SELECT 'source-revision',id,'source-revision',predecessor_id FROM public.predictive_source_stats_revisions WHERE predecessor_id IS NOT NULL
    UNION ALL SELECT 'source-row',id,'capture',capture_id FROM public.predictive_source_stats_rows
    UNION ALL SELECT 'source-decision',id,'source-decision',predecessor_id FROM public.predictive_source_decisions WHERE predecessor_id IS NOT NULL
    UNION ALL SELECT 'source-decision',decision_id,'source-binding',binding_id FROM public.predictive_source_decision_bindings
    UNION ALL SELECT 'source-decision',decision_id,'observation',observation_id FROM public.predictive_source_decision_inputs
    UNION ALL SELECT 'source-decision',decision_id,'rights',rights_decision_id FROM public.predictive_source_decision_rights
    UNION ALL SELECT 'decision',id,'decision',predecessor_id FROM public.predictive_decisions WHERE predecessor_id IS NOT NULL
    UNION ALL SELECT 'decision',decision_id,'observation',observation_id FROM public.predictive_decision_inputs
    UNION ALL SELECT 'decision',id,'ingestion-run',run_id FROM public.predictive_decisions
    UNION ALL SELECT 'observation',id,'observation',predecessor_id FROM public.predictive_observations WHERE predecessor_id IS NOT NULL
    UNION ALL SELECT 'observation',l.observation_id,'artifact',l.artifact_id FROM public.predictive_artifact_observations l
      WHERE EXISTS(SELECT 1 FROM public.predictive_captures c,inventory i WHERE c.artifact_id=l.artifact_id AND c.ingested_at<=i.snapshot_at)
    UNION ALL SELECT 'artifact',id,'blob',blob_sha256 FROM public.predictive_artifacts
    UNION ALL SELECT 'artifact',a.id,'capture',c.id FROM public.predictive_artifacts a JOIN public.predictive_captures c ON c.artifact_id=a.id
      CROSS JOIN inventory i WHERE c.ingested_at<=i.snapshot_at
    UNION ALL SELECT 'capture',id,'artifact',artifact_id FROM public.predictive_captures
    UNION ALL SELECT 'capture',id,'ingestion-run',run_id FROM public.predictive_captures
    UNION ALL SELECT 'ingestion-run',run_id,'rights',rights_decision_id FROM public.predictive_run_rights
    UNION ALL SELECT 'rights',id,'rights',predecessor_id FROM public.predictive_rights_decisions WHERE predecessor_id IS NOT NULL),
  closure(kind,id) AS (SELECT * FROM roots UNION SELECT e.kind,e.id FROM closure c JOIN edges e ON e.parent_kind=c.kind AND e.parent_id=c.id),
  protected(kind,id,use_kind) AS (
    SELECT r.kind,r.id,CASE WHEN r.kind='source-consumer' AND EXISTS(SELECT 1 FROM public.predictive_source_consumers c WHERE c.id=r.id AND c.kind='label')
      THEN 'outcome-label' ELSE 'model-input' END FROM roots r
    UNION SELECT e.kind,e.id,c.use_kind FROM protected c JOIN edges e ON e.parent_kind=c.kind AND e.parent_id=c.id),
  profile_refs(kind,id,profile) AS (
    SELECT 'artifact',id,profile_id FROM public.predictive_artifacts
    UNION ALL SELECT 'observation',id,profile_id FROM public.predictive_observations
    UNION ALL SELECT 'source-binding',id,profile_id FROM public.predictive_source_bindings
    UNION ALL SELECT 'rights',id,profile_id FROM public.predictive_rights_decisions
    UNION ALL SELECT 'identity-link',id,stats_profile_id FROM public.predictive_profile_identity_links
    UNION ALL SELECT 'identity-link',id,bridge_profile_id FROM public.predictive_profile_identity_links),
  bounded AS (SELECT * FROM closure ORDER BY kind COLLATE "C",id COLLATE "C" LIMIT 65537)
  SELECT jsonb_build_object('references',coalesce((SELECT jsonb_agg(jsonb_build_object('kind',kind,'id',id) ORDER BY kind COLLATE "C",id COLLATE "C") FROM bounded),'[]'),
    'protectedUses',coalesce((SELECT jsonb_agg(jsonb_build_object('profile',profile,'use',use_kind) ORDER BY profile COLLATE "C",use_kind COLLATE "C")
      FROM (SELECT DISTINCT p.profile,c.use_kind FROM protected c JOIN profile_refs p USING(kind,id)) uses),'[]'),
    'blobs',coalesce((SELECT jsonb_agg(jsonb_build_object('sha256',b.sha256,'storageRef',b.storage_ref,'byteSize',b.byte_size,'mediaType',b.media_type)
      ORDER BY b.storage_ref COLLATE "C") FROM bounded c JOIN public.predictive_blobs b ON c.kind='blob' AND c.id=b.sha256),'[]'))
$$;

CREATE FUNCTION public.predictive_training_dataset_counts(rows jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT jsonb_agg(jsonb_build_object('partition',partition,'slots',n,'targetEvents',events,'usableFeatures',features,'usableLabels',labels,
    'missingFeatures',missing_features,'unavailableFeatures',unavailable_features,'expiredFeatures',expired_features,'missingLabels',missing_labels)
    ORDER BY CASE partition WHEN 'training' THEN 0 ELSE 1 END)
  FROM (SELECT partition,count(x)::integer AS n,count(DISTINCT x->'slot'->>'gameId')::integer AS events,
    count(x) FILTER(WHERE x->'feature'->>'state'='usable')::integer AS features,count(x) FILTER(WHERE x->'label'->>'state'='usable')::integer AS labels,
    count(x) FILTER(WHERE x->'feature'->>'state'='missing')::integer AS missing_features,
    count(x) FILTER(WHERE x->'feature'->>'state'='unavailable')::integer AS unavailable_features,
    count(x) FILTER(WHERE x->'feature'->>'state'='expired')::integer AS expired_features,
    count(x) FILTER(WHERE x->'label'->>'state'='missing')::integer AS missing_labels
    FROM unnest(ARRAY['training','evaluation']) partition LEFT JOIN jsonb_array_elements($1) x ON x->'slot'->>'partition'=partition GROUP BY partition) c
$$;

ALTER FUNCTION public.predictive_training_read_guard() RENAME TO predictive_training_codec_guard;
DO $revoke$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_replay') THEN
    REVOKE ALL ON FUNCTION public.predictive_training_codec_guard() FROM predictive_replay;
  END IF;
END $revoke$;
CREATE FUNCTION public.predictive_training_read_guard() RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM public.predictive_training_codec_guard();
  LOCK TABLE public.predictive_training_dataset_identities,public.predictive_training_datasets,public.predictive_training_dataset_consumers,
    public.predictive_training_pin_identities,public.predictive_training_dataset_pins,public.predictive_training_dataset_releases,
    public.predictive_training_dataset_retention_audits IN SHARE MODE;
  RETURN public.predictive_source_time(date_trunc('milliseconds',clock_timestamp()));
END
$$;

CREATE FUNCTION public.predictive_training_dataset_read(dataset text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE d public.predictive_training_datasets; approved_use jsonb; item record; t timestamptz;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_replay','MEMBER') THEN RAISE EXCEPTION 'training-read-not-authorized' USING ERRCODE='42501'; END IF;
  PERFORM public.predictive_training_read_guard();
  SELECT * INTO d FROM public.predictive_training_datasets WHERE id=dataset;
  IF d.id IS NULL THEN
    IF EXISTS(SELECT 1 FROM public.predictive_training_dataset_identities WHERE id_sha256=public.predictive_source_digest(to_jsonb(dataset))) THEN
      RAISE EXCEPTION 'training-dataset-evidence-removed' USING ERRCODE='23514'; END IF;
    RETURN NULL;
  END IF;
  IF d.body_sha256<>public.predictive_source_digest(d.body)
      OR d.body->'closure' IS DISTINCT FROM public.predictive_training_dataset_closure(d.run_id,d.id)
      OR d.body->'rows' IS DISTINCT FROM (SELECT jsonb_agg(selection ORDER BY ordinal) FROM public.predictive_training_run_slots WHERE run_id=d.run_id AND dataset_id=d.id)
      OR public.predictive_source_set_equal(d.body->'consumerIds',coalesce((SELECT jsonb_agg(consumer_id) FROM public.predictive_training_dataset_consumers WHERE dataset_id=d.id),'[]')) IS NOT TRUE THEN
    RAISE EXCEPTION 'training-dataset-integrity-refused' USING ERRCODE='23514'; END IF;
  t:=clock_timestamp();
  FOR approved_use IN SELECT value FROM jsonb_array_elements(d.body->'protectedUses') LOOP
    IF NOT public.predictive_rights_allow(approved_use->>'profile',t,t,'internal-research') OR NOT public.predictive_rights_allow(approved_use->>'profile',t,t,approved_use->>'use') THEN
      RAISE EXCEPTION 'training-dataset-rights-refused' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR item IN SELECT c.* FROM public.predictive_source_consumers c JOIN public.predictive_training_dataset_consumers x ON x.consumer_id=c.id WHERE x.dataset_id=d.id LOOP
    IF public.predictive_source_consumer_check(item.id) IS NULL THEN RAISE EXCEPTION 'training-dataset-evidence-removed' USING ERRCODE='23514'; END IF;
    IF item.kind='feature' AND item.recorded_at+interval '90 days'<=t AND NOT public.predictive_training_dataset_active(d.id) THEN
      RAISE EXCEPTION 'training-dataset-feature-expired' USING ERRCODE='23514'; END IF;
  END LOOP;
  t:=clock_timestamp();
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(d.body->'protectedUses') p WHERE
    NOT public.predictive_rights_allow(p->>'profile',t,t,'internal-research') OR NOT public.predictive_rights_allow(p->>'profile',t,t,p->>'use')) THEN
    RAISE EXCEPTION 'training-dataset-rights-refused' USING ERRCODE='23514'; END IF;
  RETURN d.body || jsonb_build_object('manifestSha256',d.body_sha256,'activePin',public.predictive_training_dataset_active(d.id));
END
$$;

-- Existing manifests can be reverified after another unpinned shard expires.
-- Do not rerun full-run consumer selection/checks or replace the assigned IDs.
CREATE FUNCTION public.predictive_training_dataset_context(dataset text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE manifest jsonb; inventory jsonb;
BEGIN
  manifest:=public.predictive_training_dataset_read(dataset);
  IF manifest IS NULL THEN RETURN NULL; END IF;
  SELECT body || jsonb_build_object('inventorySha256',body_sha256) INTO inventory FROM public.predictive_training_runs WHERE id=manifest->>'fittingRunId';
  RETURN jsonb_build_object('manifest',manifest,'inventory',inventory);
END
$$;

CREATE FUNCTION public.predictive_pin_training_dataset(dataset text,pin text,run_name text,inventory_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE d public.predictive_training_datasets; old public.predictive_training_dataset_pins; result jsonb; total bigint; n integer;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_recorder','MEMBER') OR NOT pg_has_role(session_user,'predictive_replay','MEMBER') THEN
    RAISE EXCEPTION 'training-record-not-authorized' USING ERRCODE='42501'; END IF;
  IF public.predictive_training_identity(to_jsonb(pin)) IS NOT TRUE THEN RAISE EXCEPTION 'training-pin-identity-refused' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(520052,1);
  result:=public.predictive_training_dataset_read(dataset);
  SELECT * INTO d FROM public.predictive_training_datasets WHERE id=dataset;
  IF d.id IS NULL OR d.run_id IS DISTINCT FROM run_name OR d.body->>'inventorySha256' IS DISTINCT FROM inventory_hash THEN
    RAISE EXCEPTION 'training-dataset-inventory-mismatch' USING ERRCODE='23514'; END IF;
  SELECT * INTO old FROM public.predictive_training_dataset_pins WHERE id=pin;
  IF old.id IS NOT NULL THEN
    IF old.dataset_id<>dataset THEN RAISE EXCEPTION 'training-pin-conflict' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM public.predictive_training_dataset_releases WHERE pin_id=pin) THEN RAISE EXCEPTION 'training-pin-released' USING ERRCODE='23514'; END IF;
    RETURN jsonb_build_object('id',pin,'datasetId',dataset,'recordedAt',public.predictive_source_time(old.recorded_at),'reused',true);
  END IF;
  IF EXISTS(SELECT 1 FROM public.predictive_training_pin_identities WHERE id_sha256=public.predictive_source_digest(to_jsonb(pin))) THEN
    RAISE EXCEPTION 'training-pin-evidence-removed' USING ERRCODE='23514'; END IF;
  -- Initial/re-activation cannot resurrect any selected expired feature.
  IF NOT public.predictive_training_dataset_active(dataset) AND EXISTS(SELECT 1 FROM public.predictive_training_dataset_consumers x
    JOIN public.predictive_source_consumers c ON c.id=x.consumer_id WHERE x.dataset_id=dataset AND c.kind='feature' AND c.recorded_at+interval '90 days'<=clock_timestamp()) THEN
    RAISE EXCEPTION 'training-dataset-feature-expired' USING ERRCODE='23514'; END IF;
  SELECT count(*),coalesce(sum(charged_bytes),0) INTO n,total FROM public.predictive_training_datasets WHERE public.predictive_training_dataset_active(id);
  IF NOT public.predictive_training_dataset_active(dataset) AND (n>=32 OR total+d.charged_bytes>1073741824) THEN
    RAISE EXCEPTION 'training-retention-quota-refused' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM public.predictive_training_dataset_pins WHERE dataset_id=dataset)>=1024 THEN
    RAISE EXCEPTION 'training-pin-bounds-refused' USING ERRCODE='23514'; END IF;
  INSERT INTO public.predictive_training_pin_identities VALUES(public.predictive_source_digest(to_jsonb(pin)),d.identity_sha256,date_trunc('milliseconds',clock_timestamp()));
  INSERT INTO public.predictive_training_dataset_pins VALUES(pin,dataset,public.predictive_source_digest(to_jsonb(pin)),date_trunc('milliseconds',clock_timestamp()));
  RETURN jsonb_build_object('id',pin,'datasetId',dataset,'recordedAt',public.predictive_source_time((SELECT recorded_at FROM public.predictive_training_dataset_pins WHERE id=pin)),'reused',false);
END
$$;

CREATE FUNCTION public.predictive_prepare_training_dataset(req jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE inventory jsonb; rows jsonb; closure jsonb; body jsonb; consumers jsonb; protected_uses jsonb; hashes text; dataset text; run_name text;
  old public.predictive_training_datasets; charge bigint; pin_result jsonb; t timestamptz;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_recorder','MEMBER') OR NOT pg_has_role(session_user,'predictive_replay','MEMBER') THEN
    RAISE EXCEPTION 'training-record-not-authorized' USING ERRCODE='42501'; END IF;
  IF public.predictive_source_exact(req,ARRAY['version','fittingRunId','inventorySha256','datasetId','pinId']) IS NOT TRUE
      OR req->>'version' IS DISTINCT FROM 'qb-training-read-v1'
      OR public.predictive_training_identity(req->'fittingRunId') IS NOT TRUE OR public.predictive_training_identity(req->'datasetId') IS NOT TRUE
      OR public.predictive_training_identity(req->'pinId') IS NOT TRUE OR jsonb_typeof(req->'inventorySha256') IS DISTINCT FROM 'string'
      OR req->>'inventorySha256' !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'training-dataset-request-refused' USING ERRCODE='23514'; END IF;
  dataset:=req->>'datasetId'; run_name:=req->>'fittingRunId'; hashes:=public.predictive_source_digest(req-'pinId');
  PERFORM pg_advisory_xact_lock(520052,1);
  PERFORM public.predictive_training_read_guard();
  SELECT * INTO old FROM public.predictive_training_datasets WHERE id=dataset;
  IF old.id IS NOT NULL THEN
    IF old.request_sha256 IS DISTINCT FROM hashes THEN RAISE EXCEPTION 'training-dataset-conflict' USING ERRCODE='23514'; END IF;
    pin_result:=public.predictive_pin_training_dataset(dataset,req->>'pinId',run_name,req->>'inventorySha256');
    RETURN public.predictive_training_dataset_read(dataset) || jsonb_build_object('pin',pin_result,'reused',true);
  END IF;
  IF EXISTS(SELECT 1 FROM public.predictive_training_dataset_identities WHERE id_sha256=public.predictive_source_digest(to_jsonb(dataset))) THEN
    RAISE EXCEPTION 'training-dataset-evidence-removed' USING ERRCODE='23514'; END IF;
  inventory:=public.predictive_training_run_read(run_name);
  IF inventory IS NULL OR inventory->>'inventorySha256' IS DISTINCT FROM req->>'inventorySha256' THEN
    RAISE EXCEPTION 'training-dataset-inventory-mismatch' USING ERRCODE='23514'; END IF;
  SELECT jsonb_agg(selection ORDER BY ordinal) INTO rows FROM public.predictive_training_run_slots WHERE run_id=run_name AND dataset_id=dataset;
  IF rows IS NULL THEN RAISE EXCEPTION 'training-shard-not-assigned' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(rows) r WHERE r->'feature'->>'state'='expired') THEN
    RAISE EXCEPTION 'training-dataset-feature-expired' USING ERRCODE='23514'; END IF;
  closure:=public.predictive_training_dataset_closure(run_name,dataset);
  IF jsonb_array_length(closure->'references')>65536 THEN RAISE EXCEPTION 'training-dependency-bounds-refused' USING ERRCODE='23514'; END IF;
  SELECT coalesce(jsonb_agg(x->>'id' ORDER BY x->>'id' COLLATE "C"),'[]') INTO consumers FROM jsonb_array_elements(closure->'references') x WHERE x->>'kind'='source-consumer';
  SELECT jsonb_agg(x ORDER BY x->>'profile' COLLATE "C",x->>'use' COLLATE "C") INTO protected_uses FROM
    (SELECT DISTINCT value AS x FROM jsonb_array_elements((inventory->'protectedUses') || (closure->'protectedUses'))) uses;
  IF (SELECT count(DISTINCT x->>'profile') FROM jsonb_array_elements(protected_uses) x)>16 THEN
    RAISE EXCEPTION 'training-profile-bounds-refused' USING ERRCODE='23514'; END IF;
  t:=date_trunc('milliseconds',clock_timestamp());
  body:=jsonb_build_object('version','qb-training-dataset-v1','status','sealed','fittingReady',false,'populationCoverage','unqualified',
    'datasetId',dataset,'fittingRunId',run_name,'inventorySha256',inventory->>'inventorySha256','inventorySnapshotAt',inventory->>'snapshotAt',
    'recordedAt',public.predictive_source_time(t),'requestSha256',hashes,'selection',inventory->'request'->'selection',
    'modelIdentity',inventory->'request'->'modelIdentity','splitPolicy',inventory->'request'->'splitPolicy','population',inventory->'request'->'population',
    'fitCutoff',inventory->'request'->'fitCutoff','evaluationPlanId',inventory->'request'->'evaluationPlanId','foldId',inventory->'request'->'foldId',
    'reuseDisclosure',inventory->'reuseDisclosure','pinEligibility',inventory->'pinEligibility','protectedUses',protected_uses,'rows',rows,'counts',public.predictive_training_dataset_counts(rows),
    'closure',closure,'consumerIds',consumers,'consumerManifests',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,
      'bodySha256',c.body_sha256,'executionDigest',c.execution_digest,'manifest',c.body->'manifest') ORDER BY c.id COLLATE "C")
      FROM public.predictive_source_consumers c WHERE c.id IN (SELECT jsonb_array_elements_text(consumers))),'[]'),
    'byteVerification','required-on-every-access');
  IF octet_length(public.predictive_source_canonical_json(body))>8000000 THEN RAISE EXCEPTION 'training-manifest-byte-bounds-refused' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum((b->>'byteSize')::bigint),0)+octet_length(public.predictive_source_canonical_json(body)) INTO charge FROM jsonb_array_elements(closure->'blobs') b;
  IF charge>268435456 THEN RAISE EXCEPTION 'training-retention-quota-refused' USING ERRCODE='23514'; END IF;
  INSERT INTO public.predictive_training_dataset_identities VALUES(public.predictive_source_digest(to_jsonb(dataset)),hashes,t);
  INSERT INTO public.predictive_training_datasets VALUES(dataset,run_name,public.predictive_source_digest(to_jsonb(dataset)),hashes,body,public.predictive_source_digest(body),charge,t);
  INSERT INTO public.predictive_training_dataset_consumers SELECT dataset,jsonb_array_elements_text(consumers);
  pin_result:=public.predictive_pin_training_dataset(dataset,req->>'pinId',run_name,req->>'inventorySha256');
  RETURN public.predictive_training_dataset_read(dataset) || jsonb_build_object('pin',pin_result,'reused',false);
END
$$;

CREATE FUNCTION public.predictive_release_training_dataset_pin(pin text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE p public.predictive_training_dataset_pins; prior timestamptz; t timestamptz;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_recorder','MEMBER') THEN RAISE EXCEPTION 'training-record-not-authorized' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(520052,1);
  SELECT * INTO p FROM public.predictive_training_dataset_pins WHERE id=pin;
  IF p.id IS NULL THEN RAISE EXCEPTION 'training-pin-not-found' USING ERRCODE='23514'; END IF;
  SELECT recorded_at INTO prior FROM public.predictive_training_dataset_releases WHERE pin_id=pin;
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('pinId',pin,'releasedAt',public.predictive_source_time(prior),'reused',true); END IF;
  t:=date_trunc('milliseconds',clock_timestamp());
  INSERT INTO public.predictive_training_dataset_releases VALUES(pin,t);
  RETURN jsonb_build_object('pinId',pin,'releasedAt',public.predictive_source_time(t),'reused',false);
END
$$;

-- Install two narrow extension seams against the exact reviewed function body.
-- Fail closed on an unexpected prefix; preserve the remaining procedure, its
-- execute-only grants and legacy audit byte-for-byte. This avoids a seventh full
-- multi-ledger copy. #115 can replace this seam with its ledger decomposition.
DO $expiry_seams$
DECLARE signature regprocedure; definition text; source text; old_clause text; new_clause text;
BEGIN
  signature:='public.predictive_retention_execute(text,text,text,timestamptz,jsonb,text)'::regprocedure;
  SELECT prosrc,pg_get_functiondef(oid) INTO source,definition FROM pg_proc WHERE oid=signature;
  IF encode(sha256(convert_to(source,'UTF8')),'hex')<>'bb3e4f1589e4dee78bbe316fc1ca15ec8347c5dab34da212526f14ee14b7b362' THEN
    RAISE EXCEPTION 'training-retention-prefix-refused'; END IF;
  old_clause:='c.recorded_at+interval ''90 days''<=as_of';
  new_clause:=old_clause || ' AND NOT public.predictive_training_consumer_pinned(c.id,clock_timestamp())';
  IF (length(source)-length(replace(source,old_clause,'')))/length(old_clause)<>1 THEN RAISE EXCEPTION 'training-retention-seam-refused'; END IF;
  EXECUTE replace(definition,old_clause,new_clause);
  signature:='public.predictive_training_retention_hook()'::regprocedure;
  SELECT prosrc,pg_get_functiondef(oid) INTO source,definition FROM pg_proc WHERE oid=signature;
  IF encode(sha256(convert_to(source,'UTF8')),'hex')<>'0fdf88221f66e4d85e5748b240bcaef006ec6cadf803a2613b8b233c9680edc8' THEN
    RAISE EXCEPTION 'training-inventory-retention-prefix-refused'; END IF;
  old_clause:='event.scope_descriptor->>''kind''=''feature-run-expiry'' AND EXISTS';
  new_clause:='event.scope_descriptor->>''kind''=''feature-run-expiry'' AND NOT EXISTS(SELECT 1 FROM public.predictive_training_datasets d WHERE d.run_id=r.id AND public.predictive_training_dataset_active(d.id) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.body->''protectedUses'') p WHERE NOT public.predictive_rights_allow(p->>''profile'',clock_timestamp(),clock_timestamp(),''internal-research'') OR NOT public.predictive_rights_allow(p->>''profile'',clock_timestamp(),clock_timestamp(),p->>''use''))) AND EXISTS';
  IF (length(source)-length(replace(source,old_clause,'')))/length(old_clause)<>1 THEN RAISE EXCEPTION 'training-retention-seam-refused'; END IF;
  definition:=replace(definition,old_clause,new_clause);
  old_clause:='p.profile_id IN (SELECT jsonb_array_elements_text(event.scope_descriptor->''profileIds''))';
  new_clause:='(' || old_clause || ' OR EXISTS(SELECT 1 FROM public.predictive_training_datasets d CROSS JOIN LATERAL jsonb_array_elements(d.body->''protectedUses'') u WHERE d.run_id=r.id AND u->>''profile'' IN (SELECT jsonb_array_elements_text(event.scope_descriptor->''profileIds''))))';
  IF (length(source)-length(replace(source,old_clause,'')))/length(old_clause)<>1 THEN RAISE EXCEPTION 'training-dataset-source-seam-refused'; END IF;
  EXECUTE replace(definition,old_clause,new_clause);
  signature:='public.predictive_prepare_training_run(jsonb)'::regprocedure;
  SELECT prosrc,pg_get_functiondef(oid) INTO source,definition FROM pg_proc WHERE oid=signature;
  IF encode(sha256(convert_to(source,'UTF8')),'hex')<>'db53ff8d8c4ea751dcf9bf4151f0cc5476b4ed2e3fff31fe4483f06fe149b9ad' THEN
    RAISE EXCEPTION 'training-run-pin-prefix-refused'; END IF;
  old_clause:='f.recorded_at+interval ''90 days''<=t';
  new_clause:=old_clause || ' AND NOT public.predictive_training_consumer_pinned(f.id,t)';
  IF (length(source)-length(replace(source,old_clause,'')))/length(old_clause)<>1 THEN RAISE EXCEPTION 'training-retention-seam-refused'; END IF;
  definition:=replace(definition,old_clause,new_clause);
  old_clause:='IF octet_length(public.predictive_source_canonical_json(body))>8000000 THEN';
  new_clause:='body:=body || jsonb_build_object(''pinEligibility'',jsonb_build_object(''version'',''source-feature-pin-eligibility-v1'',''featureIds'',coalesce((SELECT jsonb_agg(id ORDER BY id COLLATE "C") FROM (SELECT DISTINCT x->''selection''->>''featureId'' AS id FROM jsonb_array_elements(rows) x WHERE public.predictive_training_consumer_pinned(x->''selection''->>''featureId'',t)) pinned),''[]''))); ' || old_clause;
  IF (length(source)-length(replace(source,old_clause,'')))/length(old_clause)<>1 THEN RAISE EXCEPTION 'training-run-pin-seam-refused'; END IF;
  EXECUTE replace(definition,old_clause,new_clause);
END
$expiry_seams$;

-- Erase each dataset's pin closure before deleting its row. Per-dataset audit
-- also covers expired unpinned shards of a run that retains a different pin.
CREATE FUNCTION public.predictive_training_dataset_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE event public.predictive_retention_events; pairs jsonb; counts jsonb;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_retention_owner','MEMBER') THEN RAISE EXCEPTION 'training-retention-not-authorized' USING ERRCODE='42501'; END IF;
  SELECT e.* INTO STRICT event FROM public.predictive_retention_authorizations a JOIN public.predictive_retention_events e ON e.id=a.retention_event_id WHERE a.txid=pg_current_xact_id();
  SELECT jsonb_agg(jsonb_build_object('kind',kind,'id',id) ORDER BY kind COLLATE "C",id COLLATE "C") INTO pairs FROM (
    SELECT 'training-dataset' AS kind,OLD.id AS id
    UNION ALL SELECT 'training-pin',p.id FROM public.predictive_training_dataset_pins p WHERE p.dataset_id=OLD.id) x;
  counts:=jsonb_build_object('datasets',1,
    'datasetConsumers',(SELECT count(*) FROM public.predictive_training_dataset_consumers WHERE dataset_id=OLD.id),
    'datasetPins',(SELECT count(*) FROM public.predictive_training_dataset_pins WHERE dataset_id=OLD.id),
    'datasetReleases',(SELECT count(*) FROM public.predictive_training_dataset_releases r JOIN public.predictive_training_dataset_pins p ON p.id=r.pin_id WHERE p.dataset_id=OLD.id));
  INSERT INTO public.predictive_training_dataset_retention_audits VALUES(event.id,public.predictive_source_digest(to_jsonb(OLD.id)),counts,public.predictive_source_digest(pairs),
    CASE WHEN event.audit_level='full' THEN pairs END);
  DELETE FROM public.predictive_training_dataset_releases WHERE pin_id IN (SELECT id FROM public.predictive_training_dataset_pins WHERE dataset_id=OLD.id);
  DELETE FROM public.predictive_training_dataset_pins WHERE dataset_id=OLD.id;
  DELETE FROM public.predictive_training_dataset_consumers WHERE dataset_id=OLD.id;
  RETURN OLD;
END
$$;
CREATE TRIGGER predictive_training_dataset_delete BEFORE DELETE ON public.predictive_training_datasets FOR EACH ROW EXECUTE FUNCTION public.predictive_training_dataset_delete();

CREATE FUNCTION public.predictive_training_run_dataset_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  DELETE FROM public.predictive_training_datasets WHERE run_id=OLD.id;
  RETURN OLD;
END
$$;
CREATE TRIGGER predictive_training_run_dataset_delete BEFORE DELETE ON public.predictive_training_runs FOR EACH ROW EXECUTE FUNCTION public.predictive_training_run_dataset_delete();

CREATE FUNCTION public.predictive_training_dataset_expiry_hook() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE event public.predictive_retention_events;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_retention_owner','MEMBER') OR NEW.txid<>pg_current_xact_id() THEN
    RAISE EXCEPTION 'training-retention-not-authorized' USING ERRCODE='42501'; END IF;
  SELECT * INTO STRICT event FROM public.predictive_retention_events WHERE id=NEW.retention_event_id;
  IF event.scope_descriptor->>'kind'='feature-run-expiry' THEN
    DELETE FROM public.predictive_training_datasets d WHERE EXISTS(SELECT 1 FROM public.predictive_training_dataset_consumers x
      JOIN public.predictive_source_consumers c ON c.id=x.consumer_id WHERE x.dataset_id=d.id AND c.kind='feature'
        AND c.recorded_at+interval '90 days'<=(event.scope_descriptor->>'asOf')::timestamptz
        AND NOT public.predictive_training_consumer_pinned(c.id,clock_timestamp()));
  END IF;
  RETURN NEW;
END
$$;
-- Alphabetical AFTER-trigger order runs this before the existing inventory hook.
CREATE TRIGGER predictive_training_dataset_expiry_hook AFTER INSERT ON public.predictive_retention_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.predictive_training_dataset_expiry_hook();

CREATE OR REPLACE FUNCTION public.predictive_training_retention_result(event_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE original jsonb; extra jsonb; hashes jsonb;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_retention_owner','MEMBER') THEN RAISE EXCEPTION 'training-retention-not-authorized' USING ERRCODE='42501'; END IF;
  SELECT jsonb_build_object('removedCounts',removed_counts,'removedIdsDigest',removed_ids_digest) INTO original
    FROM public.predictive_training_retention_audits a WHERE a.event_id=predictive_training_retention_result.event_id;
  SELECT jsonb_object_agg(k,n) INTO extra FROM (SELECT k,sum(v::bigint) AS n FROM public.predictive_training_dataset_retention_audits a
    CROSS JOIN LATERAL jsonb_each_text(a.removed_counts) x(k,v) WHERE a.event_id=predictive_training_retention_result.event_id GROUP BY k) x;
  IF extra IS NULL THEN RETURN original; END IF;
  SELECT jsonb_agg(jsonb_build_object('datasetSha256',dataset_sha256,'removedIdsDigest',removed_ids_digest) ORDER BY dataset_sha256 COLLATE "C") INTO hashes
    FROM public.predictive_training_dataset_retention_audits a WHERE a.event_id=predictive_training_retention_result.event_id;
  RETURN jsonb_build_object('removedCounts',coalesce(original->'removedCounts','{}') || extra,
    'removedIdsDigest',public.predictive_source_digest(jsonb_build_object('inventoryDigest',original->'removedIdsDigest','datasets',hashes)));
END
$$;

DO $immutable$ DECLARE rel text; BEGIN
  FOREACH rel IN ARRAY ARRAY['predictive_training_dataset_identities','predictive_training_datasets','predictive_training_dataset_consumers',
    'predictive_training_pin_identities','predictive_training_dataset_pins','predictive_training_dataset_releases'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only()',rel || '_immutable',rel);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only()',rel || '_no_truncate',rel);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',rel);
  END LOOP;
END $immutable$;
CREATE TRIGGER predictive_training_dataset_retention_audits_immutable BEFORE UPDATE OR DELETE ON public.predictive_training_dataset_retention_audits
  FOR EACH ROW EXECUTE FUNCTION public.predictive_retention_audit_immutable();
CREATE TRIGGER predictive_training_dataset_retention_audits_no_truncate BEFORE TRUNCATE ON public.predictive_training_dataset_retention_audits
  FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_retention_audit_immutable();
REVOKE ALL ON FUNCTION public.predictive_training_dataset_active(text),public.predictive_training_consumer_pinned(text,timestamptz),
  public.predictive_training_pinned_consumers(text[]),public.predictive_training_dataset_context(text),
  public.predictive_training_dataset_counts(jsonb),
  public.predictive_training_dataset_closure(text,text),public.predictive_training_read_guard(),public.predictive_training_dataset_read(text),
  public.predictive_pin_training_dataset(text,text,text,text),public.predictive_prepare_training_dataset(jsonb),
  public.predictive_release_training_dataset_pin(text),public.predictive_training_dataset_delete(),public.predictive_training_run_dataset_delete(),
  public.predictive_training_dataset_expiry_hook() FROM PUBLIC;
DO $grants$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_replay') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_training_read_guard(),public.predictive_training_dataset_read(text),
      public.predictive_training_dataset_context(text),public.predictive_training_pinned_consumers(text[]) TO predictive_replay;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_recorder') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_prepare_training_dataset(jsonb),public.predictive_pin_training_dataset(text,text,text,text),
      public.predictive_release_training_dataset_pin(text) TO predictive_recorder;
  END IF;
END $grants$;
