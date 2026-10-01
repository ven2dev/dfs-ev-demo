import { afterEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("./db", () => ({
  getSql: () => ({ query: queryMock }),
}));

const { getOrCreatePlayerCrosswalk } = await import("./playerCrosswalkRepo.ts");
const { RosterSnapshotUnavailableError, upsertRosterPlayers } = await import(
  "./playerRosterRepo.ts"
);

afterEach(() => {
  queryMock.mockReset();
});

describe("player crosswalk persistence", () => {
  it("matches from the newest team-scoped roster snapshot and persists once", async () => {
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          source_updated_at: "2026-10-01T07:00:00Z",
          player_id: "00-0036389",
          full_name: "Jalen Hurts",
          first_name: "Jalen",
          last_name: "Hurts",
          football_name: "Jalen",
          team: "PHI",
          position: "QB",
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          nflverse_player_id: "00-0036389",
          nflverse_player_name: "Jalen Hurts",
        },
      ]);

    await expect(
      getOrCreatePlayerCrosswalk("J. Hurts", {
        season: 2026,
        eventTeams: ["PHI", "DAL"],
        marketKey: "player_pass_yds",
      })
    ).resolves.toEqual({
      playerId: "00-0036389",
      playerName: "Jalen Hurts",
    });

    expect(queryMock).toHaveBeenCalledTimes(4);
    expect(queryMock.mock.calls[1][0]).toContain("WITH latest_snapshot AS");
    expect(queryMock.mock.calls[1][0]).toContain("LEFT JOIN nflverse_roster_players");
    expect(queryMock.mock.calls[1][0]).toContain("team = ANY($2::text[])");
    expect(queryMock.mock.calls[1][1]).toEqual([2026, ["PHI", "DAL"]]);
    expect(queryMock.mock.calls[2][0]).toContain("ON CONFLICT (odds_api_name) DO NOTHING");
    expect(queryMock.mock.calls[2][1]).toEqual([
      "J. Hurts",
      "00-0036389",
      "Jalen Hurts",
    ]);
  });

  it("fails as unavailable when no synchronized roster snapshot exists", async () => {
    queryMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        source_updated_at: null,
        player_id: null,
        full_name: null,
        first_name: null,
        last_name: null,
        football_name: null,
        team: null,
        position: null,
      },
    ]);

    await expect(
      getOrCreatePlayerCrosswalk("Jalen Hurts", {
        season: 2026,
        eventTeams: ["PHI", "DAL"],
        marketKey: "player_pass_yds",
      })
    ).rejects.toBeInstanceOf(RosterSnapshotUnavailableError);
  });

  it("keeps an available snapshot with no team candidates distinct from no snapshot", async () => {
    queryMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        source_updated_at: "2026-10-01T07:00:00Z",
        player_id: null,
        full_name: null,
        first_name: null,
        last_name: null,
        football_name: null,
        team: null,
        position: null,
      },
    ]);

    await expect(
      getOrCreatePlayerCrosswalk("Jalen Hurts", {
        season: 2026,
        eventTeams: ["PHI", "DAL"],
        marketKey: "player_pass_yds",
      })
    ).resolves.toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO"))).toBe(
      false
    );
  });
});

describe("roster snapshot persistence", () => {
  it("writes a complete snapshot in one atomic upsert statement", async () => {
    queryMock.mockResolvedValueOnce([]);

    await upsertRosterPlayers([
      {
        season: 2026,
        playerId: "00-0036389",
        fullName: "Jalen Hurts",
        firstName: "Jalen",
        lastName: "Hurts",
        footballName: "Jalen",
        team: "PHI",
        position: "QB",
        status: "ACT",
        sourceUpdatedAt: "2026-10-01T07:00:00Z",
      },
      {
        season: 2026,
        playerId: "00-0036900",
        fullName: "CeeDee Lamb",
        firstName: "CeeDee",
        lastName: "Lamb",
        footballName: "CeeDee",
        team: "DAL",
        position: "WR",
        status: "ACT",
        sourceUpdatedAt: "2026-10-01T07:00:00Z",
      },
    ]);

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toContain("ON CONFLICT (season, player_id)");
    expect(queryMock.mock.calls[0][0]).toContain("source_updated_at = EXCLUDED.source_updated_at");
    expect(queryMock.mock.calls[0][1]).toHaveLength(20);
  });
});
