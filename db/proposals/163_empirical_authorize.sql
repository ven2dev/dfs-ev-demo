-- #163 query 1 and query 3: one batched current rights/status check each.
-- Exact pinned selection is distinct from current freshness and current rights.
WITH clock AS MATERIALIZED(SELECT clock_timestamp() AS now),
feature AS MATERIALIZED(
 SELECT f.feature_id,f.job_id,f.player_id,f.game_id,f.season,f.stat,f.cutoff,
  f.checkpoint,f.computed_at,f.feature_version,f.history_policy,f.evidence_mode,
  f.state,f.reasons,f.flags,f.sample_size,j.status AS job_status
 FROM fs138.feature_values f JOIN fs138.job_runs j USING(job_id) WHERE f.feature_id=$1::uuid
), eligibility AS(
 SELECT CASE
  WHEN $2::timestamptz>now THEN 'future-knowledge-as-of'
  WHEN NOT EXISTS(SELECT 1 FROM feature) THEN 'feature-missing'
  WHEN EXISTS(SELECT 1 FROM feature WHERE feature_version<>$3 OR history_policy<>$4 OR evidence_mode<>$5) THEN 'unsupported-version'
  WHEN EXISTS(SELECT 1 FROM feature WHERE computed_at>$2::timestamptz OR checkpoint>$2::timestamptz) THEN 'feature-after-as-of'
  WHEN EXISTS(SELECT 1 FROM feature WHERE sample_size<2) THEN 'insufficient-history'
  WHEN EXISTS(SELECT 1 FROM feature WHERE sample_size>16) THEN 'history-limit-exceeded'
  WHEN EXISTS(SELECT 1 FROM feature WHERE state<>'usable' OR job_status<>'succeeded' OR stat<>'passing_yards' OR cutoff IS NULL) THEN 'feature-unavailable'
 END AS reason FROM clock
), lineage AS MATERIALIZED(
 SELECT i.snapshot_id,s.profile_id,s.deleted_at,s.available_at::text,s.ingested_at::text,
  s.evidence_basis,j.status AS job_status
 FROM feature f JOIN fs138.feature_inputs i USING(feature_id)
 LEFT JOIN fs138.source_snapshots s USING(snapshot_id)
 LEFT JOIN fs138.job_runs j ON j.job_id=s.job_id
), profiles AS(SELECT DISTINCT profile_id FROM lineage WHERE profile_id IS NOT NULL),
decisions AS MATERIALIZED(
 SELECT p.profile_id,r.decision_id,r.allowed_uses FROM profiles p CROSS JOIN clock
 LEFT JOIN LATERAL(
  SELECT decision_id,allowed_uses FROM fs138.rights_decisions r
  WHERE r.profile_id=p.profile_id AND r.recorded_at<=now AND r.valid_from<=now
   AND (r.valid_until IS NULL OR r.valid_until>now)
  ORDER BY r.recorded_at DESC,r.decision_id DESC LIMIT 1
 ) r ON true
), inputs AS(
 SELECT coalesce(array_agg(snapshot_id ORDER BY snapshot_id),'{}') AS ids FROM lineage
), head AS MATERIALIZED(
 SELECT n.feature_id,n.state FROM feature f JOIN fs138.feature_values n
  ON (n.player_id,n.game_id,n.stat,n.feature_version,n.history_policy,n.evidence_mode)
   =(f.player_id,f.game_id,f.stat,f.feature_version,f.history_policy,f.evidence_mode)
 JOIN fs138.job_runs j ON j.job_id=n.job_id CROSS JOIN clock
 WHERE j.status='succeeded' AND n.computed_at<=now AND n.checkpoint<=now
 ORDER BY n.checkpoint DESC,n.computed_at DESC,n.feature_id DESC LIMIT 1
)
SELECT now::text AS checked_at,eligibility.reason AS selection_reason,
 eligibility.reason IS NULL AND cardinality(ids)>0
 AND NOT EXISTS(SELECT 1 FROM lineage WHERE profile_id IS NULL OR deleted_at IS NOT NULL OR job_status IS DISTINCT FROM 'succeeded')
 AND NOT EXISTS(SELECT 1 FROM decisions WHERE decision_id IS NULL OR NOT('research'=ANY(allowed_uses)))
 AND ($6::uuid[] IS NULL OR ids=$6::uuid[]) AS allowed,
 (SELECT row_to_json(metadata) FROM(
  SELECT f.feature_id,f.job_id,f.player_id,f.game_id,f.season,f.stat,
   f.cutoff::text,f.checkpoint::text,f.computed_at::text,
   f.feature_version,f.history_policy,f.evidence_mode,f.state,f.reasons,f.flags,f.sample_size,f.job_status,
   coalesce(h.feature_id<>f.feature_id,false) AS superseded,
   coalesce(h.feature_id<>f.feature_id AND h.state='unavailable',false) AS stale
  FROM feature f LEFT JOIN head h ON true
 ) metadata) AS feature,
 ids AS snapshot_ids,
 coalesce((SELECT jsonb_agg(to_jsonb(l)-'deleted_at'-'job_status' ORDER BY snapshot_id) FROM lineage l),'[]') AS lineage,
 coalesce((SELECT jsonb_agg(jsonb_build_object('profileId',profile_id,'decisionId',decision_id) ORDER BY profile_id) FROM decisions),'[]') AS decisions
FROM clock CROSS JOIN inputs CROSS JOIN eligibility;
