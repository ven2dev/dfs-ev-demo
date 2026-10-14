-- Versioned compressed bindings share the released lineage, row-reference,
-- consumer and retention graph. Legacy CSV qualification remains unchanged.
CREATE TABLE public.predictive_compressed_row_authorizations (
  transaction_id xid8 NOT NULL, capture_id text NOT NULL REFERENCES public.predictive_compressed_publications(capture_id),
  PRIMARY KEY(transaction_id,capture_id)
);
REVOKE ALL ON public.predictive_compressed_row_authorizations FROM PUBLIC;

ALTER TABLE public.predictive_source_stats_rows DROP CONSTRAINT predictive_source_stats_rows_row_ordinal_check;
ALTER TABLE public.predictive_source_stats_rows ADD CONSTRAINT predictive_source_stats_rows_row_ordinal_check CHECK(row_ordinal BETWEEN 1 AND 80000);
CREATE FUNCTION public.predictive_materialized_projection_valid(capture text,projection jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE feed text; season integer;
BEGIN
  -- Only the private materializer can create this transaction authorization.
  -- It copies the already validated sealed array; deferred coverage hashes the
  -- COMPLETE typed result once per capture, rather than once per copied row.
  IF EXISTS(SELECT 1 FROM public.predictive_compressed_row_authorizations
      WHERE transaction_id=pg_current_xact_id_if_assigned() AND capture_id=capture) THEN RETURN true; END IF;
  -- Existing compressed rows still satisfy a durable shape predicate after
  -- transaction authorization is removed, including catalog/restore validation.
  SELECT p.feed,a.scope_season INTO feed,season FROM public.predictive_captures c
    JOIN public.predictive_artifacts a ON a.id=c.artifact_id JOIN public.predictive_source_profiles p ON p.id=a.profile_id
    JOIN public.predictive_compressed_publications publication ON publication.capture_id=c.id
    JOIN public.predictive_blobs blob ON blob.sha256=a.blob_sha256 WHERE c.id=capture AND blob.media_type='application/gzip';
  IF FOUND THEN RETURN public.predictive_compressed_projection_valid(projection,feed,season) IS TRUE; END IF;
  RETURN public.predictive_source_projection_valid(projection) IS TRUE;
END $$;
REVOKE ALL ON FUNCTION public.predictive_materialized_projection_valid(text,jsonb) FROM PUBLIC;
DO $grants$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_ingest') THEN
  GRANT EXECUTE ON FUNCTION public.predictive_materialized_projection_valid(text,jsonb) TO predictive_ingest;
END IF; END $grants$;

ALTER TABLE public.predictive_source_stats_rows DROP CONSTRAINT predictive_source_stats_rows_projection_check;
ALTER TABLE public.predictive_source_stats_rows ADD CONSTRAINT predictive_source_stats_rows_projection_check CHECK(projection IS NULL OR
  public.predictive_materialized_projection_valid(capture_id,projection) IS TRUE);

CREATE FUNCTION public.predictive_compressed_row_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.predictive_compressed_row_authorizations WHERE transaction_id=pg_current_xact_id_if_assigned() AND capture_id=NEW.capture_id) THEN
    RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM public.predictive_captures c JOIN public.predictive_artifacts a ON a.id=c.artifact_id
      JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256 WHERE c.id=NEW.capture_id AND b.media_type='application/gzip') THEN
    RAISE EXCEPTION 'compressed-row-materializer-required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER predictive_compressed_row_guard BEFORE INSERT ON public.predictive_source_stats_rows
FOR EACH ROW EXECUTE FUNCTION public.predictive_compressed_row_guard();

CREATE FUNCTION public.predictive_compressed_row_authorization_finish() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actual jsonb; expected text;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'rowOrdinal',row_ordinal,'rawKeySha256',raw_key_sha256,
    'selectedSha256',selected_sha256,'projection',projection,'failureCode',failure_code) ORDER BY row_ordinal),'[]') INTO actual
    FROM public.predictive_source_stats_rows WHERE capture_id=NEW.capture_id;
  SELECT claims_sha256 INTO STRICT expected FROM public.predictive_compressed_publications WHERE capture_id=NEW.capture_id;
  IF public.predictive_source_digest(actual) IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'compressed-materialized-coverage-invalid' USING ERRCODE='23514'; END IF;
  DELETE FROM public.predictive_compressed_row_authorizations WHERE transaction_id=NEW.transaction_id AND capture_id=NEW.capture_id;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER predictive_compressed_row_authorization_finish AFTER INSERT ON public.predictive_compressed_row_authorizations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.predictive_compressed_row_authorization_finish();

