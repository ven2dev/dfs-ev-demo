-- Local qualification only. No ordered migration or production API.
CREATE SCHEMA spike220;
CREATE TABLE spike220.catalog (resource text PRIMARY KEY);
CREATE TABLE spike220.resources (
  resource text PRIMARY KEY REFERENCES spike220.catalog,
  owner text, lease_until timestamptz, payload jsonb, fetched_at timestamptz
);
CREATE TABLE spike220.subjects (subject text PRIMARY KEY, tat timestamptz NOT NULL DEFAULT '-infinity');
CREATE TABLE spike220.budget (
  id int PRIMARY KEY CHECK(id=1), balance int NOT NULL CHECK(balance>=0),
  floor int NOT NULL CHECK(floor>=0), observed_at timestamptz NOT NULL,
  provider_remaining int NOT NULL DEFAULT 0 CHECK(provider_remaining>=0),
  provider_used int NOT NULL DEFAULT 0 CHECK(provider_used>=0),
  quota_total bigint NOT NULL DEFAULT 0,
  pending_reserved bigint NOT NULL DEFAULT 0 CHECK(pending_reserved>=0),
  period text NOT NULL, cost_overrun boolean NOT NULL DEFAULT false
);
CREATE TABLE spike220.attempts (
  id text PRIMARY KEY, cost int NOT NULL, collector boolean NOT NULL,
  admitted boolean NOT NULL, actual int, observation_at timestamptz,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  liability int NOT NULL DEFAULT 0 CHECK(liability>=0),
  settled boolean NOT NULL DEFAULT false, response_used int, response_remaining int,
  period text NOT NULL, overrun boolean NOT NULL DEFAULT false
);
CREATE TABLE spike220.quota_probe (
  id int PRIMARY KEY CHECK(id=1), owner text, lease_until timestamptz, retry_after timestamptz, reported_cost int
);
INSERT INTO spike220.quota_probe(id) VALUES(1);
-- Atomic single-row debit primitive; caller transaction decides whether leases
-- and subject state also commit. Never held across provider network calls.
CREATE FUNCTION spike220.reserve(attempt text, amount int, is_collector boolean)
RETURNS TABLE(admitted boolean,replay boolean) LANGUAGE plpgsql AS $$
DECLARE b spike220.budget; a spike220.attempts; ok boolean;
BEGIN
  IF amount IS NULL OR amount<=0 OR attempt IS NULL OR length(attempt) NOT BETWEEN 1 AND 128
    OR is_collector IS NULL THEN RAISE EXCEPTION 'invalid reservation'; END IF;
  SELECT * INTO b FROM spike220.budget WHERE id=1 FOR UPDATE;
  SELECT * INTO a FROM spike220.attempts WHERE id=attempt;
  IF FOUND THEN
    IF a.cost<>amount OR a.collector<>is_collector THEN RAISE EXCEPTION 'identity conflict'; END IF;
    RETURN QUERY SELECT a.admitted,true; RETURN;
  END IF;
  UPDATE spike220.budget SET balance=balance-amount,pending_reserved=pending_reserved+amount WHERE id=1
    AND NOT cost_overrun
    AND observed_at BETWEEN clock_timestamp()-interval '5 minutes' AND clock_timestamp()
    AND balance-amount>=CASE WHEN is_collector THEN 0 ELSE floor END;
  ok:=FOUND;
  INSERT INTO spike220.attempts(id,cost,collector,admitted,liability,period)
    VALUES(attempt,amount,is_collector,ok,CASE WHEN ok THEN amount ELSE 0 END,b.period);
  RETURN QUERY SELECT ok,false;
END $$;
CREATE FUNCTION spike220.admit(keys text[], request_owner text, dimensions text[],
  interval_ms int[], burst int[], lease_ms int, freshness_ms int DEFAULT 300000)
