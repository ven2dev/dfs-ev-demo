-- #223 proposal only. No ordered migration or hosted activation.
-- Function-scoped search_path is restored by PostgreSQL on return; this is not
-- a session SET command and does not require pool session affinity.
CREATE TABLE public.odds_subject_limits (
  subject text PRIMARY KEY CHECK (subject ~ '^[a-z][a-z0-9]{0,15}:(anonymous-network|signed-network|user):[0-9a-f]{64}$'),
  tat timestamptz NOT NULL DEFAULT '-infinity'
);
CREATE TABLE public.odds_subject_buckets (
  subject text NOT NULL REFERENCES public.odds_subject_limits(subject),
  minute timestamptz NOT NULL CHECK (minute = date_trunc('minute', minute)),
  admitted bigint NOT NULL DEFAULT 0 CHECK (admitted >= 0),
  denied bigint NOT NULL DEFAULT 0 CHECK (denied >= 0),
  would_deny bigint NOT NULL DEFAULT 0 CHECK (would_deny >= 0),
  floor_denied bigint NOT NULL DEFAULT 0 CHECK (floor_denied >= 0),
  anonymous bigint NOT NULL DEFAULT 0 CHECK (anonymous >= 0),
  signed_in bigint NOT NULL DEFAULT 0 CHECK (signed_in >= 0),
  PRIMARY KEY (subject, minute)
);
CREATE INDEX odds_subject_buckets_minute ON public.odds_subject_buckets(minute, subject);
-- Headerless/error observations must not turn LIMIT 1 into an unbounded scan.
CREATE INDEX odds_admission_latest_quota ON public.odds_api_request_log(requested_at DESC)
  WHERE quota_remaining IS NOT NULL;
REVOKE ALL ON public.odds_subject_limits, public.odds_subject_buckets FROM PUBLIC;

