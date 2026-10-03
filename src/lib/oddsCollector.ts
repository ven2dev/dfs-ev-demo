import "server-only";

import { randomUUID } from "node:crypto";
import {
  getOddsCollectionQuotaLimits,
  planBaselineCheckpoints,
  planPriorityCheckpoints,
  selectBaselineEvents,
  type BaselineEventSelection,
  type OddsCollectionProfile,
} from "./oddsCollectionPolicy";
import {
  claimDueOddsCheckpoints,
  completeOddsCheckpoint,
  failOddsCheckpoint,
  getFreePilotSelection,
  listActiveOddsPriorityTargets,
  pinFreePilotSelection,
  skipOddsCheckpoint,
  supersedeFreePilotCheckpoints,
  upsertOddsCollectionCheckpoints,
  type ClaimedOddsCheckpoint,
} from "./oddsCollectionRepo";
import {
  DEFAULT_SPORT_KEY,
  OddsApiHttpError,
  fetchEventOdds,
  fetchSlateEvents,
  type OddsApiFetch,
  type OddsApiQuota,
  type EventOddsResponse,
} from "./oddsApi";
import { persistOddsObservation } from "./oddsSnapshotRepo";
import { TRACKABLE_PLAYER_PROP_MARKET_KEYS } from "./playerPropMarkets";
import { getCurrentNflSlateWindow } from "./nflWeek";

export type OddsCollectorConfig = {
  profile: OddsCollectionProfile;
  freePilotEventId?: string;
  eveningHourEastern: number;
  ownerId: string;
  leaseMs: number;
  claimLimit: number;
  requestTimeoutMs: number;
  retryDelayMs: number;
  quotaReserve: number;
  priorityFarIntervalMs: number;
  priorityActiveIntervalMs: number;
};

export type OddsCollectorSummary = {
  profile: OddsCollectionProfile;
  baselineEvents: number;
  priorityTargets: number;
  checkpointsUpserted: number;
  supersededFreePilotCheckpoints: number;
  expiredOrExhaustedSkipped: number;
  claimed: number;
  completed: number;
  failed: number;
  skipped: number;
  leaseLost: number;
  knownCreditsUsed: number;
  unknownCostAttempts: number;
  slateQuota: OddsApiQuota | null;
  maxPriorityRank: number;
  claimLimitApplied: number;
  maxCreditCost: number;
};

export type OddsCollectorDeps = {
  fetchSlateEvents: typeof fetchSlateEvents;
  fetchEventOdds: typeof fetchEventOdds;
  listActiveTargets: typeof listActiveOddsPriorityTargets;
  getFreePilotSelection: typeof getFreePilotSelection;
  pinFreePilotSelection: typeof pinFreePilotSelection;
  supersedeFreePilotCheckpoints: typeof supersedeFreePilotCheckpoints;
  upsertCheckpoints: typeof upsertOddsCollectionCheckpoints;
  claimDue: typeof claimDueOddsCheckpoints;
  persistObservation: typeof persistOddsObservation;
  completeCheckpoint: typeof completeOddsCheckpoint;
  failCheckpoint: typeof failOddsCheckpoint;
  skipCheckpoint: typeof skipOddsCheckpoint;
  makeObservationId: () => string;
  now: () => Date;
};

const realDeps: OddsCollectorDeps = {
  fetchSlateEvents,
  fetchEventOdds,
  listActiveTargets: listActiveOddsPriorityTargets,
  getFreePilotSelection,
  pinFreePilotSelection,
  supersedeFreePilotCheckpoints,
  upsertCheckpoints: upsertOddsCollectionCheckpoints,
  claimDue: claimDueOddsCheckpoints,
  persistObservation: persistOddsObservation,
  completeCheckpoint: completeOddsCheckpoint,
  failCheckpoint: failOddsCheckpoint,
  skipCheckpoint: skipOddsCheckpoint,
  makeObservationId: randomUUID,
  now: () => new Date(),
};

