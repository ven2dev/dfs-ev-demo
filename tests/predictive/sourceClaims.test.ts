import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runSourceClaimsProof } from "../../scripts/predictive/sourceLocal.ts";
import { prepareSourceClaims } from "../../src/lib/predictive/sourceClaims.ts";
import { digest } from "../../src/lib/predictive/validation.ts";
import { sourceClaimFixture } from "./fixtures/sourceClaims.ts";
import { sourceCsv, sourceSamples } from "./fixtures/source.ts";

it("binds raw stats claims to CSV data-record ordinals across quoted newlines and blank records", async () => {
  const rows = sourceSamples().player;
  const bytes = sourceCsv("player", [{ ...rows[0], player_display_name: "A\nquoted, name" }, { ...rows[0], player_id: "00-0000002", attempts: "0", passing_yards: "0" }]);
  const lines = bytes.split("\n"); lines.splice(1, 0, "");
  const input = sourceClaimFixture("quoted", "player", lines.join("\n"));
  const prepared = await prepareSourceClaims(input);
  expect(prepared.rows.map((row) => row.rowOrdinal)).toEqual([1, 2]);
  expect(prepared.rows.map((row) => row.projection?.values.attempts)).toEqual([10, 0]);
  expect(prepared.rows[0].failureCode).toBeNull();
  expect(prepared.rows[0].projection).toMatchObject({ rawPlayerId: "00-0000001", playerIdProvider: "gsis" });
  expect(prepared.rows[0].projection).not.toHaveProperty("playerId");
});
it("pins excluded columns in the source hash without importing them into selected-row or projection hashes", async () => {
  const row = sourceSamples().player[0];
  const a = sourceClaimFixture("same", "player", sourceCsv("player", [{ ...row, fantasy_points: "999" }]));
  const b = sourceClaimFixture("same", "player", sourceCsv("player", [{ ...row, fantasy_points: "-99" }]));
  expect(a.artifact.sha256).not.toBe(b.artifact.sha256);
  expect(await prepareSourceClaims(a)).toEqual(await prepareSourceClaims(b));
});
it("retains invalid rows as explicit refusals instead of dropping them or zero-filling", async () => {
  const row = sourceSamples().player[0];
  const result = await prepareSourceClaims(sourceClaimFixture("mixed", "player", sourceCsv("player", [row,
    { ...row, player_id: "" }, { ...row, attempts: "1.5" }, { ...row, season: "2025", game_id: "2025_06_CAR_PHI" }])));
  expect(result.rows.map(({ rowOrdinal, failureCode }) => ({ rowOrdinal, failureCode }))).toEqual([
    { rowOrdinal: 1, failureCode: null }, { rowOrdinal: 2, failureCode: "source-stats-player-refused" },
    { rowOrdinal: 3, failureCode: "source-number-refused" }, { rowOrdinal: 4, failureCode: "source-stats-scope-refused" }]);
  expect(result.rows.slice(1).every((row) => row.projection === null)).toBe(true);
});
it.each([
  ["hash", "artifact-integrity-failed"], ["parser", "source-publication-profile-refused"],
  ["header", "source-publication-header-refused"], ["scope", "source-publication-profile-refused"],
  ["filter", "source-publication-profile-refused"], ["probe", "source-publication-profile-refused"],
  ["id", "source-publication-id-refused"],
])("refuses incompatible %s before persistence", async (change, code) => {
  const input = sourceClaimFixture();
  if (change === "hash") input.artifact.sha256 = "0".repeat(64);
  if (change === "parser") input.profile.parserVersion = "unknown-transform";
  if (change === "header") input.profile.headerProfileSha256 = "0".repeat(64);
  if (change === "scope") input.artifact.scopeSeason = 2025;
  if (change === "filter") input.artifact.scopeFilter = "QB only";
  if (change === "probe") input.artifact.retrievalKind = "header-probe";
  if (change === "id") input.captureId = "invalid\nidentity";
  await expect(prepareSourceClaims(input)).rejects.toMatchObject({ code });
});
it("fails closed on CSV header drift even when the content digest is correct", async () => {
  const input = sourceClaimFixture(); input.artifact.bytes = input.artifact.bytes.replace("player_id,", "wrong_id,");
  input.artifact.sha256 = digest(input.artifact.bytes);
  await expect(prepareSourceClaims(input)).rejects.toThrow("source-header-drift");
});
it("refuses invalid local-proof arguments and application credentials before writing or connecting", async () => {
  const root = await mkdtemp(join(tmpdir(), "dfs52-source-cli-"));
  try {
    const args = ["prove", "--artifact-root", root, "--journal", "a".repeat(64) + ".json", "--journal-bytes", "1"];
    for (const invalid of [[], [...args, "extra"], [...args.slice(0, -1), "9007199254740993"],
      [...args.slice(0, -1), "0"], ["capture", ...args.slice(1)]])
      await expect(runSourceClaimsProof(invalid, { NODE_ENV: "test" })).rejects.toMatchObject({ code: "source-proof-arguments-refused" });
    for (const key of ["DATABASE_URL", "MIGRATION_DATABASE_URL", "PGHOST", "GOOGLE_APPLICATION_CREDENTIALS"])
      await expect(runSourceClaimsProof(args, { NODE_ENV: "test", [key]: "" })).rejects.toThrow("credentials are not allowed");
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