CREATE FUNCTION public.admit_paid_odds(
  p_dimensions jsonb, p_enforce boolean, p_reserve integer, p_batch integer
) RETURNS TABLE (
  outcome text, retry_after_ms bigint, denied_subjects text[],
  warning text, quota_remaining integer, would_deny boolean
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  d jsonb; k text; keys text[]; namespace text; namespaces text[] := '{}';
  versions text[]; first_versions text[]; reporting_version text;
  t timestamptz; debt timestamptz; candidate timestamptz;
  next_tats jsonb := '{}'; locked_tats jsonb; denied boolean := false;
  retry_ms bigint := 0; denied_keys text[] := '{}';
  limiter_error boolean := false; floor_refused boolean := false; floor_checked boolean := false;
  rem integer; warn text; minute_at timestamptz;
BEGIN
  -- Validate before any writes so caller mistakes cannot persist raw identity,
  -- unbounded arrays, unbounded debt or partial policies.
  IF p_dimensions IS NULL OR jsonb_typeof(p_dimensions) <> 'array'
    OR p_enforce IS NULL OR p_reserve IS NULL OR p_reserve NOT BETWEEN 0 AND 1000000
    OR p_batch IS NULL OR p_batch NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'invalid paid admission input' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_dimensions) NOT BETWEEN 1 AND 2 THEN
    RAISE EXCEPTION 'invalid paid admission dimensions' USING ERRCODE = '22023';
  END IF;
  FOR d IN SELECT value FROM jsonb_array_elements(p_dimensions) LOOP
    IF jsonb_typeof(d) <> 'object' OR NOT d ?& ARRAY['keys','report','intervalMs','burst','traffic']
      OR d - ARRAY['keys','report','intervalMs','burst','traffic'] <> '{}'::jsonb
      OR jsonb_typeof(d->'keys') <> 'array' THEN
      RAISE EXCEPTION 'invalid paid admission dimension' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(d->'keys') NOT BETWEEN 1 AND 2
      OR jsonb_typeof(d->'report') <> 'string'
      OR jsonb_typeof(d->'intervalMs') <> 'number' OR (d->>'intervalMs') !~ '^[0-9]{1,8}$'
      OR jsonb_typeof(d->'burst') <> 'number' OR (d->>'burst') !~ '^[0-9]{1,4}$'
      OR (d->>'intervalMs')::bigint NOT BETWEEN 1 AND 86400000
      OR (d->>'burst')::bigint NOT BETWEEN 1 AND 1000
      OR (d->>'intervalMs')::bigint * (d->>'burst')::bigint > 86400000
      OR jsonb_typeof(d->'traffic') <> 'string'
      OR (d->>'traffic') NOT IN ('anonymous','signed-in') THEN
      RAISE EXCEPTION 'invalid paid admission policy' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT FROM jsonb_array_elements(d->'keys') x WHERE jsonb_typeof(x) <> 'string')
      OR EXISTS (SELECT FROM jsonb_array_elements_text(d->'keys') x
        WHERE x !~ '^[a-z][a-z0-9]{0,15}:(anonymous-network|signed-network|user):[0-9a-f]{64}$')
      OR NOT (d->'keys') ? (d->>'report') THEN
      RAISE EXCEPTION 'invalid paid admission subject' USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(DISTINCT split_part(x,':',1) ORDER BY split_part(x,':',1)) INTO versions
      FROM jsonb_array_elements_text(d->'keys') x;
    IF cardinality(versions) <> jsonb_array_length(d->'keys')
      OR (first_versions IS NOT NULL AND versions <> first_versions)
      OR (reporting_version IS NOT NULL AND reporting_version <> split_part(d->>'report',':',1)) THEN
      RAISE EXCEPTION 'invalid paid admission key versions' USING ERRCODE = '22023';
    END IF;
    first_versions := versions; reporting_version := split_part(d->>'report',':',1);
    namespace := split_part(d->>'report',':',2);
    IF EXISTS (SELECT FROM jsonb_array_elements_text(d->'keys') x WHERE split_part(x,':',2) <> namespace)
      OR namespace = ANY(namespaces)
      OR (namespace = 'anonymous-network') <> (d->>'traffic' = 'anonymous') THEN
      RAISE EXCEPTION 'invalid paid admission subject class' USING ERRCODE = '22023';
    END IF;
    namespaces := array_append(namespaces, namespace);
  END LOOP;
  IF (cardinality(namespaces) = 1 AND namespaces <> ARRAY['anonymous-network'])
    OR (cardinality(namespaces) = 2 AND NOT (namespaces @> ARRAY['signed-network','user'])) THEN
    RAISE EXCEPTION 'invalid paid admission identity dimensions' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT v ORDER BY v) INTO keys
    FROM jsonb_array_elements(p_dimensions) x
    CROSS JOIN LATERAL jsonb_array_elements_text(x->'keys') v;

  BEGIN
    -- Insert and lock in the same order on every instance/version pair.
    FOREACH k IN ARRAY keys LOOP
      INSERT INTO public.odds_subject_limits(subject) VALUES(k) ON CONFLICT DO NOTHING;
    END LOOP;
    -- Capture debt in the already-required sorted lock read. Re-reading the
    -- same PK rows per dimension adds work as subject state grows.
    SELECT jsonb_object_agg(locked.subject,locked.tat) INTO locked_tats FROM (
      SELECT subject,tat FROM public.odds_subject_limits
      WHERE subject = ANY(keys) ORDER BY subject FOR UPDATE
    ) locked;
    t := clock_timestamp(); minute_at := date_trunc('minute', t);
    FOR d IN SELECT value FROM jsonb_array_elements(p_dimensions) LOOP
      SELECT max((locked_tats->>value)::timestamptz) INTO debt
        FROM jsonb_array_elements_text(d->'keys');
      candidate := debt - ((d->>'burst')::int - 1) * (d->>'intervalMs')::int * interval '1 millisecond';
      IF t < candidate THEN
        denied := true;
        retry_ms := greatest(retry_ms, ceil(extract(epoch FROM candidate - t) * 1000)::bigint);
        SELECT denied_keys || array_agg(value) INTO denied_keys FROM jsonb_array_elements_text(d->'keys');
      END IF;
      FOR k IN SELECT jsonb_array_elements_text(d->'keys') LOOP
        next_tats := next_tats || jsonb_build_object(k,
          greatest(t, debt) + (d->>'intervalMs')::int * interval '1 millisecond');
      END LOOP;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    limiter_error := true; denied := false; retry_ms := 0; denied_keys := '{}';
    warn := 'limiter-evaluation-failed';
  END;

  IF limiter_error OR NOT denied OR NOT p_enforce THEN
    floor_checked := true;
    BEGIN
      SELECT q.quota_remaining INTO rem FROM public.odds_api_request_log q
        WHERE q.quota_remaining IS NOT NULL ORDER BY q.requested_at DESC LIMIT 1;
      floor_refused := coalesce(rem <= p_reserve + p_batch, false);
    EXCEPTION WHEN OTHERS THEN
      warn := coalesce(warn, 'quota-read-failed');
    END;
  END IF;

  IF NOT limiter_error THEN
    BEGIN
      IF NOT denied AND NOT floor_refused THEN
        UPDATE public.odds_subject_limits s SET tat = (next_tats->>s.subject)::timestamptz
          WHERE s.subject = ANY(keys);
      END IF;
      FOR d IN SELECT value FROM jsonb_array_elements(p_dimensions) ORDER BY value->>'report' LOOP
        INSERT INTO public.odds_subject_buckets(subject, minute, admitted, denied, would_deny,
          floor_denied, anonymous, signed_in)
        VALUES (d->>'report', minute_at,
          CASE WHEN NOT floor_refused AND (NOT denied OR NOT p_enforce) THEN 1 ELSE 0 END,
          CASE WHEN denied AND p_enforce THEN 1 ELSE 0 END,
          CASE WHEN denied AND NOT p_enforce THEN 1 ELSE 0 END,
          CASE WHEN floor_refused THEN 1 ELSE 0 END,
          CASE WHEN d->>'traffic' = 'anonymous' AND NOT floor_refused AND (NOT denied OR NOT p_enforce) THEN 1 ELSE 0 END,
          CASE WHEN d->>'traffic' = 'signed-in' AND NOT floor_refused AND (NOT denied OR NOT p_enforce) THEN 1 ELSE 0 END)
        ON CONFLICT(subject, minute) DO UPDATE SET
          admitted = public.odds_subject_buckets.admitted + excluded.admitted,
          denied = public.odds_subject_buckets.denied + excluded.denied,
          would_deny = public.odds_subject_buckets.would_deny + excluded.would_deny,
          floor_denied = public.odds_subject_buckets.floor_denied + excluded.floor_denied,
          anonymous = public.odds_subject_buckets.anonymous + excluded.anonymous,
          signed_in = public.odds_subject_buckets.signed_in + excluded.signed_in;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      -- This subtransaction rolls back every TAT/counter change together.
      -- A known quota refusal remains authoritative even if counters fail.
      limiter_error := true; denied := false; retry_ms := 0; denied_keys := '{}';
      warn := 'limiter-counter-failed';
    END;
  END IF;
  -- A failed denial counter can turn a limiter refusal into advisory allow.
  -- If the floor was skipped for that refusal, evaluate it now, still at most
  -- once and in this same driver statement. A counter outage cannot bypass it.
  IF limiter_error AND NOT floor_checked THEN
    BEGIN
      SELECT q.quota_remaining INTO rem FROM public.odds_api_request_log q
        WHERE q.quota_remaining IS NOT NULL ORDER BY q.requested_at DESC LIMIT 1;
      floor_refused := coalesce(rem <= p_reserve + p_batch, false);
    EXCEPTION WHEN OTHERS THEN
      NULL; -- Keep the limiter reason; an unreadable floor remains advisory.
    END;
  END IF;
  RETURN QUERY SELECT
    CASE WHEN floor_refused THEN 'quota-floor'
      WHEN denied AND p_enforce AND NOT limiter_error THEN 'subject-rate-limit' ELSE 'allow' END,
    CASE WHEN denied THEN retry_ms ELSE 0 END, denied_keys, warn, rem,
    denied AND NOT p_enforce;
