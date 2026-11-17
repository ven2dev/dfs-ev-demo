-- #221 qualification only; additive nullable columns on the existing odds cache.
-- Not an ordered migration or an authorization to apply this to a hosted DB.
ALTER TABLE event_market_odds_cache ADD COLUMN refresh_owner text;
ALTER TABLE event_market_odds_cache ADD COLUMN refresh_lease_until timestamptz;
ALTER TABLE event_market_odds_cache ADD COLUMN refresh_claimed_at timestamptz;

CREATE FUNCTION claim_shared_odds_batch(p_event text,p_keys text[],p_owner text,p_ttl_ms int,p_lease_ms int)
RETURNS TABLE(outcome text,owned_keys text[],claimed_at timestamptz,resources jsonb) LANGUAGE plpgsql AS $$
DECLARE k text; keys text[]; eligible text[]; t timestamptz; states jsonb;
BEGIN
  SELECT array_agg(DISTINCT x ORDER BY x) INTO keys FROM unnest(p_keys) x;
  IF keys IS NULL OR cardinality(keys)>12 OR p_owner IS NULL OR length(p_owner)=0
    OR p_ttl_ms IS NULL OR p_ttl_ms<1 OR p_lease_ms IS NULL OR p_lease_ms<1
    OR p_event IS NULL OR length(p_event) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'invalid bounded batch';
  END IF;
  FOREACH k IN ARRAY keys LOOP
    INSERT INTO event_market_odds_cache(event_id,market_key,payload,fetched_at)
      VALUES(p_event,k,'{"bookmakers":[]}'::jsonb,'epoch'::timestamptz)
      ON CONFLICT(event_id,market_key) DO NOTHING;
  END LOOP;
  PERFORM 1 FROM event_market_odds_cache c WHERE c.event_id=p_event AND c.market_key=ANY(keys)
    ORDER BY c.market_key FOR UPDATE;
  t:=clock_timestamp();
  -- Cooldown is fixed per key, independent of the caller's payload TTL.
  SELECT array_agg(c.market_key ORDER BY c.market_key) INTO eligible FROM event_market_odds_cache c
    WHERE c.event_id=p_event AND c.market_key=ANY(keys)
      AND c.fetched_at<=t-p_ttl_ms*interval '1 millisecond'
      AND (c.refresh_claimed_at IS NULL OR c.refresh_claimed_at<=t-interval '20 seconds');
  SELECT jsonb_object_agg(c.market_key,jsonb_build_object(
    'state',CASE WHEN c.fetched_at>t-p_ttl_ms*interval '1 millisecond' THEN 'fresh'
      WHEN c.refresh_claimed_at>t-interval '20 seconds'
        THEN CASE WHEN c.fetched_at>'epoch'::timestamptz THEN 'stale' ELSE 'unavailable' END
      ELSE 'pending' END,
    'payload',CASE WHEN c.fetched_at>'epoch'::timestamptz THEN c.payload ELSE NULL END,
    'fetchedAt',CASE WHEN c.fetched_at>'epoch'::timestamptz THEN c.fetched_at ELSE NULL END))
    INTO states FROM event_market_odds_cache c WHERE c.event_id=p_event AND c.market_key=ANY(keys);
  -- Active ownership still wins even when its attempt cooldown has expired.
  IF EXISTS(SELECT FROM event_market_odds_cache c WHERE c.event_id=p_event AND c.market_key=ANY(keys)
    AND c.fetched_at<=t-p_ttl_ms*interval '1 millisecond'
    AND c.refresh_owner IS NOT NULL AND c.refresh_lease_until>t) THEN
    RETURN QUERY SELECT 'follower'::text,'{}'::text[],NULL::timestamptz,states; RETURN;
  END IF;
  IF eligible IS NULL THEN
    RETURN QUERY SELECT 'complete'::text,'{}'::text[],NULL::timestamptz,states; RETURN;
  END IF;
  UPDATE event_market_odds_cache c SET refresh_owner=p_owner,
    refresh_lease_until=t+p_lease_ms*interval '1 millisecond',refresh_claimed_at=t
    WHERE c.event_id=p_event AND c.market_key=ANY(eligible);
  RETURN QUERY SELECT 'leader'::text,eligible,t,states;
END $$;

CREATE FUNCTION renew_shared_odds_batch(p_event text,p_keys text[],p_owner text,p_lease_ms int)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE matches int;
BEGIN
 PERFORM 1 FROM event_market_odds_cache c WHERE c.event_id=p_event AND c.market_key=ANY(p_keys) ORDER BY c.market_key FOR UPDATE;
 SELECT count(*) INTO matches FROM event_market_odds_cache c WHERE c.event_id=p_event AND c.market_key=ANY(p_keys)
   AND c.refresh_owner=p_owner AND c.refresh_lease_until>clock_timestamp();
 IF matches<>cardinality(p_keys) OR matches=0 THEN RETURN false; END IF;
 UPDATE event_market_odds_cache c SET refresh_lease_until=clock_timestamp()+p_lease_ms*interval '1 millisecond'
  WHERE c.event_id=p_event AND c.market_key=ANY(p_keys) AND c.refresh_owner=p_owner;
 RETURN true;
END $$;

CREATE FUNCTION publish_shared_odds_batch(p_event text,p_keys text[],p_owner text,p_payloads jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE matches int;
BEGIN
 PERFORM 1 FROM event_market_odds_cache c WHERE c.event_id=p_event AND c.market_key=ANY(p_keys) ORDER BY c.market_key FOR UPDATE;
 SELECT count(*) INTO matches FROM event_market_odds_cache c WHERE c.event_id=p_event AND c.market_key=ANY(p_keys)
   AND c.refresh_owner=p_owner AND c.refresh_lease_until>clock_timestamp();
 IF matches<>cardinality(p_keys) OR matches=0 OR (SELECT count(*) FROM jsonb_object_keys(p_payloads))<>matches THEN
   RAISE EXCEPTION 'lost owner or incomplete publication';
 END IF;
 IF EXISTS(SELECT FROM unnest(p_keys) k WHERE NOT p_payloads ? k) THEN RAISE EXCEPTION 'missing market'; END IF;
 UPDATE event_market_odds_cache c SET payload=p_payloads->c.market_key,fetched_at=clock_timestamp(),
   refresh_owner=NULL,refresh_lease_until=NULL
  WHERE c.event_id=p_event AND c.market_key=ANY(p_keys) AND c.refresh_owner=p_owner;
END $$;

CREATE FUNCTION release_shared_odds_batch(p_event text,p_keys text[],p_owner text)
RETURNS void LANGUAGE sql AS $$
 UPDATE event_market_odds_cache c SET refresh_owner=NULL,refresh_lease_until=NULL
 WHERE c.event_id=p_event AND c.market_key=ANY(p_keys) AND c.refresh_owner=p_owner;
 -- refresh_claimed_at deliberately survives release/publication failure.
$$;