CREATE FUNCTION public.predictive_compressed_binding_guard() RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT pg_has_role(session_user,'predictive_recorder','MEMBER') THEN RAISE EXCEPTION 'compressed-binding-not-authorized' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(520052,1);
  PERFORM public.predictive_training_read_guard();
  LOCK TABLE public.predictive_source_stats_rows IN SHARE ROW EXCLUSIVE MODE;
  RETURN public.predictive_source_time(date_trunc('milliseconds',clock_timestamp()));
END $$;

CREATE FUNCTION public.predictive_materialize_compressed_rows(capture text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE publication public.predictive_compressed_publications;
BEGIN
  SELECT * INTO STRICT publication FROM public.predictive_compressed_publications WHERE capture_id=capture;
  IF public.predictive_source_digest(publication.claims) IS DISTINCT FROM publication.claims_sha256 THEN
    RAISE EXCEPTION 'compressed-publication-integrity-failed' USING ERRCODE='23514'; END IF;
  INSERT INTO public.predictive_compressed_row_authorizations VALUES(pg_current_xact_id(),capture) ON CONFLICT DO NOTHING;
  INSERT INTO public.predictive_source_stats_rows(id,capture_id,row_ordinal,raw_key_sha256,selected_sha256,projection,failure_code)
    SELECT x->>'id',capture,(x->>'rowOrdinal')::integer,x->>'rawKeySha256',x->>'selectedSha256',nullif(x->'projection','null'::jsonb),x->>'failureCode'
    FROM jsonb_array_elements(publication.claims) x ON CONFLICT(id) DO NOTHING;
END $$;

ALTER FUNCTION public.predictive_source_request_key(jsonb) RENAME TO predictive_source_request_key_v6;
CREATE FUNCTION public.predictive_source_request_key(req jsonb) RETURNS text
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.predictive_source_profiles WHERE id=req->>'profileId' AND parser_version='nflverse-gzip-csv-source-qualification-v1') THEN
    IF req->>'rawGameId' !~ '^(2025|2026)_[0-9]{2}_[A-Z]{2,3}_[A-Z]{2,3}$' THEN
      RAISE EXCEPTION 'predictive-source-request-invalid' USING ERRCODE='23514'; END IF;
    PERFORM public.predictive_source_request_key_v6(jsonb_set(req,'{rawGameId}',to_jsonb('2026' || substr(req->>'rawGameId',5))));
    RETURN public.predictive_source_digest(jsonb_build_array(req->>'rawGameId',req->>'rawTeam') ||
      CASE WHEN req->'rawPlayerId'='null'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(req->>'rawPlayerId') END);
  END IF;
  RETURN public.predictive_source_request_key_v6(req);
END $$;


CREATE OR REPLACE FUNCTION public.predictive_source_claim_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE cap public.predictive_captures; art public.predictive_artifacts; profile public.predictive_source_profiles;
  media text; n integer; maximum integer; minimum integer; expected_key text;
