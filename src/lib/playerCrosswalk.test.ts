import { describe, expect, it, vi } from "vitest";
import {
  resolvePlayerCrosswalk,
  type CrosswalkEntry,
  type PlayerCrosswalkDeps,
} from "./playerCrosswalk";
import type { PlayerIdentityCandidate } from "./playerIdentityMatcher";

const context = {
  season: 2026,
  eventTeams: ["PHI", "DAL"],
  marketKey: "player_pass_yds",
};

const candidate: PlayerIdentityCandidate = {
  playerId: "00-0036389",
  fullName: "Jalen Hurts",
  firstName: "Jalen",
  lastName: "Hurts",
  footballName: "Jalen",
  team: "PHI",
  position: "QB",
};

const makeDeps = (overrides: Partial<PlayerCrosswalkDeps> = {}): PlayerCrosswalkDeps => ({
  readCrosswalk: vi.fn().mockResolvedValue(null),
  readRosterCandidates: vi.fn().mockResolvedValue([candidate]),
  insertCrosswalkIfAbsent: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe("resolvePlayerCrosswalk", () => {
  it("returns a cached mapping without loading or matching the roster", async () => {
    const cached: CrosswalkEntry = {
      playerId: "manual-id",
      playerName: "Manual Name",
    };
    const deps = makeDeps({ readCrosswalk: vi.fn().mockResolvedValue(cached) });

    await expect(resolvePlayerCrosswalk("Jalen Hurts", context, deps)).resolves.toEqual(cached);
    expect(deps.readRosterCandidates).not.toHaveBeenCalled();
    expect(deps.insertCrosswalkIfAbsent).not.toHaveBeenCalled();
  });

  it("matches, inserts, and returns a previously unseen player", async () => {
    const persisted: CrosswalkEntry = {
      playerId: candidate.playerId,
      playerName: candidate.fullName,
    };
    const readCrosswalk = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(persisted);
    const deps = makeDeps({ readCrosswalk });

    await expect(resolvePlayerCrosswalk("Jalen Hurts", context, deps)).resolves.toEqual(
      persisted
    );
    expect(deps.readRosterCandidates).toHaveBeenCalledWith(2026, ["PHI", "DAL"]);
    expect(deps.insertCrosswalkIfAbsent).toHaveBeenCalledWith(
      "Jalen Hurts",
      expect.objectContaining(candidate)
    );
  });

  it("returns null and does not insert an ambiguous match", async () => {
    const deps = makeDeps({
      readRosterCandidates: vi.fn().mockResolvedValue([
        { ...candidate, playerId: "one", fullName: "James Smith", firstName: "James" },
        {
          ...candidate,
          playerId: "two",
          fullName: "Javonte Smith",
          firstName: "Javonte",
          team: "DAL",
        },
      ]),
    });

    await expect(resolvePlayerCrosswalk("J. Smith", context, deps)).resolves.toBeNull();
    expect(deps.insertCrosswalkIfAbsent).not.toHaveBeenCalled();
  });

  it("preserves a concurrent or manual mapping that wins the insert race", async () => {
    const winningEntry: CrosswalkEntry = {
      playerId: "manual-winner",
      playerName: "Jalen Hurts",
    };
    const deps = makeDeps({
      readCrosswalk: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winningEntry),
    });

    await expect(resolvePlayerCrosswalk("Jalen Hurts", context, deps)).resolves.toEqual(
      winningEntry
    );
  });

  it("propagates roster and database availability failures", async () => {
    const deps = makeDeps({
      readRosterCandidates: vi.fn().mockRejectedValue(new Error("roster unavailable")),
    });

    await expect(resolvePlayerCrosswalk("Jalen Hurts", context, deps)).rejects.toThrow(
      "roster unavailable"
    );
  });
});
