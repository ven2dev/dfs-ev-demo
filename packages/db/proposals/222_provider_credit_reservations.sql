-- #222 proposal only: not an ordered migration or permission to apply hosted SQL.
-- Apply after #221 for raw ownership checks. No quota is initialized by this DDL.
-- Functions are owned by the reviewed migration authority, never the app role.
-- PUBLIC has no access; activation grants EXECUTE separately to serving/operator
-- roles. Fully qualified relations plus transaction-local pg_catalog search_path
-- prevent caller search-path objects from running with definer privileges.
CREATE SCHEMA provider_credit;
REVOKE ALL ON SCHEMA provider_credit FROM PUBLIC;

CREATE TABLE provider_credit.account (
  id smallint PRIMARY KEY CHECK (id = 1),
  initialized boolean NOT NULL DEFAULT false,
  period text,
  period_ends_at timestamptz,
  provider_remaining bigint NOT NULL DEFAULT 0 CHECK (provider_remaining BETWEEN 0 AND 9007199254740991),
  provider_used bigint NOT NULL DEFAULT 0 CHECK (provider_used BETWEEN 0 AND 9007199254740991),
  quota_total bigint NOT NULL DEFAULT 0 CHECK (quota_total BETWEEN 0 AND 9007199254740991),
  pending_liability bigint NOT NULL DEFAULT 0 CHECK (pending_liability >= 0),
  pending_count bigint NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  collector_floor bigint NOT NULL DEFAULT 0 CHECK (collector_floor >= 0),
  observed_at timestamptz,
  quota_freshness_ms integer,
  health_reason text CHECK (health_reason IS NULL OR health_reason = 'period-mismatch'),
  CHECK (NOT initialized OR (period IS NOT NULL AND period_ends_at IS NOT NULL
    AND observed_at IS NOT NULL AND quota_freshness_ms BETWEEN 1 AND 3600000))
);
-- Sentinel serializes even first initialization; it grants zero spend authority.
INSERT INTO provider_credit.account(id) VALUES (1);

CREATE TABLE provider_credit.attempts (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  mode text NOT NULL CHECK (mode IN ('log-only', 'enforce')),
  kind text NOT NULL CHECK (kind IN ('raw', 'collector')),
  resource_id text NOT NULL,
  owner_id text NOT NULL,
  sport_key text NOT NULL,
  market_keys text[] NOT NULL,
  expected_cost integer NOT NULL CHECK (expected_cost BETWEEN 1 AND 12),
  derived_cost integer NOT NULL CHECK (derived_cost BETWEEN 1 AND 12),
  original_period text NOT NULL,
  admitted boolean NOT NULL,
  decision_reason text NOT NULL,
  liability bigint NOT NULL CHECK (liability >= 0),
  settled boolean NOT NULL,
  actual_cost bigint,
  response_fingerprint jsonb,
  decision jsonb NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  settlement_kind text CHECK (settlement_kind IN ('response', 'operator')),
  CHECK (admitted OR liability = 0),
  CHECK (mode = 'enforce' OR NOT admitted)
);
CREATE INDEX provider_credit_unresolved ON provider_credit.attempts(reserved_at, id)
  WHERE admitted AND NOT settled;
