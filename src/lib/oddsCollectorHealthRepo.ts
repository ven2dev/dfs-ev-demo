import "server-only";

import { getSql } from "./db";
import { getCurrentNflSlateWindow } from "./nflWeek";
import type { OddsCollectorHealthSnapshot } from "./oddsCollectorHealth";

type HealthSnapshotRow = {
  has_current_week_pin: boolean;
  has_current_week_scheduled_wake: boolean;
  latest_wake_requested_at: string | null;
  latest_wake_outcome: "success" | "http-error" | "network-error" | "aborted" | null;
  recent_unknown_cost_count: number;
  repeated_failure_count: number;
  terminal_failure_count: number;
  stale_claim_count: number;
  missed_checkpoint_count: number;
  active_non_pilot_checkpoint_count: number;
  active_priority_target_count: number;
  latest_quota_remaining: number | null;
  next_priority_rank: number | null;
  next_market_credit_cost: number | null;
};

const HEALTH_SNAPSHOT_SQL = `
WITH current_pin AS (
  SELECT event_id, selected_at
  FROM odds_free_pilot_selections
  WHERE week_start_time = $2::timestamptz
    AND week_end_time = $3::timestamptz
  LIMIT 1
),
latest_wake AS (
  SELECT requested_at, outcome
  FROM odds_api_request_log
  WHERE source = 'scheduled' AND request_kind = 'events'
  ORDER BY requested_at DESC, id DESC
  LIMIT 1
),
latest_quota AS (
  SELECT quota_remaining
  FROM odds_api_request_log
  WHERE quota_remaining IS NOT NULL
  ORDER BY requested_at DESC, id DESC
  LIMIT 1
),
next_checkpoint AS (
  SELECT checkpoint.priority_rank,
    cardinality(checkpoint.market_keys)::INTEGER AS market_credit_cost
  FROM odds_collection_checkpoints AS checkpoint
  JOIN current_pin AS pin ON pin.event_id = checkpoint.event_id
  WHERE checkpoint.collection_profile = 'free-pilot'
    AND checkpoint.status IN ('pending', 'failed')
    AND checkpoint.due_window_end > $1::timestamptz
  ORDER BY checkpoint.due_at, checkpoint.id
  LIMIT 1
)
SELECT
  EXISTS (SELECT 1 FROM current_pin) AS has_current_week_pin,
  EXISTS (
    SELECT 1
    FROM odds_api_request_log
    WHERE source = 'scheduled'
      AND request_kind = 'events'
      AND requested_at >= $2::timestamptz
      AND requested_at < $3::timestamptz
  ) AS has_current_week_scheduled_wake,
  (SELECT requested_at FROM latest_wake) AS latest_wake_requested_at,
  (SELECT outcome FROM latest_wake) AS latest_wake_outcome,
  (
    SELECT COUNT(*)::INTEGER
    FROM odds_api_request_log
    WHERE source = 'scheduled'
      AND request_kind = 'event-odds'
      AND outcome = 'success'
      AND quota_last IS NULL
      AND requested_at >= $4::timestamptz
  ) AS recent_unknown_cost_count,
  (
    SELECT COUNT(*)::INTEGER
    FROM odds_collection_checkpoints AS checkpoint
    JOIN current_pin AS pin ON pin.event_id = checkpoint.event_id
    WHERE checkpoint.collection_profile = 'free-pilot'
      AND checkpoint.status = 'failed'
      AND checkpoint.attempts >= 2
      AND checkpoint.due_window_end > $1::timestamptz
  ) AS repeated_failure_count,
  (
    SELECT COUNT(*)::INTEGER
    FROM odds_collection_checkpoints AS checkpoint
    JOIN current_pin AS pin ON pin.event_id = checkpoint.event_id
    WHERE checkpoint.collection_profile = 'free-pilot'
      AND checkpoint.status = 'skipped'
      AND checkpoint.outcome_reason IN (
        'attempt-limit-exhausted',
        'retry-window-exhausted'
      )
      AND checkpoint.updated_at >= pin.selected_at
  ) AS terminal_failure_count,
  (
    SELECT COUNT(*)::INTEGER
    FROM odds_collection_checkpoints
    WHERE status = 'claimed'
      AND claim_expires_at < $5::timestamptz
      AND due_window_end > $1::timestamptz
  ) AS stale_claim_count,
  (
    SELECT COUNT(*)::INTEGER
    FROM odds_collection_checkpoints AS checkpoint
    JOIN current_pin AS pin ON pin.event_id = checkpoint.event_id
    WHERE checkpoint.collection_profile = 'free-pilot'
      AND checkpoint.status = 'skipped'
      AND checkpoint.outcome_reason = 'due-window-expired'
      AND checkpoint.due_window_end > pin.selected_at
  ) AS missed_checkpoint_count,
  (
    SELECT COUNT(*)::INTEGER
    FROM odds_collection_checkpoints
    WHERE collection_profile <> 'free-pilot'
      AND status IN ('pending', 'failed', 'claimed')
      AND due_window_end > $1::timestamptz
  ) AS active_non_pilot_checkpoint_count,
  (
    SELECT COUNT(*)::INTEGER
    FROM odds_priority_targets
    WHERE active = TRUE AND event_start_time > $1::timestamptz
  ) AS active_priority_target_count,
  (SELECT quota_remaining FROM latest_quota) AS latest_quota_remaining,
  (SELECT priority_rank FROM next_checkpoint) AS next_priority_rank,
  (SELECT market_credit_cost FROM next_checkpoint) AS next_market_credit_cost
`;

