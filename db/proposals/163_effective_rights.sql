-- Shared #163 review repair; apply after the two #138 companion proposals.
-- An effective newer decision supersedes older grants even after it expires.
-- Callers pass their single statement clock; historical tests also pin knowledge.
-- Invoker rights and fully qualified objects preserve existing role boundaries.
CREATE FUNCTION fs138.effective_rights(p_profile text,p_valid_at timestamptz,p_known_at timestamptz)
RETURNS TABLE(decision_id uuid,allowed_uses text[])
LANGUAGE sql STABLE PARALLEL SAFE ROWS 1 AS $$
 SELECT head.decision_id,
  CASE WHEN head.valid_until IS NULL OR head.valid_until>p_valid_at
   THEN head.allowed_uses ELSE '{}'::text[] END AS allowed_uses
 FROM (
  SELECT r.decision_id,r.allowed_uses,r.valid_until FROM fs138.rights_decisions r
  WHERE r.profile_id=p_profile AND r.recorded_at<=p_known_at AND r.valid_from<=p_valid_at
  ORDER BY r.recorded_at DESC,r.decision_id DESC LIMIT 1
 ) head
$$;
REVOKE ALL ON FUNCTION fs138.effective_rights(text,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fs138.effective_rights(text,timestamptz,timestamptz)
 TO fs138_reader,fs138_pipeline_writer;
