-- Applied only AFTER the reviewed local proposal on an approved schema-only test
-- branch. Operator creates/initializes run and tickets before the load generator.
CREATE TABLE spike220.hosted_run (
  id uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL, active_group text NOT NULL,
  runner name NOT NULL, max_tickets int NOT NULL CHECK(max_tickets BETWEEN 1 AND 20000)
);
CREATE TABLE spike220.hosted_tickets (
  run_id uuid NOT NULL REFERENCES spike220.hosted_run, sample text NOT NULL,
  group_name text NOT NULL, mode text NOT NULL CHECK(mode IN ('baseline','admission','path')),
  resource_keys text[] NOT NULL CHECK(cardinality(resource_keys)=1),
  dimensions text[] NOT NULL CHECK(cardinality(dimensions)=2), owner_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','needs-quota','complete')),
  quota_retries int NOT NULL DEFAULT 0 CHECK(quota_retries BETWEEN 0 AND 1),
  result text, PRIMARY KEY(run_id,sample)
);
-- Database-side expiry/runner fence only. The bearer is authenticated only by
-- authorize() in the route. SECURITY INVOKER keeps production admission privileges.
CREATE FUNCTION spike220.hosted_check(p_run uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE r record;
BEGIN
  SELECT id,expires_at,runner INTO r FROM spike220.hosted_run WHERE id=p_run;
  IF NOT FOUND OR r.expires_at<=clock_timestamp()
    OR r.runner<>current_user THEN RAISE EXCEPTION 'missing, expired or wrong-runner run'; END IF;
END $$;
CREATE FUNCTION spike220.hosted_begin(p_run uuid,p_sample text,p_baseline boolean)
RETURNS TABLE(outcome text,owner text,resources text[]) LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE t spike220.hosted_tickets;
BEGIN
  PERFORM spike220.hosted_check(p_run);
  UPDATE spike220.hosted_tickets x SET state=CASE WHEN p_baseline THEN 'complete' ELSE 'claimed' END
    WHERE x.run_id=p_run AND x.sample=p_sample AND x.state='pending'
      AND ((p_baseline AND x.mode='baseline') OR (NOT p_baseline AND x.mode='path'))
      AND x.group_name=(SELECT active_group FROM spike220.hosted_run WHERE id=p_run)
    RETURNING x.* INTO t;
  IF NOT FOUND THEN RAISE EXCEPTION 'sample absent, replayed or wrong phase'; END IF;
  -- Same existing-cache read shape; deliberately forced misses for leader trials.
  PERFORM payload,fetched_at FROM spike220.resources WHERE resource=ANY(t.resource_keys);
  RETURN QUERY SELECT CASE WHEN p_baseline THEN 'baseline' ELSE 'claimed' END,t.owner_id::text,t.resource_keys;
END $$;
CREATE FUNCTION spike220.hosted_sample(p_run uuid,p_sample text,p_after_read boolean)
RETURNS TABLE(outcome text,owner text,resources text[]) LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE t spike220.hosted_tickets; a record;
BEGIN
  PERFORM spike220.hosted_check(p_run);
  SELECT * INTO t FROM spike220.hosted_tickets x WHERE x.run_id=p_run AND x.sample=p_sample
    AND x.group_name=(SELECT active_group FROM spike220.hosted_run WHERE id=p_run) FOR UPDATE;
  IF NOT FOUND OR t.mode='baseline'
    OR (NOT p_after_read AND (t.mode<>'admission' OR t.state<>'pending'))
    OR (p_after_read AND (t.mode<>'path' OR t.state NOT IN ('claimed','needs-quota')))
    OR (t.state='needs-quota' AND t.quota_retries>=1) THEN
    RAISE EXCEPTION 'sample absent, replayed or invalid transition';
  END IF;
  SELECT * INTO a FROM spike220.admit(t.resource_keys,t.owner_id::text,t.dimensions,
    ARRAY[10000,10000],ARRAY[10000,10000],30000);
  UPDATE spike220.hosted_tickets x SET state=CASE WHEN a.outcome='quota-stale' THEN 'needs-quota' ELSE 'complete' END,
    quota_retries=x.quota_retries+CASE WHEN t.state='needs-quota' THEN 1 ELSE 0 END,result=a.outcome
    WHERE x.run_id=p_run AND x.sample=p_sample;
  RETURN QUERY SELECT a.outcome,t.owner_id::text,a.resources;
END $$;
CREATE FUNCTION spike220.hosted_release(p_run uuid,p_sample text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE t spike220.hosted_tickets;
BEGIN
  PERFORM spike220.hosted_check(p_run);
  SELECT * INTO t FROM spike220.hosted_tickets x WHERE x.run_id=p_run AND x.sample=p_sample;
  IF NOT FOUND OR t.state<>'complete' OR t.result<>'leader' THEN RAISE EXCEPTION 'not an admitted sample'; END IF;
  UPDATE spike220.resources SET owner=NULL,lease_until=NULL
    WHERE resource=ANY(t.resource_keys) AND owner=t.owner_id::text;
END $$;
-- No globally incremented counter: each preallocated ticket bounds one sample.
-- Setup records <=20,000 tickets. Function code enforces ticket transitions;
-- the runner technically has UPDATE on tickets and DML on budget tables. Its DSN
-- is a branch-scoped server Secret, and this entire branch is disposable.
