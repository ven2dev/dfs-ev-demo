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

-- Canonical producer scope/context definitions, relocated from the mutable
-- #138 proposal so completion eligibility has one policy owner. Discovery
-- uses the checkpoint; strict context also uses each request's event boundary.
CREATE FUNCTION fs138.qb_job_snapshot_ids(p_season integer,p_checkpoint timestamptz,
 p_purpose text,p_normalizer text) RETURNS TABLE(snapshot_id uuid)
LANGUAGE sql STABLE AS $$
 WITH scoped AS (
  SELECT snapshot_id FROM fs138.norm_schedule n JOIN fs138.completed_jobs_at(p_checkpoint) j USING(job_id) WHERE normalizer_version=p_normalizer
   AND season BETWEEN CASE WHEN p_purpose='labels' THEN p_season ELSE 2021 END AND p_season
  UNION SELECT snapshot_id FROM fs138.norm_identity n JOIN fs138.completed_jobs_at(p_checkpoint) j USING(job_id) WHERE normalizer_version=p_normalizer
   AND season BETWEEN CASE WHEN p_purpose='labels' THEN p_season ELSE 2021 END AND p_season
  UNION SELECT snapshot_id FROM fs138.norm_player_game_stats n JOIN fs138.completed_jobs_at(p_checkpoint) j USING(job_id) WHERE normalizer_version=p_normalizer
   AND substring(game_id from '^([0-9]{4})_')::integer BETWEEN CASE WHEN p_purpose='labels' THEN p_season ELSE 2021 END AND p_season
  UNION SELECT snapshot_id FROM fs138.norm_participation n JOIN fs138.completed_jobs_at(p_checkpoint) j USING(job_id) WHERE normalizer_version=p_normalizer
   AND substring(game_id from '^([0-9]{4})_')::integer BETWEEN CASE WHEN p_purpose='labels' THEN p_season ELSE 2021 END AND p_season
 ) SELECT s.snapshot_id FROM scoped JOIN fs138.source_snapshots s USING(snapshot_id)
 JOIN fs138.completed_jobs_at(p_checkpoint) j ON j.job_id=s.job_id
 WHERE s.ingested_at<=p_checkpoint AND s.deleted_at IS NULL
 AND p_purpose IN('features','labels');
