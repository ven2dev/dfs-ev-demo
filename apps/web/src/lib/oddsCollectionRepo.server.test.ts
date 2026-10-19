import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlannedOddsCheckpoint } from "./oddsCollectionPolicy";

const queryMock = vi.fn();

vi.mock("./db", () => ({
  getSql: () => ({ query: queryMock }),
}));

const {
  claimDueOddsCheckpoints,
  completeOddsCheckpoint,
  failOddsCheckpoint,
  getFreePilotSelection,
  listActiveOddsPriorityTargets,
  pinFreePilotSelection,
  skipOddsCheckpoint,
  supersedeFreePilotCheckpoints,
  upsertOddsCollectionCheckpoints,
  upsertOddsPriorityTarget,
} = await import("./oddsCollectionRepo.ts");

const context = () => ({
  profile: "free-pilot" as const,
  sportKey: "americanfootball_nfl",
  eventId: "event-1",
  homeTeam: "Philadelphia Eagles",
  awayTeam: "Dallas Cowboys",
  eventStartTime: new Date("2026-10-04T20:00:00Z"),
  marketKeys: ["player_pass_yds", "player_receptions"],
  priorityRank: 20,
  maxAttempts: 3,
  scheduleReason: "weekly-free-pilot",
});

const checkpoint = (): PlannedOddsCheckpoint => ({
  eventId: "event-1",
  kind: "baseline",
  checkpointKey: "t-15m",
  dueAt: "2026-10-04T19:45:00.000Z",
  dueWindowEnd: "2026-10-04T20:00:00.000Z",
});

afterEach(() => {
  queryMock.mockReset();
});

