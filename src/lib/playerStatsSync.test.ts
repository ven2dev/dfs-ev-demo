import { describe, it, expect, vi } from "vitest";
import {
  syncPlayerStats,
  NFLVERSE_STATS_SOURCE,
  NFLVERSE_SCHEDULES_SOURCE,
  type SyncPlayerStatsDeps,
  type NflverseStatsRow,
  type NflverseScheduleRow,
} from "./playerStatsSync.ts";

const statRow = (overrides: Partial<NflverseStatsRow> = {}): NflverseStatsRow => ({
  player_id: "00-0023459",
  player_name: "A.Rodgers",
  team: "PIT",
  opponent_team: "ATL",
  season: "2026",
  week: "1",
  game_id: "2026_01_ATL_PIT",
  position: "QB",
  position_group: "QB",
  passing_yards: "245",
  ...overrides,
});

const scheduleRow = (overrides: Partial<NflverseScheduleRow> = {}): NflverseScheduleRow => ({
  game_id: "2026_01_ATL_PIT",
  gameday: "2026-09-07",
  home_team: "PIT",
  ...overrides,
});

const makeDeps = (overrides: Partial<SyncPlayerStatsDeps> = {}): SyncPlayerStatsDeps => ({
  fetchStatsReleaseUpdatedAt: vi.fn().mockResolvedValue("2026-09-27T00:00:00Z"),
  fetchSchedulesReleaseUpdatedAt: vi.fn().mockResolvedValue("2026-09-27T00:00:00Z"),
  readSyncState: vi.fn().mockResolvedValue(null),
  writeSyncState: vi.fn().mockResolvedValue(undefined),
  fetchStatsRows: vi.fn().mockResolvedValue([statRow()]),
  fetchScheduleRows: vi.fn().mockResolvedValue([scheduleRow()]),
  upsertStats: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe("syncPlayerStats", () => {
  it("is a safe no-op when neither source has changed since the last sync", async () => {
    const deps = makeDeps({
      readSyncState: vi.fn().mockResolvedValue("2026-09-27T00:00:00Z"),
    });

    const result = await syncPlayerStats(deps);

    expect(result).toEqual({ status: "up-to-date" });
    expect(deps.fetchStatsRows).not.toHaveBeenCalled();
    expect(deps.fetchScheduleRows).not.toHaveBeenCalled();
    expect(deps.upsertStats).not.toHaveBeenCalled();
  });

  it("is still a safe no-op when the stored timestamp round-trips through a different (but equal-instant) string format", async () => {
    // Reproduces a real bug found via live verification against Postgres:
    // GitHub's raw format ("...T00:00:00Z") and a value that's been
    // round-tripped through Date.toISOString() ("...T00:00:00.000Z")
    // are the identical instant but never string-equal.
    const deps = makeDeps({
      readSyncState: vi.fn().mockResolvedValue("2026-09-27T00:00:00.000Z"),
    });

    const result = await syncPlayerStats(deps);

    expect(result).toEqual({ status: "up-to-date" });
    expect(deps.fetchStatsRows).not.toHaveBeenCalled();
  });

  it("re-syncs when only the schedules source changed, even if stats didn't", async () => {
    const readSyncState = vi.fn((source: string) =>
      Promise.resolve(source === NFLVERSE_SCHEDULES_SOURCE ? "2026-09-20T00:00:00Z" : "2026-09-27T00:00:00Z")
    );
    const deps = makeDeps({ readSyncState });

    const result = await syncPlayerStats(deps);

    expect(result.status).toBe("synced");
    expect(deps.fetchStatsRows).toHaveBeenCalled();
  });

  it("joins stats to schedules via game_id, deriving is_home and game_date", async () => {
    const deps = makeDeps();

    const result = await syncPlayerStats(deps);

    expect(result).toEqual({ status: "synced", rowsUpserted: 1 });
    expect(deps.upsertStats).toHaveBeenCalledWith([
      {
        player_id: "00-0023459",
        player_name: "A.Rodgers",
        team: "PIT",
        opponent: "ATL",
        is_home: true,
        season: 2026,
        week: 1,
        game_date: "2026-09-07",
        stat_type: "passing_yards",
        stat_value: 245,
      },
    ]);
  });

  it("melts every populated supported stat type from a single row, e.g. a dual-threat player", async () => {
    const deps = makeDeps({
      fetchStatsRows: vi.fn().mockResolvedValue([
        statRow({
          player_id: "00-0099999",
          player_name: "R.Back",
          position: "RB",
          position_group: "RB",
          passing_yards: "",
          carries: "18",
          rushing_yards: "112",
          receptions: "3",
          receiving_yards: "24",
        }),
      ]),
    });

    const result = await syncPlayerStats(deps);

    expect(result.status).toBe("synced");
    const [rows] = (deps.upsertStats as ReturnType<typeof vi.fn>).mock.calls[0];
    const statTypes = rows.map((r: { stat_type: string; stat_value: number }) => [
      r.stat_type,
      r.stat_value,
    ]);
    expect(statTypes).toEqual(
      expect.arrayContaining([
        ["carries", 18],
        ["rushing_yards", 112],
        ["receptions", 3],
        ["receiving_yards", 24],
      ])
    );
    // Blank passing_yards on this row must not produce a stray row.
    expect(statTypes).not.toContainEqual(["passing_yards", expect.anything()]);
  });

  it("derives anytime_td as rushing + receiving TDs combined", async () => {
    const deps = makeDeps({
      fetchStatsRows: vi.fn().mockResolvedValue([
        statRow({ passing_yards: "", rushing_tds: "1", receiving_tds: "1" }),
      ]),
    });

    await syncPlayerStats(deps);

    const [rows] = (deps.upsertStats as ReturnType<typeof vi.fn>).mock.calls[0];
    const anytimeTd = rows.find((r: { stat_type: string }) => r.stat_type === "anytime_td");
    expect(anytimeTd.stat_value).toBe(2);
  });

  it("derives anytime_td when only one of rushing/receiving TDs is present", async () => {
    const deps = makeDeps({
      fetchStatsRows: vi.fn().mockResolvedValue([
        statRow({ passing_yards: "", rushing_tds: "2" }),
      ]),
    });

    await syncPlayerStats(deps);

    const [rows] = (deps.upsertStats as ReturnType<typeof vi.fn>).mock.calls[0];
    const anytimeTd = rows.find((r: { stat_type: string }) => r.stat_type === "anytime_td");
    expect(anytimeTd.stat_value).toBe(2);
  });

  it("does not produce an anytime_td row when neither rushing nor receiving TDs apply (e.g. a kicker)", async () => {
    const deps = makeDeps({
      fetchStatsRows: vi.fn().mockResolvedValue([
        statRow({ position: "K", position_group: "SPEC", passing_yards: "", fg_made: "2" }),
      ]),
    });

    await syncPlayerStats(deps);

    const [rows] = (deps.upsertStats as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(rows.some((r: { stat_type: string }) => r.stat_type === "anytime_td")).toBe(false);
  });

  it("derives total_tds as passing + rushing + receiving TDs, unlike anytime_td", async () => {
    const deps = makeDeps({
      fetchStatsRows: vi.fn().mockResolvedValue([
        statRow({ passing_tds: "2", rushing_tds: "1", receiving_tds: "" }),
      ]),
    });

    await syncPlayerStats(deps);

    const [rows] = (deps.upsertStats as ReturnType<typeof vi.fn>).mock.calls[0];
    const byType = Object.fromEntries(
      rows.map((r: { stat_type: string; stat_value: number }) => [r.stat_type, r.stat_value])
    );
    expect(byType.total_tds).toBe(3);
    expect(byType.anytime_td).toBe(1);
  });

  it("derives kicking_points as 3x FG made + 1x XP made", async () => {
    const deps = makeDeps({
      fetchStatsRows: vi.fn().mockResolvedValue([
        statRow({
          position: "K",
          position_group: "SPEC",
          passing_yards: "",
          fg_made: "2",
          pat_made: "3",
        }),
      ]),
    });

    await syncPlayerStats(deps);

    const [rows] = (deps.upsertStats as ReturnType<typeof vi.fn>).mock.calls[0];
    const kickingPoints = rows.find(
      (r: { stat_type: string }) => r.stat_type === "kicking_points"
    );
    expect(kickingPoints.stat_value).toBe(9);
  });

  it("derives tackles_plus_assists for a defensive player, and skips it for an offensive one", async () => {
    const defenderDeps = makeDeps({
      fetchStatsRows: vi.fn().mockResolvedValue([
        statRow({
          position: "LB",
          position_group: "LB",
          passing_yards: "",
          def_tackles_solo: "6",
          def_tackle_assists: "2",
        }),
      ]),
    });
    await syncPlayerStats(defenderDeps);
    const [defenderRows] = (defenderDeps.upsertStats as ReturnType<typeof vi.fn>).mock.calls[0];
    const tackles = defenderRows.find(
      (r: { stat_type: string }) => r.stat_type === "tackles_plus_assists"
    );
    expect(tackles.stat_value).toBe(8);

    const receiverDeps = makeDeps();
    await syncPlayerStats(receiverDeps);
    const [receiverRows] = (receiverDeps.upsertStats as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(
      receiverRows.some((r: { stat_type: string }) => r.stat_type === "tackles_plus_assists")
    ).toBe(false);
  });

  it("does not store position-inapplicable stats even when nflverse fills them with a literal zero (not blank)", async () => {
    // Reproduces a real bug found via live verification: nflverse's CSV
    // gives a kicker literal "0" values for passing/rushing/receiving
    // columns (not blank), which numberOrUndefined alone would treat as
    // a genuine present value -- confirmed live against N.Folk, a real
    // kicker, who had exactly this happen for anytime_td/attempts/
    // carries/completions before the position gate existed.
    const deps = makeDeps({
      fetchStatsRows: vi.fn().mockResolvedValue([
        statRow({
          player_id: "00-0011111",
          player_name: "N.Folk",
          position: "K",
          position_group: "SPEC",
          passing_yards: "0",
          attempts: "0",
          completions: "0",
          carries: "0",
          rushing_tds: "0",
          receiving_tds: "0",
          fg_made: "2",
          pat_made: "3",
        }),
      ]),
    });

    await syncPlayerStats(deps);

    const [rows] = (deps.upsertStats as ReturnType<typeof vi.fn>).mock.calls[0];
    const statTypes = rows.map((r: { stat_type: string }) => r.stat_type);
    expect(statTypes).not.toEqual(
      expect.arrayContaining([
        "passing_yards",
        "attempts",
        "completions",
        "carries",
        "anytime_td",
      ])
    );
    expect(statTypes).toEqual(
      expect.arrayContaining(["field_goals_made", "extra_points_made", "kicking_points"])
    );
  });

  it("stores fantasy_points and fantasy_points_ppr for every position, unlike the position-gated stats", async () => {
    // The one branch of isApplicableToPosition that always returns true --
    // nflverse computes fantasy scoring for every player regardless of
    // position, so a kicker's fantasy_points row is a real fact, not
    // pollution to gate out like its passing/rushing/receiving columns.
    const deps = makeDeps({
      fetchStatsRows: vi.fn().mockResolvedValue([
        statRow({
          position: "K",
          position_group: "SPEC",
          passing_yards: "0",
          fantasy_points: "9",
          fantasy_points_ppr: "9",
        }),
      ]),
    });

    await syncPlayerStats(deps);

    const [rows] = (deps.upsertStats as ReturnType<typeof vi.fn>).mock.calls[0];
    const byType = Object.fromEntries(
      rows.map((r: { stat_type: string; stat_value: number }) => [r.stat_type, r.stat_value])
    );
    expect(byType.fantasy_points).toBe(9);
    expect(byType.fantasy_points_ppr).toBe(9);
  });

  it("derives is_home false for the away team", async () => {
    const deps = makeDeps({
      fetchStatsRows: vi.fn().mockResolvedValue([statRow({ team: "ATL", opponent_team: "PIT" })]),
    });

    await syncPlayerStats(deps);

    const [rows] = (deps.upsertStats as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(rows[0].is_home).toBe(false);
  });

  it("skips a stat row whose game has no matching schedule entry yet", async () => {
    const deps = makeDeps({ fetchScheduleRows: vi.fn().mockResolvedValue([]) });

    const result = await syncPlayerStats(deps);

    expect(result).toEqual({ status: "synced", rowsUpserted: 0 });
    expect(deps.upsertStats).not.toHaveBeenCalled();
  });

  it("skips a supported stat type whose value is blank for that row", async () => {
    const deps = makeDeps({
      fetchStatsRows: vi.fn().mockResolvedValue([statRow({ passing_yards: "" })]),
    });

    const result = await syncPlayerStats(deps);

    expect(result).toEqual({ status: "synced", rowsUpserted: 0 });
    expect(deps.upsertStats).not.toHaveBeenCalled();
  });

  it("advances both watermarks together after a successful sync", async () => {
    const deps = makeDeps();

    await syncPlayerStats(deps);

    expect(deps.writeSyncState).toHaveBeenCalledWith(
      NFLVERSE_STATS_SOURCE,
      "2026-09-27T00:00:00Z"
    );
    expect(deps.writeSyncState).toHaveBeenCalledWith(
      NFLVERSE_SCHEDULES_SOURCE,
      "2026-09-27T00:00:00Z"
    );
  });
});
