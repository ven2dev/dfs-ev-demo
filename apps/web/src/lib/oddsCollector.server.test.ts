import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedOddsCheckpoint } from "./oddsCollectionRepo";
import type { OddsCollectorConfig, OddsCollectorDeps } from "./oddsCollector";
import { OddsApiHttpError } from "./oddsApi";

const { runOddsCollector } = await import("./oddsCollector.ts");

const config = (): OddsCollectorConfig => ({
  profile: "free-pilot",
  eveningHourEastern: 20,
  ownerId: "collector-1",
  leaseMs: 45_000,
  claimLimit: 2,
  requestTimeoutMs: 15_000,
  retryDelayMs: 60_000,
  quotaReserve: 100,
  priorityFarIntervalMs: 60 * 60 * 1_000,
  priorityActiveIntervalMs: 5 * 60 * 1_000,
});

const claimed = (): ClaimedOddsCheckpoint => ({
  id: "checkpoint-1",
  kind: "baseline",
  collection_profile: "free-pilot",
  target_id: null,
  sport_key: "americanfootball_nfl",
  event_id: "event-1",
  home_team: "Philadelphia Eagles",
  away_team: "Dallas Cowboys",
  event_start_time: "2026-10-04T20:00:00.000Z",
  market_keys: [
    "player_pass_yds",
    "player_pass_tds",
    "player_pass_completions",
    "player_pass_attempts",
    "player_pass_interceptions",
    "player_rush_yds",
    "player_rush_attempts",
    "player_reception_yds",
    "player_receptions",
  ],
  checkpoint_key: "t-15m",
  due_at: "2026-10-04T19:45:00.000Z",
  due_window_end: "2026-10-04T20:00:00.000Z",
  priority_rank: 20,
  attempts: 1,
  max_attempts: 3,
  schedule_reason: "latest-sunday",
});

const mocks = {
  fetchSlateEvents: vi.fn(),
  fetchEventOdds: vi.fn(),
  listActiveTargets: vi.fn(),
  getFreePilotSelection: vi.fn(),
  pinFreePilotSelection: vi.fn(),
  supersedeFreePilotCheckpoints: vi.fn(),
  upsertCheckpoints: vi.fn(),
  claimDue: vi.fn(),
  persistObservation: vi.fn(),
  completeCheckpoint: vi.fn(),
  failCheckpoint: vi.fn(),
  skipCheckpoint: vi.fn(),
  makeObservationId: vi.fn(),
  now: vi.fn(),
};

const deps = mocks as unknown as OddsCollectorDeps;

const slateFetch = () => ({
  data: [
    {
      id: "event-1",
      sportKey: "americanfootball_nfl",
      homeTeam: "Philadelphia Eagles",
      awayTeam: "Dallas Cowboys",
      commenceTime: "2026-10-04T20:00:00.000Z",
    },
  ],
  capturedAt: "2026-10-04T19:46:00.000Z",
  quota: { remaining: 500, used: 0, last: 0 },
});

const fetchedOdds = () => ({
  data: {
    id: "event-1",
    bookmakers: [
      {
        key: "draftkings",
        markets: [
          {
            key: "player_pass_yds",
            outcomes: [
              { name: "Over", description: "Jalen Hurts", point: 244.5, price: 1.9 },
              { name: "Under", description: "Jalen Hurts", point: 244.5, price: 1.9 },
            ],
          },
        ],
      },
    ],
  },
  capturedAt: "2026-10-04T19:46:01.000Z",
  quota: { remaining: 491, used: 9, last: 9 },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.now.mockReturnValue(new Date("2026-10-04T19:46:00Z"));
  mocks.fetchSlateEvents.mockResolvedValue(slateFetch());
  mocks.listActiveTargets.mockResolvedValue([]);
  mocks.getFreePilotSelection.mockResolvedValue(null);
  mocks.pinFreePilotSelection.mockImplementation(async (input) => ({
    weekStartTime: input.weekStartTime,
    weekEndTime: input.weekEndTime,
    event: input.event,
    reason: input.reason,
    selectedAt: input.selectedAt,
  }));
  mocks.supersedeFreePilotCheckpoints.mockResolvedValue(0);
  mocks.upsertCheckpoints.mockImplementation(async (_context, checkpoints) =>
    checkpoints.map((_: unknown, index: number) => `planned-${index}`)
  );
  mocks.claimDue.mockResolvedValue({ claimed: [claimed()], skippedCount: 0 });
  mocks.fetchEventOdds.mockResolvedValue(fetchedOdds());
  mocks.persistObservation.mockResolvedValue({ inserted: true });
  mocks.completeCheckpoint.mockResolvedValue(true);
  mocks.failCheckpoint.mockResolvedValue(true);
  mocks.skipCheckpoint.mockResolvedValue(true);
  mocks.makeObservationId.mockReturnValue("observation-1");
});