END $$;
REVOKE ALL ON FUNCTION public.admit_paid_odds(jsonb,boolean,integer,integer) FROM PUBLIC;
-- A separately approved migration/release grants EXECUTE only to the existing
-- web role. The web role receives no direct table writes or owner membership.

-- Pre-send limiter refusal only: ordinary release keeps the attempt cooldown.
CREATE FUNCTION public.release_shared_odds_limiter_denial(p_event text,p_keys text[],p_owner text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_event IS NULL OR length(p_event) NOT BETWEEN 1 AND 128 OR p_owner IS NULL
    OR length(p_owner) NOT BETWEEN 1 AND 128 OR p_keys IS NULL
    OR cardinality(p_keys) NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'invalid refused claim release' USING ERRCODE='22023';
  END IF;
  UPDATE public.event_market_odds_cache c SET refresh_owner=NULL,
    refresh_lease_until=NULL,refresh_claimed_at=NULL
    WHERE c.event_id=p_event AND c.market_key=ANY(p_keys) AND c.refresh_owner=p_owner
      AND c.refresh_lease_until>clock_timestamp();
END $$;
REVOKE ALL ON FUNCTION public.release_shared_odds_limiter_denial(text,text[],text) FROM PUBLIC;

-- Authenticated operator report only, never the paid path. Fixed windows and
-- top-20 lists bound response size; no caller-selected SQL/window/subject.
CREATE FUNCTION public.report_odds_subjects()
RETURNS TABLE(label text,totals jsonb,top_admitted jsonb,top_denied jsonb,top_would_deny jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
RETURN QUERY
WITH totals AS MATERIALIZED (
 SELECT b.subject,count(*) FILTER(WHERE minute>=date_trunc('minute',statement_timestamp()-interval '1 hour')) recent_rows,
 sum(admitted)::bigint admitted_24,
 coalesce(sum(admitted) FILTER(WHERE minute>=date_trunc('minute',statement_timestamp()-interval '1 hour')),0)::bigint admitted_1,
 sum(denied)::bigint denied_24,
 coalesce(sum(denied) FILTER(WHERE minute>=date_trunc('minute',statement_timestamp()-interval '1 hour')),0)::bigint denied_1,
 sum(would_deny)::bigint would_deny_24,
 coalesce(sum(would_deny) FILTER(WHERE minute>=date_trunc('minute',statement_timestamp()-interval '1 hour')),0)::bigint would_deny_1,
 sum(floor_denied)::bigint floor_denied_24,
 coalesce(sum(floor_denied) FILTER(WHERE minute>=date_trunc('minute',statement_timestamp()-interval '1 hour')),0)::bigint floor_denied_1,
 sum(anonymous)::bigint anonymous_24,
 coalesce(sum(anonymous) FILTER(WHERE minute>=date_trunc('minute',statement_timestamp()-interval '1 hour')),0)::bigint anonymous_1,
 sum(signed_in)::bigint signed_in_24,
 coalesce(sum(signed_in) FILTER(WHERE minute>=date_trunc('minute',statement_timestamp()-interval '1 hour')),0)::bigint signed_in_1
 FROM public.odds_subject_buckets b
 WHERE b.minute>=date_trunc('minute',statement_timestamp()-interval '24 hours')
 AND b.minute<=date_trunc('minute',statement_timestamp()) GROUP BY b.subject
)
SELECT w.label,report.* FROM (VALUES ('1h'),('24h')) w(label)
CROSS JOIN LATERAL (
 WITH selected AS MATERIALIZED (
 SELECT subject,CASE WHEN w.label='1h' THEN admitted_1 ELSE admitted_24 END admitted,
 CASE WHEN w.label='1h' THEN denied_1 ELSE denied_24 END denied,
 CASE WHEN w.label='1h' THEN would_deny_1 ELSE would_deny_24 END would_deny,
 CASE WHEN w.label='1h' THEN floor_denied_1 ELSE floor_denied_24 END floor_denied,
 CASE WHEN w.label='1h' THEN anonymous_1 ELSE anonymous_24 END anonymous,
 CASE WHEN w.label='1h' THEN signed_in_1 ELSE signed_in_24 END signed_in
 FROM totals WHERE w.label='24h' OR recent_rows>0
 )
 SELECT (SELECT jsonb_build_object('admitted',coalesce(sum(admitted),0),'denied',coalesce(sum(denied),0),'wouldDeny',coalesce(sum(would_deny),0),'floorDenied',coalesce(sum(floor_denied),0),'anonymous',coalesce(sum(anonymous),0),'signedIn',coalesce(sum(signed_in),0)) FROM selected),
 (SELECT coalesce(jsonb_agg(jsonb_build_object('subject',subject,'admitted',admitted,'denied',denied,'wouldDeny',would_deny,'floorDenied',floor_denied,'anonymous',anonymous,'signedIn',signed_in) ORDER BY admitted DESC,subject),'[]'::jsonb)
  FROM (SELECT * FROM selected ORDER BY admitted DESC,subject LIMIT 20) bounded),
 (SELECT coalesce(jsonb_agg(jsonb_build_object('subject',subject,'admitted',admitted,'denied',denied,'wouldDeny',would_deny,'floorDenied',floor_denied,'anonymous',anonymous,'signedIn',signed_in) ORDER BY denied DESC,subject),'[]'::jsonb)
  FROM (SELECT * FROM selected ORDER BY denied DESC,subject LIMIT 20) bounded),
 (SELECT coalesce(jsonb_agg(jsonb_build_object('subject',subject,'admitted',admitted,'denied',denied,'wouldDeny',would_deny,'floorDenied',floor_denied,'anonymous',anonymous,'signedIn',signed_in) ORDER BY would_deny DESC,subject),'[]'::jsonb)
  FROM (SELECT * FROM selected ORDER BY would_deny DESC,subject LIMIT 20) bounded)
) report ORDER BY w.label;
END $$;
REVOKE ALL ON FUNCTION public.report_odds_subjects() FROM PUBLIC;