RETURNS TABLE(outcome text, resources text[], attempt_id text) LANGUAGE plpgsql AS $$
DECLARE r spike220.resources; k text; d text; t timestamptz; at_time timestamptz;
  policy record; missing text[]:='{}'; paid record;
BEGIN
  IF keys IS NULL OR cardinality(keys) NOT BETWEEN 1 AND 12
    OR array_ndims(keys)<>1 OR array_lower(keys,1)<>1
    OR EXISTS(SELECT FROM unnest(keys) x WHERE x IS NULL OR length(x) NOT BETWEEN 1 AND 256)
    OR (SELECT count(DISTINCT x) FROM unnest(keys) x)<>cardinality(keys)
    OR request_owner IS NULL OR length(request_owner) NOT BETWEEN 1 AND 128
    OR cardinality(dimensions) NOT BETWEEN 1 AND 2 OR dimensions IS NULL
    OR array_ndims(dimensions)<>1 OR array_lower(dimensions,1)<>1
    OR EXISTS(SELECT FROM unnest(dimensions) x WHERE x IS NULL OR length(x) NOT BETWEEN 1 AND 128)
    OR (SELECT count(DISTINCT x) FROM unnest(dimensions) x)<>cardinality(dimensions)
    OR interval_ms IS NULL OR cardinality(interval_ms)<>cardinality(dimensions)
    OR array_ndims(interval_ms)<>1 OR array_lower(interval_ms,1)<>1
    OR EXISTS(SELECT FROM unnest(interval_ms) x WHERE x IS NULL OR x NOT BETWEEN 1 AND 3600000)
    OR burst IS NULL OR cardinality(burst)<>cardinality(dimensions)
    OR array_ndims(burst)<>1 OR array_lower(burst,1)<>1
    OR EXISTS(SELECT FROM unnest(burst) x WHERE x IS NULL OR x NOT BETWEEN 1 AND 10000)
    OR lease_ms IS NULL OR lease_ms NOT BETWEEN 1 AND 30000
    OR freshness_ms IS NULL OR freshness_ms NOT BETWEEN 1 AND 300000 THEN
    RAISE EXCEPTION 'invalid bounded admission input';
  END IF;
  IF EXISTS(SELECT FROM unnest(keys) x WHERE NOT EXISTS(SELECT FROM spike220.catalog c WHERE c.resource=x)) THEN
    RAISE EXCEPTION 'resource outside authoritative event/market catalog';
  END IF;
  FOR k IN SELECT x FROM unnest(keys) x ORDER BY x LOOP
    INSERT INTO spike220.resources(resource) VALUES(k) ON CONFLICT DO NOTHING;
    SELECT * INTO r FROM spike220.resources WHERE resource=k FOR UPDATE;
    IF r.payload IS NOT NULL AND r.fetched_at>clock_timestamp()-freshness_ms*interval '1 millisecond' THEN
      CONTINUE;
    END IF;
    IF r.lease_until>clock_timestamp() THEN
      RETURN QUERY SELECT 'follower','{}'::text[],NULL::text; RETURN;
    END IF;
    missing:=array_append(missing,k);
  END LOOP;
  IF cardinality(missing)=0 THEN RETURN QUERY SELECT 'fresh','{}'::text[],NULL::text; RETURN; END IF;
  IF NOT EXISTS(SELECT FROM spike220.budget WHERE id=1 AND observed_at BETWEEN
    clock_timestamp()-interval '5 minutes' AND clock_timestamp()) THEN
    RETURN QUERY SELECT 'quota-stale','{}'::text[],NULL::text; RETURN;
  END IF;
  FOR d IN SELECT x FROM unnest(dimensions) x ORDER BY x LOOP
    INSERT INTO spike220.subjects(subject) VALUES(d) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM spike220.subjects WHERE subject=d FOR UPDATE;
  END LOOP;
  at_time:=clock_timestamp();
  FOR policy IN SELECT x.subject,interval_ms[x.n] AS step_ms,burst[x.n] AS capacity
    FROM unnest(dimensions) WITH ORDINALITY x(subject,n) ORDER BY x.subject LOOP
    SELECT tat INTO t FROM spike220.subjects WHERE subject=policy.subject;
    IF t-(policy.capacity-1)*policy.step_ms*interval '1 millisecond'>at_time THEN
      RETURN QUERY SELECT 'denied','{}'::text[],NULL::text; RETURN;
    END IF;
  END LOOP;
  -- One reservation for the batch, cost = stale markets (one region fixture).
  SELECT * INTO paid FROM spike220.reserve(request_owner,cardinality(missing),false);
  IF paid.replay THEN RETURN QUERY SELECT 'replay','{}'::text[],request_owner; RETURN; END IF;
  IF NOT paid.admitted THEN
    IF NOT EXISTS(SELECT FROM spike220.budget WHERE id=1 AND observed_at BETWEEN
      clock_timestamp()-interval '5 minutes' AND clock_timestamp()) THEN
      RETURN QUERY SELECT 'quota-stale','{}'::text[],request_owner; RETURN;
    END IF;
    RETURN QUERY SELECT 'budget-refused','{}'::text[],request_owner; RETURN;
  END IF;
  FOR policy IN SELECT x.subject,interval_ms[x.n] AS step_ms
    FROM unnest(dimensions) WITH ORDINALITY x(subject,n) ORDER BY x.subject LOOP
    UPDATE spike220.subjects SET tat=greatest(tat,at_time)+policy.step_ms*interval '1 millisecond'
      WHERE subject=policy.subject;
  END LOOP;
  UPDATE spike220.resources SET owner=request_owner,lease_until=clock_timestamp()+lease_ms*interval '1 millisecond'
    WHERE resource=ANY(missing);
  RETURN QUERY SELECT 'leader',missing,request_owner;
