import "server-only";

import { createHash } from "node:crypto";
import { getSql } from "./db";
import type { PlannedOddsCheckpoint } from "./oddsCollectionPolicy";

export type CollectionCheckpointProfile = "free-pilot" | "paid-baseline" | "priority";

export type CollectionCheckpointContext = {
  profile: CollectionCheckpointProfile;
  targetId?: string;
  sportKey: string;
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  eventStartTime: Date;
  marketKeys: string[];
  priorityRank: number;
  maxAttempts?: number;
  scheduleReason: string;
};

export type ClaimedOddsCheckpoint = {
  id: string;
  kind: "baseline" | "priority";
  collection_profile: CollectionCheckpointProfile;
  target_id: string | null;
  sport_key: string;
  event_id: string;
  home_team: string;
  away_team: string;
  event_start_time: string;
  market_keys: string[];
  checkpoint_key: string;
  due_at: string;
  due_window_end: string;
  priority_rank: number;
  attempts: number;
  max_attempts: number;
  schedule_reason: string;
};

export type OddsPriorityTargetInput = {
  id: string;
  sportKey: string;
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  eventStartTime: Date;
  marketKeys: string[];
  activatedAt: Date;
  reason: string;
};

const UPSERT_CHECKPOINTS_SQL = `
INSERT INTO odds_collection_checkpoints (
  id, kind, collection_profile, target_id, sport_key, event_id,
  home_team, away_team, event_start_time, market_keys, checkpoint_key,
  due_at, due_window_end, priority_rank, max_attempts, schedule_reason
)
SELECT
  checkpoint.id,
  checkpoint.kind,
  $1,
  $2,
  $3,
  $4,
  $5,
  $6,
  $7,
  $8,
  checkpoint.checkpoint_key,
  checkpoint.due_at,
  checkpoint.due_window_end,
  $9,
  $10,
  $11
FROM jsonb_to_recordset($12::jsonb) AS checkpoint(
  id TEXT,
  kind TEXT,
  checkpoint_key TEXT,
  due_at TIMESTAMPTZ,
  due_window_end TIMESTAMPTZ
)
ON CONFLICT (id) DO UPDATE SET
  event_start_time = EXCLUDED.event_start_time,
  market_keys = EXCLUDED.market_keys,
  due_at = EXCLUDED.due_at,
  due_window_end = EXCLUDED.due_window_end,
  priority_rank = EXCLUDED.priority_rank,
  max_attempts = EXCLUDED.max_attempts,
  schedule_reason = EXCLUDED.schedule_reason,
  updated_at = now()
WHERE odds_collection_checkpoints.status IN ('pending', 'failed')
RETURNING id
`;

const CLAIM_DUE_SQL = `
WITH terminal AS (
  UPDATE odds_collection_checkpoints
  SET
    status = 'skipped',
    claim_owner = NULL,
    claim_expires_at = NULL,
    outcome_reason = CASE
      WHEN due_window_end <= $2::timestamptz THEN 'due-window-expired'
      ELSE 'attempt-limit-exhausted'
    END,
    updated_at = $2::timestamptz
  WHERE
    (
      status IN ('pending', 'failed')
      OR (status = 'claimed' AND claim_expires_at <= $2::timestamptz)
    )
    AND due_at <= $2::timestamptz
    AND (due_window_end <= $2::timestamptz OR attempts >= max_attempts)
  RETURNING id
),
candidate AS (
  SELECT id
  FROM odds_collection_checkpoints
  WHERE due_at <= $2::timestamptz
    AND due_window_end > $2::timestamptz
    AND attempts < max_attempts
    AND (
      status = 'pending'
      OR (status = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= $2::timestamptz))
      OR (status = 'claimed' AND claim_expires_at <= $2::timestamptz)
    )
  ORDER BY priority_rank, due_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT $4
),
claimed AS (
  UPDATE odds_collection_checkpoints AS checkpoint
  SET
    status = 'claimed',
    claim_owner = $1,
    claim_expires_at = $2::timestamptz + ($3 * interval '1 millisecond'),
    attempts = checkpoint.attempts + 1,
    next_attempt_at = NULL,
    updated_at = $2::timestamptz
  FROM candidate
  WHERE checkpoint.id = candidate.id
  RETURNING checkpoint.*
)
SELECT
  COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(ordered_claims))
      FROM (
        SELECT * FROM claimed ORDER BY priority_rank, due_at, id
      ) AS ordered_claims
    ),
    '[]'::jsonb
  ) AS claimed,
  (SELECT COUNT(*)::INTEGER FROM terminal) AS skipped_count
`;

const nonEmpty = (value: string, field: string) => {
  if (value.trim().length === 0) throw new Error(`${field} must not be empty`);
};

const checkpointId = (
  context: CollectionCheckpointContext,
  checkpoint: PlannedOddsCheckpoint
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        context.profile,
        context.targetId ?? null,
        context.eventId,
        checkpoint.checkpointKey,
      ])
    )
    .digest("hex");