describe("odds collection persistence", () => {
  it("keeps the first automatic free-pilot selection for an NFL week", async () => {
    queryMock.mockResolvedValueOnce([
      {
        week_start_time: "2026-09-29T04:00:00.000Z",
        week_end_time: "2026-10-06T04:00:00.000Z",
        sport_key: "americanfootball_nfl",
        event_id: "event-1",
        home_team: "Philadelphia Eagles",
        away_team: "Dallas Cowboys",
        event_start_time: "2026-10-04T20:00:00.000Z",
        selection_reason: "latest-sunday",
        selected_at: "2026-09-30T00:00:00.000Z",
      },
    ]);

    await expect(
      pinFreePilotSelection({
        weekStartTime: new Date("2026-09-29T04:00:00Z"),
        weekEndTime: new Date("2026-10-06T04:00:00Z"),
        event: {
          id: "event-1",
          sportKey: "americanfootball_nfl",
          homeTeam: "Philadelphia Eagles",
          awayTeam: "Dallas Cowboys",
          commenceTime: "2026-10-04T20:00:00Z",
        },
        reason: "latest-sunday",
        selectedAt: new Date("2026-09-30T00:00:00Z"),
      })
    ).resolves.toMatchObject({
      event: { id: "event-1" },
      reason: "latest-sunday",
    });

    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain("ON CONFLICT (week_start_time) DO UPDATE");
    expect(sql).toContain("EXCLUDED.selection_reason = 'explicit-override'");
    expect(sql).toContain("odds_free_pilot_selections.event_id = EXCLUDED.event_id");
    expect(sql).toContain("THEN odds_free_pilot_selections.selected_at");
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM selected)");
  });

  it("loads a durable weekly pilot selection", async () => {
    queryMock.mockResolvedValueOnce([
      {
        week_start_time: "2026-09-29T04:00:00.000Z",
        week_end_time: "2026-10-06T04:00:00.000Z",
        sport_key: "americanfootball_nfl",
        event_id: "event-1",
        home_team: "Philadelphia Eagles",
        away_team: "Dallas Cowboys",
        event_start_time: "2026-10-04T20:00:00.000Z",
        selection_reason: "latest-sunday",
        selected_at: "2026-09-30T00:00:00.000Z",
      },
    ]);

    await expect(
      getFreePilotSelection(new Date("2026-09-29T04:00:00Z"))
    ).resolves.toMatchObject({ event: { id: "event-1" } });
    expect(queryMock.mock.calls[0][0]).toContain("FROM odds_free_pilot_selections");
  });

  it("supersedes only unfinished checkpoints for a replaced pilot event", async () => {
    queryMock.mockResolvedValueOnce([{ id: "old-1" }, { id: "old-2" }]);

    await expect(
      supersedeFreePilotCheckpoints({
        selectedEventId: "event-2",
        weekStartTime: new Date("2026-09-29T04:00:00Z"),
        weekEndTime: new Date("2026-10-06T04:00:00Z"),
        supersededAt: new Date("2026-10-01T12:00:00Z"),
      })
    ).resolves.toBe(2);

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("status IN ('pending', 'failed')");
    expect(sql).toContain("free-pilot-event-superseded");
    expect(params).toEqual([
      "event-2",
      "2026-09-29T04:00:00.000Z",
      "2026-10-06T04:00:00.000Z",
      "2026-10-01T12:00:00.000Z",
    ]);
  });

  it("upserts a priority target with complete event and market context", async () => {
    queryMock.mockResolvedValueOnce([]);

    await upsertOddsPriorityTarget({
      id: "target-1",
      sportKey: "americanfootball_nfl",
      eventId: "event-1",
      homeTeam: "Philadelphia Eagles",
      awayTeam: "Dallas Cowboys",
      eventStartTime: new Date("2026-10-04T20:00:00Z"),
      marketKeys: ["player_pass_yds"],
      activatedAt: new Date("2026-10-04T08:00:00Z"),
      reason: "manual-analysis-priority",
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toContain("INSERT INTO odds_priority_targets");
    expect(queryMock.mock.calls[0][1]).toEqual([
      "target-1",
      "americanfootball_nfl",
      "event-1",
      "Philadelphia Eagles",
      "Dallas Cowboys",
      "2026-10-04T20:00:00.000Z",
      ["player_pass_yds"],
      "2026-10-04T08:00:00.000Z",
      "manual-analysis-priority",
    ]);
  });

  it("loads only active pregame targets in deterministic order", async () => {
    queryMock.mockResolvedValueOnce([
      {
        id: "target-1",
        sport_key: "americanfootball_nfl",
        event_id: "event-1",
        home_team: "Philadelphia Eagles",
        away_team: "Dallas Cowboys",
        event_start_time: "2026-10-04T20:00:00.000Z",
        market_keys: ["player_pass_yds"],
        activated_at: "2026-10-04T08:00:00.000Z",
        reason: "manual-analysis-priority",
      },
    ]);

    await expect(
      listActiveOddsPriorityTargets(new Date("2026-10-04T19:00:00Z"))
    ).resolves.toEqual([
      {
        id: "target-1",
        sportKey: "americanfootball_nfl",
        eventId: "event-1",
        homeTeam: "Philadelphia Eagles",
        awayTeam: "Dallas Cowboys",
        eventStartTime: new Date("2026-10-04T20:00:00.000Z"),
        marketKeys: ["player_pass_yds"],
        activatedAt: new Date("2026-10-04T08:00:00.000Z"),
        reason: "manual-analysis-priority",
      },
    ]);
    expect(queryMock.mock.calls[0][0]).toContain("active = TRUE AND event_start_time > $1");
  });

  it("creates deterministic checkpoint identities and only reschedules unfinished work", async () => {
    queryMock.mockImplementationOnce((_sql: string, params: unknown[]) => {
      const payload = JSON.parse(params[11] as string);
      return Promise.resolve([{ id: payload[0].id }]);
    });

    const ids = await upsertOddsCollectionCheckpoints(context(), [checkpoint()]);

    expect(ids[0]).toMatch(/^[a-f0-9]{64}$/);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(sql).toContain("status IN ('pending', 'failed')");
    expect(params.slice(0, 11)).toEqual([
      "free-pilot",
      null,
      "americanfootball_nfl",
      "event-1",
      "Philadelphia Eagles",
      "Dallas Cowboys",
      "2026-10-04T20:00:00.000Z",
      ["player_pass_yds", "player_receptions"],
      20,
      3,
      "weekly-free-pilot",
    ]);
  });

  it("rejects mismatched kinds, duplicate keys, and windows beyond kickoff", async () => {
    const priority = checkpoint();
    priority.kind = "priority";
    await expect(upsertOddsCollectionCheckpoints(context(), [priority])).rejects.toThrow(
      "kind does not match"
    );

    const duplicate = checkpoint();
    await expect(
      upsertOddsCollectionCheckpoints(context(), [duplicate, duplicate])
    ).rejects.toThrow("checkpointKey values must be unique");

    const afterKickoff = checkpoint();
    afterKickoff.dueWindowEnd = "2026-10-04T20:01:00.000Z";
    await expect(upsertOddsCollectionCheckpoints(context(), [afterKickoff])).rejects.toThrow(
      "invalid due window"
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("atomically expires stale work and claims due work by priority with a lease", async () => {
    queryMock.mockResolvedValueOnce([
      {
        claimed: [{ id: "checkpoint-1", attempts: 2 }],
        skipped_count: 3,
      },
    ]);

    await expect(
      claimDueOddsCheckpoints({
        ownerId: "collector-1",
        now: new Date("2026-10-04T19:46:00Z"),
        leaseMs: 30_000,
        limit: 5,
        maxPriorityRank: 20,
        maxCreditCost: 9,
      })
    ).resolves.toEqual({
      claimed: [{ id: "checkpoint-1", attempts: 2 }],
      skippedCount: 3,
    });

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("attempts = checkpoint.attempts + 1");
    expect(sql).toContain("due-window-expired");
    expect(sql).toContain("attempt-limit-exhausted");
    expect(sql).toContain("ORDER BY priority_rank, due_at, id");
    expect(params).toEqual([
      "collector-1",
      "2026-10-04T19:46:00.000Z",
      30_000,
      5,
      20,
      9,
    ]);
  });

  it("completes, fails, and skips only work owned by the current lease holder", async () => {
    queryMock
      .mockResolvedValueOnce([{ id: "checkpoint-1" }])
      .mockResolvedValueOnce([{ id: "checkpoint-2" }])
      .mockResolvedValueOnce([]);

    await expect(
      completeOddsCheckpoint({
        checkpointId: "checkpoint-1",
        ownerId: "collector-1",
        completedAt: new Date("2026-10-04T19:47:00Z"),
        observationId: "observation-1",
        creditCost: 9,
        reason: "upstream-response-persisted",
      })
    ).resolves.toBe(true);
    expect(queryMock.mock.calls[0][0]).toContain("status = 'claimed' AND claim_owner = $2");

    await expect(
      failOddsCheckpoint({
        checkpointId: "checkpoint-2",
        ownerId: "collector-1",
        failedAt: new Date("2026-10-04T19:47:00Z"),
        retryAt: new Date("2026-10-04T19:48:00Z"),
        reason: "provider-error",
        error: "503 upstream unavailable",
      })
    ).resolves.toBe(true);
    expect(queryMock.mock.calls[1][0]).toContain("status = 'failed'");

    await expect(
      skipOddsCheckpoint({
        checkpointId: "checkpoint-3",
        ownerId: "wrong-owner",
        skippedAt: new Date("2026-10-04T19:47:00Z"),
        reason: "quota-degraded",
      })
    ).resolves.toBe(false);
    expect(queryMock.mock.calls[2][0]).toContain("status = 'skipped'");
  });
});
