-- #223 Q0 scratch only. No migration/hosted apply. Synthetic injection arguments
-- are qualification controls, not a proposed production API.
CREATE SCHEMA spike223;
CREATE TABLE spike223.subjects(subject text PRIMARY KEY, tat timestamptz NOT NULL DEFAULT '-infinity');
CREATE TABLE spike223.buckets(
 subject text NOT NULL, minute timestamptz NOT NULL,
 admitted bigint NOT NULL DEFAULT 0, denied bigint NOT NULL DEFAULT 0,
 would_deny bigint NOT NULL DEFAULT 0, floor_denied bigint NOT NULL DEFAULT 0,
 anonymous bigint NOT NULL DEFAULT 0, signed_in bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(subject,minute));
CREATE INDEX buckets_minute ON spike223.buckets(minute,subject);
CREATE TABLE spike223.quota(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 remaining integer, used integer, requested_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX quota_latest ON spike223.quota(requested_at DESC);

-- A logical dimension has 1 ordinary or 2 overlap-version keys. Each dimension
-- designates one reporting key, so overlap checks do not duplicate counts.
CREATE FUNCTION spike223.admit(dims jsonb, enforce boolean, reserve integer,
 batch integer, with_floor boolean DEFAULT true, fault text DEFAULT '')
RETURNS TABLE(outcome text, limiter_denied boolean, warning text, quota_remaining integer)
LANGUAGE plpgsql AS $$
DECLARE d jsonb; k text; keys text[]; t timestamptz; debt timestamptz;
 next_tats jsonb:='{}'; denied boolean:=false; limiter_error boolean:=false;
 floor_denied boolean:=false; rem integer; warn text; minute_at timestamptz;
BEGIN
 BEGIN
  IF jsonb_typeof(dims)<>'array' OR jsonb_array_length(dims) NOT BETWEEN 1 AND 2
    OR EXISTS(SELECT FROM jsonb_array_elements(dims) x WHERE
      jsonb_array_length(x->'keys') NOT BETWEEN 1 AND 2
      OR (x->>'interval_ms')::int<1 OR (x->>'burst')::int<1
      OR NOT (x->'keys') ? (x->>'report')) THEN RAISE EXCEPTION 'invalid dimensions'; END IF;
  SELECT array_agg(DISTINCT v ORDER BY v) INTO keys
   FROM jsonb_array_elements(dims) x CROSS JOIN LATERAL jsonb_array_elements_text(x->'keys') v;
  FOREACH k IN ARRAY keys LOOP
    INSERT INTO spike223.subjects(subject) VALUES(k) ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM 1 FROM spike223.subjects WHERE subject=ANY(keys) ORDER BY subject FOR UPDATE;
  t:=clock_timestamp(); minute_at:=date_trunc('minute',t);
  FOR d IN SELECT * FROM jsonb_array_elements(dims) LOOP
    SELECT max(tat) INTO debt FROM spike223.subjects
     WHERE subject IN (SELECT jsonb_array_elements_text(d->'keys'));
    IF t<debt-((d->>'burst')::int-1)*(d->>'interval_ms')::int*interval '1 millisecond' THEN denied:=true; END IF;
    FOR k IN SELECT jsonb_array_elements_text(d->'keys') LOOP
      next_tats:=next_tats||jsonb_build_object(k,greatest(t,debt)+(d->>'interval_ms')::int*interval '1 millisecond');
    END LOOP;
  END LOOP;
  IF fault='limiter' THEN RAISE EXCEPTION 'injected limiter failure'; END IF;
 EXCEPTION WHEN OTHERS THEN
  limiter_error:=true; denied:=false; warn:='limiter-evaluation-failed';
 END;
 IF with_floor AND (limiter_error OR NOT denied OR NOT enforce) THEN
  BEGIN
   IF fault='quota' THEN RAISE EXCEPTION 'injected quota failure'; END IF;
   SELECT remaining INTO rem FROM spike223.quota WHERE remaining IS NOT NULL ORDER BY requested_at DESC LIMIT 1;
   floor_denied:=coalesce(rem<=reserve+batch,false);
  EXCEPTION WHEN OTHERS THEN warn:='quota-read-failed'; END;
 END IF;
 IF NOT limiter_error THEN
  BEGIN
   IF NOT denied AND NOT floor_denied THEN
    UPDATE spike223.subjects s SET tat=(next_tats->>s.subject)::timestamptz WHERE s.subject=ANY(keys);
   END IF;
   IF fault='counter' THEN RAISE EXCEPTION 'injected counter failure'; END IF;
   FOR d IN SELECT value FROM jsonb_array_elements(dims) ORDER BY value->>'report' LOOP
    INSERT INTO spike223.buckets(subject,minute,admitted,denied,would_deny,floor_denied,anonymous,signed_in)
    VALUES(d->>'report',minute_at,
     CASE WHEN NOT floor_denied AND (NOT denied OR NOT enforce) THEN 1 ELSE 0 END,
     CASE WHEN denied AND enforce THEN 1 ELSE 0 END,
     CASE WHEN denied AND NOT enforce THEN 1 ELSE 0 END,
     CASE WHEN floor_denied THEN 1 ELSE 0 END,
     CASE WHEN d->>'traffic'='anonymous' AND NOT floor_denied AND (NOT denied OR NOT enforce) THEN 1 ELSE 0 END,
     CASE WHEN d->>'traffic'='signed-in' AND NOT floor_denied AND (NOT denied OR NOT enforce) THEN 1 ELSE 0 END)
    ON CONFLICT(subject,minute) DO UPDATE SET
     admitted=spike223.buckets.admitted+excluded.admitted,
     denied=spike223.buckets.denied+excluded.denied,
     would_deny=spike223.buckets.would_deny+excluded.would_deny,
     floor_denied=spike223.buckets.floor_denied+excluded.floor_denied,
     anonymous=spike223.buckets.anonymous+excluded.anonymous,
     signed_in=spike223.buckets.signed_in+excluded.signed_in;
   END LOOP;
  EXCEPTION WHEN OTHERS THEN
   limiter_error:=true; warn:='limiter-counter-failed'; denied:=false;
  END;
 END IF;
 RETURN QUERY SELECT CASE WHEN floor_denied THEN 'quota-floor'
  WHEN denied AND enforce AND NOT limiter_error THEN 'subject-rate-limit' ELSE 'allow' END,
  denied,warn,rem;
END $$;

-- Called only after an owner proves refusal happened before any provider send.
-- Original ordinary release preserves refresh_claimed_at; this distinct release
-- removes only a current owner's limiter-denied cooldown.
CREATE TABLE spike223.event_market_odds_cache(
 event_id text NOT NULL, market_key text NOT NULL, payload jsonb NOT NULL,
 fetched_at timestamptz NOT NULL, PRIMARY KEY(event_id,market_key));