const validateConfig = (config: OddsCollectorConfig) => {
  for (const [value, field, maximum] of [
    [config.eveningHourEastern, "eveningHourEastern", 23],
    [config.claimLimit, "claimLimit", 100],
  ] as const) {
    const minimum = field === "eveningHourEastern" ? 0 : 1;
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${field} is outside its supported range`);
    }
  }
  for (const [value, field] of [
    [config.leaseMs, "leaseMs"],
    [config.requestTimeoutMs, "requestTimeoutMs"],
    [config.retryDelayMs, "retryDelayMs"],
    [config.priorityFarIntervalMs, "priorityFarIntervalMs"],
    [config.priorityActiveIntervalMs, "priorityActiveIntervalMs"],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be positive`);
  }
  if (config.ownerId.trim().length === 0) throw new Error("ownerId must not be empty");
  if (!Number.isInteger(config.quotaReserve) || config.quotaReserve < 0) {
    throw new Error("quotaReserve must be a non-negative integer");
  }
};

const CRITICAL_BASELINE_CHECKPOINTS = new Set([
  "friday-final-practice",
  "t-6h",
  "t-15m",
]);

const baselinePriorityRank = (
  profile: "free-pilot" | "paid-baseline",
  checkpointKey: string
) => {
  if (CRITICAL_BASELINE_CHECKPOINTS.has(checkpointKey)) return 20;
  return profile === "paid-baseline" ? 30 : 40;
};

const costFromError = (error: unknown): number | null =>
  error instanceof OddsApiHttpError ? error.quota.last : null;

const enrichedResponse = (
  checkpoint: ClaimedOddsCheckpoint,
  fetched: OddsApiFetch<EventOddsResponse>
): EventOddsResponse => ({
  ...fetched.data,
  sport_key: fetched.data.sport_key ?? checkpoint.sport_key,
  commence_time: fetched.data.commence_time ?? checkpoint.event_start_time,
  home_team: fetched.data.home_team ?? checkpoint.home_team,
  away_team: fetched.data.away_team ?? checkpoint.away_team,
});