BEGIN
  IF TG_TABLE_NAME='predictive_source_stats_rows' THEN
    IF EXISTS(SELECT 1 FROM public.predictive_compressed_publications WHERE capture_id=NEW.capture_id) THEN
      RETURN NULL; -- complete sealed-array coverage is checked once at COMMIT
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'predictive_captures' THEN SELECT * INTO cap FROM public.predictive_captures WHERE id = NEW.id;
  ELSE SELECT * INTO cap FROM public.predictive_captures WHERE id = NEW.capture_id; END IF;
  SELECT * INTO art FROM public.predictive_artifacts WHERE id = cap.artifact_id;
  SELECT * INTO profile FROM public.predictive_source_profiles WHERE id = art.profile_id;
  SELECT media_type INTO media FROM public.predictive_blobs WHERE sha256 = art.blob_sha256;
  IF media='application/gzip' THEN
    -- BEFORE INSERT requires private materialization authorization. Its deferred
    -- finish independently compares the full copied array with the immutable
    -- publication seal; repeating numeric/header checks for every row adds no
    -- evidence. The released capture publication trigger still checks the seal.
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='predictive_source_stats_rows' THEN
    IF NEW.row_ordinal>8192 OR (NEW.projection IS NOT NULL AND public.predictive_source_projection_valid(NEW.projection) IS NOT TRUE) THEN
      RAISE EXCEPTION 'predictive-source-claim-envelope-invalid' USING ERRCODE='23514'; END IF;
  END IF;
  -- Existing diagnostic CSVs and the released JSON proof retain their contracts.
  IF TG_TABLE_NAME = 'predictive_captures' AND (media <> 'text/csv' OR profile.parser_version <> 'nflverse-csv-qualification-v1') THEN RETURN NULL; END IF;
  IF media <> 'text/csv' OR profile.parser_version <> 'nflverse-csv-qualification-v1'
      OR profile.allowlist_version <> 'predictive-raw-allowlist-v1' OR profile.feed NOT IN ('player','team')
      OR profile.purpose NOT IN ('source','synthetic-test') OR profile.provider <> 'nflverse'
      OR profile.release_tag IS DISTINCT FROM 'stats_' || profile.feed
      OR profile.asset_pattern IS DISTINCT FROM 'stats_' || profile.feed || '_week_2026.csv'
      OR profile.header_profile_sha256 IS NULL
      OR NOT (CASE profile.feed WHEN 'player' THEN 'player-game-stats' ELSE 'team-game-stats' END = ANY(profile.evidence_kinds))
      OR cap.state <> 'published' OR art.retrieval_kind <> 'full' OR art.scope_kind <> 'season-file'
      OR art.scope_season <> 2026 OR art.scope_filter IS NOT NULL OR cap.published_at IS NOT NULL
      OR cap.available_at <> cap.captured_at OR cap.ingested_at > clock_timestamp()
      OR NOT public.predictive_rights_allow(profile.id, clock_timestamp(), clock_timestamp(), 'internal-research') THEN
    RAISE EXCEPTION 'predictive-source-claim-envelope-invalid' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'predictive_captures' THEN
    SELECT count(*), min(row_ordinal), max(row_ordinal) INTO n, minimum, maximum
      FROM public.predictive_source_stats_rows WHERE capture_id = cap.id;
    IF n <> cap.parsed_rows OR n < 1 OR minimum <> 1 OR maximum <> n THEN
      RAISE EXCEPTION 'predictive-source-claim-coverage-invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'predictive_source_stats_rows' THEN
    IF NEW.row_ordinal > cap.parsed_rows THEN RAISE EXCEPTION 'predictive-source-claim-coverage-invalid' USING ERRCODE = '23514'; END IF;
    IF NEW.id <> 'source-row:' || encode(sha256(convert_to('[' || to_json(NEW.capture_id)::text || ',' || NEW.row_ordinal::text || ']', 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'predictive-source-claim-id-invalid' USING ERRCODE = '23514';
    END IF;
    IF NEW.projection IS NOT NULL THEN
      expected_key := '[' || to_json(NEW.projection->>'rawGameId')::text || ',' || to_json(NEW.projection->>'rawTeam')::text
        || CASE profile.feed WHEN 'player' THEN ',' || to_json(NEW.projection->>'rawPlayerId')::text ELSE '' END || ']';
      IF NEW.projection->>'feed' <> profile.feed OR NEW.raw_key_sha256 <> encode(sha256(convert_to(expected_key, 'UTF8')), 'hex') THEN
        RAISE EXCEPTION 'predictive-source-claim-key-invalid' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION public.predictive_source_plan_v3(req jsonb, rights_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE p public.predictive_source_profiles; t timestamptz; raw_key text;
  caps jsonb; cap jsonb; source_rows jsonb:='[]'; row_refs jsonb:='[]'; stats jsonb;
  reason text; candidate jsonb; deps jsonb:='[]'; links jsonb:='[]'; decisions jsonb:='[]'; rights_ids jsonb;
  ids text[]; rivals text[]; role_name text; fact text; game text; team text; opponent text; player text; chosen text;
  schedule jsonb; parts text[]; decision_ids text[]; values_count integer; bad boolean; data jsonb; b jsonb;
  d public.predictive_decisions; publications jsonb:='[]'; sealed public.predictive_compressed_publications; materialized integer;
BEGIN
  raw_key:=public.predictive_source_request_key(req); t:=(req->>'cutoff')::timestamptz;
  SELECT * INTO p FROM public.predictive_source_profiles WHERE id=req->>'profileId';
  IF rights_time IS NULL OR NOT isfinite(rights_time) OR t>rights_time OR p.id IS NULL OR p.provider<>'nflverse'
      OR p.parser_version<>'nflverse-gzip-csv-source-qualification-v1' OR p.allowlist_version<>'predictive-raw-allowlist-v1'
      OR p.release_tag IS DISTINCT FROM 'stats_' || p.feed
      OR p.asset_pattern IS DISTINCT FROM 'stats_' || p.feed || '_week_' || left(req->>'rawGameId',4) || '.csv.gz'
      OR p.header_profile_sha256 IS DISTINCT FROM (CASE p.feed WHEN 'player' THEN 'd3b3c633d85281035f40d96b180cb4e6231d8ed54e836896c4a832c4e012f42e' ELSE '9e7fda4bb987d8b3d7a8b218a830e1340af30ae832e5eabe7bdaa451dec82d7f' END)
      OR p.feed NOT IN ('player','team') OR (p.feed='player') IS DISTINCT FROM (req->'rawPlayerId'<>'null'::jsonb)
      OR public.predictive_rights_allow(p.id,rights_time,rights_time,'internal-research') IS NOT TRUE THEN
    RAISE EXCEPTION 'predictive-source-plan-rights-profile-invalid' USING ERRCODE='23514'; END IF;

  WITH eligible AS (SELECT c.*,dense_rank() OVER (ORDER BY c.captured_at DESC) AS rank
    FROM public.predictive_captures c JOIN public.predictive_artifacts a ON a.id=c.artifact_id
    JOIN public.predictive_blobs bl ON bl.sha256=a.blob_sha256 JOIN public.predictive_ingestion_runs r ON r.id=c.run_id
    JOIN public.predictive_compressed_publications publication ON publication.capture_id=c.id
    WHERE a.profile_id=p.id AND a.scope_kind='season-file' AND a.scope_season=left(req->>'rawGameId',4)::integer AND a.scope_filter IS NULL AND bl.media_type='application/gzip'
      AND c.state='published' AND r.status='published' AND c.available_at<=t AND c.ingested_at<=t
      AND publication.recorded_at<=t AND public.predictive_compressed_profile_valid(a.id))
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
    SELECT count(*) INTO materialized FROM public.predictive_source_stats_rows WHERE capture_id=cap->>'id';
    IF materialized>0 THEN
      IF materialized<>(cap->>'parsedRows')::integer THEN RAISE EXCEPTION 'compressed-materialized-coverage-invalid' USING ERRCODE='23514'; END IF;
      -- These immutable tuples are populated only by the private materializer,
      -- whose deferred finish verifies the COMPLETE sealed array before commit.
      -- This metadata kernel never claims to authenticate filesystem bytes.
      SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'rowOrdinal',s.row_ordinal,'rawKeySha256',s.raw_key_sha256,
          'selectedSha256',s.selected_sha256,'projection',s.projection,'failureCode',s.failure_code) ORDER BY s.row_ordinal),'[]'),
        coalesce(jsonb_agg(jsonb_build_object('id',s.id,'rowOrdinal',s.row_ordinal,'selectedSha256',s.selected_sha256) ORDER BY s.row_ordinal),'[]')
        INTO source_rows,row_refs FROM public.predictive_source_stats_rows s WHERE s.capture_id=cap->>'id' AND s.raw_key_sha256=raw_key;
    ELSE
    SELECT * INTO STRICT sealed FROM public.predictive_compressed_publications WHERE capture_id=cap->>'id';
    -- Publication payloads are immutable and validated when sealed. The recorder's
    -- materializer verifies their complete hash once before copying any rows.
    SELECT coalesce(jsonb_agg(x ORDER BY (x->>'rowOrdinal')::integer),'[]'),
      coalesce(jsonb_agg(jsonb_build_object('id',x->'id','rowOrdinal',x->'rowOrdinal','selectedSha256',x->'selectedSha256') ORDER BY (x->>'rowOrdinal')::integer),'[]')
      INTO source_rows,row_refs FROM jsonb_array_elements(sealed.claims) x WHERE x->>'rawKeySha256'=raw_key;
    END IF;
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
  SELECT coalesce(jsonb_agg(jsonb_build_object('captureId',sealed_publication.capture_id,'requestHash',sealed_publication.request_hash,'claimsSha256',sealed_publication.claims_sha256,
    'recordedAt',public.predictive_source_time(sealed_publication.recorded_at)) ORDER BY n),'[]') INTO publications
    FROM jsonb_array_elements(caps) WITH ORDINALITY x(c,n) JOIN public.predictive_compressed_publications sealed_publication ON sealed_publication.capture_id=c->>'id';
  b:=jsonb_build_object('version','nflverse-stats-normalization-plan-v3' ,'cutoff',req->'cutoff','sourceRequest',req,
    'sourceInputDigest',public.predictive_source_digest(jsonb_build_object('version','nflverse-gzip-csv-source-claims-v1','request',req,'captures',caps,'rows',source_rows,'publications',publications)),
    'sourceProfileId',p.id,'rawSourceKey',CASE WHEN source_rows='[]'::jsonb THEN NULL ELSE raw_key END,
    'sourceCaptures',caps,'sourceRows',row_refs,'sourcePublications',publications,'parserVersion','nflverse-gzip-csv-source-qualification-v1','projectionVersion','nflverse-raw-stats-v1',
    'dependencies',deps,'identityLinks',links,'decisions',decisions,'rightsDecisionIds',rights_ids);
  RETURN jsonb_build_object('status',CASE WHEN reason IS NULL THEN 'planned-source-normalization' ELSE 'unavailable-source-normalization' END,
    'reason',reason,'candidate',candidate,'dataDigest',public.predictive_source_digest(candidate),'binding',b,
    'planDigest',public.predictive_source_digest(jsonb_build_object('reason',reason,'candidate',candidate,'binding',b)),
    'observationsPublished',false,'featuresPublished',false,'labelsFinalized',false,'populationCoverage','unqualified');
END
$$;


ALTER FUNCTION public.predictive_source_plan_v2(jsonb,timestamptz) RENAME TO predictive_source_plan_v2_csv;
CREATE FUNCTION public.predictive_source_plan_v2(req jsonb, rights_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.predictive_source_profiles WHERE id=req->>'profileId' AND parser_version='nflverse-gzip-csv-source-qualification-v1') THEN
    RETURN public.predictive_source_plan_v3(req,rights_time);
  END IF;
  RETURN public.predictive_source_plan_v2_csv(req,rights_time);
END $$;
ALTER FUNCTION public.predictive_source_plan_check(jsonb,timestamptz,boolean) RENAME TO predictive_source_plan_check_csv;
CREATE FUNCTION public.predictive_source_plan_check(proposed jsonb, rights_time timestamptz, require_current boolean) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE expected jsonb; current_plan jsonb; req jsonb:=proposed->'binding'->'sourceRequest';
BEGIN
  IF proposed->'binding'->>'version' IS DISTINCT FROM 'nflverse-stats-normalization-plan-v3' THEN
    PERFORM public.predictive_source_plan_check_csv(proposed,rights_time,require_current); RETURN;
  END IF;
  IF require_current IS NULL THEN RAISE EXCEPTION 'predictive-source-plan-invalid' USING ERRCODE='23514'; END IF;
  expected:=public.predictive_source_plan_v3(req,rights_time);
  IF proposed IS DISTINCT FROM expected THEN RAISE EXCEPTION 'predictive-source-plan-witness-invalid' USING ERRCODE='23514'; END IF;
  IF require_current THEN
    current_plan:=public.predictive_source_plan_v3(jsonb_set(req,'{cutoff}',to_jsonb(public.predictive_source_time(rights_time))),rights_time);
    IF public.predictive_source_plan_basis(proposed) IS DISTINCT FROM public.predictive_source_plan_basis(current_plan) THEN
      RAISE EXCEPTION 'predictive-source-plan-stale' USING ERRCODE='23514'; END IF;
  END IF;
END $$;


CREATE OR REPLACE FUNCTION public.predictive_record_source_binding(binding_id text, expected_head text, proposed jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE p text:=proposed->'binding'->>'sourceProfileId'; raw_key text; t timestamptz; old public.predictive_source_bindings;
  head public.predictive_source_bindings; prior public.predictive_source_stats_revisions; revision text; kind text; data jsonb; fact text;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'predictive_recorder','MEMBER') THEN
    RAISE EXCEPTION 'predictive-source-recorder-not-authorized' USING ERRCODE='42501'; END IF;
  IF proposed->'binding'->>'version'='nflverse-stats-normalization-plan-v3' THEN
    RAISE EXCEPTION 'compressed-binding-recorder-required' USING ERRCODE='23514'; END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'predictive-source-recorder-isolation-refused' USING ERRCODE='25001'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(520052,1);
  -- Freeze the publication evidence while independently checking the proposed
  -- witness. Cooperating writers already use the global lock; SHARE also covers
  -- direct SQL appenders. No filesystem write or digest lock is needed here.
  LOCK TABLE public.predictive_source_profiles,public.predictive_rights_decisions,public.predictive_ingestion_runs,
    public.predictive_artifacts,public.predictive_blobs,public.predictive_captures,public.predictive_source_stats_rows,
    public.predictive_observations,public.predictive_artifact_observations,public.predictive_profile_identity_links,
    public.predictive_decisions,public.predictive_decision_inputs IN SHARE MODE;
  t:=date_trunc('milliseconds',pg_catalog.clock_timestamp());
  IF EXISTS (SELECT 1 FROM public.predictive_source_profiles sp WHERE sp.purpose='synthetic-test' AND
      (sp.id=p OR sp.id IN (SELECT x->>'profileId' FROM jsonb_array_elements(proposed->'binding'->'dependencies') x)))
      AND NOT public.predictive_harness_session() THEN RAISE EXCEPTION 'predictive-synthetic-outside-harness' USING ERRCODE='23514'; END IF;
  raw_key:=public.predictive_source_request_key(proposed->'binding'->'sourceRequest');
  SELECT * INTO old FROM public.predictive_source_bindings WHERE id=binding_id;
  IF old.id IS NOT NULL THEN
    IF old.plan IS DISTINCT FROM proposed OR old.predecessor_id IS DISTINCT FROM expected_head THEN RAISE EXCEPTION 'predictive-source-binding-id-conflict' USING ERRCODE='23514'; END IF;
    IF EXISTS (SELECT 1 FROM (SELECT old.profile_id AS id UNION SELECT x->>'profileId' FROM jsonb_array_elements(old.plan->'binding'->'dependencies') x) profiles
        WHERE public.predictive_rights_allow(profiles.id,t,t,'internal-research') IS NOT TRUE) THEN
      RAISE EXCEPTION 'predictive-source-plan-rights-profile-invalid' USING ERRCODE='23514'; END IF;
    RETURN jsonb_build_object('id',old.id,'recordedAt',public.predictive_source_time(old.recorded_at),'reused',true);
  END IF;
  PERFORM public.predictive_source_plan_check(proposed,t,true);
  SELECT * INTO head FROM public.predictive_source_bindings b WHERE b.profile_id=p AND b.raw_key_sha256=raw_key
    AND NOT EXISTS (SELECT 1 FROM public.predictive_source_bindings n WHERE n.predecessor_id=b.id);
  IF head.id IS DISTINCT FROM expected_head OR (head.id IS NOT NULL AND (head.recorded_at>t OR head.cutoff>(proposed->'binding'->>'cutoff')::timestamptz)) THEN
    RAISE EXCEPTION 'predictive-source-binding-head-conflict' USING ERRCODE='23514'; END IF;
  IF proposed->'candidate'<>'null'::jsonb THEN
    kind:=proposed->'candidate'->>'kind'; data:=proposed->'candidate'->'data'; fact:=public.predictive_entity_key(kind,data);
    SELECT r.* INTO prior FROM public.predictive_source_stats_revisions r WHERE r.profile_id=p AND r.source_record_id=raw_key AND r.entity_key=fact
      AND NOT EXISTS (SELECT 1 FROM public.predictive_source_stats_revisions n WHERE n.predecessor_id=r.id);
    IF prior.id IS NOT NULL AND prior.data=data AND prior.kind=kind THEN revision:=prior.id;
    ELSE
      revision:='normalized-stats:' || encode(sha256(convert_to(binding_id,'UTF8')),'hex');
      INSERT INTO public.predictive_source_stats_revisions(id,kind,profile_id,source_record_id,data,entity_key,source_key,predecessor_id,correction_reason)
        VALUES(revision,kind,p,raw_key,data,fact,fact || '|' || p || '|' || raw_key,prior.id,CASE WHEN prior.id IS NOT NULL THEN 'source-normalization-change' END);
    END IF;
  END IF;
  INSERT INTO public.predictive_source_bindings(id,profile_id,raw_key_sha256,predecessor_id,recorded_at,cutoff,plan,revision_id)
    VALUES(binding_id,p,raw_key,head.id,t,(proposed->'binding'->>'cutoff')::timestamptz,proposed,revision);
  INSERT INTO public.predictive_source_binding_captures SELECT binding_id,x->>'id' FROM jsonb_array_elements(proposed->'binding'->'sourceCaptures') x;
  INSERT INTO public.predictive_source_binding_rows SELECT binding_id,x->>'id' FROM jsonb_array_elements(proposed->'binding'->'sourceRows') x;
  INSERT INTO public.predictive_source_binding_dependencies SELECT binding_id,x->>'observationId',x->>'role',x->>'captureId',x->>'artifactId'
    FROM jsonb_array_elements(proposed->'binding'->'dependencies') x;
  INSERT INTO public.predictive_source_binding_links SELECT binding_id,x->>'id' FROM jsonb_array_elements(proposed->'binding'->'identityLinks') x;
  INSERT INTO public.predictive_source_binding_decisions SELECT binding_id,x->>'id' FROM jsonb_array_elements(proposed->'binding'->'decisions') x;
  INSERT INTO public.predictive_source_binding_rights SELECT binding_id,jsonb_array_elements_text(proposed->'binding'->'rightsDecisionIds');
  RETURN jsonb_build_object('id',binding_id,'recordedAt',public.predictive_source_time(t),'reused',false);
END
$$;

CREATE FUNCTION public.predictive_record_compressed_source_binding(binding_id text, expected_head text, proposed jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE p text:=proposed->'binding'->>'sourceProfileId'; raw_key text; t timestamptz; old public.predictive_source_bindings;
  head public.predictive_source_bindings; prior public.predictive_source_stats_revisions; revision text; kind text; data jsonb; fact text;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'predictive_recorder','MEMBER') THEN
    RAISE EXCEPTION 'predictive-source-recorder-not-authorized' USING ERRCODE='42501'; END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'predictive-source-recorder-isolation-refused' USING ERRCODE='25001'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(520052,1);
  -- Freeze the publication evidence while independently checking the proposed
  -- witness. Cooperating writers already use the global lock; SHARE also covers
  -- direct SQL appenders. No filesystem write or digest lock is needed here.
  LOCK TABLE public.predictive_source_profiles,public.predictive_rights_decisions,public.predictive_ingestion_runs,
    public.predictive_artifacts,public.predictive_blobs,public.predictive_captures,public.predictive_source_stats_rows,
    public.predictive_observations,public.predictive_artifact_observations,public.predictive_profile_identity_links,
    public.predictive_decisions,public.predictive_decision_inputs IN SHARE MODE;
  t:=date_trunc('milliseconds',pg_catalog.clock_timestamp());
  IF EXISTS (SELECT 1 FROM public.predictive_source_profiles sp WHERE sp.purpose='synthetic-test' AND
      (sp.id=p OR sp.id IN (SELECT x->>'profileId' FROM jsonb_array_elements(proposed->'binding'->'dependencies') x)))
      AND NOT public.predictive_harness_session() THEN RAISE EXCEPTION 'predictive-synthetic-outside-harness' USING ERRCODE='23514'; END IF;
  IF proposed->'binding'->>'version' IS DISTINCT FROM 'nflverse-stats-normalization-plan-v3' THEN
    RAISE EXCEPTION 'compressed-binding-version-refused' USING ERRCODE='23514'; END IF;
  PERFORM public.predictive_compressed_binding_guard();
  raw_key:=public.predictive_source_request_key(proposed->'binding'->'sourceRequest');
  SELECT * INTO old FROM public.predictive_source_bindings WHERE id=binding_id;
  IF old.id IS NOT NULL THEN
    IF old.plan IS DISTINCT FROM proposed OR old.predecessor_id IS DISTINCT FROM expected_head THEN RAISE EXCEPTION 'predictive-source-binding-id-conflict' USING ERRCODE='23514'; END IF;
    IF EXISTS (SELECT 1 FROM (SELECT old.profile_id AS id UNION SELECT x->>'profileId' FROM jsonb_array_elements(old.plan->'binding'->'dependencies') x) profiles
        WHERE public.predictive_rights_allow(profiles.id,t,t,'internal-research') IS NOT TRUE) THEN
      RAISE EXCEPTION 'predictive-source-plan-rights-profile-invalid' USING ERRCODE='23514'; END IF;
    RETURN jsonb_build_object('id',old.id,'recordedAt',public.predictive_source_time(old.recorded_at),'reused',true);
  END IF;
  PERFORM public.predictive_source_plan_check(proposed,t,true);
  PERFORM public.predictive_materialize_compressed_rows(x->>'id') FROM jsonb_array_elements(proposed->'binding'->'sourceCaptures') x;
  SELECT * INTO head FROM public.predictive_source_bindings b WHERE b.profile_id=p AND b.raw_key_sha256=raw_key
    AND NOT EXISTS (SELECT 1 FROM public.predictive_source_bindings n WHERE n.predecessor_id=b.id);
  IF head.id IS DISTINCT FROM expected_head OR (head.id IS NOT NULL AND (head.recorded_at>t OR head.cutoff>(proposed->'binding'->>'cutoff')::timestamptz)) THEN
    RAISE EXCEPTION 'predictive-source-binding-head-conflict' USING ERRCODE='23514'; END IF;
  IF proposed->'candidate'<>'null'::jsonb THEN
    kind:=proposed->'candidate'->>'kind'; data:=proposed->'candidate'->'data'; fact:=public.predictive_entity_key(kind,data);
    SELECT r.* INTO prior FROM public.predictive_source_stats_revisions r WHERE r.profile_id=p AND r.source_record_id=raw_key AND r.entity_key=fact
      AND NOT EXISTS (SELECT 1 FROM public.predictive_source_stats_revisions n WHERE n.predecessor_id=r.id);
    IF prior.id IS NOT NULL AND prior.data=data AND prior.kind=kind THEN revision:=prior.id;
    ELSE
      revision:='normalized-stats:' || encode(sha256(convert_to(binding_id,'UTF8')),'hex');
      INSERT INTO public.predictive_source_stats_revisions(id,kind,profile_id,source_record_id,data,entity_key,source_key,predecessor_id,correction_reason)
        VALUES(revision,kind,p,raw_key,data,fact,fact || '|' || p || '|' || raw_key,prior.id,CASE WHEN prior.id IS NOT NULL THEN 'source-normalization-change' END);
    END IF;
  END IF;
  INSERT INTO public.predictive_source_bindings(id,profile_id,raw_key_sha256,predecessor_id,recorded_at,cutoff,plan,revision_id)
    VALUES(binding_id,p,raw_key,head.id,t,(proposed->'binding'->>'cutoff')::timestamptz,proposed,revision);
  INSERT INTO public.predictive_source_binding_captures SELECT binding_id,x->>'id' FROM jsonb_array_elements(proposed->'binding'->'sourceCaptures') x;
  INSERT INTO public.predictive_source_binding_rows SELECT binding_id,x->>'id' FROM jsonb_array_elements(proposed->'binding'->'sourceRows') x;
  INSERT INTO public.predictive_source_binding_dependencies SELECT binding_id,x->>'observationId',x->>'role',x->>'captureId',x->>'artifactId'
    FROM jsonb_array_elements(proposed->'binding'->'dependencies') x;
  INSERT INTO public.predictive_source_binding_links SELECT binding_id,x->>'id' FROM jsonb_array_elements(proposed->'binding'->'identityLinks') x;
  INSERT INTO public.predictive_source_binding_decisions SELECT binding_id,x->>'id' FROM jsonb_array_elements(proposed->'binding'->'decisions') x;
  INSERT INTO public.predictive_source_binding_rights SELECT binding_id,jsonb_array_elements_text(proposed->'binding'->'rightsDecisionIds');
  RETURN jsonb_build_object('id',binding_id,'recordedAt',public.predictive_source_time(t),'reused',false);
END
$$;

CREATE OR REPLACE FUNCTION public.predictive_source_witness_at(req jsonb, rights_time timestamptz) RETURNS jsonb
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
      (s.provider<>'nflverse' OR s.feed NOT IN ('player','team') OR s.parser_version NOT IN ('nflverse-csv-qualification-v1','nflverse-gzip-csv-source-qualification-v1')
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

CREATE OR REPLACE FUNCTION public.predictive_training_dataset_closure(run_name text,dataset text) RETURNS jsonb
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


REVOKE ALL ON FUNCTION public.predictive_compressed_row_guard(),public.predictive_compressed_row_authorization_finish(),
  public.predictive_materialize_compressed_rows(text),public.predictive_compressed_binding_guard(),public.predictive_source_request_key_v6(jsonb),
  public.predictive_source_request_key(jsonb),public.predictive_source_plan_v3(jsonb,timestamptz),public.predictive_source_plan_v2_csv(jsonb,timestamptz),
  public.predictive_source_plan_v2(jsonb,timestamptz),public.predictive_source_plan_check_csv(jsonb,timestamptz,boolean),
  public.predictive_source_plan_check(jsonb,timestamptz,boolean),public.predictive_record_compressed_source_binding(text,text,jsonb) FROM PUBLIC;
DO $grants$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='predictive_recorder') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_compressed_binding_guard(),public.predictive_record_compressed_source_binding(text,text,jsonb) TO predictive_recorder;
  END IF;
END $grants$;


-- Scheduled expiry can occur during deferred coverage hashing at COMMIT.
-- Recheck the complete binding's research rights after that work as well.
CREATE FUNCTION public.predictive_compressed_binding_finish() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.plan->'binding'->>'version'='nflverse-stats-normalization-plan-v3' THEN
    IF EXISTS(SELECT 1 FROM (SELECT NEW.profile_id AS id UNION SELECT x->>'profileId'
        FROM jsonb_array_elements(NEW.plan->'binding'->'dependencies') x) profiles
        WHERE public.predictive_rights_allow(id,clock_timestamp(),clock_timestamp(),'internal-research') IS NOT TRUE) THEN
      RAISE EXCEPTION 'compressed-binding-rights-expired' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.predictive_compressed_binding_finish() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER predictive_compressed_binding_finish AFTER INSERT ON public.predictive_source_bindings
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.predictive_compressed_binding_finish();
