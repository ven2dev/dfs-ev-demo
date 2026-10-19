import { getOddsCollectionQuotaLimits } from "./oddsCollectionPolicy";

export const ODDS_COLLECTOR_EXPECTED_PROFILE = "free-pilot" as const;

export type OddsCollectorHealthReason =
  | "active-non-pilot-checkpoint"
  | "active-priority-target"
  | "exhausted-checkpoint-failure"
  | "latest-scheduled-wake-failed"
  | "missed-baseline-checkpoint"
  | "missing-current-week-pin"
  | "missing-scheduled-wake"
  | "quota-blocks-next-checkpoint"
  | "repeated-checkpoint-failure"
  | "stale-checkpoint-lease"
  | "successful-request-unknown-cost"
  | "unexpected-collection-profile"
  | "scheduled-wake-stale";

export type OddsCollectorHealthWarning =
  | "quota-policy-degraded"
  | "quota-state-unavailable";

export type OddsCollectorHealthSnapshot = {
  currentWeekStartTime: Date;
  hasCurrentWeekPin: boolean;
  hasCurrentWeekScheduledWake: boolean;
  latestScheduledWake: {
    requestedAt: Date;
    outcome: "success" | "http-error" | "network-error" | "aborted";
  } | null;
  recentSuccessfulUnknownCostCount: number;
  repeatedFailureCount: number;
  terminalFailureCount: number;
  staleClaimCount: number;
  missedCheckpointCount: number;
  activeNonPilotCheckpointCount: number;
  activePriorityTargetCount: number;
  latestQuotaRemaining: number | null;
  nextPilotCheckpoint: {
    priorityRank: number;
    marketCreditCost: number;
  } | null;
};

export type OddsCollectorHealthResult = {
  status: "healthy" | "unhealthy";
  reasons: OddsCollectorHealthReason[];
  warnings: OddsCollectorHealthWarning[];
};

const requireCount = (value: number, field: string) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
};

export const evaluateOddsCollectorHealth = (
  snapshot: OddsCollectorHealthSnapshot,
  options: {
    now: Date;
    actualProfile: string | undefined;
    quotaReserve: number;
    maxWakeAgeMs?: number;
    pinCreationGraceMs?: number;
  }
): OddsCollectorHealthResult => {
  const nowMs = options.now.getTime();
  const maxWakeAgeMs = options.maxWakeAgeMs ?? 20 * 60 * 1_000;
  const pinCreationGraceMs = options.pinCreationGraceMs ?? 15 * 60 * 1_000;
  if (!Number.isFinite(nowMs)) throw new Error("now must be a valid date");
  const weekStartMs = snapshot.currentWeekStartTime.getTime();
  if (!Number.isFinite(weekStartMs)) {
    throw new Error("currentWeekStartTime must be a valid date");
  }
  for (const [value, field] of [
    [maxWakeAgeMs, "maxWakeAgeMs"],
    [pinCreationGraceMs, "pinCreationGraceMs"],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${field} must be a positive integer`);
    }
  }
  if (!Number.isInteger(options.quotaReserve) || options.quotaReserve < 0) {
    throw new Error("quotaReserve must be a non-negative integer");
  }
  for (const [value, field] of [
    [snapshot.recentSuccessfulUnknownCostCount, "recentSuccessfulUnknownCostCount"],
    [snapshot.repeatedFailureCount, "repeatedFailureCount"],
    [snapshot.terminalFailureCount, "terminalFailureCount"],
    [snapshot.staleClaimCount, "staleClaimCount"],
    [snapshot.missedCheckpointCount, "missedCheckpointCount"],
    [snapshot.activeNonPilotCheckpointCount, "activeNonPilotCheckpointCount"],
    [snapshot.activePriorityTargetCount, "activePriorityTargetCount"],
  ] as const) {
    requireCount(value, field);
  }

  const reasons: OddsCollectorHealthReason[] = [];
  const warnings: OddsCollectorHealthWarning[] = [];
  if (options.actualProfile !== ODDS_COLLECTOR_EXPECTED_PROFILE) {
    reasons.push("unexpected-collection-profile");
  }
  if (
    !snapshot.hasCurrentWeekPin &&
    (snapshot.hasCurrentWeekScheduledWake || nowMs - weekStartMs > pinCreationGraceMs)
  ) {
    reasons.push("missing-current-week-pin");
  }

  if (!snapshot.latestScheduledWake) {
    reasons.push("missing-scheduled-wake");
  } else {
    const requestedAtMs = snapshot.latestScheduledWake.requestedAt.getTime();
    if (!Number.isFinite(requestedAtMs)) {
      throw new Error("latestScheduledWake.requestedAt must be a valid date");
    }
    if (nowMs - requestedAtMs > maxWakeAgeMs) {
      reasons.push("scheduled-wake-stale");
    }
    if (snapshot.latestScheduledWake.outcome !== "success") {
      reasons.push("latest-scheduled-wake-failed");
    }
  }

  if (snapshot.recentSuccessfulUnknownCostCount > 0) {
    reasons.push("successful-request-unknown-cost");
  }
  if (snapshot.repeatedFailureCount > 0) reasons.push("repeated-checkpoint-failure");
  if (snapshot.terminalFailureCount > 0) reasons.push("exhausted-checkpoint-failure");
  if (snapshot.staleClaimCount > 0) reasons.push("stale-checkpoint-lease");
  if (snapshot.missedCheckpointCount > 0) reasons.push("missed-baseline-checkpoint");
  if (snapshot.activeNonPilotCheckpointCount > 0) {
    reasons.push("active-non-pilot-checkpoint");
  }
  if (snapshot.activePriorityTargetCount > 0) reasons.push("active-priority-target");

  const nextCheckpoint = snapshot.nextPilotCheckpoint;
  if (nextCheckpoint) {
    if (!Number.isInteger(nextCheckpoint.priorityRank) || nextCheckpoint.priorityRank <= 0) {
      throw new Error("nextPilotCheckpoint.priorityRank must be a positive integer");
    }
    const limits = getOddsCollectionQuotaLimits(
      snapshot.latestQuotaRemaining,
      options.quotaReserve,
      nextCheckpoint.marketCreditCost
    );
    if (
      nextCheckpoint.priorityRank > limits.maxPriorityRank ||
      nextCheckpoint.marketCreditCost > limits.maxCreditCost
    ) {
      reasons.push("quota-blocks-next-checkpoint");
    }
    if (snapshot.latestQuotaRemaining === null) {
      warnings.push("quota-state-unavailable");
    } else if (limits.maxPriorityRank < 40 && !reasons.includes("quota-blocks-next-checkpoint")) {
      warnings.push("quota-policy-degraded");
    }
  }

  return {
    status: reasons.length === 0 ? "healthy" : "unhealthy",
    reasons,
    warnings,
  };
};