describe("runOddsCollector", () => {
  it("does nothing when the collection profile is disabled", async () => {
    const result = await runOddsCollector({ ...config(), profile: "disabled" }, deps);

    expect(result).toMatchObject({ profile: "disabled", claimed: 0, completed: 0 });
    expect(mocks.fetchSlateEvents).not.toHaveBeenCalled();
    expect(mocks.claimDue).not.toHaveBeenCalled();
  });

  it("plans the free pilot, batches nine markets, and completes one persisted observation", async () => {
    const result = await runOddsCollector(config(), deps);

    expect(mocks.upsertCheckpoints).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "free-pilot",
        eventId: "event-1",
        marketKeys: claimed().market_keys,
        priorityRank: 20,
      }),
      expect.arrayContaining([expect.objectContaining({ checkpointKey: "t-15m" })])
    );
    expect(mocks.fetchEventOdds).toHaveBeenCalledWith(
      "americanfootball_nfl",
      "event-1",
      claimed().market_keys,
      expect.any(AbortSignal),
      "scheduled"
    );
    expect(mocks.persistObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        observationId: "observation-1",
        source: "scheduled",
        requestedMarketKeys: claimed().market_keys,
        collectionProfile: "free-pilot",
        checkpointKey: "t-15m",
      }),
      expect.objectContaining({
        id: "event-1",
        home_team: "Philadelphia Eagles",
        away_team: "Dallas Cowboys",
      })
    );
    expect(result).toMatchObject({
      baselineEvents: 1,
      claimed: 1,
      completed: 1,
      knownCreditsUsed: 9,
      unknownCostAttempts: 0,
      slateQuota: { remaining: 500, used: 0, last: 0 },
      maxPriorityRank: 40,
      claimLimitApplied: 2,
      maxCreditCost: 500,
    });
    expect(mocks.upsertCheckpoints).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "free-pilot", priorityRank: 40 }),
      expect.arrayContaining([expect.objectContaining({ checkpointKey: "tuesday-opening" })])
    );
    expect(mocks.pinFreePilotSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ id: "event-1" }),
        reason: "latest-sunday",
      })
    );
    expect(mocks.supersedeFreePilotCheckpoints).toHaveBeenCalledWith(
      expect.objectContaining({ selectedEventId: "event-1" })
    );
  });

  it("keeps the durable weekly pilot event when kickoff ordering changes", async () => {
    mocks.getFreePilotSelection.mockResolvedValueOnce({
      weekStartTime: new Date("2026-09-29T04:00:00Z"),
      weekEndTime: new Date("2026-10-06T04:00:00Z"),
      event: {
        id: "event-1",
        sportKey: "americanfootball_nfl",
        homeTeam: "Philadelphia Eagles",
        awayTeam: "Dallas Cowboys",
        commenceTime: "2026-10-04T19:00:00.000Z",
      },
      reason: "latest-sunday",
      selectedAt: new Date("2026-09-30T00:00:00Z"),
    });
    mocks.claimDue.mockResolvedValueOnce({ claimed: [], skippedCount: 0 });

    const result = await runOddsCollector(config(), deps);

    expect(mocks.pinFreePilotSelection).not.toHaveBeenCalled();
    expect(mocks.upsertCheckpoints).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "event-1",
        eventStartTime: new Date("2026-10-04T20:00:00.000Z"),
      }),
      expect.any(Array)
    );
    expect(result.baselineEvents).toBe(1);
  });

  it("reports unfinished checkpoints superseded by an explicit pilot override", async () => {
    mocks.supersedeFreePilotCheckpoints.mockResolvedValueOnce(4);
    mocks.claimDue.mockResolvedValueOnce({ claimed: [], skippedCount: 0 });

    const result = await runOddsCollector(
      { ...config(), freePilotEventId: "event-1" },
      deps
    );

    expect(mocks.getFreePilotSelection).not.toHaveBeenCalled();
    expect(mocks.pinFreePilotSelection).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "explicit-override" })
    );
    expect(result.supersededFreePilotCheckpoints).toBe(4);
  });

  it("ranks ordinary paid baseline work ahead of exploratory free-pilot work", async () => {
    mocks.claimDue.mockResolvedValueOnce({ claimed: [], skippedCount: 0 });

    await runOddsCollector({ ...config(), profile: "paid-baseline" }, deps);

    expect(mocks.upsertCheckpoints).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "paid-baseline", priorityRank: 30 }),
      expect.arrayContaining([expect.objectContaining({ checkpointKey: "tuesday-opening" })])
    );
    expect(mocks.upsertCheckpoints).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "paid-baseline", priorityRank: 20 }),
      expect.arrayContaining([expect.objectContaining({ checkpointKey: "t-15m" })])
    );
  });

  it.each([
    { remaining: null, maxCreditCost: 9 },
    { remaining: 100, maxCreditCost: 100 },
  ])("admits only critical work when remaining quota is $remaining", async ({
    remaining,
    maxCreditCost,
  }) => {
    mocks.fetchSlateEvents.mockResolvedValueOnce({
      ...slateFetch(),
      quota: { remaining, used: null, last: 0 },
    });
    mocks.claimDue.mockResolvedValueOnce({ claimed: [], skippedCount: 0 });

    const result = await runOddsCollector(config(), deps);

    expect(mocks.claimDue).toHaveBeenCalledWith(
      expect.objectContaining({ maxPriorityRank: 20, maxCreditCost, limit: 1 })
    );
    expect(result).toMatchObject({ maxPriorityRank: 20, claimLimitApplied: 1 });
  });

  it("admits one paid-baseline checkpoint when exactly one request fits above reserve", async () => {
    mocks.fetchSlateEvents.mockResolvedValueOnce({
      ...slateFetch(),
      quota: { remaining: 109, used: 391, last: 0 },
    });
    mocks.claimDue.mockResolvedValueOnce({ claimed: [], skippedCount: 0 });

    const result = await runOddsCollector(config(), deps);

    expect(mocks.claimDue).toHaveBeenCalledWith(
      expect.objectContaining({ maxPriorityRank: 30, maxCreditCost: 109, limit: 1 })
    );
    expect(result).toMatchObject({ maxPriorityRank: 30, claimLimitApplied: 1 });
  });

  it("passes configured priority intervals into target planning", async () => {
    mocks.listActiveTargets.mockResolvedValueOnce([
      {
        id: "target-1",
        sportKey: "americanfootball_nfl",
        eventId: "event-1",
        homeTeam: "Philadelphia Eagles",
        awayTeam: "Dallas Cowboys",
        eventStartTime: new Date("2026-10-04T20:00:00Z"),
        marketKeys: ["player_pass_yds"],
        activatedAt: new Date("2026-10-04T08:00:00Z"),
        reason: "manual-analysis-priority",
      },
    ]);
    mocks.claimDue.mockResolvedValueOnce({ claimed: [], skippedCount: 0 });

    await runOddsCollector(
      {
        ...config(),
        priorityFarIntervalMs: 2 * 60 * 60 * 1_000,
        priorityActiveIntervalMs: 10 * 60 * 1_000,
      },
      deps
    );

    expect(mocks.upsertCheckpoints).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "priority", priorityRank: 10 }),
      expect.arrayContaining([
        expect.objectContaining({ dueAt: "2026-10-04T10:00:00.000Z" }),
        expect.objectContaining({ dueAt: "2026-10-04T14:10:00.000Z" }),
      ])
    );
  });

  it("records provider error cost and schedules a retry inside the due window", async () => {
    mocks.fetchEventOdds.mockRejectedValueOnce(
      new OddsApiHttpError(
        "Odds API event-odds fetch failed: 503",
        503,
        "2026-10-04T19:46:01.000Z",
        { remaining: 491, used: 9, last: 9 }
      )
    );

    const result = await runOddsCollector(config(), deps);

    expect(mocks.failCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointId: "checkpoint-1",
        retryAt: new Date("2026-10-04T19:47:00.000Z"),
        reason: "collection-attempt-failed",
      })
    );
    expect(result).toMatchObject({ failed: 1, knownCreditsUsed: 9, unknownCostAttempts: 0 });
  });

  it("claims nothing above rank zero when the provider reports no remaining quota", async () => {
    mocks.fetchSlateEvents.mockResolvedValueOnce({
      ...slateFetch(),
      quota: { remaining: 0, used: 500, last: 0 },
    });
    mocks.claimDue.mockResolvedValueOnce({ claimed: [], skippedCount: 0 });

    const result = await runOddsCollector(config(), deps);

    expect(mocks.claimDue).toHaveBeenCalledWith(
      expect.objectContaining({ maxPriorityRank: 0, maxCreditCost: 0, limit: 1 })
    );
    expect(mocks.fetchEventOdds).not.toHaveBeenCalled();
    expect(result.maxPriorityRank).toBe(0);
  });

  it("does not persist a response received at kickoff and records its cost", async () => {
    mocks.fetchEventOdds.mockResolvedValueOnce({
      ...fetchedOdds(),
      capturedAt: "2026-10-04T20:00:00.000Z",
    });

    const result = await runOddsCollector(config(), deps);

    expect(mocks.persistObservation).not.toHaveBeenCalled();
    expect(mocks.skipCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "response-received-at-or-after-kickoff",
        creditCost: 9,
      })
    );
    expect(result).toMatchObject({ skipped: 1, completed: 0, knownCreditsUsed: 9 });
  });
});