$$;
REVOKE ALL ON FUNCTION fs138.qb_job_snapshot_ids(integer,timestamptz,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fs138.qb_job_snapshot_ids(integer,timestamptz,text,text) TO fs138_pipeline_writer;

CREATE FUNCTION fs138.qb_job_context(p_season integer, p_checkpoint timestamptz,
  p_mode text, p_purpose text, p_normalizer text)
RETURNS TABLE(player_id text, game_id text, season integer, cutoff timestamptz,
  context_game_id text, context_kickoff timestamptz, discovery_kickoff timestamptz,
  yards integer, reasons text[], target_reasons text[])
-- SECURITY INVOKER, with explicitly qualified relations. No SET clause: this
-- set-returning SQL function stays inlinable so each call can plan from its
-- season/mode/purpose instead of reusing a poor generic function-body plan.
LANGUAGE sql STABLE AS $$
WITH snapshots AS MATERIALIZED (
  SELECT s.* FROM fs138.source_snapshots s
  WHERE p_mode IN ('strict-point-in-time-v1','retrospective-reconstruction-v1')
    AND p_purpose IN ('features','labels')
    AND s.snapshot_id IN(SELECT snapshot_id FROM fs138.qb_job_snapshot_ids(p_season,p_checkpoint,p_purpose,p_normalizer))
), discovery_schedule AS MATERIALIZED (
  SELECT DISTINCT ON(n.game_id) n.*,
    count(*) OVER(PARTITION BY n.game_id,s.available_at,s.ingested_at) AS heads
  FROM fs138.norm_schedule n JOIN snapshots s USING(snapshot_id)
  JOIN fs138.completed_jobs_at(p_checkpoint) nj ON nj.job_id=n.job_id
  WHERE n.normalizer_version=p_normalizer
  ORDER BY n.game_id,s.available_at DESC,s.ingested_at DESC,n.snapshot_id
), discovery_roster AS (
  SELECT DISTINCT ON(n.player_id,n.season,n.week,n.team) n.*
  FROM fs138.norm_identity n JOIN snapshots s USING(snapshot_id)
  JOIN fs138.completed_jobs_at(p_checkpoint) nj ON nj.job_id=n.job_id WHERE n.normalizer_version=p_normalizer
  ORDER BY n.player_id,n.season,n.week,n.team,s.available_at DESC,s.ingested_at DESC,n.snapshot_id
), discovery_stats AS (
  SELECT DISTINCT ON(n.player_id,n.game_id) n.*
  FROM fs138.norm_player_game_stats n JOIN snapshots s USING(snapshot_id)
  JOIN fs138.completed_jobs_at(p_checkpoint) nj ON nj.job_id=n.job_id WHERE n.normalizer_version=p_normalizer
  ORDER BY n.player_id,n.game_id,s.available_at DESC,s.ingested_at DESC,n.snapshot_id
), population AS MATERIALIZED (
  SELECT n.player_id,s.game_id FROM discovery_roster n JOIN discovery_schedule s
    ON n.season=s.season AND n.week=s.week AND n.team IN(s.home_team,s.away_team)
  UNION SELECT player_id,game_id FROM discovery_stats
), targets AS MATERIALIZED (
  SELECT p.*,coalesce(s.season,substring(p.game_id from '^([0-9]{4})_')::integer) AS season,
    s.kickoff-interval '1 hour' AS cutoff,s.heads AS discovery_heads
  FROM population p LEFT JOIN discovery_schedule s USING(game_id)
  WHERE coalesce(s.season,substring(p.game_id from '^([0-9]{4})_')::integer)=p_season
), requests AS MATERIALIZED (
  SELECT t.*,h.game_id AS context_game_id,d.kickoff AS discovery_kickoff,
    CASE WHEN p_purpose='labels' THEN p_checkpoint ELSE t.cutoff END AS eligibility_clock
  FROM targets t JOIN population h ON h.player_id=t.player_id
    AND (p_purpose='features' OR h.game_id=t.game_id)
  LEFT JOIN discovery_schedule d ON d.game_id=h.game_id
), schedules AS MATERIALIZED (
  SELECT DISTINCT ON(r.player_id,r.game_id,r.context_game_id)
    r.player_id,r.game_id,r.context_game_id,n.season,n.week,n.kickoff,n.home_team,n.away_team,
    n.state='usable' AND n.game_type='REG' AS usable,n.state='ambiguous' AS ambiguous,
    n.home_score IS NOT NULL AND n.away_score IS NOT NULL AS completed,
    count(*) OVER(PARTITION BY r.player_id,r.game_id,r.context_game_id,s.available_at,s.ingested_at) AS heads
  FROM requests r JOIN fs138.norm_schedule n ON n.game_id=r.context_game_id JOIN snapshots s USING(snapshot_id)
  -- Keep this CASE at each join: a constant p_mode folds it to a fixed checkpoint
  -- job set in reconstruction mode. Computing it as a column of a precomputed
  -- (materialized) step makes the check run per row, measured at +8.78% context
  -- buffer hits; see cleanup-stopped-20261108T045418Z.json.
  JOIN fs138.completed_jobs_at(CASE WHEN p_mode='strict-point-in-time-v1' THEN least(p_checkpoint,r.eligibility_clock) ELSE p_checkpoint END) sj ON sj.job_id=s.job_id
  JOIN fs138.completed_jobs_at(CASE WHEN p_mode='strict-point-in-time-v1' THEN least(p_checkpoint,r.eligibility_clock) ELSE p_checkpoint END) nj ON nj.job_id=n.job_id
  WHERE n.normalizer_version=p_normalizer AND (p_mode='retrospective-reconstruction-v1'
    OR (s.available_at<=r.eligibility_clock AND s.ingested_at<=r.eligibility_clock))
  ORDER BY r.player_id,r.game_id,r.context_game_id,s.available_at DESC,s.ingested_at DESC,n.snapshot_id
), stats AS MATERIALIZED (
  SELECT DISTINCT ON(r.player_id,r.game_id,r.context_game_id)
    r.player_id,r.game_id,r.context_game_id,n.team,n.passing_yards AS yards,
    n.state='usable' AS usable,n.state='ambiguous' AS ambiguous,
    count(*) OVER(PARTITION BY r.player_id,r.game_id,r.context_game_id,s.available_at,s.ingested_at) AS heads
  FROM requests r JOIN fs138.norm_player_game_stats n ON n.player_id=r.player_id AND n.game_id=r.context_game_id
    JOIN snapshots s USING(snapshot_id)
  JOIN fs138.completed_jobs_at(CASE WHEN p_mode='strict-point-in-time-v1' THEN least(p_checkpoint,r.eligibility_clock) ELSE p_checkpoint END) sj ON sj.job_id=s.job_id
  JOIN fs138.completed_jobs_at(CASE WHEN p_mode='strict-point-in-time-v1' THEN least(p_checkpoint,r.eligibility_clock) ELSE p_checkpoint END) nj ON nj.job_id=n.job_id
  WHERE n.normalizer_version=p_normalizer AND (p_mode='retrospective-reconstruction-v1'
    OR (s.available_at<=r.eligibility_clock AND s.ingested_at<=r.eligibility_clock))
  ORDER BY r.player_id,r.game_id,r.context_game_id,s.available_at DESC,s.ingested_at DESC,n.snapshot_id
), identity_heads AS (
  SELECT DISTINCT ON(r.player_id,r.game_id,r.context_game_id,n.team)
    r.player_id,r.game_id,r.context_game_id,n.team,n.state,n.position,
    count(*) OVER(PARTITION BY r.player_id,r.game_id,r.context_game_id,n.team,s.available_at,s.ingested_at) AS heads
  FROM requests r JOIN schedules g USING(player_id,game_id,context_game_id)
    JOIN fs138.norm_identity n ON n.player_id=r.player_id AND n.season=g.season AND n.week=g.week
      AND n.team IN(g.home_team,g.away_team) JOIN snapshots s USING(snapshot_id)
  JOIN fs138.completed_jobs_at(CASE WHEN p_mode='strict-point-in-time-v1' THEN least(p_checkpoint,r.eligibility_clock) ELSE p_checkpoint END) sj ON sj.job_id=s.job_id
  JOIN fs138.completed_jobs_at(CASE WHEN p_mode='strict-point-in-time-v1' THEN least(p_checkpoint,r.eligibility_clock) ELSE p_checkpoint END) nj ON nj.job_id=n.job_id
  WHERE n.normalizer_version=p_normalizer AND (p_mode='retrospective-reconstruction-v1'
    OR (s.available_at<=r.eligibility_clock AND s.ingested_at<=r.eligibility_clock))
  ORDER BY r.player_id,r.game_id,r.context_game_id,n.team,s.available_at DESC,s.ingested_at DESC,n.snapshot_id
), identities AS MATERIALIZED (
  SELECT player_id,game_id,context_game_id,min(team) AS team,sum(heads) AS heads,
    bool_and(state='usable' AND position='QB') AS usable,bool_or(state='ambiguous') AS ambiguous
  FROM identity_heads GROUP BY player_id,game_id,context_game_id
), participation AS MATERIALIZED (
  SELECT DISTINCT ON(r.player_id,r.game_id,r.context_game_id)
    r.player_id,r.game_id,r.context_game_id,n.state='usable' AND n.offense_play_count>0 AS usable,n.state='ambiguous' AS ambiguous,
    count(*) OVER(PARTITION BY r.player_id,r.game_id,r.context_game_id,s.available_at,s.ingested_at) AS heads
  FROM requests r JOIN fs138.norm_participation n ON n.player_id=r.player_id AND n.game_id=r.context_game_id
    JOIN snapshots s USING(snapshot_id)
  JOIN fs138.completed_jobs_at(CASE WHEN p_mode='strict-point-in-time-v1' THEN least(p_checkpoint,r.eligibility_clock) ELSE p_checkpoint END) sj ON sj.job_id=s.job_id
  JOIN fs138.completed_jobs_at(CASE WHEN p_mode='strict-point-in-time-v1' THEN least(p_checkpoint,r.eligibility_clock) ELSE p_checkpoint END) nj ON nj.job_id=n.job_id
  WHERE n.normalizer_version=p_normalizer AND (p_mode='retrospective-reconstruction-v1'
    OR (s.available_at<=r.eligibility_clock AND s.ingested_at<=r.eligibility_clock))
  ORDER BY r.player_id,r.game_id,r.context_game_id,s.available_at DESC,s.ingested_at DESC,n.snapshot_id
)
SELECT r.player_id,r.game_id,r.season,r.cutoff,r.context_game_id,g.kickoff,r.discovery_kickoff,st.yards,
  array_remove(ARRAY[
    CASE WHEN g.heads IS NULL THEN 'schedule-missing' WHEN g.heads<>1 OR g.ambiguous THEN 'schedule-ambiguous' WHEN NOT g.usable THEN 'schedule-refused' END,
    CASE WHEN NOT coalesce(g.completed,false) THEN 'completion-unavailable' END,
    CASE WHEN st.heads IS NULL THEN 'stats-missing' WHEN st.heads<>1 OR st.ambiguous THEN 'stats-ambiguous' WHEN NOT st.usable THEN 'stats-refused' END,
    CASE WHEN i.heads IS NULL THEN 'identity-missing' WHEN i.heads<>1 OR i.ambiguous THEN 'identity-ambiguous' WHEN NOT i.usable THEN 'identity-refused' END,
    CASE WHEN st.team IS NOT NULL AND (st.team NOT IN(g.home_team,g.away_team) OR st.team<>i.team) THEN 'identity-team-conflict' END,
    CASE WHEN p.heads IS NULL THEN 'positive-offense-participation-missing' WHEN p.heads<>1 OR p.ambiguous THEN 'participation-ambiguous' WHEN NOT p.usable THEN 'participation-refused' END
  ],NULL),
  array_remove(ARRAY[
    CASE WHEN r.cutoff IS NULL THEN 'target-schedule-missing' WHEN r.discovery_heads<>1 THEN 'target-schedule-ambiguous' END,
    CASE WHEN g.heads IS NULL THEN 'target-schedule-missing' WHEN g.heads<>1 OR g.ambiguous THEN 'target-schedule-ambiguous'
      WHEN NOT g.usable THEN 'target-schedule-refused' WHEN g.kickoff-interval '1 hour'<>r.cutoff THEN 'target-schedule-changed' END,
    CASE WHEN i.heads IS NULL THEN 'target-identity-missing' WHEN i.heads<>1 OR i.ambiguous THEN 'target-identity-ambiguous' WHEN NOT i.usable THEN 'target-identity-refused' END
  ],NULL)
FROM requests r LEFT JOIN schedules g USING(player_id,game_id,context_game_id)
  LEFT JOIN stats st USING(player_id,game_id,context_game_id)
  LEFT JOIN identities i USING(player_id,game_id,context_game_id)
  LEFT JOIN participation p USING(player_id,game_id,context_game_id);
$$;
REVOKE ALL ON FUNCTION fs138.qb_job_context(integer,timestamptz,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fs138.qb_job_context(integer,timestamptz,text,text,text) TO fs138_pipeline_writer;