const validateUniqueMarketKeys = (marketKeys: string[]) => {
  const unique = Array.from(new Set(marketKeys));
  if (unique.length === 0 || unique.some((key) => key.trim().length === 0)) {
    throw new Error("marketKeys must contain at least one non-empty market");
  }
  if (unique.length !== marketKeys.length) {
    throw new Error("marketKeys must not contain duplicates");
  }
  return unique;
};

export const upsertOddsPriorityTarget = async (
  input: OddsPriorityTargetInput
): Promise<void> => {
  for (const [value, field] of [
    [input.id, "id"],
    [input.sportKey, "sportKey"],
    [input.eventId, "eventId"],
    [input.homeTeam, "homeTeam"],
    [input.awayTeam, "awayTeam"],
    [input.reason, "reason"],
  ] as const) {
    nonEmpty(value, field);
  }
  const eventStartMs = input.eventStartTime.getTime();
  const activatedAtMs = input.activatedAt.getTime();
  if (!Number.isFinite(eventStartMs) || !Number.isFinite(activatedAtMs)) {
    throw new Error("Priority target times must be valid dates");
  }
  if (activatedAtMs >= eventStartMs) {
    throw new Error("Priority target must be activated before kickoff");
  }
  const marketKeys = validateUniqueMarketKeys(input.marketKeys);

  await getSql().query(
    `INSERT INTO odds_priority_targets (
       id, sport_key, event_id, home_team, away_team, event_start_time,
       market_keys, activated_at, reason
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       sport_key = EXCLUDED.sport_key,
       event_id = EXCLUDED.event_id,
       home_team = EXCLUDED.home_team,
       away_team = EXCLUDED.away_team,
       event_start_time = EXCLUDED.event_start_time,
       market_keys = EXCLUDED.market_keys,
       reason = EXCLUDED.reason,
       active = TRUE,
       updated_at = now()`,
    [
      input.id,
      input.sportKey,
      input.eventId,
      input.homeTeam,
      input.awayTeam,
      input.eventStartTime.toISOString(),
      marketKeys,
      input.activatedAt.toISOString(),
      input.reason,
    ]
  );
};

export const upsertOddsCollectionCheckpoints = async (
  context: CollectionCheckpointContext,
  checkpoints: PlannedOddsCheckpoint[]
): Promise<string[]> => {
  nonEmpty(context.sportKey, "sportKey");
  nonEmpty(context.eventId, "eventId");
  nonEmpty(context.homeTeam, "homeTeam");
  nonEmpty(context.awayTeam, "awayTeam");
  nonEmpty(context.scheduleReason, "scheduleReason");
  if (!Number.isFinite(context.eventStartTime.getTime())) {
    throw new Error("eventStartTime must be a valid date");
  }
  if (!Number.isInteger(context.priorityRank) || context.priorityRank <= 0) {
    throw new Error("priorityRank must be a positive integer");
  }
  const maxAttempts = context.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("maxAttempts must be a positive integer");
  }
  if ((context.profile === "priority") !== (context.targetId !== undefined)) {
    throw new Error("Priority checkpoints require a targetId, and baseline checkpoints forbid it");
  }
  if (context.targetId !== undefined) nonEmpty(context.targetId, "targetId");

  const marketKeys = validateUniqueMarketKeys(context.marketKeys);
  if (checkpoints.length === 0) return [];
  if (new Set(checkpoints.map((checkpoint) => checkpoint.checkpointKey)).size !== checkpoints.length) {
    throw new Error("checkpointKey values must be unique within one plan");
  }

  const eventStartMs = context.eventStartTime.getTime();
  const payload = checkpoints.map((checkpoint) => {
    if (checkpoint.eventId !== context.eventId) {
      throw new Error(`Checkpoint event "${checkpoint.eventId}" does not match context`);
    }
    if ((checkpoint.kind === "priority") !== (context.profile === "priority")) {
      throw new Error("Checkpoint kind does not match its collection profile");
    }
    const dueAtMs = Date.parse(checkpoint.dueAt);
    const dueWindowEndMs = Date.parse(checkpoint.dueWindowEnd);
    if (
      !Number.isFinite(dueAtMs) ||
      !Number.isFinite(dueWindowEndMs) ||
      dueAtMs >= dueWindowEndMs ||
      dueWindowEndMs > eventStartMs
    ) {
      throw new Error(`Checkpoint "${checkpoint.checkpointKey}" has an invalid due window`);
    }
    nonEmpty(checkpoint.checkpointKey, "checkpointKey");
    return {
      id: checkpointId(context, checkpoint),
      kind: checkpoint.kind,
      checkpoint_key: checkpoint.checkpointKey,
      due_at: checkpoint.dueAt,
      due_window_end: checkpoint.dueWindowEnd,
    };
  });

  const rows = (await getSql().query(UPSERT_CHECKPOINTS_SQL, [
    context.profile,
    context.targetId ?? null,
    context.sportKey,
    context.eventId,
    context.homeTeam,
    context.awayTeam,
    context.eventStartTime.toISOString(),
    marketKeys,
    context.priorityRank,
    maxAttempts,
    context.scheduleReason,
    JSON.stringify(payload),
  ])) as { id: string }[];
  return rows.map((row) => row.id);
};