END $$;
-- Validated provider counters order snapshots within an initialized period.
CREATE FUNCTION spike220.observe(remaining int, used int, observed timestamptz, quota_period text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE b spike220.budget;
BEGIN
  SELECT * INTO b FROM spike220.budget WHERE id=1 FOR UPDATE;
  IF NOT FOUND OR remaining IS NULL OR remaining<0 OR used IS NULL OR used<0
    OR observed IS NULL OR observed>clock_timestamp() OR quota_period IS DISTINCT FROM b.period
    OR remaining::bigint+used<>b.quota_total THEN RETURN 'invalid'; END IF;
  IF used<b.provider_used THEN RETURN 'older-or-reset'; END IF;
  IF used=b.provider_used AND remaining>b.provider_remaining THEN RETURN 'inconsistent'; END IF;
  IF used=b.provider_used AND observed<b.observed_at THEN RETURN 'older'; END IF;
  UPDATE spike220.budget SET provider_remaining=remaining,provider_used=used,
    observed_at=greatest(observed_at,observed),
    balance=greatest(0,remaining::bigint-pending_reserved)::int WHERE id=1;
  RETURN 'accepted';
END $$;
CREATE FUNCTION spike220.reconcile(attempt text, actual_cost int, remaining int,
  used int, observed timestamptz, quota_period text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE a spike220.attempts; b spike220.budget; state text; extra int;
BEGIN
  SELECT * INTO b FROM spike220.budget WHERE id=1 FOR UPDATE;
  SELECT * INTO a FROM spike220.attempts WHERE id=attempt;
  IF NOT FOUND OR NOT a.admitted OR actual_cost IS NULL OR actual_cost<0 THEN
    RAISE EXCEPTION 'invalid attempt or actual cost'; END IF;
  IF a.actual IS NOT NULL THEN
    IF a.actual<>actual_cost THEN RAISE EXCEPTION 'reconciliation conflict'; END IF;
    IF a.response_used IS NOT DISTINCT FROM used AND a.response_remaining IS NOT DISTINCT FROM remaining
      AND a.observation_at IS NOT DISTINCT FROM observed THEN RETURN 'replay'; END IF;
    IF a.settled THEN RAISE EXCEPTION 'reconciliation conflict'; END IF;
    -- An unresolved actual-cost record may gain trusted metadata later, without
    -- another provider send or a second decrement of the liability aggregate.
  END IF;
  extra:=greatest(0,actual_cost-a.liability);
  UPDATE spike220.attempts SET actual=actual_cost,liability=greatest(liability,actual_cost),
    response_used=used,response_remaining=remaining,observation_at=observed,
    overrun=actual_cost>cost WHERE id=attempt;
  UPDATE spike220.budget SET pending_reserved=pending_reserved+extra,
    cost_overrun=cost_overrun OR actual_cost>a.cost WHERE id=1;
  state:=spike220.observe(remaining,used,observed,quota_period);
  -- Even an older same-period paid response settles against the retained newer
  -- snapshot. Missing/malformed headers keep liability unresolved and consumed.
  IF state IN ('accepted','older','older-or-reset') AND a.period=b.period
    AND quota_period=b.period AND remaining IS NOT NULL AND used>=actual_cost
    AND remaining::bigint+used=b.quota_total AND observed IS NOT NULL AND observed<=clock_timestamp() THEN
    UPDATE spike220.budget SET pending_reserved=pending_reserved-(a.liability+extra) WHERE id=1;
    UPDATE spike220.attempts SET settled=true,liability=0 WHERE id=attempt;
  END IF;
  UPDATE spike220.budget SET balance=greatest(0,provider_remaining::bigint-pending_reserved)::int WHERE id=1;
  RETURN state;
END $$;
CREATE FUNCTION spike220.claim_probe(request_owner text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE p spike220.quota_probe;
BEGIN
  IF request_owner IS NULL OR length(request_owner) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'invalid owner'; END IF;
  SELECT * INTO p FROM spike220.quota_probe WHERE id=1 FOR UPDATE;
  IF EXISTS(SELECT FROM spike220.budget WHERE id=1 AND observed_at BETWEEN
    clock_timestamp()-interval '5 minutes' AND clock_timestamp()) THEN RETURN 'fresh'; END IF;
  IF p.retry_after>clock_timestamp() THEN RETURN 'backoff'; END IF;
  IF p.lease_until>clock_timestamp() THEN RETURN 'follower'; END IF;
  UPDATE spike220.quota_probe SET owner=request_owner,lease_until=clock_timestamp()+interval '30 seconds',retry_after=NULL WHERE id=1;
  RETURN 'leader';
END $$;
CREATE FUNCTION spike220.finish_probe(request_owner text, remaining int, used int,
  observed timestamptz, quota_period text, free_cost int DEFAULT 0)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE p spike220.quota_probe; state text; b spike220.budget;
BEGIN
  SELECT * INTO p FROM spike220.quota_probe WHERE id=1 FOR UPDATE;
  IF p.owner IS DISTINCT FROM request_owner OR p.lease_until IS NULL OR p.lease_until<=clock_timestamp() THEN
    RETURN 'owner-expired'; END IF;
  IF free_cost IS NULL OR free_cost<0 THEN
    state:='invalid';
  ELSIF free_cost>0 THEN
    -- Unexpected cost on the nominally free endpoint is still real cost.
    SELECT * INTO b FROM spike220.budget WHERE id=1 FOR UPDATE;
    INSERT INTO spike220.attempts(id,cost,collector,admitted,period)
      VALUES('quota:'||request_owner,0,false,true,b.period);
    state:=spike220.reconcile('quota:'||request_owner,free_cost,remaining,used,observed,quota_period);
  ELSE
    state:=spike220.observe(remaining,used,observed,quota_period);
  END IF;
  UPDATE spike220.quota_probe SET owner=NULL,lease_until=NULL,reported_cost=free_cost,
    retry_after=CASE WHEN state='accepted' THEN NULL ELSE clock_timestamp()+interval '1 second' END WHERE id=1;
  RETURN state;
END $$;
