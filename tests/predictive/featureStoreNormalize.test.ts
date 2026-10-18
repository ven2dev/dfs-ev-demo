import { describe, expect, it, vi } from "vitest";
import { normalizeSource, easternKickoff } from "../../src/lib/featureStore/normalize.ts";
import { sha256 } from "../../src/lib/featureStore/objectStore.ts";
import { downloadSource, INGEST_LIMITS } from "../../src/lib/featureStore/source.ts";
import { csvFixture, sourceFixture, STAT_HEADER, STAT_ROW } from "../feature-store/fixtures.ts";

const signal = () => AbortSignal.timeout(5_000);
describe("#138 source normalization", () => {
  it("preserves zero-opportunity QB rows, validates every row, and excludes POST/non-QB scope", async () => {
    const fixture = sourceFixture(csvFixture(STAT_HEADER, [STAT_ROW, [...STAT_ROW.slice(0, 1), "WR", ...STAT_ROW.slice(2)],
      [...STAT_ROW.slice(0, 4), "POST", ...STAT_ROW.slice(5)]]), { gzip: true });
    const result = await normalizeSource(fixture.bytes, fixture.asset, signal());
    expect(result.rowCount).toBe(3);
    expect(result.rows).toEqual([{ player_id: "00-0000001", game_id: "2021_01_DAL_TB", team: "DAL",
      passing_attempts: 0, passing_yards: 0, state: "usable", reasons: [] }]);
    expect(result.diagnostics.filteredRows).toBe(2);
  });

  it("marks conflicting duplicate values ambiguous and identity/value gaps refused", async () => {
    const bad = [...STAT_ROW]; bad[0] = "bad-player"; bad[8] = "NA";
    const correction = [...STAT_ROW]; correction[8] = "10";
    const fixture = sourceFixture(csvFixture(STAT_HEADER, [STAT_ROW, STAT_ROW, correction, bad]));
    const result = await normalizeSource(fixture.bytes, fixture.asset, signal());
    expect(result.rows).toHaveLength(2);
    expect(result.rows.find((row) => row.player_id === "00-0000001")?.state).toBe("ambiguous");
    expect(result.rows.find((row) => row.player_id === "bad-player")?.reasons).toEqual(["player-identity-invalid", "stats-value-invalid"]);
    expect(result.diagnostics.duplicateRows).toBe(1);
  });

  it("refuses a bad wire digest and a gzip CRC failure even when that corrupt wire hash is pinned", async () => {
    const fixture = sourceFixture(undefined, { gzip: true });
    await expect(normalizeSource(fixture.bytes, { ...fixture.asset, sha256: "0".repeat(64) }, signal())).rejects.toThrow("ingest-wire-digest-mismatch");
    const corrupt = Buffer.from(fixture.bytes); corrupt[corrupt.length - 8] ^= 1;
    await expect(normalizeSource(corrupt, { ...fixture.asset, sha256: sha256(corrupt), provider_digest: null }, signal())).rejects.toThrow();
  });

  it("refuses changed/duplicate headers, malformed widths, invalid UTF-8 and exhausted quotas", async () => {
    for (const text of [csvFixture([...STAT_HEADER.slice(1), STAT_HEADER[0]], [STAT_ROW]),
      csvFixture([STAT_HEADER[0], ...STAT_HEADER.slice(0, -1)], [STAT_ROW]),
      csvFixture(STAT_HEADER, [STAT_ROW.slice(1)])]) {
      const fixture = sourceFixture(text);
      await expect(normalizeSource(fixture.bytes, fixture.asset, signal())).rejects.toThrow();
    }
    const fixture = sourceFixture();
    await expect(normalizeSource(fixture.bytes, fixture.asset, signal(), { ...INGEST_LIMITS, decodedBytes: 10 })).rejects.toThrow("ingest-decoded-budget-exceeded");
    const bytes = Buffer.concat([fixture.bytes, Buffer.from([0xff])]);
    await expect(normalizeSource(bytes, { ...fixture.asset, wire_bytes: bytes.length, sha256: sha256(bytes), provider_digest: null }, signal())).rejects.toThrow();
    const rows = sourceFixture(csvFixture(STAT_HEADER, [STAT_ROW, STAT_ROW]));
    await expect(normalizeSource(rows.bytes, rows.asset, signal(), { ...INGEST_LIMITS, rows: 1 })).rejects.toThrow("ingest-row-budget-exceeded");
  });

  it("uses positive participation only, de-duplicates plays and refuses conflicting plays", async () => {
    const header = ["nflverse_game_id", "play_id", "offense_players"];
    const game = "2021_01_DAL_TB";
    const fixture = sourceFixture(csvFixture(header, [[game, "1", ""], [game, "2", "00-0000001;00-0000002"],
      [game, "2", "00-0000001;00-0000002"], [game, "3", "junk00-0000001"],
      [game, "4", "00-0000001"], [game, "4", "00-0000002"]]), { feed: "pbp_participation", columns: header });
    const result = await normalizeSource(fixture.bytes, fixture.asset, signal());
    expect(result.rows.map((row) => [row.player_id, row.offense_play_count])).toEqual([["00-0000001", 1], ["00-0000002", 1]]);
    expect(result.diagnostics.missingOffenseRows).toBe(1);
    expect(result.diagnostics.invalidParticipationRows).toBe(1);
    expect(result.diagnostics.conflictingRows).toBe(1);
  });

  it("normalizes roster identities and schedule Eastern clocks without inventing completion times", async () => {
    const rosterHeader = ["season", "week", "game_type", "position", "gsis_id", "team", "full_name"];
    const roster = sourceFixture(csvFixture(rosterHeader, [["2021", "1", "REG", "QB", "00-0000001", "DAL", "Synthetic QB"]]),
      { feed: "weekly_rosters", columns: rosterHeader });
    expect((await normalizeSource(roster.bytes, roster.asset, signal())).rows[0].player_id).toBe("00-0000001");
    const header = ["game_id", "season", "week", "game_type", "gameday", "gametime", "home_team", "away_team", "home_score", "away_score"];
    const schedule = sourceFixture(csvFixture(header, [["2021_01_DAL_TB", "2021", "1", "REG", "2021-09-09", "20:20", "TB", "DAL", "31", "29"]]),
      { feed: "schedules", columns: header });
    expect((await normalizeSource(schedule.bytes, schedule.asset, signal())).rows[0].kickoff).toBe("2021-09-10T00:20:00.000Z");
    expect(easternKickoff("2022-01-09", "13:00")).toBe("2022-01-09T18:00:00.000Z");
    expect(() => easternKickoff("2021-03-14", "02:30")).toThrow();
    expect(() => easternKickoff("2021-11-07", "01:30")).toThrow();
  });
});

describe("#138 binary download", () => {
  it("bounds exact wire bytes and refuses unsafe redirects or transparent decoding", async () => {
    const fixture = sourceFixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture.bytes));
    expect((await downloadSource(fixture.asset, signal(), INGEST_LIMITS, fetcher)).bytes).toEqual(fixture.bytes);
    fetcher.mockResolvedValue(new Response(fixture.bytes, { headers: { "content-encoding": "gzip" } }));
    await expect(downloadSource(fixture.asset, signal(), INGEST_LIMITS, fetcher)).rejects.toThrow("ingest-wire-metadata-refused");
    fetcher.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://example.invalid/file" } }));
    await expect(downloadSource(fixture.asset, signal(), INGEST_LIMITS, fetcher)).rejects.toThrow("ingest-url-refused");
    fetcher.mockResolvedValue(new Response(Buffer.concat([fixture.bytes, Buffer.from("x")])));
    await expect(downloadSource(fixture.asset, signal(), INGEST_LIMITS, fetcher)).rejects.toThrow("ingest-wire-budget-exceeded");
  });
});
