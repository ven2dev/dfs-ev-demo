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
      expect.any(AbortSignal)
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
