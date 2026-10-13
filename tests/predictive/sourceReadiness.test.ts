import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runSourcePrototype } from "../../scripts/predictive/source.ts";
import { openArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { captureSourcePrototype, verifySourcePrototype } from "../../src/lib/predictive/sourcePrototype.ts";
import { assessSourcePrototype, assessSourceSamples } from "../../src/lib/predictive/sourceReadiness.ts";
import { SOURCE_LIMITS } from "../../src/lib/predictive/sourceTransport.ts";
import type { SourceRow } from "../../src/lib/predictive/sourceAdapters.ts";
import { fixtureTransport, sourceGameId, sourceSamples } from "./fixtures/source.ts";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
it("counts positive usage for one QB, keeps a missing backup unresolved and withholds model/label readiness", () => {
  const report = assessSourceSamples(sourceSamples(), 2026, sourceGameId);
  expect(report.qbParticipation).toEqual({ candidates: 2, positiveUsageIndividuals: 1, confirmedAbsent: 0, unresolved: 1,
    unresolvedReasons: { "player-stats-missing": 1 } });
  expect(report).toMatchObject({ assessmentVersion: "nflverse-source-readiness-v1", populationCoverage: "unqualified",
    historicalCutoffCoverage: "unverified", featureStatus: "unavailable-inputs", featuresPublished: false, labelsFinalized: false, modelValidated: false });
  expect(report.gates).toEqual(expect.arrayContaining(["complete-offensive-population-unqualified", "completion-source-unqualified", "csv-persistence-not-implemented"]));
});
it.each(["zero", "blank"])("keeps %s statistics unresolved despite ACT roster status", (kind) => {
  const samples = sourceSamples(); samples.player[0] = { ...samples.player[0], attempts: kind === "zero" ? "0" : "", carries: "0", targets: "0" };
  expect(assessSourceSamples(samples, 2026, sourceGameId).qbParticipation).toMatchObject({ candidates: 2, positiveUsageIndividuals: 0,
    confirmedAbsent: 0, unresolved: 2, unresolvedReasons: { "offensive-participation-unresolved": 1, "player-stats-missing": 1 } });
});
it.each([
  ["identifier", "player-identity-ambiguous"], ["roster", "roster-conflicting"], ["stats", "player-stats-conflicting"],
  ["denominator", "source-stats-denominator-refused"], ["number", "source-number-refused"], ["opponent", "source-stats-context-refused"],
  ["schedule", "player-stats-schedule-conflicting"],
])("withholds the individual's claim when %s evidence conflicts or is invalid", (kind, reason) => {
  const samples = sourceSamples();
  if (kind === "identifier") samples.identifiers.push({ ...samples.identifiers[0], display_name: "Conflicting name" });
  if (kind === "roster") samples.roster.push({ ...samples.roster[0], status: "RES" });
  if (kind === "stats") samples.player.push({ ...samples.player[0], passing_yards: "90" });
  if (kind === "denominator") samples.player[0].completions = "11";
  if (kind === "number") samples.player[0].attempts = "1.5";
  if (kind === "opponent") samples.player[0].opponent_team = "BUF";
  if (kind === "schedule") samples.player[0].season_type = "POST";
  const report = assessSourceSamples(samples, 2026, sourceGameId);
  expect(report.qbParticipation).toMatchObject({ candidates: 2, positiveUsageIndividuals: 0, unresolved: 2, confirmedAbsent: 0 });
  expect(report.qbParticipation.unresolvedReasons[reason]).toBe(1);
});
it("leaves missing/ambiguous schedule joins and missing identities in the denominator", () => {
  const samples = sourceSamples(); samples.roster[0].week = "7"; samples.identifiers = [samples.identifiers[0]];
  const report = assessSourceSamples(samples, 2026, sourceGameId);
  expect(report.qbParticipation).toMatchObject({ candidates: 2, positiveUsageIndividuals: 0, unresolved: 2,
    unresolvedReasons: { "player-schedule-unresolved": 1, "player-identity-missing": 1 } });
});
it("deduplicates identical candidates and makes their evidence digest independent of input ordering", () => {
  const samples = sourceSamples(); const initial = assessSourceSamples(samples, 2026, sourceGameId);
  samples.roster.push({ ...samples.roster[0] }); samples.player.push({ ...samples.player[0] });
  samples.roster.reverse(); samples.player.reverse(); samples.identifiers.reverse();
  const report = assessSourceSamples(samples, 2026, sourceGameId);
  expect(report.qbParticipation).toEqual(initial.qbParticipation); expect(report.candidateEvidenceDigest).toBe(initial.candidateEvidenceDigest);
  expect(report.populationCoverage).toBe("unqualified");
});
it.each(["roster", "stats", "identifier", "schedule"])("keeps conflicting %s evidence and its digest stable across input ordering", (kind) => {
  const samples = sourceSamples();
  if (kind === "roster") samples.roster.push({ ...samples.roster[0], position: "RB" });
  if (kind === "stats") samples.player.push({ ...samples.player[0], attempts: "15" });
  if (kind === "identifier") samples.identifiers.push({ ...samples.identifiers[0], display_name: "Another name" });
  const target = kind === "schedule" ? "2026_07_PHI_BUF" : sourceGameId;
  if (kind === "schedule") {
    samples.schedule.push({ ...samples.schedule[0], gametime: "16:00" }, { ...samples.schedule[0], game_id: target,
      week: "7", away_team: "PHI", home_team: "BUF", gameday: "2026-10-25" });
  }
  const initial = assessSourceSamples(samples, 2026, target);
  samples.roster.reverse(); samples.player.reverse(); samples.identifiers.reverse(); samples.schedule.reverse();
  const reordered = assessSourceSamples(samples, 2026, target);
  expect(reordered.qbParticipation).toEqual(initial.qbParticipation);
  expect(reordered.qbParticipation).toMatchObject({ candidates: 2, positiveUsageIndividuals: 0, unresolved: 2 });
  expect(reordered.candidateEvidenceDigest).toBe(initial.candidateEvidenceDigest);
});
it.each<SourceRow>([{ game_type: "PRE" }, { week: "6.0" }, { season: "2026.0" }])("keeps malformed current-season QB context %j unresolved in the denominator", (change) => {
  const samples = sourceSamples(); samples.roster[0] = { ...samples.roster[0], ...change };
  expect(assessSourceSamples(samples, 2026, sourceGameId).qbParticipation).toMatchObject({ candidates: 2, positiveUsageIndividuals: 0,
    unresolved: 2, unresolvedReasons: { "player-roster-context-refused": 1, "player-stats-missing": 1 } });
});
it("binds the readiness digest to selected identity, roster, schedule and stats evidence even when counts stay unchanged", () => {
  const samples = sourceSamples(); const original = assessSourceSamples(samples, 2026, sourceGameId);
  samples.identifiers[0].display_name = "Changed source identity";
  const identity = assessSourceSamples(samples, 2026, sourceGameId);
  samples.roster[0].status = "RES";
  const roster = assessSourceSamples(samples, 2026, sourceGameId);
  samples.schedule[0].gametime = "16:00";
  const schedule = assessSourceSamples(samples, 2026, sourceGameId);
  samples.player[0].passing_yards = "101";
  const stats = assessSourceSamples(samples, 2026, sourceGameId);
  for (const result of [identity, roster, schedule, stats]) expect(result.qbParticipation).toEqual(original.qbParticipation);
  expect(new Set([original, identity, roster, schedule, stats].map((report) => report.candidateEvidenceDigest)).size).toBe(5);
});
it("refuses rows outside the captured stats season instead of counting them as qualified projections", () => {
  const samples = sourceSamples(); samples.player.push({ ...samples.player[0], season: "2025", game_id: "2025_06_CAR_PHI" });
  samples.team.push({ ...samples.team[0], season: "2025", game_id: "2025_06_CAR_PHI" });
  const report = assessSourceSamples(samples, 2026, sourceGameId);
  expect(report.statistics.player).toMatchObject({ sourceRows: 2, projectedRows: 1, refusedRows: 1, reasons: { "source-stats-scope-refused": 1 } });
  expect(report.statistics.team).toMatchObject({ sourceRows: 2, projectedRows: 1, refusedRows: 1, reasons: { "source-stats-scope-refused": 1 } });
});
it("assesses a verified v1 journal offline without rewriting its original qualification or source files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs-ev-readiness-"))); roots.push(root);
  const store = await openArtifactStore(root, SOURCE_LIMITS.responseBytes);
  const captured = await captureSourcePrototype(store, 2026, sourceGameId, fixtureTransport({ partialDepth: true }).transport);
  const entries = await readdir(root, { withFileTypes: true });
  const before = new Map(await Promise.all(entries.filter((entry) => entry.isFile()).map(async ({ name }) => [name, await readFile(join(root, name))] as const)));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("offline only"); }));
  const result = await runSourcePrototype(["assess", "--artifact-root", root, "--journal", captured.journal.reference,
    "--journal-bytes", String(captured.journal.byteSize)], { NODE_ENV: "test" });
  expect(result).toMatchObject({ captureFinishedAt: captured.report.finishedAt, assessment: { qbParticipation: { positiveUsageIndividuals: 1, unresolved: 1 } } });
  expect(await verifySourcePrototype(store, captured.journal)).toMatchObject({ qualification: captured.report.qualification });
  expect(captured.report.qualification!.counts.offensiveParticipationUnresolved).toBe(2);
  expect(globalThis.fetch).not.toHaveBeenCalled(); expect((await readdir(root)).sort()).toEqual(entries.map((entry) => entry.name).sort());
  expect(await readdir(join(root, ".db-blobs"))).toEqual([]);
  for (const [name, bytes] of before) expect(await readFile(join(root, name))).toEqual(bytes);
  const source = captured.report.captures[0].source!;
  await writeFile(join(root, source.reference), "tampered", { mode: 0o600 });
  await expect(assessSourcePrototype(store, captured.journal)).rejects.toThrow("artifact-integrity-failed");
});
it("refuses assessment of failed captures and ambient database/provider credentials", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs-ev-readiness-"))); roots.push(root);
  const store = await openArtifactStore(root, SOURCE_LIMITS.responseBytes);
  const captured = await captureSourcePrototype(store, 2026, sourceGameId, fixtureTransport({ failFeed: "team" }).transport);
  await expect(assessSourcePrototype(store, captured.journal)).rejects.toThrow("source-assessment-capture-refused");
  const args = ["assess", "--artifact-root", root, "--journal", captured.journal.reference, "--journal-bytes", String(captured.journal.byteSize)];
  for (const key of ["TEST_DATABASE_URL", "NEON_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"])
    await expect(runSourcePrototype(args, { NODE_ENV: "test", [key]: "forbidden" })).rejects.toThrow("source-environment-refused");
  expect(() => assessSourceSamples(sourceSamples(), 2025, sourceGameId)).toThrow("source-scope-refused");
});
