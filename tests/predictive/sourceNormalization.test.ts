import { expect, it } from "vitest";
import { planSourceStatsFromReplay, planSourceStatsNormalization } from "../../src/lib/predictive/sourceNormalization.ts";
import { createReplay } from "../../src/lib/predictive/replay.ts";
import { canonical, digest } from "../../src/lib/predictive/validation.ts";
import { addCapture, gameId, profile, revision, rights } from "./fixtures/passingYards.ts";
import { sourceCsv, sourceSamples } from "./fixtures/source.ts";
import { BRIDGE_PROFILE, normalizationFixture, NORMALIZATION_ACCESS, NORMALIZATION_CUTOFF, NORMALIZATION_GAME,
  NORMALIZATION_KICKOFF, rewriteNormalizationRows } from "./fixtures/sourceNormalization.ts";

const plan = async () => {
  const fixture = await normalizationFixture();
  return { ...fixture, result: planSourceStatsNormalization(fixture.source, fixture.context, NORMALIZATION_ACCESS) };
};
it("plans exact raw-row and cutoff-visible bridge bindings without publishing observations or inventing completion", async () => {
  const { result, input, source } = await plan();
  expect(result.status).toBe("planned-source-normalization");
  expect(result.candidate).toEqual({ kind: "player-game-stats", data: { gameId: NORMALIZATION_GAME, rawGameId: "2026_06_CAR_PHI",
    teamId: "nfl:team:PHI", rawTeam: "PHI", season: 2026, seasonType: "REG", playerId: "00-0000001",
    rawPlayerId: "00-0000001", playerIdProvider: "gsis", attempts: 10, passingYards: 80,
    completions: null, passingTds: null, passingInterceptions: null, carries: null, rushingYards: null,
    targets: null, receptions: null, receivingYards: null, missing: { completions: "source-blank", passingTds: "source-blank",
      passingInterceptions: "source-blank", carries: "source-blank", rushingYards: "source-blank", targets: "source-blank",
      receptions: "source-blank", receivingYards: "source-blank" } } });
  expect(result.binding.dependencies.map((row) => [row.role, row.observationId])).toEqual([
    ["game-bridge", "game-map"], ["opponent-alias", "opponent-map"], ["player-bridge", "player-map"],
    ["schedule", "game-schedule"], ["team-alias", "team-map"],
  ]);
  expect(result.binding.sourceCaptures[0]).toMatchObject({ artifactId: input.artifact.id, sha256: input.artifact.sha256 });
  expect(result.binding.sourceRows).toEqual([{ id: source.evidence.rows[0].id, rowOrdinal: 1, selectedSha256: source.evidence.rows[0].selectedSha256 }]);
  expect(result).toMatchObject({ observationsPublished: false, featuresPublished: false, labelsFinalized: false, populationCoverage: "unqualified" });
  expect(result.candidate).not.toHaveProperty("predecessorId");
  expect(result.binding.identityLinks.map((row) => row.id)).toEqual(["raw-stats-gsis-link"]);
});
it("allows internal-research normalization while preserving the default model-input rights gate", async () => {
  const { source, context } = await normalizationFixture();
  expect(createReplay(context, NORMALIZATION_CUTOFF, NORMALIZATION_ACCESS).resolveGame("nflverse", "2026_06_CAR_PHI").state).toBe("missing");
  expect(planSourceStatsNormalization(source, context, NORMALIZATION_ACCESS).status).toBe("planned-source-normalization");
});
it("plans team statistics with game/team/opponent/schedule evidence and no player bridge requirement", async () => {
  const { source, context, bridgeRows } = await normalizationFixture("team");
  rewriteNormalizationRows(context, bridgeRows.filter((row) => row.kind !== "player-bridge")); context.identityLinks = [];
  const result = planSourceStatsNormalization(source, context, NORMALIZATION_ACCESS);
  expect(result.status).toBe("planned-source-normalization"); expect(result.candidate?.kind).toBe("team-game-stats");
  expect(result.candidate?.data).not.toHaveProperty("playerId"); expect(result.binding.identityLinks).toEqual([]);
});
it.each([
  ["game-map", "game-bridge-missing"], ["team-map", "team-alias-missing"], ["opponent-map", "opponent-alias-missing"],
  ["game-schedule", "normalization-schedule-missing"], ["player-map", "player-bridge-missing"],
])("does not infer %s from a familiar raw identifier", async (id, reason) => {
  const { source, context, bridgeRows } = await normalizationFixture();
  rewriteNormalizationRows(context, bridgeRows.filter((row) => row.id !== id));
  expect(planSourceStatsNormalization(source, context, NORMALIZATION_ACCESS)).toMatchObject({ status: "unavailable-source-normalization", reason, candidate: null });
});
it.each(["missing", "future", "wrong-provider"])("requires an exact current profile/namespace authorization link (%s)", async (mode) => {
  const { source, context } = await normalizationFixture();
  if (mode === "missing") context.identityLinks = [];
  if (mode === "future") context.identityLinks[0].decidedAt = NORMALIZATION_ACCESS;
  if (mode === "wrong-provider") context.identityLinks[0].provider = "other-id";
  expect(planSourceStatsNormalization(source, context, NORMALIZATION_ACCESS)).toMatchObject({ reason: "player-bridge-link-missing", candidate: null });
});
it.each(["starts-at-kickoff", "ends-at-kickoff", "starts-after-cutoff"])("uses the player bridge's half-open window at kickoff (%s)", async (mode) => {
  const { source, context, bridgeRows } = await normalizationFixture();
  const player = bridgeRows.find((row) => row.kind === "player-bridge")!;
  if (mode === "ends-at-kickoff") player.data.effectiveTo = NORMALIZATION_KICKOFF;
  else player.data.effectiveFrom = mode === "starts-at-kickoff" ? NORMALIZATION_KICKOFF : "2026-10-12T00:00:00.000Z";
  rewriteNormalizationRows(context, bridgeRows);
  expect(planSourceStatsNormalization(source, context, NORMALIZATION_ACCESS).status)
    .toBe(mode === "ends-at-kickoff" ? "unavailable-source-normalization" : "planned-source-normalization");
});
it.each(["week", "seasonType", "home-away"])("refuses source/schedule context disagreement (%s)", async (mode) => {
  const { source, context, bridgeRows } = await normalizationFixture();
  const game = bridgeRows.find((row) => row.kind === "schedule")!;
  if (mode === "week") game.data.week = 5;
  if (mode === "seasonType") game.data.seasonType = "POST";
  if (mode === "home-away") [game.data.homeTeamId, game.data.awayTeamId] = [game.data.awayTeamId, game.data.homeTeamId];
  rewriteNormalizationRows(context, bridgeRows);
  expect(planSourceStatsNormalization(source, context, NORMALIZATION_ACCESS)).toMatchObject({ reason: "source-schedule-context-conflict", candidate: null });
});
it("retains exact zero and signed yardage while leaving blank counts missing", async () => {
  const { source, context } = await normalizationFixture("player", sourceCsv("player", [{ ...sourceSamples().player[0], attempts: "0", passing_yards: "-4" }]));
  expect(planSourceStatsNormalization(source, context, NORMALIZATION_ACCESS).candidate?.data).toMatchObject({ attempts: 0, passingYards: -4, carries: null });
});
it("keeps duplicate source records bound to their own ordinals while proposing one canonical payload", async () => {
  const row = sourceSamples().player[0];
  const { source, context } = await normalizationFixture("player", sourceCsv("player", [row, row]));
  const result = planSourceStatsNormalization(source, context, NORMALIZATION_ACCESS);
  expect(result.status).toBe("planned-source-normalization"); expect(result.binding.sourceRows.map((row) => row.rowOrdinal)).toEqual([1, 2]);
});
it.each(["source-row-missing", "source-row-refused", "source-row-ambiguous", "source-capture-ambiguous"])("preserves an unavailable raw-source state (%s)", async (reason) => {
  const { source, context } = await normalizationFixture(); source.status = "unavailable-source-claim"; source.reason = reason;
  expect(planSourceStatsNormalization(source, context, NORMALIZATION_ACCESS)).toMatchObject({ reason, candidate: null, dataDigest: null });
});
it("refuses modified raw replay evidence and source rows that are not visible at the cutoff", async () => {
  const { source, context } = await normalizationFixture();
  source.evidence.rows[0].projection!.values.passingYards = 999;
  expect(() => planSourceStatsNormalization(source, context, NORMALIZATION_ACCESS)).toThrow("source-normalization-evidence-refused");
  source.inputDigest = digest(canonical(source.evidence)); source.evidence.captures[0].ingestedAt = NORMALIZATION_ACCESS;
  source.inputDigest = digest(canonical(source.evidence));
  expect(() => planSourceStatsNormalization(source, context, NORMALIZATION_ACCESS)).toThrow("source-normalization-evidence-refused");
});
it("refuses a future normalization cutoff", async () => {
  const { source, context } = await normalizationFixture();
  expect(() => planSourceStatsNormalization(source, context, "2026-10-09T12:00:00.000Z")).toThrow("source-normalization-evidence-refused");
});
it("checks cutoff visibility even when a caller supplies an already constructed replay", async () => {
  const { source, context } = await normalizationFixture();
  const future = "2026-10-10T13:00:00.000Z";
  context.captures[0].capturedAt = future; context.captures[0].availableAt = future; context.captures[0].ingestedAt = future;
  const replay = createReplay(context, NORMALIZATION_ACCESS, NORMALIZATION_ACCESS, "internal-research");
  expect(() => planSourceStatsFromReplay(source, { ...context, replay }, NORMALIZATION_ACCESS)).toThrow("source-normalization-context-time-refused");
});
it("a later player-bridge correction changes later normalization without rewriting the earlier plan", async () => {
  const { source, context } = await normalizationFixture();
  const before = planSourceStatsNormalization(source, context, NORMALIZATION_ACCESS);
  addCapture(context, "player-correction", [revision("player-map-B", "player-bridge", { provider: "gsis", rawPlayerId: "00-0000001",
    playerId: "00-0000002", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z" }, "player-map")],
    "2026-10-10T13:00:00.000Z", BRIDGE_PROFILE);
  expect(planSourceStatsNormalization(source, context, NORMALIZATION_ACCESS)).toEqual(before);
  source.evidence.request.cutoff = "2026-10-10T14:00:00.000Z"; source.inputDigest = digest(canonical(source.evidence));
  const later = planSourceStatsNormalization(source, context, NORMALIZATION_ACCESS);
  expect(later.candidate?.data).toHaveProperty("playerId", "00-0000002");
  expect(later.binding.dependencies.find((row) => row.role === "player-bridge")?.observationId).toBe("player-map-B");
  expect(later.dataDigest).not.toBe(before.dataDigest);
});
it.each(["player-forward", "player-reverse", "game-reverse"])("withholds conflicting bridge mappings across profiles (%s)", async (mode) => {
  const { source, context } = await normalizationFixture();
  const other = "rival-normalization-profile"; context.profiles.push(profile(other)); context.rightsDecisions.push(rights(other));
  addCapture(context, "rival-map", [mode === "game-reverse"
    ? revision("rival", "game-bridge", { provider: "nflverse", rawGameId: "other-game", gameId: NORMALIZATION_GAME })
    : revision("rival", "player-bridge", { provider: "gsis", rawPlayerId: mode === "player-forward" ? "00-0000001" : "00-0000002",
      playerId: mode === "player-forward" ? "00-0000002" : "00-0000001", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z" })],
    "2026-10-09T12:00:00.000Z", other);
  const result = planSourceStatsNormalization(source, context, NORMALIZATION_ACCESS);
  expect(result).toMatchObject({ reason: mode === "game-reverse" ? "game-bridge-conflict" : "player-bridge-conflict", candidate: null });
  expect(result.binding.dependencies.some((row) => row.observationId === "rival")).toBe(true);
});
it("refuses a currently revoked source even when its original capture and cutoff were authorized", async () => {
  const { source, context, input } = await normalizationFixture();
  context.rightsDecisions.push({ ...input.rightsDecisions[0], id: "source-revoked", predecessorId: input.rightsDecisions[0].id,
    allowedUses: [], effectiveFrom: "2026-10-10T13:00:00.000Z", decidedAt: "2026-10-10T13:00:00.000Z" });
  expect(planSourceStatsNormalization(source, context, NORMALIZATION_ACCESS)).toMatchObject({ reason: "rights-not-in-force", candidate: null });
});
it("does not change the plan for unrelated evidence, input ordering or a later access time under the same rights", async () => {
  const { source, context, result } = await plan();
  addCapture(context, "unrelated", [revision("unrelated-game", "game-bridge", { provider: "nflverse", rawGameId: "unrelated", gameId: gameId(99) })],
    "2026-10-09T12:00:00.000Z", BRIDGE_PROFILE);
  context.artifacts.reverse(); context.captures.reverse(); context.profiles.reverse(); context.rightsDecisions.reverse();
  expect(planSourceStatsNormalization(source, context, "2026-10-11T13:00:00.000Z")).toEqual(result);
});
