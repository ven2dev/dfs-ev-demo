import { describe, expect, it, vi } from "vitest";
import {
  NFLVERSE_ROSTER_SOURCE,
  syncNflverseRoster,
  type NflverseRosterRow,
  type SyncNflverseRosterDeps,
} from "./nflverseRosterSync";

const rosterRow = (overrides: Partial<NflverseRosterRow> = {}): NflverseRosterRow => ({
  season: "2026",
  team: "PHI",
  position: "QB",
  status: "ACT",
  full_name: "Jalen Hurts",
  first_name: "Jalen",
  last_name: "Hurts",
  football_name: "Jalen",
  gsis_id: "00-0036389",
  ...overrides,
});

const makeDeps = (
  overrides: Partial<SyncNflverseRosterDeps> = {}
): SyncNflverseRosterDeps => ({
  fetchRosterReleaseUpdatedAt: vi.fn().mockResolvedValue("2026-10-01T07:00:00Z"),
  fetchRosterRows: vi.fn().mockResolvedValue([rosterRow()]),
  readSyncState: vi.fn().mockResolvedValue(null),
  writeSyncState: vi.fn().mockResolvedValue(undefined),
  upsertRosterPlayers: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe("syncNflverseRoster", () => {
  it("does not download the roster when the release timestamp is unchanged", async () => {
    const deps = makeDeps({
      readSyncState: vi.fn().mockResolvedValue("2026-10-01T07:00:00.000Z"),
    });

    await expect(syncNflverseRoster(deps)).resolves.toEqual({ status: "up-to-date" });
    expect(deps.fetchRosterRows).not.toHaveBeenCalled();
    expect(deps.upsertRosterPlayers).not.toHaveBeenCalled();
  });

  it("normalizes and persists a new roster snapshot before advancing its watermark", async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      upsertRosterPlayers: vi.fn(async () => {
        callOrder.push("upsert");
      }),
      writeSyncState: vi.fn(async () => {
        callOrder.push("watermark");
      }),
    });

    await expect(syncNflverseRoster(deps)).resolves.toEqual({
      status: "synced",
      rowsUpserted: 1,
    });
    expect(deps.upsertRosterPlayers).toHaveBeenCalledWith([
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
    ]);
    expect(deps.writeSyncState).toHaveBeenCalledWith(
      NFLVERSE_ROSTER_SOURCE,
      "2026-10-01T07:00:00Z"
    );
    expect(callOrder).toEqual(["upsert", "watermark"]);
  });

  it("deduplicates repeated GSIS ids within one source snapshot", async () => {
    const deps = makeDeps({
      fetchRosterRows: vi.fn().mockResolvedValue([
        rosterRow({ team: "TEN" }),
        rosterRow({ team: "PHI" }),
      ]),
    });

    await expect(syncNflverseRoster(deps)).resolves.toEqual({
      status: "synced",
      rowsUpserted: 1,
    });
    const [players] = (deps.upsertRosterPlayers as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(players[0].team).toBe("PHI");
  });

  it("skips incomplete identities but does not advance an empty snapshot", async () => {
    const deps = makeDeps({
      fetchRosterRows: vi.fn().mockResolvedValue([rosterRow({ gsis_id: "" })]),
    });

    await expect(syncNflverseRoster(deps)).rejects.toThrow(
      "nflverse roster contained no usable player identities"
    );
    expect(deps.upsertRosterPlayers).not.toHaveBeenCalled();
    expect(deps.writeSyncState).not.toHaveBeenCalled();
  });

  it("does not advance the watermark when persistence fails", async () => {
    const deps = makeDeps({
      upsertRosterPlayers: vi.fn().mockRejectedValue(new Error("database unavailable")),
    });

    await expect(syncNflverseRoster(deps)).rejects.toThrow("database unavailable");
    expect(deps.writeSyncState).not.toHaveBeenCalled();
  });
});
