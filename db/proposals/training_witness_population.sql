-- Unnumbered experiment. No migration allocation or promotion is implied.
-- The released witness kernel validates every visible lineage before filtering.
-- Reuse that exact unfiltered result only under 0020's complete evidence guard,
-- profile/cutoff identity and rights epoch; derive identical entity projections.
CREATE OR REPLACE FUNCTION public.predictive_source_witness_at(req jsonb,rights_time timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE profiles text[]; entities text[]; t timestamptz; epoch jsonb; k jsonb; population_key jsonb;
  population jsonb; result jsonb; heads jsonb; withheld jsonb; missing jsonb; fields jsonb;
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
  epoch:=public.predictive_training_rights_epoch(rights_time);
  k:=jsonb_build_array(req,epoch);
  result:=public.predictive_training_memo_get('witness',k);
  IF result IS NOT NULL THEN RETURN result; END IF;
  population_key:=jsonb_build_array(req || jsonb_build_object('entityKeys','[]'::jsonb),epoch);
  population:=public.predictive_training_memo_get('witness-population',population_key);
  IF population IS NULL THEN
    population:=public.predictive_source_witness_at_unmemoized(req || jsonb_build_object('entityKeys','[]'::jsonb),rights_time);
    PERFORM public.predictive_training_memo_put('witness-population',population_key,population);
  END IF;
  IF cardinality(entities)=0 THEN result:=population;
  ELSE
    -- Kernel errors and scope-wide refusal precede entity selection. Keep their
    -- original empty arrays rather than inventing missing-entity evidence.
    heads:='[]'; withheld:='[]'; missing:='[]';
    IF population->>'reason' IS NULL THEN
      SELECT coalesce(jsonb_agg(x ORDER BY x->>'lineageKey' COLLATE "C"),'[]') INTO heads
        FROM jsonb_array_elements(population->'heads') x WHERE x->>'entityKey'=ANY(entities);
      -- Even unresolved lineages can retain historical known destinations.
      -- Filter those destinations too, while always retaining unresolved rows.
      SELECT coalesce(jsonb_agg(item ORDER BY item->>'lineageKey' COLLATE "C"),'[]') INTO withheld FROM (
        SELECT x || jsonb_build_object('entityKeys',coalesce((SELECT jsonb_agg(to_jsonb(key) ORDER BY key COLLATE "C")
          FROM jsonb_array_elements_text(x->'entityKeys') key WHERE key=ANY(entities)),'[]')) AS item
        FROM jsonb_array_elements(population->'withheld') x) selected
        WHERE item->>'routing'='unresolved' OR jsonb_array_length(item->'entityKeys')>0;
      SELECT coalesce(jsonb_agg(to_jsonb(key) ORDER BY key COLLATE "C"),'[]') INTO missing FROM unnest(entities) key
        WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(heads) h WHERE h->>'entityKey'=key)
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(withheld) w WHERE w->>'routing'='unresolved' OR w->'entityKeys' ? key);
    END IF;
    fields:=(population-'cutoff'-'evidenceDigest') || jsonb_build_object('entityKeys',req->'entityKeys',
      'heads',heads,'withheld',withheld,'missingEntityKeys',missing);
    result:=fields || jsonb_build_object('cutoff',req->'cutoff','evidenceDigest',public.predictive_source_digest(fields));
  END IF;
  PERFORM public.predictive_training_memo_put('witness',k,result);
  RETURN result;
END $$;