export const claimDueOddsCheckpoints = async (input: {
  ownerId: string;
  now: Date;
  leaseMs: number;
  limit: number;
}): Promise<{ claimed: ClaimedOddsCheckpoint[]; skippedCount: number }> => {
  nonEmpty(input.ownerId, "ownerId");
  if (!Number.isFinite(input.now.getTime())) throw new Error("now must be a valid date");
  if (!Number.isInteger(input.leaseMs) || input.leaseMs <= 0) {
    throw new Error("leaseMs must be a positive integer");
  }
  if (!Number.isInteger(input.limit) || input.limit <= 0 || input.limit > 100) {
    throw new Error("limit must be an integer from 1 through 100");
  }

  const rows = (await getSql().query(CLAIM_DUE_SQL, [
    input.ownerId,
    input.now.toISOString(),
    input.leaseMs,
    input.limit,
  ])) as { claimed: ClaimedOddsCheckpoint[]; skipped_count: number }[];
  const result = rows[0];
  if (!result) throw new Error("Checkpoint claim returned no result");
  return { claimed: result.claimed, skippedCount: result.skipped_count };
};

export const completeOddsCheckpoint = async (input: {
  checkpointId: string;
  ownerId: string;
  completedAt: Date;
  observationId: string;
  creditCost: number | null;
  reason: string;
}): Promise<boolean> => {
  nonEmpty(input.checkpointId, "checkpointId");
  nonEmpty(input.ownerId, "ownerId");
  nonEmpty(input.observationId, "observationId");
  nonEmpty(input.reason, "reason");
  if (!Number.isFinite(input.completedAt.getTime())) {
    throw new Error("completedAt must be a valid date");
  }
  if (
    input.creditCost !== null &&
    (!Number.isInteger(input.creditCost) || input.creditCost < 0)
  ) {
    throw new Error("creditCost must be a non-negative integer");
  }
  const rows = await getSql().query(
    `UPDATE odds_collection_checkpoints
     SET status = 'completed', claim_owner = NULL, claim_expires_at = NULL,
       observation_id = $4, credit_cost = $5, outcome_reason = $6,
       completed_at = $3, updated_at = $3
     WHERE id = $1 AND status = 'claimed' AND claim_owner = $2
     RETURNING id`,
    [
      input.checkpointId,
      input.ownerId,
      input.completedAt.toISOString(),
      input.observationId,
      input.creditCost,
      input.reason,
    ]
  );
  return rows.length > 0;
};

export const failOddsCheckpoint = async (input: {
  checkpointId: string;
  ownerId: string;
  failedAt: Date;
  retryAt: Date;
  reason: string;
  error: string;
}): Promise<boolean> => {
  for (const [value, field] of [
    [input.checkpointId, "checkpointId"],
    [input.ownerId, "ownerId"],
    [input.reason, "reason"],
    [input.error, "error"],
  ] as const) {
    nonEmpty(value, field);
  }
  if (!Number.isFinite(input.failedAt.getTime()) || !Number.isFinite(input.retryAt.getTime())) {
    throw new Error("Failure and retry times must be valid dates");
  }
  if (input.retryAt.getTime() <= input.failedAt.getTime()) {
    throw new Error("retryAt must be after failedAt");
  }
  const rows = await getSql().query(
    `UPDATE odds_collection_checkpoints
     SET status = 'failed', claim_owner = NULL, claim_expires_at = NULL,
       next_attempt_at = $4, outcome_reason = $5, last_error = $6, updated_at = $3
     WHERE id = $1 AND status = 'claimed' AND claim_owner = $2
     RETURNING id`,
    [
      input.checkpointId,
      input.ownerId,
      input.failedAt.toISOString(),
      input.retryAt.toISOString(),
      input.reason,
      input.error,
    ]
  );
  return rows.length > 0;
};

export const skipOddsCheckpoint = async (input: {
  checkpointId: string;
  ownerId: string;
  skippedAt: Date;
  reason: string;
}): Promise<boolean> => {
  nonEmpty(input.checkpointId, "checkpointId");
  nonEmpty(input.ownerId, "ownerId");
  nonEmpty(input.reason, "reason");
  if (!Number.isFinite(input.skippedAt.getTime())) {
    throw new Error("skippedAt must be a valid date");
  }
  const rows = await getSql().query(
    `UPDATE odds_collection_checkpoints
     SET status = 'skipped', claim_owner = NULL, claim_expires_at = NULL,
       outcome_reason = $4, completed_at = $3, updated_at = $3
     WHERE id = $1 AND status = 'claimed' AND claim_owner = $2
     RETURNING id`,
    [input.checkpointId, input.ownerId, input.skippedAt.toISOString(), input.reason]
  );
  return rows.length > 0;
};