CREATE TABLE provider_credit.operations (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  actor text NOT NULL,
  login_role text NOT NULL,
  action text NOT NULL CHECK (action IN ('initialize', 'resolve')),
  fingerprint jsonb NOT NULL,
  result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON ALL TABLES IN SCHEMA provider_credit FROM PUBLIC;

CREATE FUNCTION provider_credit.reserve(
  p_id text, p_mode text, p_kind text, p_resource text, p_owner text,
  p_sport text, p_markets text[], p_expected_cost integer, p_period text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$
DECLARE
  b provider_credit.account; a provider_credit.attempts;
  cp public.odds_collection_checkpoints;
  keys text[]; checkpoint_keys text[]; cost integer; owned integer;
  reason text; available bigint; result jsonb; fingerprint jsonb;
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog', true);
  IF p_id IS NULL OR length(p_id) NOT BETWEEN 1 AND 128
    OR p_mode IS NULL OR p_mode NOT IN ('log-only','enforce')
    OR p_kind IS NULL OR p_kind NOT IN ('raw','collector')
    OR p_resource IS NULL OR length(p_resource) NOT BETWEEN 1 AND 128
    OR p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 128
    OR p_period IS NULL OR length(p_period) NOT BETWEEN 1 AND 128
    OR p_sport IS DISTINCT FROM 'americanfootball_nfl'
    OR p_expected_cost IS NULL OR p_expected_cost NOT BETWEEN 1 AND 12
    OR p_markets IS NULL OR array_ndims(p_markets) IS DISTINCT FROM 1
    OR cardinality(p_markets) NOT BETWEEN 1 AND 12
    OR EXISTS (SELECT FROM unnest(p_markets) k WHERE k IS NULL OR length(k) NOT BETWEEN 1 AND 64)
  THEN RAISE EXCEPTION 'invalid credit reservation'; END IF;
  SELECT array_agg(DISTINCT k ORDER BY k) INTO keys FROM unnest(p_markets) k;
  cost := cardinality(keys);
  fingerprint := jsonb_build_array(p_mode,p_kind,p_resource,p_owner,p_sport,keys,p_expected_cost,p_period);

  -- The sole explicit write lock in reservation. Ownership is read afterwards,
  -- so a replaced owner during the account wait is not admitted from old state.
  IF p_mode = 'enforce' THEN
    SELECT * INTO b FROM provider_credit.account WHERE id=1 FOR UPDATE;
  ELSE
    SELECT * INTO b FROM provider_credit.account WHERE id=1;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit authority unavailable'; END IF;
  SELECT * INTO a FROM provider_credit.attempts WHERE id=p_id;
  IF FOUND THEN
    IF jsonb_build_array(a.mode,a.kind,a.resource_id,a.owner_id,a.sport_key,a.market_keys,a.expected_cost,a.original_period)
      IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'credit reservation identity conflict'; END IF;
    RETURN a.decision || jsonb_build_object('outcome','replay','allowed',false);
  END IF;

  reason := 'reserved';
  IF p_kind='collector' THEN
    -- No row lock. Only the claimed checkpoint's canonical set authorizes cost.
    SELECT * INTO cp FROM public.odds_collection_checkpoints WHERE id=p_resource;
    IF NOT FOUND OR cp.status<>'claimed' OR cp.claim_owner IS DISTINCT FROM p_owner
      OR cp.claim_expires_at IS NULL OR cp.claim_expires_at<=clock_timestamp()
      OR cp.sport_key IS DISTINCT FROM p_sport
      OR cp.due_window_end<=clock_timestamp() OR cp.event_start_time<=clock_timestamp()
    THEN reason := 'owner-expired';
    ELSE
      SELECT array_agg(DISTINCT k ORDER BY k) INTO checkpoint_keys FROM unnest(cp.market_keys) k;
      IF cardinality(checkpoint_keys) NOT BETWEEN 1 AND 12 THEN reason := 'cost-mismatch';
      ELSE
        cost := cardinality(checkpoint_keys);
        IF checkpoint_keys IS DISTINCT FROM keys OR cost<>p_expected_cost THEN reason := 'cost-mismatch'; END IF;
      END IF;
    END IF;
  ELSE
    -- #221 cache columns are proposal-only. Current-schema shadow mode does not
    -- inspect them; it preserves pre-initialization legacy refresh compatibility.
    IF p_mode='enforce' THEN
      SELECT count(*) INTO owned FROM public.event_market_odds_cache c
        WHERE c.event_id=p_resource AND c.market_key=ANY(keys)
          AND c.refresh_owner=p_owner AND c.refresh_lease_until>clock_timestamp();
      IF owned<>cardinality(keys) THEN reason := 'owner-expired'; END IF;
    END IF;
    IF cost<>p_expected_cost THEN reason := 'cost-mismatch'; END IF;
  END IF;

  available := CASE WHEN b.initialized THEN greatest(0,b.provider_remaining-b.pending_liability) ELSE NULL END;
  IF reason='reserved' THEN
    IF NOT b.initialized THEN reason := 'uninitialized';
    ELSIF b.period IS DISTINCT FROM p_period OR b.period_ends_at<=clock_timestamp()
      OR b.health_reason='period-mismatch' THEN reason := 'period-mismatch';
    ELSIF b.observed_at<clock_timestamp()-b.quota_freshness_ms*interval '1 millisecond'
      THEN reason := 'quota-stale';
    ELSIF available-cost<(CASE WHEN p_kind='collector' THEN 0 ELSE b.collector_floor END)
      THEN reason := 'insufficient-credit';
    END IF;
  END IF;
  IF p_mode='enforce' AND reason='period-mismatch' THEN
    UPDATE provider_credit.account SET health_reason='period-mismatch' WHERE id=1;
  END IF;
  result := jsonb_build_object(
    'outcome',CASE WHEN p_mode='log-only' THEN 'shadow' WHEN reason='reserved' THEN 'reserved' ELSE 'denied' END,
    'allowed',p_mode='enforce' AND reason='reserved', 'reason',reason,
    'reservationId',p_id,'cost',cost,'availableCredits',available,'period',b.period);
  IF p_mode='enforce' AND reason='reserved' THEN
    UPDATE provider_credit.account SET pending_liability=pending_liability+cost,
      pending_count=pending_count+1 WHERE id=1;
  END IF;
  -- A denied reservation keeps its one audit row. Followers/replays add none.
  -- The unique conflict path also serializes shadow duplicates without account
  -- write locks; a conflict rolls back this statement before it can authorize.
  INSERT INTO provider_credit.attempts(id,mode,kind,resource_id,owner_id,sport_key,market_keys,
    expected_cost,derived_cost,original_period,admitted,decision_reason,liability,settled,decision)
  VALUES(p_id,p_mode,p_kind,p_resource,p_owner,p_sport,keys,p_expected_cost,cost,p_period,
    p_mode='enforce' AND reason='reserved',reason,
    CASE WHEN p_mode='enforce' AND reason='reserved' THEN cost ELSE 0 END,
    NOT (p_mode='enforce' AND reason='reserved'),result)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    IF p_mode='enforce' THEN RAISE EXCEPTION 'credit reservation identity conflict'; END IF;
    SELECT * INTO a FROM provider_credit.attempts WHERE id=p_id;
    IF jsonb_build_array(a.mode,a.kind,a.resource_id,a.owner_id,a.sport_key,a.market_keys,a.expected_cost,a.original_period)
      IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'credit reservation identity conflict'; END IF;
    RETURN a.decision || jsonb_build_object('outcome','replay','allowed',false);
  END IF;
  RETURN result;
END $$;

CREATE FUNCTION provider_credit.reconcile(
  p_id text, p_actual bigint, p_remaining bigint, p_used bigint, p_period text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$
DECLARE b provider_credit.account; a provider_credit.attempts; fingerprint jsonb; extra bigint;
BEGIN
  PERFORM pg_catalog.set_config('search_path','pg_catalog',true);
  IF p_actual IS NULL OR p_actual NOT BETWEEN 0 AND 9007199254740991 THEN
    RAISE EXCEPTION 'invalid actual credit cost'; END IF;
  SELECT * INTO b FROM provider_credit.account WHERE id=1 FOR UPDATE;
  SELECT * INTO a FROM provider_credit.attempts WHERE id=p_id;
  IF NOT FOUND OR NOT a.admitted THEN RAISE EXCEPTION 'unknown admitted reservation'; END IF;
  fingerprint := jsonb_build_array(p_actual,p_remaining,p_used,p_period);
  IF a.settled THEN
    IF a.settlement_kind='response' AND a.response_fingerprint=fingerprint THEN
      RETURN jsonb_build_object('outcome','replay'); END IF;
    RAISE EXCEPTION 'credit reconciliation conflict';
  END IF;
  IF a.actual_cost IS NOT NULL AND a.actual_cost<>p_actual THEN RAISE EXCEPTION 'actual credit cost conflict'; END IF;
  extra := greatest(0,p_actual-a.liability);
  UPDATE provider_credit.attempts SET actual_cost=p_actual,liability=liability+extra WHERE id=p_id;
  UPDATE provider_credit.account SET pending_liability=pending_liability+extra WHERE id=1;
  -- Old-period headers cannot settle against/overwrite a new period. Carry debt
  -- remains for audited operator resolution, even when the response arrives late.
  IF p_period IS DISTINCT FROM b.period OR a.original_period IS DISTINCT FROM b.period THEN
    UPDATE provider_credit.account SET health_reason='period-mismatch' WHERE id=1;
    RETURN jsonb_build_object('outcome','unresolved','reason','period-mismatch');
  END IF;
  IF p_remaining IS NULL OR p_remaining NOT BETWEEN 0 AND 9007199254740991
    OR p_used IS NULL OR p_used NOT BETWEEN 0 AND 9007199254740991
    OR p_used<p_actual OR p_remaining+p_used<>b.quota_total THEN
    RETURN jsonb_build_object('outcome','unresolved','reason','invalid-quota');
  END IF;
  -- A caller without response headers never invokes settlement with invented
  -- numbers. Its liability survives indefinitely, including across initialization.
  IF p_used>=b.provider_used THEN
    UPDATE provider_credit.account SET provider_remaining=p_remaining,provider_used=p_used,
      observed_at=clock_timestamp() WHERE id=1;
  END IF;
  UPDATE provider_credit.account SET pending_liability=pending_liability-a.liability-extra,
    pending_count=pending_count-1 WHERE id=1;
  UPDATE provider_credit.attempts SET liability=0,settled=true,settled_at=clock_timestamp(),
    settlement_kind='response',response_fingerprint=fingerprint WHERE id=p_id;
  RETURN jsonb_build_object('outcome','settled');
END $$;

CREATE FUNCTION provider_credit.initialize(
  p_operation text,p_actor text,p_remaining bigint,p_used bigint,p_period text,
  p_period_ends_at timestamptz,p_floor bigint,p_freshness_ms integer,p_reference text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$
DECLARE b provider_credit.account; o provider_credit.operations; fingerprint jsonb; result jsonb;
BEGIN
  PERFORM pg_catalog.set_config('search_path','pg_catalog',true);
  IF p_operation IS NULL OR length(p_operation) NOT BETWEEN 1 AND 128
    OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 128
    OR p_reference IS NULL OR p_reference !~ '^[A-Za-z0-9._:-]{1,128}$'
    OR p_remaining IS NULL OR p_remaining NOT BETWEEN 0 AND 9007199254740991
    OR p_used IS NULL OR p_used NOT BETWEEN 0 AND 9007199254740991
    OR p_remaining+p_used>9007199254740991
    OR p_period IS NULL OR length(p_period) NOT BETWEEN 1 AND 128
    OR p_period_ends_at IS NULL OR NOT isfinite(p_period_ends_at)
    OR p_floor IS NULL OR p_floor NOT BETWEEN 0 AND 9007199254740991
    OR p_freshness_ms IS NULL OR p_freshness_ms NOT BETWEEN 1 AND 3600000
  THEN RAISE EXCEPTION 'invalid credit initialization'; END IF;
  SELECT * INTO b FROM provider_credit.account WHERE id=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit authority unavailable'; END IF;
  fingerprint := jsonb_build_array(p_remaining,p_used,p_period,p_period_ends_at,p_floor,p_freshness_ms,p_reference);
  SELECT * INTO o FROM provider_credit.operations WHERE id=p_operation;
  IF FOUND THEN
    IF o.actor<>p_actor OR o.action<>'initialize' OR o.fingerprint<>fingerprint THEN
      RAISE EXCEPTION 'credit operator identity conflict'; END IF;
    RETURN o.result || jsonb_build_object('outcome','replay');
  END IF;
  IF p_period_ends_at<=clock_timestamp() THEN RAISE EXCEPTION 'credit period already ended'; END IF;
  -- Owner decision b: preserve pending total/count from ALL original periods.
  -- Neither changing the period nor initializing fresh quota forgives old debt.
  UPDATE provider_credit.account SET initialized=true,period=p_period,period_ends_at=p_period_ends_at,
    provider_remaining=p_remaining,provider_used=p_used,quota_total=p_remaining+p_used,
    collector_floor=p_floor,observed_at=clock_timestamp(),quota_freshness_ms=p_freshness_ms,
    health_reason=NULL WHERE id=1;
  result := jsonb_build_object('outcome','initialized','period',p_period,
    'unresolvedLiabilityTotal',b.pending_liability,'unresolvedLiabilityCount',b.pending_count,
    'availableCredits',greatest(0,p_remaining-b.pending_liability));
  INSERT INTO provider_credit.operations VALUES(p_operation,p_actor,session_user,'initialize',fingerprint,result,clock_timestamp());
  RETURN result;
END $$;

CREATE FUNCTION provider_credit.resolve_unknown(
  p_operation text,p_actor text,p_attempt text,p_evidence jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$
DECLARE b provider_credit.account; a provider_credit.attempts; o provider_credit.operations;
  fingerprint jsonb; result jsonb;
BEGIN
  PERFORM pg_catalog.set_config('search_path','pg_catalog',true);
  IF p_operation IS NULL OR length(p_operation) NOT BETWEEN 1 AND 128
    OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 128
    OR p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'object'
    OR p_evidence->>'kind' IS NULL OR p_evidence->>'kind' NOT IN ('provider-confirmed-no-charge','covered-terminal-send')
    OR p_evidence->>'reference' IS NULL OR p_evidence->>'reference' !~ '^[A-Za-z0-9._:-]{1,128}$'
    OR jsonb_typeof(p_evidence->'sendCannotResume') IS DISTINCT FROM 'boolean'
    OR p_evidence->>'sendCannotResume' IS DISTINCT FROM 'true'
    OR p_evidence->>'period' IS NULL
    OR EXISTS(SELECT FROM jsonb_object_keys(p_evidence) k WHERE k NOT IN ('kind','reference','sendCannotResume','period'))
  THEN RAISE EXCEPTION 'insufficient credit resolution evidence'; END IF;
  SELECT * INTO b FROM provider_credit.account WHERE id=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit authority unavailable'; END IF;
  fingerprint := jsonb_build_array(p_attempt,p_evidence);
  SELECT * INTO o FROM provider_credit.operations WHERE id=p_operation;
  IF FOUND THEN
    IF o.actor<>p_actor OR o.action<>'resolve' OR o.fingerprint<>fingerprint THEN
      RAISE EXCEPTION 'credit operator identity conflict'; END IF;
    RETURN o.result || jsonb_build_object('outcome','replay');
  END IF;
  SELECT * INTO a FROM provider_credit.attempts WHERE id=p_attempt;
  IF NOT FOUND OR NOT a.admitted OR a.settled THEN RAISE EXCEPTION 'credit attempt not unresolved'; END IF;
  IF p_evidence->>'period' IS DISTINCT FROM a.original_period THEN
    RAISE EXCEPTION 'credit resolution evidence period mismatch'; END IF;
  -- Restricted operator evidence is an audited procedure, not software proof of
  -- provider chronology. No timeout, elapsed age or header alone releases debt.
  UPDATE provider_credit.account SET pending_liability=pending_liability-a.liability,
    pending_count=pending_count-1 WHERE id=1;
  UPDATE provider_credit.attempts SET liability=0,settled=true,settled_at=clock_timestamp(),
    settlement_kind='operator' WHERE id=p_attempt;
  result := jsonb_build_object('outcome','resolved','releasedCredits',a.liability,
    'availableCredits',greatest(0,b.provider_remaining-b.pending_liability+a.liability));
  INSERT INTO provider_credit.operations VALUES(p_operation,p_actor,session_user,'resolve',fingerprint,result,clock_timestamp());
  RETURN result;
END $$;

CREATE FUNCTION provider_credit.health(p_expected_period text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$
DECLARE b provider_credit.account; reason text; age_seconds bigint;
BEGIN
  PERFORM pg_catalog.set_config('search_path','pg_catalog',true);
  SELECT * INTO b FROM provider_credit.account WHERE id=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit authority unavailable'; END IF;
  reason := CASE WHEN NOT b.initialized THEN 'uninitialized'
    WHEN b.period IS DISTINCT FROM p_expected_period OR b.period_ends_at<=clock_timestamp()
      OR b.health_reason='period-mismatch' THEN 'period-mismatch'
    WHEN b.observed_at<clock_timestamp()-b.quota_freshness_ms*interval '1 millisecond' THEN 'quota-stale'
    ELSE 'ok' END;
  SELECT greatest(0,floor(extract(epoch FROM clock_timestamp()-reserved_at)))::bigint INTO age_seconds
    FROM provider_credit.attempts WHERE admitted AND NOT settled ORDER BY reserved_at,id LIMIT 1;
  RETURN jsonb_build_object('initialized',b.initialized,'period',b.period,'reason',reason,
    'severity',CASE WHEN reason='period-mismatch' THEN 'critical' WHEN reason<>'ok' THEN 'unavailable' ELSE 'ok' END,
    'unresolvedLiabilityTotal',b.pending_liability,'unresolvedLiabilityCount',b.pending_count,
    'oldestUnresolvedAgeSeconds',age_seconds,'collectorFloor',b.collector_floor,
    'availableCredits',CASE WHEN b.initialized THEN greatest(0,b.provider_remaining-b.pending_liability) ELSE NULL END);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA provider_credit FROM PUBLIC;
-- No serving/operator role is created or granted here. Schema activation must
-- choose reviewed roles: runtime reserve/reconcile/health; operator initialize/
-- resolve_unknown. Neither receives table writes or the other's functions.
