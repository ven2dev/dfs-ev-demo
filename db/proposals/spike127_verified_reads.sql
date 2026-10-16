-- #127 disposable spike ONLY. Never run through the ordered migration CLI.
-- Pattern: immutable verified records written by the checked recorder, not a
-- request-local cache. No backfill or replacement of frozen functions.
CREATE TABLE public.spike127_certificates (
  consumer_id text PRIMARY KEY REFERENCES public.predictive_source_consumers(id) ON DELETE CASCADE,
  record jsonb NOT NULL,
  closure jsonb NOT NULL,
  certificate_sha256 text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(certificate_sha256=public.predictive_source_digest(jsonb_build_array(record,closure)))
);
CREATE TRIGGER spike127_certificates_immutable BEFORE UPDATE OR DELETE ON public.spike127_certificates
  FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only();
CREATE TRIGGER spike127_certificates_no_truncate BEFORE TRUNCATE ON public.spike127_certificates
  FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only();
REVOKE ALL ON public.spike127_certificates FROM PUBLIC,predictive_recorder,predictive_replay;

CREATE FUNCTION public.spike127_closure(root_refs jsonb,snapshot_time timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  WITH RECURSIVE inventory AS (SELECT snapshot_time AS snapshot_at),
  roots(kind,id) AS (SELECT x->>'kind',x->>'id' FROM jsonb_array_elements(root_refs) x),
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
    UNION ALL SELECT 'capture',capture_id,'compressed-publication',capture_id FROM public.predictive_compressed_publications
    UNION ALL SELECT 'capture',capture_id,'compressed-inspection',capture_id FROM public.predictive_compressed_inspections
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

CREATE FUNCTION public.spike127_record_source_consumer(record_id text,expected_head text,proposed jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb; dependencies jsonb;
BEGIN
  -- Original SQL proves the body, lineage, rights and all exact associations.
  -- Certification cannot be invoked for a historical, unverified record.
  result:=public.predictive_record_source_consumer(record_id,expected_head,proposed);
  dependencies:=public.spike127_closure(jsonb_build_array(jsonb_build_object('kind','source-consumer','id',record_id)),
    (result->>'recordedAt')::timestamptz);
  IF jsonb_array_length(dependencies->'references')>65536 THEN RAISE EXCEPTION 'training-dependency-bounds-refused'; END IF;
  INSERT INTO public.spike127_certificates(consumer_id,record,closure,certificate_sha256)
    VALUES(record_id,result,dependencies,public.predictive_source_digest(jsonb_build_array(result,dependencies)));
  RETURN result;
END $$;

-- One set-based rights computation for all requested profiles AND uses. A
-- recursive chain preserves the frozen effective-time/knowledge-time policy.
CREATE FUNCTION public.spike127_assert_access(ids text[],extra_uses jsonb) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t timestamptz:=clock_timestamp(); approved boolean;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_replay','MEMBER') THEN RAISE EXCEPTION 'training-read-not-authorized' USING ERRCODE='42501'; END IF;
  IF cardinality(ids)>8192 THEN RAISE EXCEPTION 'training-consumer-bounds-refused'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(ids) requested(id) LEFT JOIN public.spike127_certificates v ON v.consumer_id=requested.id
    LEFT JOIN public.predictive_source_consumers c ON c.id=requested.id
    WHERE v.consumer_id IS NULL OR c.id IS NULL OR c.body_sha256 IS DISTINCT FROM v.record->>'bodySha256'
      OR c.execution_digest IS DISTINCT FROM v.record->>'executionDigest') THEN
    RAISE EXCEPTION 'training-dataset-evidence-removed' USING ERRCODE='23514'; END IF;
  WITH RECURSIVE uses AS MATERIALIZED (
    SELECT DISTINCT x->>'profile' AS profile,x->>'use' AS use_kind FROM (
      SELECT value AS x FROM jsonb_array_elements(extra_uses)
      UNION ALL SELECT x FROM public.spike127_certificates v CROSS JOIN LATERAL jsonb_array_elements(v.closure->'protectedUses') x
        WHERE v.consumer_id=ANY(ids)) all_uses),
  required AS (SELECT * FROM uses UNION SELECT profile,'internal-research' FROM uses),
  chain AS (
    SELECT d.*,1 AS depth FROM public.predictive_rights_decisions d WHERE d.predecessor_id IS NULL AND d.profile_id IN (SELECT profile FROM required)
    UNION ALL SELECT d.*,c.depth+1 FROM public.predictive_rights_decisions d JOIN chain c ON d.predecessor_id=c.id),
  current_rights AS (SELECT DISTINCT ON(profile_id) profile_id,allowed_uses FROM chain
    WHERE decided_at<=t AND effective_from<=t AND (effective_to IS NULL OR t<effective_to) ORDER BY profile_id,depth DESC)
  SELECT coalesce(bool_and(c.profile_id IS NOT NULL AND r.use_kind=ANY(c.allowed_uses)),true) INTO approved
    FROM required r LEFT JOIN current_rights c ON c.profile_id=r.profile;
  IF NOT approved THEN RAISE EXCEPTION 'training-dataset-rights-refused' USING ERRCODE='23514'; END IF;
  -- Only source rows still present can support a certificate. Existing 0019
  -- invalidations and retention remove the run/dataset/consumer, checked below.
  RETURN public.predictive_source_time(t);
END $$;

CREATE FUNCTION public.spike127_records(ids text[],extra_uses jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM public.spike127_assert_access(ids,extra_uses);
  RETURN coalesce((SELECT jsonb_agg(v.record ORDER BY v.consumer_id COLLATE "C")
    FROM public.spike127_certificates v WHERE v.consumer_id=ANY(ids)),'[]');
END $$;

CREATE FUNCTION public.spike127_inventory(run_name text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.predictive_training_runs; ids text[];
BEGIN
  IF NOT pg_has_role(session_user,'predictive_replay','MEMBER') THEN RAISE EXCEPTION 'training-read-not-authorized' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.predictive_training_runs WHERE id=run_name;
  IF r.id IS NULL THEN RAISE EXCEPTION 'training-run-evidence-removed' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM public.predictive_training_invalidation_addresses a JOIN public.predictive_training_invalidations i USING(address_sha256)
    WHERE a.kind='run' AND a.identity_sha256=r.identity_sha256 AND i.body->>'origin' IN ('database-confirmed','authorized-retention')) THEN
    RAISE EXCEPTION 'training-run-evidence-removed' USING ERRCODE='23514'; END IF;
  SELECT array_agg(DISTINCT id) FILTER(WHERE id IS NOT NULL) INTO ids FROM public.predictive_training_run_slots s CROSS JOIN LATERAL
    (VALUES(s.selection->'selection'->>'featureId'),(s.selection->'selection'->>'labelId')) refs(id) WHERE s.run_id=r.id;
  PERFORM public.spike127_assert_access(coalesce(ids,'{}'),r.body->'protectedUses');
  RETURN r.body || jsonb_build_object('inventorySha256',r.body_sha256);
END $$;

CREATE FUNCTION public.spike127_dataset_closure(run_name text,dataset text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  WITH rows AS (SELECT selection FROM public.predictive_training_run_slots WHERE run_id=$1 AND dataset_id=$2),
  ids AS (SELECT DISTINCT id FROM rows r CROSS JOIN LATERAL
    (VALUES(r.selection->'selection'->>'featureId'),(r.selection->'selection'->>'labelId')) refs(id) WHERE id IS NOT NULL),
  kickoff_roots AS (SELECT jsonb_build_object('kind','observation','id',x->>'observationId') AS root
      FROM rows r CROSS JOIN LATERAL jsonb_array_elements(r.selection->'kickoff'->'dependencies') x
    UNION SELECT jsonb_build_object('kind','decision','id',selection->'kickoff'->>'decisionId') FROM rows
      WHERE selection->'kickoff'->>'decisionId' IS NOT NULL),
  closures AS MATERIALIZED (SELECT v.closure FROM public.spike127_certificates v JOIN ids ON ids.id=v.consumer_id
    UNION ALL SELECT public.spike127_closure(coalesce((SELECT jsonb_agg(root) FROM kickoff_roots),'[]'),snapshot_at)
      FROM public.predictive_training_runs WHERE id=$1),
  refs AS (SELECT DISTINCT x FROM closures c CROSS JOIN LATERAL jsonb_array_elements(c.closure->'references') x),
  uses AS (SELECT DISTINCT x FROM closures c CROSS JOIN LATERAL jsonb_array_elements(c.closure->'protectedUses') x),
  blobs AS (SELECT DISTINCT x FROM closures c CROSS JOIN LATERAL jsonb_array_elements(c.closure->'blobs') x)
  SELECT jsonb_build_object('references',coalesce((SELECT jsonb_agg(x ORDER BY x->>'kind' COLLATE "C",x->>'id' COLLATE "C") FROM refs),'[]'),
    'protectedUses',coalesce((SELECT jsonb_agg(x ORDER BY x->>'profile' COLLATE "C",x->>'use' COLLATE "C") FROM uses),'[]'),
    'blobs',coalesce((SELECT jsonb_agg(x ORDER BY x->>'storageRef' COLLATE "C") FROM blobs),'[]'))
$$;

CREATE FUNCTION public.spike127_dataset_read(dataset text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE d public.predictive_training_datasets; ids text[]; t timestamptz:=clock_timestamp();
BEGIN
  IF NOT pg_has_role(session_user,'predictive_replay','MEMBER') THEN RAISE EXCEPTION 'training-read-not-authorized' USING ERRCODE='42501'; END IF;
  SELECT * INTO d FROM public.predictive_training_datasets WHERE id=dataset;
  IF d.id IS NULL THEN RAISE EXCEPTION 'training-dataset-evidence-removed' USING ERRCODE='23514'; END IF;
  SELECT array_agg(consumer_id) INTO ids FROM public.predictive_training_dataset_consumers WHERE dataset_id=d.id;
  PERFORM public.spike127_assert_access(coalesce(ids,'{}'),d.body->'protectedUses');
  IF EXISTS(SELECT 1 FROM public.predictive_training_invalidation_addresses a JOIN public.predictive_training_invalidations i USING(address_sha256)
    WHERE a.kind='dataset' AND a.identity_sha256=d.identity_sha256 AND i.body->>'origin' IN ('database-confirmed','authorized-retention')) THEN
    RAISE EXCEPTION 'training-dataset-evidence-removed' USING ERRCODE='23514'; END IF;
  IF NOT public.predictive_training_dataset_active(d.id) AND EXISTS(SELECT 1 FROM public.predictive_source_consumers c
    WHERE c.id=ANY(ids) AND c.kind='feature' AND c.recorded_at+interval '90 days'<=t) THEN
    RAISE EXCEPTION 'training-dataset-feature-expired' USING ERRCODE='23514'; END IF;
  RETURN d.body || jsonb_build_object('manifestSha256',d.body_sha256,'activePin',public.predictive_training_dataset_active(d.id));
END $$;

CREATE FUNCTION public.spike127_page_context(dataset text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE manifest jsonb;
BEGIN
  manifest:=public.spike127_dataset_read(dataset);
  RETURN jsonb_build_object('manifest',manifest,'records',coalesce((SELECT jsonb_agg(v.record ORDER BY v.consumer_id COLLATE "C")
    FROM public.spike127_certificates v JOIN public.predictive_training_dataset_consumers x ON x.consumer_id=v.consumer_id WHERE x.dataset_id=dataset),'[]'));
END $$;

CREATE FUNCTION public.spike127_pin(dataset text,pin text,run_name text,inventory_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE d public.predictive_training_datasets; old public.predictive_training_dataset_pins; result jsonb; total bigint; n integer;
BEGIN
  IF NOT pg_has_role(session_user,'predictive_recorder','MEMBER') OR NOT pg_has_role(session_user,'predictive_replay','MEMBER') THEN
    RAISE EXCEPTION 'training-record-not-authorized' USING ERRCODE='42501'; END IF;
  IF public.predictive_training_identity(to_jsonb(pin)) IS NOT TRUE THEN RAISE EXCEPTION 'training-pin-identity-refused' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(520052,1);
  SELECT body || jsonb_build_object('manifestSha256',body_sha256) INTO result FROM public.predictive_training_datasets WHERE id=dataset;
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

CREATE FUNCTION public.spike127_seal(req jsonb) RETURNS jsonb
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
  SELECT * INTO old FROM public.predictive_training_datasets WHERE id=dataset;
  IF old.id IS NOT NULL THEN
    IF old.request_sha256 IS DISTINCT FROM hashes THEN RAISE EXCEPTION 'training-dataset-conflict' USING ERRCODE='23514'; END IF;
    pin_result:=public.spike127_pin(dataset,req->>'pinId',run_name,req->>'inventorySha256');
    RETURN public.spike127_dataset_read(dataset) || jsonb_build_object('pin',pin_result,'reused',true);
  END IF;
  IF EXISTS(SELECT 1 FROM public.predictive_training_dataset_identities WHERE id_sha256=public.predictive_source_digest(to_jsonb(dataset))) THEN
    RAISE EXCEPTION 'training-dataset-evidence-removed' USING ERRCODE='23514'; END IF;
  inventory:=public.spike127_inventory(run_name);
  IF inventory IS NULL OR inventory->>'inventorySha256' IS DISTINCT FROM req->>'inventorySha256' THEN
    RAISE EXCEPTION 'training-dataset-inventory-mismatch' USING ERRCODE='23514'; END IF;
  SELECT jsonb_agg(selection ORDER BY ordinal) INTO rows FROM public.predictive_training_run_slots WHERE run_id=run_name AND dataset_id=dataset;
  IF rows IS NULL THEN RAISE EXCEPTION 'training-shard-not-assigned' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(rows) r WHERE r->'feature'->>'state'='expired') THEN
    RAISE EXCEPTION 'training-dataset-feature-expired' USING ERRCODE='23514'; END IF;
  closure:=public.spike127_dataset_closure(run_name,dataset);
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
  pin_result:=public.spike127_pin(dataset,req->>'pinId',run_name,req->>'inventorySha256');
  RETURN body || jsonb_build_object('manifestSha256',public.predictive_source_digest(body),'activePin',true,'pin',pin_result,'reused',false);
END
$$;

REVOKE ALL ON FUNCTION public.spike127_closure(jsonb,timestamptz),
  public.spike127_record_source_consumer(text,text,jsonb),public.spike127_assert_access(text[],jsonb),
  public.spike127_records(text[],jsonb),public.spike127_inventory(text),public.spike127_dataset_closure(text,text),
  public.spike127_dataset_read(text),public.spike127_page_context(text),public.spike127_pin(text,text,text,text),public.spike127_seal(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.spike127_record_source_consumer(text,text,jsonb),public.spike127_seal(jsonb) TO predictive_recorder;
GRANT EXECUTE ON FUNCTION public.spike127_assert_access(text[],jsonb),public.spike127_records(text[],jsonb),
  public.spike127_inventory(text),public.spike127_dataset_read(text),public.spike127_page_context(text) TO predictive_replay;

CREATE FUNCTION public.spike127_label_access(ids text[],profiles text[],as_of timestamptz) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM public.spike127_assert_access(ids,coalesce((SELECT jsonb_agg(jsonb_build_object('profile',p,'use','outcome-label')) FROM unnest(profiles) p),'[]'));
  RETURN EXISTS(SELECT 1 FROM public.predictive_retention_events e WHERE e.scope_descriptor->>'kind'='source'
    AND e.scope_descriptor->'profileIds' ?| profiles
    AND (e.scope_descriptor->>'capturedFrom' IS NULL OR (e.scope_descriptor->>'capturedFrom')::timestamptz<=as_of));
END $$;
CREATE FUNCTION public.spike127_label_context(ids text[],profiles text[],as_of timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE removed boolean;
BEGIN
  removed:=public.spike127_label_access(ids,profiles,as_of);
  RETURN jsonb_build_object('removed',removed,
    'records',coalesce((SELECT jsonb_agg(record ORDER BY consumer_id COLLATE "C") FROM public.spike127_certificates WHERE consumer_id=ANY(ids)),'[]'),
    'blobs',coalesce((SELECT jsonb_agg(x ORDER BY x->>'storageRef' COLLATE "C") FROM
      (SELECT DISTINCT x FROM public.spike127_certificates v CROSS JOIN LATERAL jsonb_array_elements(v.closure->'blobs') x WHERE v.consumer_id=ANY(ids)) files),'[]'));
END $$;
REVOKE ALL ON FUNCTION public.spike127_label_access(text[],text[],timestamptz),public.spike127_label_context(text[],text[],timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.spike127_label_access(text[],text[],timestamptz),public.spike127_label_context(text[],text[],timestamptz) TO predictive_replay;

-- Private recorder helper: the original recorder already validated these
-- records before creating their immutable certificate. No caller can insert it.
CREATE FUNCTION public.spike127_certificate(record_id text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT record FROM public.spike127_certificates WHERE consumer_id=$1
$$;
REVOKE ALL ON FUNCTION public.spike127_certificate(text) FROM PUBLIC;


-- Recording metadata validates cutoff and schedule facts once; reads never call it.
CREATE FUNCTION public.spike127_prepare_run(input jsonb) RETURNS jsonb
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
  LOCK TABLE public.predictive_training_run_identities,public.predictive_training_runs,public.predictive_training_run_events,
    public.predictive_training_run_slots,public.predictive_training_run_profiles IN SHARE ROW EXCLUSIVE MODE;
  t:=date_trunc('milliseconds',clock_timestamp()); req:=public.predictive_training_request(input,t); sel:=req->'selection';
  request_sha:=public.predictive_source_digest(req); identity_sha:=public.predictive_source_digest(req->'fittingRunId');
  plan_sha:=public.predictive_source_digest(req->'evaluationPlanId'); fold_sha:=public.predictive_source_digest(req->'foldId');
  contract_sha:=public.predictive_source_digest(jsonb_build_object('selection',sel,'modelIdentity',req->'modelIdentity','splitPolicy',req->'splitPolicy'));
  SELECT * INTO existing FROM public.predictive_training_run_identities WHERE id_sha256=identity_sha;
  IF existing.id_sha256 IS NOT NULL THEN
    IF existing.request_sha256<>request_sha THEN RAISE EXCEPTION 'training-run-id-conflict' USING ERRCODE='23514'; END IF;
    result:=public.spike127_inventory(req->>'fittingRunId');
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
      checked:=public.spike127_certificate(f.id);
      IF checked IS NULL THEN RAISE EXCEPTION 'training-run-evidence-removed'; END IF;
      IF f.kind<>'feature' OR f.player_id IS DISTINCT FROM slot->>'playerId' OR f.game_id IS DISTINCT FROM (slot->>'gameId')::uuid
          OR f.cutoff IS DISTINCT FROM (slot->>'featureCutoff')::timestamptz OR f.recorded_at>t
          OR f.body->'bundle'->'request'->>'candidate' IS DISTINCT FROM sel->>'candidate'
          OR f.body->'bundle'->>'featureVersion' IS DISTINCT FROM sel->>'featureVersion' OR f.body->'manifest'->'profileIds' IS DISTINCT FROM sel->'profileIds'
          OR (f.body->'bundle'->'target'<>'null'::jsonb AND (f.body->'bundle'->'target'->'kickoff' IS DISTINCT FROM slot->'kickoff'
            OR f.body->'bundle'->'target'->'season' IS DISTINCT FROM slot->'season' OR f.body->'bundle'->'target'->'seasonType' IS DISTINCT FROM slot->'seasonType')) THEN
        RAISE EXCEPTION 'training-feature-reference-mismatch' USING ERRCODE='23514'; END IF;
      feature_state:=CASE WHEN f.recorded_at+interval '90 days'<=t AND NOT public.predictive_training_consumer_pinned(f.id,t) THEN 'expired'
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
      checked:=public.spike127_certificate(l.id);
      IF checked IS NULL THEN RAISE EXCEPTION 'training-run-evidence-removed'; END IF;
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
  body:=body || jsonb_build_object('pinEligibility',jsonb_build_object('version','source-feature-pin-eligibility-v1','featureIds',coalesce((SELECT jsonb_agg(id ORDER BY id COLLATE "C") FROM (SELECT DISTINCT x->'selection'->>'featureId' AS id FROM jsonb_array_elements(rows) x WHERE public.predictive_training_consumer_pinned(x->'selection'->>'featureId',t)) pinned),'[]')));
  IF octet_length(public.predictive_source_canonical_json(body))>8000000 THEN RAISE EXCEPTION 'training-inventory-byte-bounds-refused' USING ERRCODE='23514'; END IF;
  INSERT INTO public.predictive_training_run_identities VALUES(identity_sha,request_sha,plan_sha,fold_sha,contract_sha,t);
  INSERT INTO public.predictive_training_runs VALUES(req->>'fittingRunId',identity_sha,body,public.predictive_source_digest(body),t);
  INSERT INTO public.predictive_training_run_events SELECT DISTINCT req->>'fittingRunId',(s->>'gameId')::uuid,s->>'partition' FROM jsonb_array_elements(req->'slots') s;
  INSERT INTO public.predictive_training_run_slots SELECT req->>'fittingRunId',(r->>'ordinal')::integer,r->'slot'->>'datasetId',r->'slot'->>'partition',
    (r->'slot'->>'gameId')::uuid,r->'slot'->>'playerId',r FROM jsonb_array_elements(rows) r;
  INSERT INTO public.predictive_training_run_profiles SELECT DISTINCT req->>'fittingRunId',x->>'profile',x->>'use' FROM jsonb_array_elements(profiles) x;
  RETURN public.spike127_inventory(req->>'fittingRunId') || jsonb_build_object('reused',false);
END
$$;
REVOKE ALL ON FUNCTION public.spike127_prepare_run(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.spike127_prepare_run(jsonb) TO predictive_recorder;
