import { afterEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("./db", () => ({
  getSql: () => ({ query: queryMock }),
}));

const { getOddsCollectorHealthSnapshot } = await import("./oddsCollectorHealthRepo");

afterEach(() => {
  queryMock.mockReset();
});

describe("getOddsCollectorHealthSnapshot", () => {
  it("maps one bounded read-only query into the health snapshot", async () => {
    queryMock.mockResolvedValueOnce([
      {
        has_current_week_pin: true,
        has_current_week_scheduled_wake: true,
        latest_wake_requested_at: "2026-10-03T11:55:00.000Z",
        latest_wake_outcome: "success",
        recent_unknown_cost_count: 0,
        repeated_failure_count: 0,
        terminal_failure_count: 0,
        stale_claim_count: 0,
        missed_checkpoint_count: 0,
        active_non_pilot_checkpoint_count: 0,
        active_priority_target_count: 0,
        latest_quota_remaining: 478,
        next_priority_rank: 40,
        next_market_credit_cost: 9,
      },
    ]);

    await expect(
      getOddsCollectorHealthSnapshot(new Date("2026-10-03T12:00:00.000Z"))
    ).resolves.toEqual({
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

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("source = 'scheduled' AND request_kind = 'events'");
    expect(sql).toContain("requested_at >= $4::timestamptz");
    expect(sql).toContain("checkpoint.attempts >= 2");
    expect(sql).toContain("'attempt-limit-exhausted'");
    expect(sql).toContain("'retry-window-exhausted'");
    expect(sql).toContain("checkpoint.updated_at >= pin.selected_at");
    expect(sql).toContain("claim_expires_at < $5::timestamptz");
    expect(sql).toContain("checkpoint.due_window_end > pin.selected_at");
    expect(sql).toContain("collection_profile <> 'free-pilot'");
    expect(sql).toContain("active = TRUE AND event_start_time > $1::timestamptz");
    expect(params).toEqual([
      "2026-10-03T12:00:00.000Z",
      "2026-09-29T04:00:00.000Z",
      "2026-10-06T04:00:00.000Z",
      "2026-10-02T12:00:00.000Z",
      "2026-10-03T11:50:00.000Z",
    ]);
  });

  it("keeps missing optional evidence explicit instead of fabricating defaults", async () => {
    queryMock.mockResolvedValueOnce([
      {
        has_current_week_pin: false,
        has_current_week_scheduled_wake: false,
        latest_wake_requested_at: null,
        latest_wake_outcome: null,
        recent_unknown_cost_count: 0,
        repeated_failure_count: 0,
        terminal_failure_count: 0,
        stale_claim_count: 0,
        missed_checkpoint_count: 0,
        active_non_pilot_checkpoint_count: 0,
        active_priority_target_count: 0,
        latest_quota_remaining: null,
        next_priority_rank: null,
        next_market_credit_cost: null,
      },
    ]);

    await expect(
      getOddsCollectorHealthSnapshot(new Date("2026-10-03T12:00:00.000Z"))
    ).resolves.toMatchObject({
      currentWeekStartTime: new Date("2026-09-29T04:00:00.000Z"),
      hasCurrentWeekPin: false,
      hasCurrentWeekScheduledWake: false,
      latestScheduledWake: null,
      latestQuotaRemaining: null,
      nextPilotCheckpoint: null,
    });
  });
});
