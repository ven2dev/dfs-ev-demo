import { describe, expect, it } from "vitest";
import {
  evaluateOddsCollectorHealth,
  type OddsCollectorHealthSnapshot,
} from "./oddsCollectorHealth";

const now = new Date("2026-10-03T12:00:00.000Z");

const healthySnapshot = (): OddsCollectorHealthSnapshot => ({
  currentWeekStartTime: new Date("2026-09-29T04:00:00.000Z"),
  hasCurrentWeekPin: true,
  hasCurrentWeekScheduledWake: true,
  latestScheduledWake: {
    requestedAt: new Date("2026-10-03T11:55:00.000Z"),
    outcome: "success",
  },
  recentSuccessfulUnknownCostCount: 0,
  repeatedFailureCount: 0,
  terminalFailureCount: 0,
  staleClaimCount: 0,
  missedCheckpointCount: 0,
  activeNonPilotCheckpointCount: 0,
  activePriorityTargetCount: 0,
  latestQuotaRemaining: 478,
  nextPilotCheckpoint: { priorityRank: 40, marketCreditCost: 9 },
});

const evaluate = (snapshot: OddsCollectorHealthSnapshot) =>
  evaluateOddsCollectorHealth(snapshot, {
    now,
    actualProfile: "free-pilot",
    quotaReserve: 100,
  });

describe("evaluateOddsCollectorHealth", () => {
  it("reports a recent successful free-pilot wake as healthy", () => {
    expect(evaluate(healthySnapshot())).toEqual({
      status: "healthy",
      reasons: [],
      warnings: [],
    });
  });

  it("distinguishes a missing, stale, or failed scheduled wake", () => {
    const missing = healthySnapshot();
    missing.latestScheduledWake = null;
    expect(evaluate(missing).reasons).toEqual(["missing-scheduled-wake"]);

    const stale = healthySnapshot();
    stale.latestScheduledWake = {
      requestedAt: new Date("2026-10-03T11:39:59.999Z"),
      outcome: "success",
    };
    expect(evaluate(stale).reasons).toEqual(["scheduled-wake-stale"]);

    const failed = healthySnapshot();
    failed.latestScheduledWake = {
      requestedAt: new Date("2026-10-03T11:55:00.000Z"),
      outcome: "network-error",
    };
    expect(evaluate(failed).reasons).toEqual(["latest-scheduled-wake-failed"]);
  });

  it("reports every current operational anomaly with stable reason codes", () => {
    const snapshot = healthySnapshot();
    snapshot.recentSuccessfulUnknownCostCount = 1;
    snapshot.repeatedFailureCount = 1;
    snapshot.terminalFailureCount = 1;
    snapshot.staleClaimCount = 1;
    snapshot.missedCheckpointCount = 1;
    snapshot.activeNonPilotCheckpointCount = 1;
    snapshot.activePriorityTargetCount = 1;

    expect(evaluate(snapshot)).toEqual({
      status: "unhealthy",
      reasons: [
        "successful-request-unknown-cost",
        "repeated-checkpoint-failure",
        "exhausted-checkpoint-failure",
        "stale-checkpoint-lease",
        "missed-baseline-checkpoint",
        "active-non-pilot-checkpoint",
        "active-priority-target",
      ],
      warnings: [],
    });
  });

  it("fails closed when the deployment profile or current weekly pin drifts", () => {
    const snapshot = healthySnapshot();
    snapshot.hasCurrentWeekPin = false;

    expect(
      evaluateOddsCollectorHealth(snapshot, {
        now,
        actualProfile: "paid-baseline",
        quotaReserve: 100,
      }).reasons
    ).toEqual(["unexpected-collection-profile", "missing-current-week-pin"]);
  });

  it("allows rollover grace but flags a missing pin after a new-week wake", () => {
    const snapshot = healthySnapshot();
    snapshot.currentWeekStartTime = new Date("2026-09-29T04:00:00.000Z");
    snapshot.hasCurrentWeekPin = false;
    snapshot.hasCurrentWeekScheduledWake = false;
    snapshot.latestScheduledWake = {
      requestedAt: new Date("2026-09-29T04:00:00.000Z"),
      outcome: "success",
    };

    const duringGrace = evaluateOddsCollectorHealth(snapshot, {
      now: new Date("2026-09-29T04:05:00.000Z"),
      actualProfile: "free-pilot",
      quotaReserve: 100,
    });
    expect(duringGrace.reasons).not.toContain("missing-current-week-pin");

    snapshot.hasCurrentWeekScheduledWake = true;
    const afterWake = evaluateOddsCollectorHealth(snapshot, {
      now: new Date("2026-09-29T04:05:00.000Z"),
      actualProfile: "free-pilot",
      quotaReserve: 100,
    });
    expect(afterWake.reasons).toContain("missing-current-week-pin");
  });

  it("warns on quota degradation and fails only when policy blocks the next checkpoint", () => {
    const critical = healthySnapshot();
    critical.latestQuotaRemaining = 100;
    critical.nextPilotCheckpoint = { priorityRank: 20, marketCreditCost: 9 };
    expect(evaluate(critical)).toEqual({
      status: "healthy",
      reasons: [],
      warnings: ["quota-policy-degraded"],
    });

    const ordinary = healthySnapshot();
    ordinary.latestQuotaRemaining = 109;
    expect(evaluate(ordinary)).toEqual({
      status: "unhealthy",
      reasons: ["quota-blocks-next-checkpoint"],
      warnings: [],
    });
  });

  it("uses the collector's fail-closed limits when no quota is known", () => {
    const snapshot = healthySnapshot();
    snapshot.latestQuotaRemaining = null;

    expect(evaluate(snapshot)).toEqual({
      status: "unhealthy",
      reasons: ["quota-blocks-next-checkpoint"],
      warnings: ["quota-state-unavailable"],
    });
  });
});