export const getOddsCollectorHealthSnapshot = async (
  now: Date,
  options: {
    unknownCostLookbackMs?: number;
    staleClaimGraceMs?: number;
  } = {}
): Promise<OddsCollectorHealthSnapshot> => {
  const nowMs = now.getTime();
  const unknownCostLookbackMs = options.unknownCostLookbackMs ?? 24 * 60 * 60 * 1_000;
  const staleClaimGraceMs = options.staleClaimGraceMs ?? 10 * 60 * 1_000;
  if (!Number.isFinite(nowMs)) throw new Error("now must be a valid date");
  for (const [value, field] of [
    [unknownCostLookbackMs, "unknownCostLookbackMs"],
    [staleClaimGraceMs, "staleClaimGraceMs"],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${field} must be a positive integer`);
    }
  }

  const week = getCurrentNflSlateWindow(now);
  const rows = (await getSql().query(HEALTH_SNAPSHOT_SQL, [
    now.toISOString(),
    week.startTime,
    week.endTime,
    new Date(nowMs - unknownCostLookbackMs).toISOString(),
    new Date(nowMs - staleClaimGraceMs).toISOString(),
  ])) as HealthSnapshotRow[];
  const row = rows[0];
  if (!row) throw new Error("Odds collector health query returned no result");

  return {
    currentWeekStartTime: new Date(week.startTime),
    hasCurrentWeekPin: row.has_current_week_pin,
    hasCurrentWeekScheduledWake: row.has_current_week_scheduled_wake,
    latestScheduledWake:
      row.latest_wake_requested_at && row.latest_wake_outcome
        ? {
            requestedAt: new Date(row.latest_wake_requested_at),
            outcome: row.latest_wake_outcome,
          }
        : null,
    recentSuccessfulUnknownCostCount: row.recent_unknown_cost_count,
    repeatedFailureCount: row.repeated_failure_count,
    terminalFailureCount: row.terminal_failure_count,
    staleClaimCount: row.stale_claim_count,
    missedCheckpointCount: row.missed_checkpoint_count,
    activeNonPilotCheckpointCount: row.active_non_pilot_checkpoint_count,
    activePriorityTargetCount: row.active_priority_target_count,
    latestQuotaRemaining: row.latest_quota_remaining,
    nextPilotCheckpoint:
      row.next_priority_rank !== null && row.next_market_credit_cost !== null
        ? {
            priorityRank: row.next_priority_rank,
            marketCreditCost: row.next_market_credit_cost,
          }
        : null,
  };
};
