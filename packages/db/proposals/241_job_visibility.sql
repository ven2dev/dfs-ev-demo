-- #241 proposal only. Install after #138 on a registered local fixture.
-- Shared relational eligibility: callers own ranking and choose the boundary.
CREATE FUNCTION fs138.completed_jobs_at(p_known_at timestamptz)
RETURNS TABLE (job_id uuid)
LANGUAGE sql STABLE SECURITY INVOKER
-- No SET clause: SQL SRF inlining keeps this predicate relational. Passing a
-- scalar subquery as the argument also prevents inlining; current-clock callers
-- pass the captured clock column laterally instead. finished_at is the terminal
-- UPDATE clock, not COMMIT time; the accepted UPDATE/COMMIT gap remains.
AS $$
  SELECT j.job_id
  FROM fs138.job_runs AS j
  WHERE j.status = 'succeeded' AND j.finished_at <= p_known_at
$$;

REVOKE ALL ON FUNCTION fs138.completed_jobs_at(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fs138.completed_jobs_at(timestamptz)
  TO fs138_reader, fs138_pipeline_writer;
