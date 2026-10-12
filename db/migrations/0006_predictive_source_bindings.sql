-- Bound, canonical source revisions for internal research. They do not enter
-- predictive_observations or the feature/label head set until that complete
-- activation boundary is implemented. Released migrations remain unchanged.
CREATE FUNCTION public.predictive_source_canonical_json(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE jsonb_typeof($1)
    WHEN 'object' THEN '{' || coalesce((SELECT string_agg(to_jsonb(key)::text || ':' || public.predictive_source_canonical_json(v), ',' ORDER BY key COLLATE "C") FROM jsonb_each($1) e(key,v)), '') || '}'
    WHEN 'array' THEN '[' || coalesce((SELECT string_agg(public.predictive_source_canonical_json(v), ',' ORDER BY n) FROM jsonb_array_elements($1) WITH ORDINALITY e(v,n)), '') || ']'
    ELSE $1::text END
$$;
CREATE FUNCTION public.predictive_source_digest(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT encode(sha256(convert_to(public.predictive_source_canonical_json($1), 'UTF8')), 'hex') $$;
CREATE FUNCTION public.predictive_source_time(value timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT to_char($1 AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
CREATE FUNCTION public.predictive_source_set_equal(a jsonb, b jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT jsonb_typeof($1)='array' AND jsonb_typeof($2)='array'
  AND jsonb_array_length($1)=jsonb_array_length($2) AND $1 @> $2 AND $2 @> $1 $$;
CREATE FUNCTION public.predictive_source_exact(value jsonb, keys text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN jsonb_typeof($1)='object' THEN coalesce(
  (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys($1) k)=
    (SELECT array_agg(k ORDER BY k COLLATE "C") FROM unnest($2) k),false) ELSE false END $$;
CREATE FUNCTION public.predictive_source_request_key(req jsonb) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE parts text[];
BEGIN
  IF public.predictive_source_exact(req,ARRAY['profileId','rawGameId','rawTeam','rawPlayerId','cutoff']) IS NOT TRUE
      OR public.predictive_text(req->'profileId') IS NOT TRUE OR (req->>'profileId') ~ '[|]'
      OR public.predictive_instant(req->>'cutoff') IS NOT TRUE
      OR jsonb_typeof(req->'rawGameId') IS DISTINCT FROM 'string' OR (req->>'rawGameId') !~ '^2026_[0-9]{2}_[A-Z]{2,3}_[A-Z]{2,3}$'
      OR jsonb_typeof(req->'rawTeam') IS DISTINCT FROM 'string'
      OR (req->'rawPlayerId' IS DISTINCT FROM 'null'::jsonb AND public.predictive_identity(req->'rawPlayerId','player') IS NOT TRUE) THEN
    RAISE EXCEPTION 'predictive-source-request-invalid' USING ERRCODE='23514'; END IF;
  parts:=string_to_array(req->>'rawGameId','_');
  IF parts[2]::integer NOT BETWEEN 1 AND 22 OR parts[3]=parts[4] OR (req->>'rawTeam') <> ALL(parts[3:4])
      OR NOT EXISTS (SELECT 1 FROM public.predictive_teams WHERE id='nfl:team:' || parts[3])
      OR NOT EXISTS (SELECT 1 FROM public.predictive_teams WHERE id='nfl:team:' || parts[4]) THEN
    RAISE EXCEPTION 'predictive-source-request-invalid' USING ERRCODE='23514'; END IF;
  RETURN public.predictive_source_digest(jsonb_build_array(req->>'rawGameId',req->>'rawTeam') ||
    CASE WHEN req->'rawPlayerId'='null'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(req->>'rawPlayerId') END);
END
$$;
CREATE FUNCTION public.predictive_source_is_head(id text, at_time timestamptz, rights_time timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT public.predictive_observation_usable($1,$2)
  AND EXISTS (SELECT 1 FROM public.predictive_observations o WHERE o.id=$1
    AND public.predictive_rights_allow(o.profile_id,$3,$3,'internal-research'))
  AND NOT EXISTS (SELECT 1 FROM public.predictive_observations n WHERE n.predecessor_id=$1 AND public.predictive_observation_usable(n.id,$2)) $$;
CREATE FUNCTION public.predictive_source_dependencies(ids text[], role_name text, at_time timestamptz) RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT coalesce(jsonb_agg(jsonb_build_object('role',$2,'observationId',o.id,'profileId',o.profile_id,
  'sourceKey',o.source_key,'captureId',c.id,'artifactId',a.id,'artifactSha256',a.blob_sha256,
  'availableAt',public.predictive_source_time(c.available_at),'ingestedAt',public.predictive_source_time(c.ingested_at))), '[]'::jsonb)
  FROM public.predictive_observations o JOIN LATERAL (
    SELECT c.* FROM public.predictive_artifact_observations l JOIN public.predictive_captures c ON c.artifact_id=l.artifact_id
    JOIN public.predictive_ingestion_runs r ON r.id=c.run_id WHERE l.observation_id=o.id AND c.state='published' AND r.status='published'
      AND c.available_at <= $3 AND c.ingested_at <= $3
    ORDER BY c.ingested_at,c.available_at,c.captured_at,c.id COLLATE "C" LIMIT 1) c ON true
  JOIN public.predictive_artifacts a ON a.id=c.artifact_id WHERE o.id=ANY($1) $$;

CREATE TABLE public.predictive_source_stats_revisions (
  id text PRIMARY KEY CHECK (id ~ '^normalized-stats:[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('player-game-stats','team-game-stats')),
  profile_id text NOT NULL REFERENCES public.predictive_source_profiles(id),
  source_record_id text NOT NULL CHECK (source_record_id ~ '^[a-f0-9]{64}$'),
  data jsonb NOT NULL CHECK (public.predictive_payload_valid(kind,data) IS TRUE),
  entity_key text NOT NULL CHECK (entity_key=public.predictive_entity_key(kind,data)),
  source_key text NOT NULL CHECK (source_key=entity_key || '|' || profile_id || '|' || source_record_id),
  predecessor_id text,
  correction_reason text CHECK (correction_reason='source-normalization-change'),
  UNIQUE (id,source_key), UNIQUE (id,profile_id,source_record_id),
  FOREIGN KEY (predecessor_id,source_key) REFERENCES public.predictive_source_stats_revisions(id,source_key) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((predecessor_id IS NULL)=(correction_reason IS NULL)), CHECK (predecessor_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX predictive_source_revisions_successor ON public.predictive_source_stats_revisions(predecessor_id) WHERE predecessor_id IS NOT NULL;
CREATE INDEX predictive_source_revisions_entity ON public.predictive_source_stats_revisions(entity_key,profile_id,source_record_id);
CREATE TABLE public.predictive_source_bindings (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256 AND length(btrim(id))>0 AND id !~ '[[:cntrl:]|]'),
  profile_id text NOT NULL REFERENCES public.predictive_source_profiles(id),
  raw_key_sha256 text NOT NULL CHECK (raw_key_sha256 ~ '^[a-f0-9]{64}$'),
  predecessor_id text,
  recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
  cutoff timestamptz NOT NULL CHECK (isfinite(cutoff) AND cutoff <= recorded_at),
  plan jsonb NOT NULL,
  revision_id text,
  UNIQUE (id,profile_id,raw_key_sha256),
  FOREIGN KEY (predecessor_id,profile_id,raw_key_sha256) REFERENCES public.predictive_source_bindings(id,profile_id,raw_key_sha256) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (revision_id,profile_id,raw_key_sha256) REFERENCES public.predictive_source_stats_revisions(id,profile_id,source_record_id),
  CHECK (predecessor_id IS DISTINCT FROM id),
  CHECK ((revision_id IS NULL)=(plan->'candidate'='null'::jsonb))
);
CREATE UNIQUE INDEX predictive_source_bindings_root ON public.predictive_source_bindings(profile_id,raw_key_sha256) WHERE predecessor_id IS NULL;
CREATE UNIQUE INDEX predictive_source_bindings_successor ON public.predictive_source_bindings(predecessor_id) WHERE predecessor_id IS NOT NULL;
CREATE INDEX predictive_source_bindings_scope ON public.predictive_source_bindings(profile_id,raw_key_sha256,recorded_at);
CREATE TABLE public.predictive_source_binding_captures (
  binding_id text NOT NULL REFERENCES public.predictive_source_bindings(id),
  capture_id text NOT NULL REFERENCES public.predictive_captures(id), PRIMARY KEY (binding_id,capture_id)
);
CREATE TABLE public.predictive_source_binding_rows (
  binding_id text NOT NULL REFERENCES public.predictive_source_bindings(id),
  row_id text NOT NULL REFERENCES public.predictive_source_stats_rows(id), PRIMARY KEY (binding_id,row_id)
);
CREATE TABLE public.predictive_source_binding_dependencies (
  binding_id text NOT NULL REFERENCES public.predictive_source_bindings(id),
  observation_id text NOT NULL REFERENCES public.predictive_observations(id),
  role text NOT NULL CHECK (role IN ('game-bridge','team-alias','opponent-alias','player-bridge','schedule')),
  capture_id text NOT NULL REFERENCES public.predictive_captures(id),
  artifact_id text NOT NULL REFERENCES public.predictive_artifacts(id), PRIMARY KEY (binding_id,role,observation_id)
);
CREATE INDEX predictive_source_binding_dependencies_reverse ON public.predictive_source_binding_dependencies(observation_id,binding_id);
CREATE TABLE public.predictive_source_binding_links (
  binding_id text NOT NULL REFERENCES public.predictive_source_bindings(id),
  link_id text NOT NULL REFERENCES public.predictive_profile_identity_links(id), PRIMARY KEY (binding_id,link_id)
);
CREATE TABLE public.predictive_source_binding_decisions (
  binding_id text NOT NULL REFERENCES public.predictive_source_bindings(id),
  decision_id text NOT NULL REFERENCES public.predictive_decisions(id), PRIMARY KEY (binding_id,decision_id)
);
CREATE TABLE public.predictive_source_binding_rights (
  binding_id text NOT NULL REFERENCES public.predictive_source_bindings(id),
  rights_decision_id text NOT NULL REFERENCES public.predictive_rights_decisions(id), PRIMARY KEY (binding_id,rights_decision_id)
);

-- Independently recompute permitted raw rows, normalization identity and the
-- complete relevant head sets. A correctly rehashed forged plan still refuses.
CREATE FUNCTION public.predictive_source_plan_check(proposed jsonb, rights_time timestamptz, require_current boolean) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE b jsonb := proposed->'binding'; req jsonb := b->'sourceRequest'; p public.predictive_source_profiles;
  t timestamptz; raw_key text; caps jsonb; cap jsonb; source_rows jsonb; row_refs jsonb; stats jsonb;
  expected_reason text; expected_candidate jsonb; deps jsonb := '[]'; links jsonb := '[]'; decisions jsonb := '[]'; rights_ids jsonb;
  ids text[]; current_ids text[]; role_name text; fact text; game text; team text; opponent text; player text; chosen text;
  schedule jsonb; parts text[]; decision_ids text[]; values_count integer; bad boolean; candidate_data jsonb; d public.predictive_decisions;
BEGIN
  IF public.predictive_source_exact(proposed,ARRAY['status','reason','candidate','dataDigest','binding','planDigest',
        'observationsPublished','featuresPublished','labelsFinalized','populationCoverage']) IS NOT TRUE
      OR public.predictive_source_exact(b,ARRAY['version','cutoff','sourceRequest','sourceInputDigest','sourceProfileId','rawSourceKey',
        'sourceCaptures','sourceRows','parserVersion','projectionVersion','dependencies','identityLinks','decisions','rightsDecisionIds']) IS NOT TRUE THEN
    RAISE EXCEPTION 'predictive-source-plan-invalid' USING ERRCODE='23514'; END IF;
  raw_key:=public.predictive_source_request_key(req);
  IF jsonb_typeof(b->'sourceCaptures') IS DISTINCT FROM 'array' OR jsonb_typeof(b->'sourceRows') IS DISTINCT FROM 'array'
      OR jsonb_typeof(b->'dependencies') IS DISTINCT FROM 'array' OR jsonb_typeof(b->'identityLinks') IS DISTINCT FROM 'array'
      OR jsonb_typeof(b->'decisions') IS DISTINCT FROM 'array' OR jsonb_typeof(b->'rightsDecisionIds') IS DISTINCT FROM 'array'
      OR b->>'cutoff' IS DISTINCT FROM req->>'cutoff' THEN
    RAISE EXCEPTION 'predictive-source-plan-invalid' USING ERRCODE='23514'; END IF;
  t:=(b->>'cutoff')::timestamptz;
  IF rights_time IS NULL OR NOT isfinite(rights_time) OR require_current IS NULL OR b->>'version' IS DISTINCT FROM 'nflverse-stats-normalization-plan-v1' OR b->>'parserVersion' IS DISTINCT FROM 'nflverse-csv-qualification-v1'
      OR b->>'projectionVersion' IS DISTINCT FROM 'nflverse-raw-stats-v1' OR public.predictive_instant(b->>'cutoff') IS NOT TRUE
      OR t > rights_time OR req->>'cutoff' IS DISTINCT FROM b->>'cutoff' OR req->>'profileId' IS DISTINCT FROM b->>'sourceProfileId'
      OR proposed->'observationsPublished' IS DISTINCT FROM 'false'::jsonb OR proposed->'featuresPublished' IS DISTINCT FROM 'false'::jsonb
      OR proposed->'labelsFinalized' IS DISTINCT FROM 'false'::jsonb OR proposed->>'populationCoverage' IS DISTINCT FROM 'unqualified'
      OR proposed->>'planDigest' IS DISTINCT FROM public.predictive_source_digest(jsonb_build_object('reason',proposed->'reason','candidate',proposed->'candidate','binding',b)) THEN
    RAISE EXCEPTION 'predictive-source-plan-invalid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO p FROM public.predictive_source_profiles WHERE id=b->>'sourceProfileId';
  IF p.id IS NULL OR p.provider <> 'nflverse' OR p.parser_version <> 'nflverse-csv-qualification-v1' OR p.feed NOT IN ('player','team')
      OR public.predictive_rights_allow(p.id,rights_time,rights_time,'internal-research') IS NOT TRUE
      OR p.allowlist_version IS DISTINCT FROM 'predictive-raw-allowlist-v1'
      OR (p.feed='player') IS DISTINCT FROM (req->'rawPlayerId'<>'null'::jsonb) THEN
    RAISE EXCEPTION 'predictive-source-plan-rights-profile-invalid' USING ERRCODE='23514';
  END IF;
  WITH eligible AS (SELECT c.*,dense_rank() OVER (ORDER BY c.captured_at DESC) AS rank
    FROM public.predictive_captures c JOIN public.predictive_artifacts a ON a.id=c.artifact_id
    JOIN public.predictive_blobs bl ON bl.sha256=a.blob_sha256 JOIN public.predictive_ingestion_runs r ON r.id=c.run_id
    WHERE a.profile_id=p.id AND a.scope_kind='season-file' AND a.scope_season=2026 AND a.scope_filter IS NULL AND bl.media_type='text/csv'
      AND c.state='published' AND r.status='published' AND c.available_at <= t AND c.ingested_at <= t)
  SELECT jsonb_agg(jsonb_build_object('id',c.id,'runId',c.run_id,'artifactId',c.artifact_id,'capturedAt',public.predictive_source_time(c.captured_at),
    'availableAt',public.predictive_source_time(c.available_at),'ingestedAt',public.predictive_source_time(c.ingested_at),
    'parsedRows',c.parsed_rows,'sha256',a.blob_sha256,'storageRef',bl.storage_ref,'byteSize',bl.byte_size) ORDER BY c.ingested_at,c.id COLLATE "C")
    INTO caps FROM eligible c JOIN public.predictive_artifacts a ON a.id=c.artifact_id JOIN public.predictive_blobs bl ON bl.sha256=a.blob_sha256 WHERE c.rank=1;
  -- Uncaptured/ambiguous raw evidence and unresolved bridges are not recordable
  -- in this increment. Their read-only plans remain explicitly unavailable.
  IF caps IS NULL OR jsonb_array_length(caps)>256 OR (SELECT count(DISTINCT x->>'sha256') FROM jsonb_array_elements(caps) x) <> 1 THEN
    RAISE EXCEPTION 'predictive-source-plan-not-recordable' USING ERRCODE='23514';
  END IF;
  cap := caps->0;
  IF require_current AND EXISTS (SELECT 1 FROM public.predictive_captures c JOIN public.predictive_artifacts a ON a.id=c.artifact_id
      JOIN public.predictive_ingestion_runs r ON r.id=c.run_id JOIN public.predictive_blobs bl ON bl.sha256=a.blob_sha256
      WHERE a.profile_id=p.id AND a.scope_kind='season-file' AND a.scope_season=2026 AND a.scope_filter IS NULL
        AND c.state='published' AND r.status='published' AND bl.media_type='text/csv' AND c.available_at <= rights_time AND c.ingested_at <= rights_time
        AND (c.captured_at > (cap->>'capturedAt')::timestamptz OR (c.captured_at=(cap->>'capturedAt')::timestamptz AND a.blob_sha256 IS DISTINCT FROM (cap->>'sha256')))) THEN
    RAISE EXCEPTION 'predictive-source-plan-stale' USING ERRCODE='23514';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'rowOrdinal',s.row_ordinal,'rawKeySha256',s.raw_key_sha256,
      'selectedSha256',s.selected_sha256,'projection',s.projection,'failureCode',s.failure_code) ORDER BY s.row_ordinal),'[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object('id',s.id,'rowOrdinal',s.row_ordinal,'selectedSha256',s.selected_sha256) ORDER BY s.row_ordinal),'[]'::jsonb)
    INTO source_rows,row_refs FROM public.predictive_source_stats_rows s WHERE s.capture_id=cap->>'id' AND s.raw_key_sha256=raw_key;
  caps := jsonb_build_array(cap);
  IF b->'sourceCaptures' IS DISTINCT FROM caps OR b->'sourceRows' IS DISTINCT FROM row_refs
      OR b->'rawSourceKey' IS DISTINCT FROM (CASE WHEN jsonb_array_length(source_rows)=0 THEN 'null'::jsonb ELSE to_jsonb(raw_key) END)
      OR b->>'sourceInputDigest' IS DISTINCT FROM public.predictive_source_digest(jsonb_build_object('version','nflverse-csv-source-claims-v1',
        'request',req,'captures',caps,'rows',source_rows)) THEN
    RAISE EXCEPTION 'predictive-source-plan-rows-invalid' USING ERRCODE='23514';
  END IF;
  IF jsonb_array_length(source_rows)=0 THEN expected_reason := 'source-row-missing';
  ELSIF (SELECT count(DISTINCT x->>'selectedSha256') FROM jsonb_array_elements(source_rows) x)>1 THEN expected_reason := 'source-row-ambiguous';
  ELSIF source_rows->0->>'failureCode' IS NOT NULL THEN expected_reason := 'source-row-refused'; END IF;
  IF expected_reason IS NOT NULL THEN
    IF proposed->>'reason' IS DISTINCT FROM expected_reason OR proposed->'candidate' IS DISTINCT FROM 'null'::jsonb OR proposed->'dataDigest' IS DISTINCT FROM 'null'::jsonb
        OR proposed->>'status' IS DISTINCT FROM 'unavailable-source-normalization' OR b->'dependencies' IS DISTINCT FROM '[]'::jsonb OR b->'decisions' IS DISTINCT FROM '[]'::jsonb
        OR b->'identityLinks' IS DISTINCT FROM '[]'::jsonb OR b->'rightsDecisionIds' IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'predictive-source-plan-unavailable-invalid' USING ERRCODE='23514';
    END IF;
    RETURN;
  END IF;
  stats := source_rows->0->'projection';
  FOREACH role_name IN ARRAY ARRAY['game-bridge','team-alias','opponent-alias'] LOOP
    fact := CASE role_name WHEN 'game-bridge' THEN 'game-bridge:nflverse:' || (stats->>'rawGameId')
      WHEN 'team-alias' THEN 'team-alias:nflverse:' || (stats->>'rawTeam') ELSE 'team-alias:nflverse:' || (stats->>'rawOpponent') END;
    SELECT coalesce(array_agg(o.id ORDER BY o.id COLLATE "C"),'{}') INTO ids FROM public.predictive_observations o
      WHERE o.entity_key=fact AND public.predictive_source_is_head(o.id,t,rights_time);
    IF require_current THEN
      SELECT coalesce(array_agg(o.id ORDER BY o.id COLLATE "C"),'{}') INTO current_ids FROM public.predictive_observations o
        WHERE o.entity_key=fact AND public.predictive_source_is_head(o.id,rights_time,rights_time);
      IF ids<>current_ids THEN RAISE EXCEPTION 'predictive-source-plan-stale' USING ERRCODE='23514'; END IF;
    END IF;
    SELECT count(DISTINCT CASE role_name WHEN 'game-bridge' THEN o.data->>'gameId' ELSE o.data->>'teamId' END),
      coalesce(bool_or(o.kind='source-row-absent'),false), min(CASE role_name WHEN 'game-bridge' THEN o.data->>'gameId' ELSE o.data->>'teamId' END)
      FILTER (WHERE role_name='game-bridge' OR ((o.data->>'effectiveFromSeason')::integer <= (stats->>'season')::integer
        AND (o.data->>'effectiveToSeason')::integer >= (stats->>'season')::integer)) INTO values_count,bad,chosen
      FROM public.predictive_observations o WHERE o.id=ANY(ids) AND (role_name='game-bridge' OR o.kind='source-row-absent'
        OR ((o.data->>'effectiveFromSeason')::integer <= (stats->>'season')::integer AND (o.data->>'effectiveToSeason')::integer >= (stats->>'season')::integer));
    IF values_count<>1 OR bad OR chosen IS NULL THEN RAISE EXCEPTION 'predictive-source-plan-bridge-invalid' USING ERRCODE='23514'; END IF;
    IF role_name='game-bridge' THEN game:=chosen; ELSIF role_name='team-alias' THEN team:=chosen; ELSE opponent:=chosen; END IF;
    deps := deps || public.predictive_source_dependencies(ids,role_name,t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.predictive_observations o WHERE o.kind='game-bridge' AND o.game_id=game::uuid
      AND o.data->>'provider'='nflverse' AND (o.data->>'rawGameId') IS DISTINCT FROM (stats->>'rawGameId')
      AND (public.predictive_source_is_head(o.id,t,rights_time) OR (require_current AND public.predictive_source_is_head(o.id,rights_time,rights_time)))) THEN
    RAISE EXCEPTION 'predictive-source-plan-bridge-invalid' USING ERRCODE='23514';
  END IF;
  SELECT coalesce(array_agg(o.id ORDER BY o.id COLLATE "C"),'{}') INTO ids FROM public.predictive_observations o
    WHERE o.entity_key='schedule:' || game AND public.predictive_source_is_head(o.id,t,rights_time);
  IF require_current THEN
    SELECT coalesce(array_agg(o.id ORDER BY o.id COLLATE "C"),'{}') INTO current_ids FROM public.predictive_observations o
      WHERE o.entity_key='schedule:' || game AND public.predictive_source_is_head(o.id,rights_time,rights_time);
    IF ids<>current_ids THEN RAISE EXCEPTION 'predictive-source-plan-stale' USING ERRCODE='23514'; END IF;
  END IF;
  IF cardinality(ids)=1 THEN chosen:=ids[1];
  ELSIF cardinality(ids)>1 THEN
    SELECT array_agg(x.id) INTO decision_ids FROM public.predictive_decisions x WHERE x.entity_key='reconciliation:schedule:' || game AND x.kind='reconciliation'
      AND x.decided_at <= t AND NOT EXISTS (SELECT 1 FROM public.predictive_decisions n WHERE n.predecessor_id=x.id AND n.decided_at<=t)
      AND (SELECT r.status FROM public.predictive_ingestion_runs r WHERE r.id=x.run_id)='published';
    IF cardinality(decision_ids) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'predictive-source-plan-schedule-invalid' USING ERRCODE='23514'; END IF;
    SELECT * INTO d FROM public.predictive_decisions WHERE id=decision_ids[1];
    IF d.outcome->>'result' IS DISTINCT FROM 'selected' OR public.predictive_decision_current(d.id,t) IS NOT TRUE
        OR (require_current AND (SELECT array_agg(x.id ORDER BY x.id COLLATE "C") FROM public.predictive_decisions x
        JOIN public.predictive_ingestion_runs r ON r.id=x.run_id WHERE x.entity_key=d.entity_key AND x.kind='reconciliation' AND r.status='published'
          AND x.decided_at<=rights_time AND NOT EXISTS (SELECT 1 FROM public.predictive_decisions n WHERE n.predecessor_id=x.id AND n.decided_at<=rights_time)) IS DISTINCT FROM decision_ids) THEN
      RAISE EXCEPTION 'predictive-source-plan-schedule-invalid' USING ERRCODE='23514'; END IF;
    chosen:=d.outcome->>'selectedObservationId';
    decisions:=jsonb_build_array(jsonb_build_object('id',d.id,'kind',d.kind,'entityKey',d.entity_key,'policyId',d.policy_id,'mode',d.mode,
      'decidedAt',public.predictive_source_time(d.decided_at),'predecessorId',d.predecessor_id,'outcome',d.outcome,'inputs',
      (SELECT jsonb_agg(jsonb_build_object('observationId',i.observation_id,'role',i.role) ORDER BY i.observation_id COLLATE "C") FROM public.predictive_decision_inputs i WHERE i.decision_id=d.id)));
  ELSE RAISE EXCEPTION 'predictive-source-plan-schedule-invalid' USING ERRCODE='23514'; END IF;
  SELECT data INTO schedule FROM public.predictive_observations WHERE id=chosen AND kind='schedule' AND id=ANY(ids);
  IF schedule IS NULL OR EXISTS (SELECT 1 FROM public.predictive_observations s JOIN public.predictive_observations a ON a.kind='schedule'
      AND a.raw_game_id=s.raw_game_id AND a.game_id<>s.game_id WHERE s.id=ANY(ids)
        AND (public.predictive_source_is_head(a.id,t,rights_time) OR (require_current AND public.predictive_source_is_head(a.id,rights_time,rights_time)))) THEN
    RAISE EXCEPTION 'predictive-source-plan-schedule-invalid' USING ERRCODE='23514'; END IF;
  deps:=deps || public.predictive_source_dependencies(ids,'schedule',t);
  parts:=string_to_array(stats->>'rawGameId','_');
  IF schedule->'season' IS DISTINCT FROM stats->'season' OR schedule->'week' IS DISTINCT FROM stats->'week' OR schedule->'seasonType' IS DISTINCT FROM stats->'seasonType' OR team=opponent
      OR (schedule->>'homeTeamId') IS DISTINCT FROM (CASE WHEN (stats->>'rawTeam')=parts[4] THEN team ELSE opponent END)
      OR (schedule->>'awayTeamId') IS DISTINCT FROM (CASE WHEN (stats->>'rawTeam')=parts[3] THEN team ELSE opponent END) THEN
    RAISE EXCEPTION 'predictive-source-plan-context-invalid' USING ERRCODE='23514'; END IF;
  candidate_data:=jsonb_build_object('gameId',game,'rawGameId',stats->'rawGameId','teamId',team,'rawTeam',stats->'rawTeam',
    'season',stats->'season','seasonType',stats->'seasonType','missing',stats->'missing') || (stats->'values');
  IF p.feed='player' THEN
    SELECT coalesce(array_agg(o.id ORDER BY o.id COLLATE "C"),'{}') INTO ids FROM public.predictive_observations o
      WHERE o.entity_key='player-bridge:gsis:' || (stats->>'rawPlayerId') AND public.predictive_source_is_head(o.id,t,rights_time);
    IF require_current THEN
      SELECT coalesce(array_agg(o.id ORDER BY o.id COLLATE "C"),'{}') INTO current_ids FROM public.predictive_observations o
        WHERE o.entity_key='player-bridge:gsis:' || (stats->>'rawPlayerId') AND public.predictive_source_is_head(o.id,rights_time,rights_time);
      IF ids<>current_ids THEN RAISE EXCEPTION 'predictive-source-plan-stale' USING ERRCODE='23514'; END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM public.predictive_observations o WHERE o.id=ANY(ids) AND o.kind='source-row-absent') THEN
      RAISE EXCEPTION 'predictive-source-plan-player-invalid' USING ERRCODE='23514'; END IF;
    SELECT count(DISTINCT o.player_id),min(o.player_id) INTO values_count,player FROM public.predictive_observations o WHERE o.id=ANY(ids)
      AND (o.data->>'effectiveFrom')::timestamptz <= (schedule->>'kickoff')::timestamptz AND (schedule->>'kickoff')::timestamptz < (o.data->>'effectiveTo')::timestamptz;
    IF values_count<>1 OR EXISTS (SELECT 1 FROM public.predictive_observations o WHERE o.kind='player-bridge' AND o.player_id=player
        AND o.data->>'provider'='gsis' AND (o.data->>'rawPlayerId') IS DISTINCT FROM (stats->>'rawPlayerId')
        AND (o.data->>'effectiveFrom')::timestamptz <= (schedule->>'kickoff')::timestamptz AND (schedule->>'kickoff')::timestamptz < (o.data->>'effectiveTo')::timestamptz
        AND (public.predictive_source_is_head(o.id,t,rights_time) OR (require_current AND public.predictive_source_is_head(o.id,rights_time,rights_time)))) THEN
      RAISE EXCEPTION 'predictive-source-plan-player-invalid' USING ERRCODE='23514'; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',k.id,'statsProfileId',k.stats_profile_id,'bridgeProfileId',k.bridge_profile_id,
      'provider',k.provider,'decidedAt',public.predictive_source_time(k.decided_at))),'[]'::jsonb) INTO links FROM public.predictive_profile_identity_links k
      WHERE k.stats_profile_id=p.id AND k.provider='gsis' AND k.decided_at<=t AND EXISTS (SELECT 1 FROM public.predictive_observations o WHERE o.id=ANY(ids)
        AND o.profile_id=k.bridge_profile_id AND o.player_id=player AND (o.data->>'effectiveFrom')::timestamptz <= (schedule->>'kickoff')::timestamptz
        AND (schedule->>'kickoff')::timestamptz < (o.data->>'effectiveTo')::timestamptz);
    IF require_current AND EXISTS (SELECT 1 FROM public.predictive_profile_identity_links k
        WHERE k.stats_profile_id=p.id AND k.provider='gsis' AND k.decided_at>t AND k.decided_at<=rights_time
          AND EXISTS (SELECT 1 FROM public.predictive_observations o WHERE o.id=ANY(ids) AND o.profile_id=k.bridge_profile_id
            AND o.player_id=player AND (o.data->>'effectiveFrom')::timestamptz <= (schedule->>'kickoff')::timestamptz
            AND (schedule->>'kickoff')::timestamptz < (o.data->>'effectiveTo')::timestamptz)) THEN
      RAISE EXCEPTION 'predictive-source-plan-stale' USING ERRCODE='23514'; END IF;
    IF links='[]'::jsonb THEN RAISE EXCEPTION 'predictive-source-plan-player-invalid' USING ERRCODE='23514'; END IF;
    deps:=deps || public.predictive_source_dependencies(ids,'player-bridge',t);
    candidate_data:=candidate_data || jsonb_build_object('playerId',player,'rawPlayerId',stats->'rawPlayerId','playerIdProvider','gsis');
  END IF;
  SELECT jsonb_agg(to_jsonb(public.predictive_rights_in_force(id,rights_time,rights_time))) INTO rights_ids FROM (
    SELECT p.id UNION SELECT x->>'profileId' FROM jsonb_array_elements(deps) x) profiles(id);
  expected_candidate:=jsonb_build_object('kind',CASE p.feed WHEN 'player' THEN 'player-game-stats' ELSE 'team-game-stats' END,'data',candidate_data);
  IF proposed->>'status' IS DISTINCT FROM 'planned-source-normalization' OR proposed->'reason' IS DISTINCT FROM 'null'::jsonb
      OR proposed->'candidate' IS DISTINCT FROM expected_candidate OR proposed->>'dataDigest' IS DISTINCT FROM public.predictive_source_digest(expected_candidate)
      OR public.predictive_source_set_equal(b->'dependencies',deps) IS NOT TRUE OR public.predictive_source_set_equal(b->'identityLinks',links) IS NOT TRUE
      OR public.predictive_source_set_equal(b->'decisions',decisions) IS NOT TRUE OR public.predictive_source_set_equal(b->'rightsDecisionIds',rights_ids) IS NOT TRUE THEN
    RAISE EXCEPTION 'predictive-source-plan-normalization-invalid' USING ERRCODE='23514'; END IF;
END
$$;

CREATE FUNCTION public.predictive_record_source_binding(binding_id text, expected_head text, proposed jsonb) RETURNS jsonb
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

DO $immutable$
DECLARE rel text;
BEGIN
  FOREACH rel IN ARRAY ARRAY['predictive_source_stats_revisions','predictive_source_bindings','predictive_source_binding_captures',
    'predictive_source_binding_rows','predictive_source_binding_dependencies','predictive_source_binding_links','predictive_source_binding_decisions','predictive_source_binding_rights'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.predictive_append_only()',rel || '_immutable',rel);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.predictive_append_only()',rel || '_no_truncate',rel);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',rel);
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='predictive_replay') THEN EXECUTE format('GRANT SELECT ON public.%I TO predictive_replay',rel); END IF;
  END LOOP;
END
$immutable$;
REVOKE ALL ON FUNCTION public.predictive_source_canonical_json(jsonb),public.predictive_source_digest(jsonb),public.predictive_source_time(timestamptz),
  public.predictive_source_set_equal(jsonb,jsonb),public.predictive_source_exact(jsonb,text[]),public.predictive_source_request_key(jsonb),public.predictive_source_is_head(text,timestamptz,timestamptz),public.predictive_source_dependencies(text[],text,timestamptz),
  public.predictive_source_plan_check(jsonb,timestamptz,boolean),public.predictive_record_source_binding(text,text,jsonb) FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='predictive_recorder') THEN
    GRANT EXECUTE ON FUNCTION public.predictive_record_source_binding(text,text,jsonb) TO predictive_recorder;
  END IF;
END
$grants$;

-- Retention deletes a complete affected raw chain, including its older bindings.
-- A missing tail must never reactivate an earlier canonical contribution.
ALTER TABLE public.predictive_retention_tombstones DROP CONSTRAINT predictive_retention_tombstones_target_kind_check;
ALTER TABLE public.predictive_retention_tombstones ADD CONSTRAINT predictive_retention_tombstones_target_kind_check
  CHECK (target_kind IN ('observation','artifact','capture','decision','label','feature-run','pin','blob','source-stats-row','source-binding','source-stats-revision'));
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
        EXISTS (SELECT 1 FROM public.predictive_source_binding_captures x WHERE x.binding_id=b.id AND x.capture_id=ANY(caps))
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