export const runOddsCollector = async (
  config: OddsCollectorConfig,
  deps: OddsCollectorDeps = realDeps
): Promise<OddsCollectorSummary> => {
  validateConfig(config);
  const summary: OddsCollectorSummary = {
    profile: config.profile,
    baselineEvents: 0,
    priorityTargets: 0,
    checkpointsUpserted: 0,
    supersededFreePilotCheckpoints: 0,
    expiredOrExhaustedSkipped: 0,
    claimed: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    leaseLost: 0,
    knownCreditsUsed: 0,
    unknownCostAttempts: 0,
    slateQuota: null,
    maxPriorityRank: 0,
    claimLimitApplied: 0,
    maxCreditCost: 0,
  };
  if (config.profile === "disabled") return summary;

  const planningNow = deps.now();
  const slate = await deps.fetchSlateEvents(
    DEFAULT_SPORT_KEY,
    planningNow,
    AbortSignal.timeout(config.requestTimeoutMs),
    "scheduled"
  );
  summary.slateQuota = slate.quota;
  let baselineSelections: BaselineEventSelection[];
  if (config.profile === "free-pilot") {
    const window = getCurrentNflSlateWindow(planningNow);
    const weekStartTime = new Date(window.startTime);
    const weekEndTime = new Date(window.endTime);
    const existingSelection = config.freePilotEventId
      ? null
      : await deps.getFreePilotSelection(weekStartTime);
    if (existingSelection) {
      const refreshedEvent = slate.data.find(
        (event) => event.id === existingSelection.event.id
      );
      baselineSelections = [
        {
          event: refreshedEvent ?? existingSelection.event,
          reason: existingSelection.reason,
        },
      ];
    } else {
      const candidates = selectBaselineEvents(config.profile, slate.data, {
        freePilotEventId: config.freePilotEventId,
      });
      const candidate = candidates[0];
      if (candidate) {
        const selection = await deps.pinFreePilotSelection({
          weekStartTime,
          weekEndTime,
          event: candidate.event,
          reason: config.freePilotEventId ? "explicit-override" : "latest-sunday",
          selectedAt: planningNow,
        });
        const refreshedEvent = slate.data.find(
          (event) => event.id === selection.event.id
        );
        baselineSelections = [
          {
            event: refreshedEvent ?? selection.event,
            reason: selection.reason,
          },
        ];
      } else {
        baselineSelections = [];
      }
    }
    const selectedEvent = baselineSelections[0]?.event;
    if (selectedEvent) {
      summary.supersededFreePilotCheckpoints = await deps.supersedeFreePilotCheckpoints({
        selectedEventId: selectedEvent.id,
        weekStartTime,
        weekEndTime,
        supersededAt: planningNow,
      });
    }
  } else {
    baselineSelections = selectBaselineEvents(config.profile, slate.data);
  }
  summary.baselineEvents = baselineSelections.length;

  for (const selection of baselineSelections) {
    const checkpoints = planBaselineCheckpoints(selection.event, {
      eveningHourEastern: config.eveningHourEastern,
    });
    const byRank = new Map<number, typeof checkpoints>();
    for (const checkpoint of checkpoints) {
      const rank = baselinePriorityRank(config.profile, checkpoint.checkpointKey);
      byRank.set(rank, [...(byRank.get(rank) ?? []), checkpoint]);
    }
    for (const [rank, rankedCheckpoints] of byRank) {
      const ids = await deps.upsertCheckpoints(
        {
          profile: config.profile,
          sportKey: selection.event.sportKey,
          eventId: selection.event.id,
          homeTeam: selection.event.homeTeam,
          awayTeam: selection.event.awayTeam,
          eventStartTime: new Date(selection.event.commenceTime),
          marketKeys: [...TRACKABLE_PLAYER_PROP_MARKET_KEYS],
          priorityRank: rank,
          scheduleReason: selection.reason,
        },
        rankedCheckpoints
      );
      summary.checkpointsUpserted += ids.length;
    }
  }

  const targets = await deps.listActiveTargets(planningNow);
  summary.priorityTargets = targets.length;
  for (const target of targets) {
    const checkpoints = planPriorityCheckpoints(
      {
        targetId: target.id,
        eventId: target.eventId,
        activatedAt: target.activatedAt,
        eventStartTime: target.eventStartTime,
      },
      {
        farIntervalMs: config.priorityFarIntervalMs,
        activeIntervalMs: config.priorityActiveIntervalMs,
      }
    );
    const ids = await deps.upsertCheckpoints(
      {
        profile: "priority",
        targetId: target.id,
        sportKey: target.sportKey,
        eventId: target.eventId,
        homeTeam: target.homeTeam,
        awayTeam: target.awayTeam,
        eventStartTime: target.eventStartTime,
        marketKeys: target.marketKeys,
        priorityRank: 10,
        scheduleReason: target.reason,
      },
      checkpoints
    );
    summary.checkpointsUpserted += ids.length;
  }

  const quotaLimits = getOddsCollectionQuotaLimits(
    slate.quota.remaining,
    config.quotaReserve,
    TRACKABLE_PLAYER_PROP_MARKET_KEYS.length
  );
  summary.maxPriorityRank = quotaLimits.maxPriorityRank;
  const remaining = slate.quota.remaining;
  const scarceOrUnknown =
    remaining === null ||
    remaining <= config.quotaReserve + TRACKABLE_PLAYER_PROP_MARKET_KEYS.length;
  summary.claimLimitApplied = scarceOrUnknown ? 1 : config.claimLimit;
  summary.maxCreditCost = quotaLimits.maxCreditCost;
  const claimResult = await deps.claimDue({
    ownerId: config.ownerId,
    now: deps.now(),
    leaseMs: config.leaseMs,
    limit: summary.claimLimitApplied,
    maxPriorityRank: summary.maxPriorityRank,
    maxCreditCost: summary.maxCreditCost,
  });
  summary.expiredOrExhaustedSkipped = claimResult.skippedCount;
  summary.claimed = claimResult.claimed.length;

  const recordCost = (cost: number | null) => {
    if (cost === null) summary.unknownCostAttempts += 1;
    else summary.knownCreditsUsed += cost;
  };

  for (const checkpoint of claimResult.claimed) {
    const beforeFetch = deps.now();
    if (
      beforeFetch.getTime() >= Date.parse(checkpoint.event_start_time) ||
      beforeFetch.getTime() >= Date.parse(checkpoint.due_window_end)
    ) {
      const skipped = await deps.skipCheckpoint({
        checkpointId: checkpoint.id,
        ownerId: config.ownerId,
        skippedAt: beforeFetch,
        reason: "checkpoint-no-longer-pregame",
      });
      if (skipped) summary.skipped += 1;
      else summary.leaseLost += 1;
      continue;
    }

    let attempted = false;
    let costRecorded = false;
    let attemptCost: number | null = null;
    try {
      attempted = true;
      const fetched = await deps.fetchEventOdds(
        checkpoint.sport_key,
        checkpoint.event_id,
        checkpoint.market_keys,
        AbortSignal.timeout(config.requestTimeoutMs),
        "scheduled"
      );
      attemptCost = fetched.quota.last;
      recordCost(attemptCost);
      costRecorded = true;
      const event = enrichedResponse(checkpoint, fetched);
      const capturedAt = new Date(fetched.capturedAt);
      if (capturedAt.getTime() >= Date.parse(checkpoint.event_start_time)) {
        const skipped = await deps.skipCheckpoint({
          checkpointId: checkpoint.id,
          ownerId: config.ownerId,
          skippedAt: deps.now(),
          reason: "response-received-at-or-after-kickoff",
          creditCost: attemptCost,
        });
        if (skipped) summary.skipped += 1;
        else summary.leaseLost += 1;
        continue;
      }

      const observationId = deps.makeObservationId();
      await deps.persistObservation(
        {
          observationId,
          sportKey: checkpoint.sport_key,
          eventId: checkpoint.event_id,
          homeTeam: checkpoint.home_team,
          awayTeam: checkpoint.away_team,
          eventStartTime: new Date(checkpoint.event_start_time),
          source: "scheduled",
          capturedAt,
          requestedMarketKeys: checkpoint.market_keys,
          collectionProfile: checkpoint.collection_profile,
          checkpointKey: checkpoint.checkpoint_key,
          quota: fetched.quota,
        },
        event
      );
      const completed = await deps.completeCheckpoint({
        checkpointId: checkpoint.id,
        ownerId: config.ownerId,
        completedAt: deps.now(),
        observationId,
        creditCost: attemptCost,
        reason: "upstream-response-persisted",
      });
      if (completed) summary.completed += 1;
      else summary.leaseLost += 1;
    } catch (error) {
      const failedAt = deps.now();
      if (attempted && !costRecorded) {
        attemptCost = costFromError(error);
        recordCost(attemptCost);
        costRecorded = true;
      }
      const retryAt = new Date(failedAt.getTime() + config.retryDelayMs);
      const message = error instanceof Error ? error.message : "Unknown collector error";
      if (
        retryAt.getTime() >= Date.parse(checkpoint.due_window_end) ||
        retryAt.getTime() >= Date.parse(checkpoint.event_start_time)
      ) {
        const skipped = await deps.skipCheckpoint({
          checkpointId: checkpoint.id,
          ownerId: config.ownerId,
          skippedAt: failedAt,
          reason: "retry-window-exhausted",
          creditCost: attemptCost,
          error: message,
        });
        if (skipped) summary.skipped += 1;
        else summary.leaseLost += 1;
      } else {
        const failed = await deps.failCheckpoint({
          checkpointId: checkpoint.id,
          ownerId: config.ownerId,
          failedAt,
          retryAt,
          reason: "collection-attempt-failed",
          error: message,
        });
        if (failed) summary.failed += 1;
        else summary.leaseLost += 1;
      }
    }
  }

  return summary;
};
