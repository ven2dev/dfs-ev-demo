-- LOCAL SPIKE ONLY. Applied after #138/#163/#165/#166 to a disposable database.
-- Pattern: retained single-owner GC metadata on the existing removal row.
-- Alternatives/reasons and owner-approved backoff: docs/229-late-put-recovery-roadmap.md.
-- Admin-only prototypes, intentionally not exposed as production writer APIs.
ALTER TABLE fs138.object_removals ADD COLUMN recovery_until timestamptz;
ALTER TABLE fs138.object_removals ADD COLUMN recovery_due timestamptz;
ALTER TABLE fs138.object_removals ADD COLUMN recovery_step smallint NOT NULL DEFAULT 0 CHECK(recovery_step BETWEEN 0 AND 6);
CREATE FUNCTION fs138.spike229_next_due(anchor timestamptz,horizon timestamptz,step int)
RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
 SELECT least(horizon,anchor+make_interval(secs=>least(3600,60*power(2,least(greatest(step,0),6)))::double precision))
$$;
CREATE INDEX spike229_recovery_due ON fs138.object_removals(recovery_due,object_key)
 WHERE completed_at IS NOT NULL AND recovery_until IS NOT NULL;
CREATE FUNCTION fs138.spike229_adopt(address text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE enrolled timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 IF NOT EXISTS(SELECT FROM fs138.object_removals WHERE object_key=address) THEN RETURN false; END IF;
 SELECT first_seen INTO enrolled FROM fs138.orphan_observations WHERE object_key=address;
 IF enrolled IS NULL THEN RETURN false; END IF;
 UPDATE fs138.object_removals SET
  recovery_until=greatest(recovery_until,enrolled+interval '24 hours'),
  recovery_due=least(coalesce(recovery_due,clock_timestamp()),clock_timestamp()),
  remove_after=greatest(remove_after,enrolled+interval '300 seconds')
 WHERE object_key=address;
 DELETE FROM fs138.orphan_observations WHERE object_key=address;
 RETURN true;
END $$;
CREATE FUNCTION fs138.spike229_recovery_page() RETURNS SETOF text LANGUAGE sql AS $$
 SELECT r.object_key FROM fs138.object_removals r
 LEFT JOIN fs138.orphan_observations o ON o.object_key=r.object_key
 WHERE (r.object_key ~ '^(models|audits)/' AND o.object_key IS NOT NULL)
 OR (r.completed_at IS NOT NULL AND r.recovery_until IS NOT NULL
 AND r.recovery_due<=clock_timestamp() AND r.remove_after<=clock_timestamp())
 ORDER BY coalesce(r.recovery_due,o.first_seen),r.object_key LIMIT 1024
$$;
CREATE FUNCTION fs138.spike229_recovery_recheck(address text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(address,138));
 RETURN EXISTS(SELECT FROM fs138.object_removals WHERE object_key=address
  AND completed_at IS NOT NULL AND outcome='removed' AND recovery_until IS NOT NULL
  AND recovery_due<=clock_timestamp() AND remove_after<=clock_timestamp());
END $$;
-- Caller retains address transaction lock across idempotent DELETE and ack.
-- Final expired revisit deletes first; only scheduling metadata retires.
CREATE FUNCTION fs138.spike229_recovery_ack(address text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF NOT fs138.spike229_recovery_recheck(address) THEN RAISE EXCEPTION 'not eligible'; END IF;
 UPDATE fs138.object_removals SET
  recovery_due=CASE WHEN recovery_until<=clock_timestamp() THEN NULL ELSE fs138.spike229_next_due(clock_timestamp(),recovery_until,recovery_step) END,
  recovery_step=least(6,recovery_step+1),
  recovery_until=CASE WHEN recovery_until<=clock_timestamp() THEN NULL ELSE recovery_until END
 WHERE object_key=address;
END $$;
REVOKE ALL ON FUNCTION fs138.spike229_adopt(text),fs138.spike229_recovery_page(),
 fs138.spike229_recovery_recheck(text),fs138.spike229_recovery_ack(text),
 fs138.spike229_next_due(timestamptz,timestamptz,int) FROM PUBLIC;
