import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildPassingYardsBundle, buildPassingYardsFromReplay } from "../../src/lib/predictive/passingYards.ts";
import { createReplay } from "../../src/lib/predictive/replay.ts";
import { recordSnapCompatibility, snapOverlapHeadsAt, snapProfilesCompatible, snapShare, validateSnapCompatibilityDecisions } from "../../src/lib/predictive/snaps.ts";
import { reconcileFact } from "../../src/lib/predictive/policies.ts";
import { markerHeadsAt, recordCompletion } from "../../src/lib/predictive/completion.ts";
import { participationHeadsAt, recordParticipation } from "../../src/lib/predictive/participation.ts";
import { eligibleFinalAt, validateLabels } from "../../src/lib/predictive/labels.ts";
import { featureRunRecord } from "../../src/lib/predictive/featureRuns.ts";
import { digest, instant, RAW_ALLOWLISTS, validateDataset, validateRawHeader, validateRevision } from "../../src/lib/predictive/validation.ts";
import type { Artifact, Capture, CompletionRecord, Dataset, Label, ParticipationRecord, PlayerBridge, Reconciliation, Revision } from "../../src/lib/predictive/types.ts";
import { addCapture, artifact, CAPTURE_A, CAPTURE_B, completionMarkers, coverage, CUTOFF_A, CUTOFF_B, emptyDataset, gameId, membership, OPPONENT,
  passingYardsFixture, PLAYER, playerSnaps, playerStats, PRIOR, profile, PROFILE, request, revision, rights, schedule, TARGET, TEAM, teamSnaps, teamStats } from "./fixtures/passingYards.ts";

const row = (dataset: Dataset, id: string): Revision => {
  return dataset.artifacts.flatMap((item) => JSON.parse(item.bytes) as Revision[]).find((item) => item.id === id)!;
};
// Deliberately invalid/altered source fixtures for refusal tests, not production
// correction APIs. Normal replay mutations use append-only addCapture below.
const edit = (dataset: Dataset, id: string, change: (value: Revision) => void) => {
  for (const item of dataset.artifacts) {
    const rows = JSON.parse(item.bytes) as Revision[];
    const value = rows.find((item) => item.id === id);
    if (!value) continue;
    change(value); item.bytes = JSON.stringify(rows); item.sha256 = digest(item.bytes); return;
  }
  throw new Error("fixture row missing");
};
const omit = (dataset: Dataset, id: string) => {
  for (const item of dataset.artifacts) {
    const rows = (JSON.parse(item.bytes) as Revision[]).filter((value) => value.id !== id);
    item.bytes = JSON.stringify(rows); item.sha256 = digest(item.bytes);
    for (const capture of dataset.captures) if (capture.artifactId === item.id) capture.parsedRows = rows.length;
  }
};
const bundle = (dataset = passingYardsFixture(false)) => buildPassingYardsBundle(dataset, request());
const unavailable = (dataset: Dataset, reason: string) => {
  const result = bundle(dataset);
  expect(result.status).toBe("unavailable-inputs"); expect(result.reasons).toContain(reason); return result;
};
const playerChanges = (dataset: Dataset, id: string, values: Record<string, unknown>) => {
  edit(dataset, id, (value) => Object.assign(value.data, values));
};
const game = (number: number) => row(passingYardsFixture(false), "schedule-synthetic-game-" + number).data as ReturnType<typeof schedule>;
const evidence = (id: string, number: number, evidenceKind: "participation-feed" | "official-inactive-list",
  claim: "offensive-participant" | "inactive-or-dnp" | "zero-offensive-participation") =>
  revision(id, "participation-evidence", { gameId: gameId(number), playerId: PLAYER, teamId: TEAM, evidenceKind, claim });
const markOut = (dataset: Dataset, number: number) => {
  // A confirmed inactive player has no usage row; the official list supplies the claim.
  omit(dataset, "player-synthetic-game-" + number);
  addCapture(dataset, "inactive-" + number, [evidence("inactive-" + number, number, "official-inactive-list", "inactive-or-dnp")]);
};
const replaceMarkers = (dataset: Dataset, number: number, at: string) => {
  omit(dataset, "final-synthetic-game-" + number); omit(dataset, "terminal-synthetic-game-" + number);
  addCapture(dataset, "markers-" + number + "-" + at, completionMarkers(game(number), at).map((value) => ({ ...value, id: value.id + "-" + at })), at);
};

describe("passing-yard application-data cutoff replay", () => {
  it("pools paired player counts and keeps team volume separate from opposing offenses", () => {
    const result = bundle();
    expect(result.status).toBe("ready-inputs");
    expect(result.player[0]).toMatchObject({ expectedGames: 4, observedGames: 4, excludedGames: 0,
      attemptsSum: 100, passingYardsSum: 700, attemptsPerGame: 25, passingYardsPerAttempt: 7,
      gameIds: [...PRIOR].reverse().slice(0, 4) });
    expect(result.player[1]).toMatchObject({ expectedGames: 5, attemptsSum: 110, passingYardsSum: 750 });
    expect(result.team![0]).toMatchObject({ attemptsSum: 119, passingYardsSum: 869 });
    expect(result.opponent![0]).toMatchObject({ attemptsSum: 100, passingYardsSum: 700, passingYardsPerAttempt: 7 });
    expect(result.opponent![0].games.every((value) => value.teamId !== OPPONENT)).toBe(true);
    expect(result.dependencies.some((dep) => dep.observationId.startsWith("opponent-offense"))).toBe(false);
    expect(result.scheduledRestHours).toBe(168);
    expect(result.availability).toEqual({ injury: "unknown", depth: "unknown", participation: "future-unknown" });
    expect(result.quality).toEqual(expect.arrayContaining(["injury-unverified", "depth-unverified", "player-short-history"]));
    expect(result.policies).toEqual({ completion: "event-completion-v1", participation: "participation-v1", availability: "availability-v1" });
    expect(result.modelValidated).toBe(false); expect(result.populationCoverage).toBe("unqualified");
    expect(new Set(result.dependencies.map((dep) => dep.profileId))).toEqual(new Set([PROFILE]));
  });
  it("reproduces A after correction B and uses B only at a later cutoff", () => {
    const before = bundle(); const after = bundle(passingYardsFixture());
    expect(after).toEqual(before);
    const later = buildPassingYardsBundle(passingYardsFixture(), request(CUTOFF_B));
    expect(later.player[0].passingYardsSum).toBe(720);
    expect(later.dependencies.find((dep) => dep.observationId === "player-correction-B")).toMatchObject({ predecessorId: "player-synthetic-game-5", availableAt: CAPTURE_B });
    expect(later.inputDigest).not.toBe(before.inputDigest);
  });
  it.each([-1, 0, 1])("compares cutoff to availability and ingestion at %+d ms", (offset) => {
    const dataset = passingYardsFixture(false);
    const capture = dataset.captures.find((value) => value.artifactId === "A-player-game-stats")!;
    capture.availableAt = capture.ingestedAt = new Date(instant(CUTOFF_A) + offset).toISOString();
    const result = bundle(dataset);
    expect(result.status).toBe(offset <= 0 ? "ready-inputs" : "unavailable-inputs");
  });
  it("does not backdate a late ingestion from a known publication date", () => {
    const dataset = passingYardsFixture(false);
    const capture = dataset.captures.find((value) => value.artifactId === "A-player-game-stats")!;
    capture.publishedAt = "2026-10-06T12:00:00.000Z"; capture.publicationEvidence = "synthetic-publication-v1";
    capture.ingestedAt = CAPTURE_B;
    unavailable(dataset, "player-history-incomplete");
  });
  it("ignores an incomplete correction and withholds a missing required incomplete feed", () => {
    const dataset = passingYardsFixture();
    for (const capture of dataset.captures.filter((value) => value.artifactId.startsWith("B-"))) capture.state = "incomplete";
    expect(buildPassingYardsBundle(dataset, request(CUTOFF_B)).player[0].passingYardsSum).toBe(700);
    dataset.captures.find((value) => value.artifactId === "A-team-game-stats")!.state = "incomplete";
    unavailable(dataset, "opponent-history-incomplete");
  });
  it("is idempotent across duplicate captures and deterministic across capture/artifact ordering", () => {
    const dataset = passingYardsFixture(); const expected = bundle(dataset);
    dataset.captures.push({ ...dataset.captures[0] });
    dataset.captures.push({ ...dataset.captures[0], id: "zz-same-time-capture" });
    dataset.captures.push({ ...dataset.captures[0], id: "zz-later-capture", ingestedAt: CAPTURE_B });
    dataset.artifacts.reverse(); dataset.captures.reverse();
    expect(bundle(dataset)).toEqual(expected);
  });
  it("ignores later computation time in the digest but binds cutoff and selected facts", () => {
    const dataset = passingYardsFixture(false); const original = bundle(dataset);
    expect(buildPassingYardsBundle(dataset, { ...request(), computedAt: "2026-10-12T00:00:00.000Z" }).inputDigest).toBe(original.inputDigest);
    expect(buildPassingYardsBundle(dataset, request(CUTOFF_B)).inputDigest).not.toBe(original.inputDigest);
    playerChanges(dataset, "player-synthetic-game-5", { passingYards: 301 });
    expect(bundle(dataset).inputDigest).not.toBe(original.inputDigest);
  });
  it("never selects planted target-game outcomes or other season types/ranges", () => {
    const result = bundle();
    expect(result.player.flatMap((summary) => summary.games).some((value) => value.gameId === TARGET)).toBe(false);
    expect(result.excludedSchedule).toEqual([{ gameId: TARGET, reason: "target-game" }]);
    for (const id of [gameId(30), gameId(31), gameId(32)]) {
      expect(result.player[2].gameIds).not.toContain(id);
      expect(result.team![2].gameIds).not.toContain(id);
      expect(result.opponent![2].gameIds).not.toContain(id);
    }
    expect(result.dependencies.some((dep) => dep.observationId === "player-synthetic-game-10")).toBe(false);
  });
  it.each([0, -5])("preserves explicit signed or zero yardage %d", (passingYards) => {
    const dataset = passingYardsFixture(false); playerChanges(dataset, "player-synthetic-game-5", { passingYards });
    const result = bundle(dataset); expect(result.status).toBe("ready-inputs");
    expect(result.player[0].games[0].passingYards).toBe(passingYards);
    expect(result.player[0].passingYardsSum).toBe(400 + passingYards);
  });
  it("keeps confirmed zero attempts in volume and refuses zero pooled denominators", () => {
    const dataset = passingYardsFixture(false);
    for (let i = 1; i <= 5; i++) playerChanges(dataset, "player-synthetic-game-" + i, { attempts: 0, passingYards: 0 });
    // Zero usage is not participation evidence; an independent feed confirms it.
    addCapture(dataset, "feed", [1, 2, 3, 4, 5].map((i) => evidence("feed-" + i, i, "participation-feed", "offensive-participant")));
    const result = unavailable(dataset, "player-zero-or-missing-denominator");
    expect(result.player[0]).toMatchObject({ observedGames: 4, excludedGames: 0, attemptsSum: 0, attemptsPerGame: 0, passingYardsPerAttempt: null });
  });
  it("leaves a zero-usage game unresolved without independent participation evidence", () => {
    const dataset = passingYardsFixture(false);
    playerChanges(dataset, "player-synthetic-game-5", { attempts: 0, passingYards: 0 });
    const result = unavailable(dataset, "player-history-incomplete");
    expect(result.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "participation-unresolved" });
  });
  it("treats blank as missing and never fills the newest gap with an older fifth game", () => {
    const dataset = passingYardsFixture(false);
    playerChanges(dataset, "player-synthetic-game-5", { passingYards: null, missing: { passingYards: "source-blank" } });
    const result = unavailable(dataset, "player-history-incomplete");
    expect(result.player[0]).toMatchObject({ expectedGames: 4, observedGames: 3, passingYardsSum: 400,
      exclusions: [{ gameId: PRIOR[4], reason: "source-blank" }] });
    expect(result.player[0].gameIds).not.toContain(PRIOR[0]);
  });
  it("accepts positive usage as participation but withholds it when independent evidence disagrees", () => {
    const dataset = passingYardsFixture(false);
    expect(bundle(dataset).status).toBe("ready-inputs");
    addCapture(dataset, "inactive-conflict", [evidence("inactive-conflict", 5, "official-inactive-list", "inactive-or-dnp")]);
    const result = unavailable(dataset, "player-history-incomplete");
    expect(result.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "participation-conflicting" });
  });
  it.each([
    ["scheduled", ["final", "terminal"]],
    ["in-progress", ["terminal"]],
  ] as const)("withholds %s completion without guessing elapsed game time", (state, removed) => {
    const dataset = passingYardsFixture(false);
    for (const prefix of removed) omit(dataset, prefix + "-synthetic-game-5");
    const result = unavailable(dataset, "player-history-incomplete");
    expect(result.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "completion-" + state });
  });
  it.each(["suspension-notice", "postponement-notice"] as const)("treats a final status contradicted by a %s as conflicting", (markerType) => {
    const dataset = passingYardsFixture(false);
    addCapture(dataset, "stopped", [revision("stopped", "event-state-marker", { gameId: PRIOR[4], markerType, markerValue: "notice", terminalPlayTimeOfDay: null })]);
    const result = unavailable(dataset, "player-history-incomplete");
    expect(result.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "completion-conflicting" });
  });
  it("keeps a suspended game provisional and never reads its partial totals as final", () => {
    const dataset = passingYardsFixture(false);
    omit(dataset, "final-synthetic-game-5"); omit(dataset, "terminal-synthetic-game-5");
    addCapture(dataset, "suspended", [revision("suspended", "event-state-marker", { gameId: PRIOR[4], markerType: "suspension-notice", markerValue: "suspended", terminalPlayTimeOfDay: null })]);
    const result = unavailable(dataset, "player-history-incomplete");
    expect(result.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "completion-suspended" });
  });
  it.each([-1, 0, 1])("requires the completion markers' capture strictly before cutoff (%+d ms)", (offset) => {
    const dataset = passingYardsFixture(false);
    replaceMarkers(dataset, 5, new Date(instant(CUTOFF_A) + offset).toISOString());
    const result = bundle(dataset);
    expect(result.status).toBe(offset < 0 ? "ready-inputs" : "unavailable-inputs");
    if (offset === 0) expect(result.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "completion-not-before-cutoff" });
  });
  it("refuses completion evidence first captured before kickoff", () => {
    const dataset = passingYardsFixture(false); replaceMarkers(dataset, 5, "2026-10-04T17:00:00.000Z");
    unavailable(dataset, "player-history-incomplete");
  });
  it("dates completion at the later of the final status and its first confirming marker", () => {
    const dataset = passingYardsFixture(false);
    omit(dataset, "terminal-synthetic-game-5");
    addCapture(dataset, "late-terminal", [completionMarkers(game(5), CAPTURE_B)[1]], CAPTURE_B);
    expect(unavailable(dataset, "player-history-incomplete").player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "completion-in-progress" });
    expect(buildPassingYardsBundle(dataset, request(CUTOFF_B)).status).toBe("ready-inputs");
  });
  it.each(["schedule-synthetic-game-10", "member-synthetic-game-10"])("reports missing target dependency %s explicitly", (id) => {
    const dataset = passingYardsFixture(false); omit(dataset, id);
    const result = unavailable(dataset, id.startsWith("schedule") ? "target-schedule-missing" : "target-membership-missing");
    expect(result.player).toEqual([]);
  });
  it("withholds an explicit Out report and cutoff-known identity conflicts", () => {
    const dataset = passingYardsFixture(false);
    playerChanges(dataset, "availability-target", { rawReportStatus: "Out" }); unavailable(dataset, "player-excluded");
    playerChanges(dataset, "availability-target", { rawReportStatus: "Questionable", rawDepthRank: 1 });
    const usable = bundle(dataset);
    expect(usable.availability).toEqual({ injury: "unknown", depth: "observed", participation: "future-unknown" });
    expect(usable.quality).toContain("injury-unverified"); expect(usable.quality).not.toContain("depth-unverified");
    const original = row(dataset, "member-synthetic-game-10") as Revision<"membership">;
    addCapture(dataset, "conflicting-membership", [revision("conflicting-member", "membership", { ...original.data, teamId: OPPONENT, rawTeam: "DAL" })]);
    const result = unavailable(dataset, "target-membership-ambiguous");
    expect(result.dependencies.map((value) => value.observationId)).toEqual(expect.arrayContaining([original.id, "conflicting-member"]));
  });
  it.each([{ rawTeam: "DAL" }, { effectiveTo: "2026-10-11T17:00:00.000Z" }, { position: "WR" }])("requires raw and dated target membership: %j", (values) => {
    const dataset = passingYardsFixture(false); playerChanges(dataset, "member-synthetic-game-10", values);
    unavailable(dataset, "target-membership-inapplicable");
  });
  it("keeps team scheduled rest distinct from a traded player's former-team history", () => {
    const dataset = passingYardsFixture(false);
    const former = schedule(40, "2026-10-05T17:00:00.000Z", "nfl:team:BUF", "nfl:team:NE");
    addCapture(dataset, "trade-game", [revision("trade-game", "schedule", former)]);
    addCapture(dataset, "trade-member", [revision("trade-member", "membership", membership(former, { teamId: former.homeTeamId, rawTeam: "BUF",
      effectiveFrom: "2026-10-05T00:00:00.000Z", effectiveTo: "2026-10-06T00:00:00.000Z" }))]);
    addCapture(dataset, "trade-completion", completionMarkers(former));
    addCapture(dataset, "trade-player", [revision("trade-player", "player-game-stats", playerStats(former, 10, 60, former.homeTeamId, "BUF"))]);
    addCapture(dataset, "trade-team", [revision("trade-team", "team-game-stats", teamStats(former, former.homeTeamId, "BUF", 10, 60))]);
    addCapture(dataset, "trade-coverage", [revision("trade-coverage", "schedule-coverage", coverage(former.homeTeamId, [gameId(20), former.gameId]))]);
    const result = bundle(dataset); expect(result.status).toBe("ready-inputs");
    expect(result.player[0].gameIds[0]).toBe(former.gameId);
    expect(result.scheduledRestHours).toBe(168); expect(result.quality).toContain("player-team-change");
  });
  it("versions reschedules without changing prior-cutoff kickoff or rest", () => {
    const dataset = passingYardsFixture();
    const target = row(dataset, "schedule-synthetic-game-10") as Revision<"schedule">;
    addCapture(dataset, "reschedule", [revision("target-reschedule", "schedule", { ...target.data, kickoff: "2026-10-12T17:00:00.000Z" }, target.id)], CAPTURE_B);
    expect(bundle(dataset).scheduledRestHours).toBe(168);
    const later = buildPassingYardsBundle(dataset, request(CUTOFF_B));
    expect(later.target!.gameId).toBe(TARGET); expect(later.scheduledRestHours).toBe(192);
  });
  it("refuses ambiguous raw event bridges", () => {
    const dataset = passingYardsFixture(false); const target = row(dataset, "schedule-synthetic-game-10") as Revision<"schedule">;
    addCapture(dataset, "duplicate-game-alias", [revision("duplicate-game-alias", "schedule", { ...target.data, gameId: gameId(99) })]);
    unavailable(dataset, "target-schedule-ambiguous");
  });
  it("withholds enriched context without automatically falling back to stats-only", () => {
    const dataset = passingYardsFixture(false); omit(dataset, "against-synthetic-game-23");
    unavailable(dataset, "opponent-history-incomplete");
    const reduced = buildPassingYardsBundle(dataset, { ...request(), candidate: "stats-v1:player_pass_yds" });
    expect(reduced.status).toBe("ready-inputs"); expect(reduced.team).toBeNull(); expect(reduced.opponent).toBeNull();
    expect(reduced.dependencies.some((value) => value.kind === "team-game-stats")).toBe(false);
  });
  it("refuses mismatched raw stats identity and impossible paired attempt counts", () => {
    const dataset = passingYardsFixture(false); playerChanges(dataset, "player-synthetic-game-5", { rawGameId: "wrong-game" });
    expect(unavailable(dataset, "player-history-incomplete").player[0].exclusions[0].reason).toBe("stat-identity-mismatch");
    playerChanges(dataset, "player-synthetic-game-5", { rawGameId: "synthetic-game-5", attempts: 46 });
    expect(unavailable(dataset, "player-history-incomplete").player[0].exclusions[0].reason).toBe("player-team-count-conflict");
  });
  it("keeps schedule-order conflicts unavailable instead of picking a UUID order", () => {
    const dataset = passingYardsFixture(false); playerChanges(dataset, "schedule-synthetic-game-4", { kickoff: "2026-10-04T17:00:00.000Z" });
    unavailable(dataset, "player-game-order-ambiguous");
  });
  it("requires a pregame target and does not treat target completion markers as a prior input", () => {
    const dataset = passingYardsFixture(false); playerChanges(dataset, "schedule-synthetic-game-10", { kickoff: CUTOFF_A });
    unavailable(dataset, "target-not-pregame");
    playerChanges(dataset, "schedule-synthetic-game-10", { kickoff: "2026-10-11T17:00:00.000Z" });
    addCapture(dataset, "target-complete", completionMarkers(game(10)));
    unavailable(dataset, "target-started-or-completed");
  });
});

describe("strict source, rights and correction contracts", () => {
  it.each(Object.keys(RAW_ALLOWLISTS) as (keyof typeof RAW_ALLOWLISTS)[])("executes %s raw allowlist and refuses forbidden, duplicate, or missing fields", (feed) => {
    const allowed = [...RAW_ALLOWLISTS[feed]];
    expect(() => validateRawHeader(feed, allowed, [allowed[0]])).not.toThrow();
    for (const forbidden of ["spread_line", "total_line", "fantasy_points", "weather", "target_share", "height", "weight"]) {
      expect(() => validateRawHeader(feed, [...allowed, forbidden], [allowed[0]])).toThrow("raw-header-refused");
    }
    expect(() => validateRawHeader(feed, [...allowed, allowed[0]], [])).toThrow("raw-header-refused");
    expect(() => validateRawHeader(feed, allowed.slice(1), [allowed[0]])).toThrow("raw-header-refused");
  });
  it("verifies bytes before replay and refuses unregistered profiles or extra payload fields", () => {
    const dataset = passingYardsFixture(false); dataset.artifacts[0].bytes += " ";
    expect(() => bundle(dataset)).toThrow("artifact-integrity-failed");
    dataset.artifacts[0].sha256 = digest(dataset.artifacts[0].bytes);
    Object.assign(dataset.artifacts[0], { profileId: "unregistered-profile" }); expect(() => bundle(dataset)).toThrow("profile-missing");
    Object.assign(dataset.artifacts[0], { profileId: PROFILE });
    playerChanges(dataset, "player-synthetic-game-5", { fantasy_points: 20 }); expect(() => bundle(dataset)).toThrow("schema-fields-refused");
  });
  it.each([{ attempts: -1 }, { attempts: 1.2 }, { passingYards: "0" }, { passingYards: null }, { completions: 41 },
    { missing: { attempts: "source-blank" } }])("refuses malformed numeric, missing or inconsistent values %j", (values) => {
    const dataset = passingYardsFixture(false); playerChanges(dataset, "player-synthetic-game-5", values);
    expect(() => bundle(dataset)).toThrow();
  });
  it("refuses unknown GSIS and team identities", () => {
    const dataset = passingYardsFixture(false);
    expect(() => buildPassingYardsBundle(dataset, { ...request(), playerId: "player-name" })).toThrow("invalid-player-identity");
    playerChanges(dataset, "member-synthetic-game-10", { teamId: "nfl:team:unknown" }); expect(() => bundle(dataset)).toThrow("invalid-team-identity");
    playerChanges(dataset, "member-synthetic-game-10", { teamId: "nfl:team:LAR" }); expect(() => bundle(dataset)).toThrow("invalid-team-identity");
  });
  it("validates Eastern schedule strings against the stored kickoff instant", () => {
    const dataset = passingYardsFixture(false);
    playerChanges(dataset, "schedule-synthetic-game-10", { rawGameday: "2026-10-11", rawGametime: "13:00" });
    expect(bundle(dataset).status).toBe("ready-inputs");
    playerChanges(dataset, "schedule-synthetic-game-10", { rawGametime: "13:05" }); expect(() => bundle(dataset)).toThrow("source-kickoff-refused");
    playerChanges(dataset, "schedule-synthetic-game-10", { rawGametime: null }); expect(() => bundle(dataset)).toThrow("source-kickoff-refused");
  });
  it("refuses changed observation IDs, missing predecessors and backward corrections", () => {
    const dataset = passingYardsFixture();
    edit(dataset, "player-correction-B", (value) => { value.id = "player-synthetic-game-5"; });
    expect(bundle(dataset)).toEqual(bundle());
    expect(() => validateDataset(dataset)).toThrow("observation-id-conflict");
    expect(() => buildPassingYardsBundle(dataset, request(CUTOFF_B))).toThrow("observation-id-conflict");
    const missing = passingYardsFixture(); edit(missing, "player-correction-B", (value) => { value.predecessorId = "missing"; });
    expect(bundle(missing)).toEqual(bundle());
    expect(() => validateDataset(missing)).toThrow("invalid-correction-lineage");
    expect(() => buildPassingYardsBundle(missing, request(CUTOFF_B))).toThrow("invalid-correction-lineage");
    const backward = passingYardsFixture(); const capture = backward.captures.find((value) => value.artifactId === "B-player")!;
    capture.capturedAt = capture.availableAt = capture.ingestedAt = "2026-10-06T12:00:00.000Z";
    expect(() => bundle(backward)).toThrow("invalid-correction-lineage");
  });
  it("refuses correction cycles and branching chains instead of choosing a head", () => {
    const dataset = passingYardsFixture(false);
    edit(dataset, "player-synthetic-game-5", (value) => { value.predecessorId = "player-synthetic-game-5"; value.correctionReason = "cycle"; });
    expect(() => bundle(dataset)).toThrow("cyclic-correction-lineage");
    const branch = passingYardsFixture(); const original = row(branch, "player-synthetic-game-5") as Revision<"player-game-stats">;
    addCapture(branch, "branch", [revision("branch-player", "player-game-stats", { ...original.data, passingYards: 310 }, original.id)], CAPTURE_B);
    expect(bundle(branch)).toEqual(bundle());
    expect(() => buildPassingYardsBundle(branch, request(CUTOFF_B))).toThrow("correction-branch-refused");
  });
  it("keeps two providers' claims as separate chains: disagreement is ambiguous and never a correction", () => {
    const second = "synthetic-second-v1";
    const dataset = passingYardsFixture(false); dataset.profiles.push(profile(second)); dataset.rightsDecisions.push(rights(second));
    const original = row(dataset, "player-synthetic-game-5") as Revision<"player-game-stats">;
    addCapture(dataset, "second-source", [revision("second-player-5", "player-game-stats", { ...original.data, passingYards: 305 })], CAPTURE_A, second);
    const result = unavailable(dataset, "player-history-incomplete");
    expect(result.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "player-stats-ambiguous" });
    const crossed = passingYardsFixture(false); crossed.profiles.push(profile(second)); crossed.rightsDecisions.push(rights(second));
    addCapture(crossed, "crossed", [revision("crossed-player-5", "player-game-stats", { ...original.data, passingYards: 305 }, original.id)], CAPTURE_B, second);
    expect(() => buildPassingYardsBundle(crossed, request(CUTOFF_B))).toThrow("invalid-correction-lineage");
  });
  it("authorizes publication only with rights known when the bytes were captured", () => {
    const none = passingYardsFixture(false); none.rightsDecisions = [];
    expect(() => validateDataset(none)).toThrow("rights-not-in-force");
    const backdated = passingYardsFixture(false); backdated.rightsDecisions = [rights(PROFILE, { decidedAt: CAPTURE_B })];
    expect(() => validateDataset(backdated)).toThrow("rights-not-in-force");
    const trial = passingYardsFixture(false); trial.rightsDecisions = [rights(PROFILE, { allowedUses: ["adapter-testing"] })];
    expect(() => validateDataset(trial)).toThrow("rights-not-in-force");
  });
  it("blocks current use after a later revocation without rewriting the historical authorization", () => {
    const dataset = passingYardsFixture(false);
    dataset.rightsDecisions.push(rights(PROFILE, { id: "revoked", predecessorId: "rights-" + PROFILE, allowedUses: [],
      effectiveFrom: "2026-10-09T12:00:00.000Z", decidedAt: "2026-10-09T12:00:00.000Z", evidenceKind: "synthetic" }));
    expect(() => validateDataset(dataset)).not.toThrow();
    expect(bundle(dataset).status).toBe("ready-inputs");
    const now = buildPassingYardsBundle(dataset, { ...request(), computedAt: "2026-10-10T00:00:00.000Z" });
    expect(now.status).toBe("unavailable-inputs"); expect(now.reasons).toContain("rights-not-in-force");
  });
  it("refuses branching, cross-profile and out-of-order rights chains", () => {
    const branch = passingYardsFixture(false);
    branch.rightsDecisions.push(rights(PROFILE, { id: "a", predecessorId: "rights-" + PROFILE }), rights(PROFILE, { id: "b", predecessorId: "rights-" + PROFILE }));
    expect(() => validateDataset(branch)).toThrow("rights-chain-branch-refused");
    const crossed = passingYardsFixture(false); crossed.profiles.push(profile("synthetic-second-v1"));
    crossed.rightsDecisions.push(rights("synthetic-second-v1", { id: "other", predecessorId: "rights-" + PROFILE }));
    expect(() => validateDataset(crossed)).toThrow("rights-predecessor-profile-refused");
    const order = passingYardsFixture(false);
    order.rightsDecisions.push(rights(PROFILE, { id: "earlier", predecessorId: "rights-" + PROFILE, decidedAt: "2025-01-01T00:00:00.000Z" }));
    expect(() => validateDataset(order)).toThrow("rights-decision-order-refused");
  });
  it("never lets a synthetic profile claim public display or a real profile claim synthetic evidence", () => {
    const display = passingYardsFixture(false); display.rightsDecisions = [rights(PROFILE, { allowedUses: ["internal-research", "public-display"] })];
    expect(() => validateDataset(display)).toThrow("synthetic-rights-refused");
    const real = passingYardsFixture(false); real.profiles = [{ ...profile(), purpose: "source" }];
    expect(() => validateDataset(real)).toThrow("synthetic-rights-refused");
  });
  it("keeps later membership correction from resolving earlier ambiguity", () => {
    const dataset = passingYardsFixture(false); const original = row(dataset, "member-synthetic-game-10") as Revision<"membership">;
    addCapture(dataset, "identity-B", [revision("member-B", "membership", { ...original.data, teamId: OPPONENT, rawTeam: "DAL" }, original.id)], CAPTURE_B);
    expect(bundle(dataset).teamId).toBe(TEAM);
    expect(buildPassingYardsBundle(dataset, request(CUTOFF_B)).teamId).toBe(OPPONENT);
  });
  it("refuses invalid timestamps, inconsistent publication/capture identity, incomplete publication and oversized artifacts", () => {
    for (const date of ["2026-10-08", "2026-02-30T00:00:00.000Z", "2026-10-08T12:00:00Z"]) expect(() => instant(date)).toThrow("invalid-utc-instant");
    const dataset = passingYardsFixture(false); dataset.captures[0].publishedAt = CAPTURE_B; dataset.captures[0].publicationEvidence = "synthetic";
    expect(() => validateDataset(dataset)).toThrow("publication-time-refused");
    dataset.captures[0].publishedAt = null; dataset.captures[0].publicationEvidence = null;
    dataset.captures.push({ ...dataset.captures[0], ingestedAt: CAPTURE_B }); expect(() => validateDataset(dataset)).toThrow("capture-id-conflict");
    dataset.captures.pop(); dataset.captures[0].parserSucceeded = false; expect(() => validateDataset(dataset)).toThrow("incomplete-capture-published");
    dataset.captures[0].parserSucceeded = true; dataset.captures[0].parsedRows += 1; expect(() => validateDataset(dataset)).toThrow("capture-row-count-mismatch");
    dataset.captures[0].parsedRows -= 1;
    dataset.artifacts[0].bytes = " ".repeat(1_000_001); dataset.artifacts[0].sha256 = digest(dataset.artifacts[0].bytes);
    expect(() => validateDataset(dataset)).toThrow("artifact-integrity-failed");
  });
  it("refuses evidence kinds outside the artifact profile's registration", () => {
    const dataset = passingYardsFixture(false); dataset.profiles.push({ ...profile("synthetic-schedule-v1"), evidenceKinds: ["schedule"] });
    dataset.rightsDecisions.push(rights("synthetic-schedule-v1"));
    dataset.artifacts.push(artifact("bad-kind", [row(dataset, "member-synthetic-game-10")], "synthetic-schedule-v1"));
    expect(() => validateDataset(dataset)).toThrow("artifact-kind-not-in-profile");
    expect(bundle(dataset)).toEqual(bundle());
    dataset.captures.push({ ...dataset.captures[0], id: "bad-kind-capture", artifactId: "bad-kind", parsedRows: 1 });
    expect(() => createReplay(dataset, CUTOFF_A, request().computedAt)).toThrow("artifact-kind-not-in-profile");
  });
});

describe("feature-review regressions", () => {
  const formerTeamGapFixture = () => {
    const dataset = passingYardsFixture(false);
    const former = schedule(40, "2025-12-07T17:00:00.000Z", "nfl:team:BUF", "nfl:team:NE", 2025);
    const missing = schedule(41, "2025-12-14T17:00:00.000Z", former.homeTeamId, former.awayTeamId, 2025);
    addCapture(dataset, "former-schedules", [revision("former-game", "schedule", former), revision("former-gap", "schedule", missing)]);
    const member = revision("former-member", "membership", membership(former, { teamId: former.homeTeamId, rawTeam: "BUF",
      effectiveFrom: "2025-09-01T00:00:00.000Z", effectiveTo: "2025-12-31T00:00:00.000Z" }));
    addCapture(dataset, member.id, [member]);
    addCapture(dataset, "former-completion", completionMarkers(former));
    addCapture(dataset, "former-player", [revision("former-player", "player-game-stats", playerStats(former, 10, 60, former.homeTeamId, "BUF"))]);
    addCapture(dataset, "former-team", [revision("former-team", "team-game-stats", teamStats(former, former.homeTeamId, "BUF", 10, 60))]);
    addCapture(dataset, "former-coverage", [revision("former-coverage", "schedule-coverage", coverage(former.homeTeamId, [gameId(20), former.gameId, missing.gameId]))]);
    return { dataset, former, missing, member };
  };
  it.each(["stats-v1:player_pass_yds", "player-opponent-v1:player_pass_yds"] as const)("keeps a former-team membership gap in the %s window", (candidate) => {
    const { dataset, former, missing, member } = formerTeamGapFixture();
    const result = buildPassingYardsBundle(dataset, { ...request(), candidate });
    expect(result.scheduleCoverage.state).toBe("complete");
    expect(result.status).toBe("unavailable-inputs"); expect(result.reasons).toContain("player-history-incomplete");
    expect(result.player[1]).toMatchObject({ gameIds: [...PRIOR].reverse().concat(missing.gameId, former.gameId),
      expectedGames: 7, observedGames: 6, unknownGames: 1, attemptsSum: 120, passingYardsSum: 810,
      exclusions: [{ gameId: missing.gameId, reason: "membership-missing" }] });
    expect(result.player[0]).toMatchObject({ observedGames: 4, passingYardsSum: 700, attemptsSum: 100 });
    expect(result.dependencies.map((item) => item.observationId)).toEqual(expect.arrayContaining([member.id, "former-game", "former-gap", "former-coverage"]));
  });
  it.each([
    ["2025-08-31T23:59:59.999Z", false],
    ["2025-09-01T00:00:00.000Z", true],
    ["2025-12-30T23:59:59.999Z", true],
    ["2025-12-31T00:00:00.000Z", false],
    ["2025-12-31T00:00:00.001Z", false],
  ] as const)("uses inclusive-start/exclusive-end former-team ranges at %s", (kickoff, expected) => {
    const { dataset, missing } = formerTeamGapFixture(); playerChanges(dataset, "former-gap", { kickoff });
    const result = buildPassingYardsBundle(dataset, { ...request(), candidate: "stats-v1:player_pass_yds" });
    expect(result.status).toBe(expected ? "unavailable-inputs" : "ready-inputs");
    expect(result.player[1].gameIds.includes(missing.gameId)).toBe(expected);
    // BUF faced the enriched opponent in 2026, outside this membership range.
    expect(result.player[1].gameIds).not.toContain(gameId(20));
  });
  it("uses a former-team range only to retain a gap, never as per-game membership or participation", () => {
    const { dataset, missing, member } = formerTeamGapFixture();
    addCapture(dataset, "missing-member", [revision("missing-member", "membership", { ...member.data, gameId: missing.gameId })]);
    addCapture(dataset, "missing-completion", completionMarkers(missing));
    addCapture(dataset, "missing-player", [revision("missing-player", "player-game-stats", playerStats(missing, 0, 0, missing.homeTeamId, "BUF"))]);
    const result = buildPassingYardsBundle(dataset, { ...request(), candidate: "stats-v1:player_pass_yds" });
    expect(result.status).toBe("unavailable-inputs");
    expect(result.player[1].exclusions).toContainEqual({ gameId: missing.gameId, reason: "participation-unresolved" });
  });
  it("uses a corrected former-team range only at the later cutoff", () => {
    const { dataset, member, missing } = formerTeamGapFixture();
    const query = { ...request(), candidate: "stats-v1:player_pass_yds" as const };
    const before = buildPassingYardsBundle(dataset, query);
    expect(before.status).toBe("unavailable-inputs"); expect(before.player[1].gameIds).toContain(missing.gameId);
    addCapture(dataset, "former-member-B", [revision("former-member-B", "membership", {
      ...member.data, effectiveTo: "2025-12-10T00:00:00.000Z",
    }, member.id)], CAPTURE_B);
    expect(buildPassingYardsBundle(dataset, query)).toEqual(before);
    const after = buildPassingYardsBundle(dataset, { ...query, cutoff: CUTOFF_B });
    expect(after.status).toBe("ready-inputs"); expect(after.player[1].gameIds).not.toContain(missing.gameId);
  });
  it("does not let a late former-team membership invent gaps at the earlier cutoff", () => {
    const { dataset, missing, member } = formerTeamGapFixture();
    dataset.captures.find((capture) => capture.artifactId === member.id)!.ingestedAt = CAPTURE_B;
    const query = { ...request(), candidate: "stats-v1:player_pass_yds" as const };
    const before = buildPassingYardsBundle(dataset, query);
    expect(before.status).toBe("ready-inputs"); expect(before.player[1].gameIds).toEqual([...PRIOR].reverse());
    const after = buildPassingYardsBundle(dataset, { ...query, cutoff: CUTOFF_B });
    expect(after.status).toBe("unavailable-inputs");
    expect(after.player[1].exclusions).toContainEqual({ gameId: missing.gameId, reason: "membership-missing" });
  });
  it("keeps conflicting former-team ranges unavailable and retains their gap evidence", () => {
    const { dataset, missing, member } = formerTeamGapFixture();
    addCapture(dataset, "former-member-conflict", [revision("former-member-conflict", "membership", {
      ...member.data, effectiveTo: "2025-12-10T00:00:00.000Z",
    })]);
    const result = buildPassingYardsBundle(dataset, { ...request(), candidate: "stats-v1:player_pass_yds" });
    expect(result.status).toBe("unavailable-inputs");
    expect(result.player[1].exclusions).toEqual(expect.arrayContaining([
      { gameId: member.data.gameId, reason: "membership-ambiguous" }, { gameId: missing.gameId, reason: "membership-missing" },
    ]));
    expect(result.dependencies.map((item) => item.observationId)).toContain("former-member-conflict");
  });
  const addExpectedGame = (dataset: Dataset, team: string, id: string) => {
    const prior = row(dataset, "coverage-" + team) as Revision<"schedule-coverage">;
    addCapture(dataset, "coverage-added-" + team, [revision("coverage-added-" + team, "schedule-coverage", {
      ...prior.data, gameIds: [...prior.data.gameIds, id].sort(),
    }, prior.id)]);
  };
  it.each(["schema", "digest", "lineage", "id-conflict", "cycle"])("keeps an earlier replay unchanged by a future %s defect while rejecting it at ingestion", (defect) => {
    const dataset = passingYardsFixture();
    if (defect === "schema") playerChanges(dataset, "player-correction-B", { extra: 1 });
    if (defect === "digest") dataset.artifacts.find((value) => value.id === "B-player")!.bytes += " ";
    if (defect === "lineage") edit(dataset, "player-correction-B", (value) => { value.predecessorId = "missing"; });
    if (defect === "id-conflict") edit(dataset, "player-correction-B", (value) => { value.id = "player-synthetic-game-5"; });
    if (defect === "cycle") edit(dataset, "player-correction-B", (value) => { value.predecessorId = value.id; });
    expect(bundle(dataset)).toEqual(bundle());
    expect(() => validateDataset(dataset)).toThrow();
    expect(() => buildPassingYardsBundle(dataset, request(CUTOFF_B))).toThrow();
  });
  it("ignores malformed incomplete diagnostic artifacts even after their timestamps are cutoff-known", () => {
    const dataset = passingYardsFixture();
    playerChanges(dataset, "player-correction-B", { forbidden: "diagnostic" });
    for (const capture of dataset.captures.filter((value) => value.artifactId.startsWith("B-"))) capture.state = "incomplete";
    const expected = buildPassingYardsBundle(passingYardsFixture(false), request(CUTOFF_B));
    expect(buildPassingYardsBundle(dataset, request(CUTOFF_B))).toEqual(expected);
  });
  it("applies byte/capture bounds to the visible replay rather than the later repository", () => {
    const dataset = passingYardsFixture(false);
    for (let i = 0; i < 260; i++) {
      addCapture(dataset, "future-" + i, [revision("future-" + i, "event-state-marker", { gameId: gameId(90), markerType: "suspension-notice", markerValue: "notice-" + i, terminalPlayTimeOfDay: null }, i ? "future-" + (i - 1) : null)], CAPTURE_B);
    }
    expect(bundle(dataset)).toEqual(bundle());
    expect(() => validateDataset(dataset)).toThrow("dataset-bounds-refused");
  });
  it("leaves values, dependencies, exclusions and digest unchanged by unrelated schedules and corrections", () => {
    const dataset = passingYardsFixture(false); const expected = bundle(dataset);
    const other = schedule(77, "2026-09-14T00:15:00.000Z", "nfl:team:SEA", "nfl:team:ARI");
    addCapture(dataset, "unrelated", [revision("unrelated", "schedule", other)]);
    expect(bundle(dataset)).toEqual(expected);
    addCapture(dataset, "unrelated-correction", [revision("unrelated-correction", "schedule", { ...other, kickoff: "2026-09-14T00:20:00.000Z" }, "unrelated")]);
    expect(bundle(dataset)).toEqual(expected);
    addCapture(dataset, "unrelated-conflict", [revision("unrelated-conflict", "schedule", other)]);
    expect(bundle(dataset)).toEqual(expected);
  });
  it("measures POST target rest from the preceding REG game and keeps history windows separate", () => {
    const dataset = passingYardsFixture(false);
    playerChanges(dataset, "schedule-synthetic-game-10", { seasonType: "POST" });
    addCapture(dataset, "old-playoff-complete", completionMarkers(schedule(30, "2026-01-11T17:00:00.000Z", TEAM, OPPONENT, 2025, "POST")));
    const result = bundle(dataset);
    expect(result.scheduledRestHours).toBe(168);
    expect(result.player[0].gameIds).toEqual([gameId(30)]);
    expect(result.dependencies.some((value) => value.observationId === "schedule-synthetic-game-5")).toBe(true);
  });
  it("withholds tied previous rest games across season types instead of choosing by UUID", () => {
    const dataset = passingYardsFixture(false);
    playerChanges(dataset, "schedule-synthetic-game-30", { kickoff: "2026-10-04T17:00:00.000Z" });
    const result = unavailable(dataset, "scheduled-rest-order-ambiguous");
    expect(result.scheduledRestHours).toBeNull();
  });
  it("does not use confirmed absence to resolve an ambiguous chronological order", () => {
    const dataset = passingYardsFixture(false);
    playerChanges(dataset, "schedule-synthetic-game-4", { kickoff: "2026-10-04T17:00:00.000Z" });
    markOut(dataset, 4);
    unavailable(dataset, "player-game-order-ambiguous");
  });
  it.each(["stats-v1:player_pass_yds", "player-opponent-v1:player_pass_yds"] as const)("withholds %s for an intervening team game without inferring future participation", (candidate) => {
    const dataset = passingYardsFixture(false);
    const upcoming = schedule(11, "2026-10-09T00:15:00.000Z", OPPONENT, TEAM);
    addCapture(dataset, "upcoming", [revision("upcoming", "schedule", upcoming)]);
    for (const team of [TEAM, OPPONENT]) addExpectedGame(dataset, team, upcoming.gameId);
    const result = buildPassingYardsBundle(dataset, { ...request(), candidate });
    expect(result.scheduleCoverage.state).toBe("complete");
    expect(result.status).toBe("unavailable-inputs"); expect(result.reasons).toContain("intervening-team-game");
    expect(result.scheduledRestHours).toBeNull();
    expect(result.excludedSchedule).toContainEqual({ gameId: upcoming.gameId, reason: "intervening-game" });
    expect(result.availability.participation).toBe("future-unknown");
  });
  it("permits the intervening game only after its required evidence arrives and measures 64.75 scheduled rest hours", () => {
    const dataset = passingYardsFixture(false); const upcoming = schedule(11, "2026-10-09T00:15:00.000Z");
    addCapture(dataset, "upcoming", [revision("upcoming", "schedule", upcoming)]);
    addExpectedGame(dataset, TEAM, upcoming.gameId);
    expect(unavailable(dataset, "intervening-team-game").scheduledRestHours).toBeNull();
    const at = "2026-10-09T04:00:00.000Z";
    addCapture(dataset, "upcoming-member", [revision("upcoming-member", "membership", membership(upcoming))], at);
    addCapture(dataset, "upcoming-complete", completionMarkers(upcoming, at), at);
    addCapture(dataset, "upcoming-player", [revision("upcoming-player", "player-game-stats", playerStats(upcoming, 20, 120))], at);
    addCapture(dataset, "upcoming-team", [revision("upcoming-team", "team-game-stats", teamStats(upcoming, TEAM, "PHI", 20, 120))], at);
    const result = buildPassingYardsBundle(dataset, { ...request("2026-10-09T05:00:00.000Z"), computedAt: "2026-10-10T00:00:00.000Z" });
    expect(result.status).toBe("ready-inputs"); expect(result.scheduledRestHours).toBe(64.75);
    expect(result.player[0].gameIds[0]).toBe(upcoming.gameId);
  });
  it("withholds an intervening opponent game in the enriched candidate", () => {
    const dataset = passingYardsFixture(false); const upcoming = schedule(11, "2026-10-09T00:15:00.000Z", OPPONENT, "nfl:team:SEA");
    addCapture(dataset, "upcoming", [revision("upcoming", "schedule", upcoming)]); addExpectedGame(dataset, OPPONENT, upcoming.gameId);
    unavailable(dataset, "intervening-opponent-game");
    const reduced = buildPassingYardsBundle(dataset, { ...request(), candidate: "stats-v1:player_pass_yds" });
    expect(reduced.status).toBe("ready-inputs");
  });
  it("keeps the newest missing schedule as unavailable instead of shifting either history or rest", () => {
    const dataset = passingYardsFixture(false); omit(dataset, "schedule-synthetic-game-5");
    const result = unavailable(dataset, "schedule-row-missing");
    expect(result.scheduleCoverage).toEqual({ state: "unverified", missingGameIds: [PRIOR[4]] });
    expect(result.player).toEqual([]); expect(result.scheduledRestHours).toBeNull();
  });
  it("detects an omitted whole game from independent coverage even when all its other records are absent", () => {
    const dataset = passingYardsFixture(false);
    for (const prefix of ["schedule", "member", "final", "terminal", "player", "team"]) omit(dataset, prefix + "-synthetic-game-5");
    expect(unavailable(dataset, "schedule-row-missing").scheduleCoverage.missingGameIds).toEqual([PRIOR[4]]);
  });
  it.each(["missing", "incomplete", "late", "ambiguous"])("requires explicit %s schedule coverage rather than guessing from week numbers", (state) => {
    const dataset = passingYardsFixture(false);
    const original = row(dataset, "coverage-" + TEAM) as Revision<"schedule-coverage">;
    if (state === "missing") omit(dataset, original.id);
    if (state === "incomplete") playerChanges(dataset, original.id, { state: "incomplete" });
    if (state === "late") dataset.captures.find((value) => value.artifactId === "A-schedule-coverage")!.ingestedAt = CAPTURE_B;
    if (state === "ambiguous") addCapture(dataset, "coverage-conflict", [revision("coverage-conflict", "schedule-coverage", original.data)]);
    const reason = state === "late" ? "schedule-coverage-missing" : "schedule-coverage-" + state;
    expect(unavailable(dataset, reason).player).toEqual([]);
  });
  it("accepts an explicit complete schedule with a bye without demanding consecutive week numbers", () => {
    const dataset = passingYardsFixture(false);
    playerChanges(dataset, "schedule-synthetic-game-5", { week: 6 }); playerChanges(dataset, "schedule-synthetic-game-10", { week: 7 });
    expect(bundle(dataset).status).toBe("ready-inputs");
  });
  it("refuses coverage that omits a known team game or references a different team's game", () => {
    const dataset = passingYardsFixture(false);
    const original = row(dataset, "coverage-" + TEAM) as Revision<"schedule-coverage">;
    playerChanges(dataset, original.id, { gameIds: original.data.gameIds.filter((id) => id !== PRIOR[4]) });
    unavailable(dataset, "schedule-coverage-mismatch");
    playerChanges(dataset, original.id, { gameIds: [...original.data.gameIds, gameId(20)] });
    unavailable(dataset, "schedule-coverage-mismatch");
  });
  it("binds the evidence that causes a missing former-team scope or coverage conflict", () => {
    const dataset = passingYardsFixture(false); const former = schedule(40, "2026-10-05T17:00:00.000Z", "nfl:team:BUF", "nfl:team:NE");
    addCapture(dataset, "former-game", [revision("former-game", "schedule", former)]);
    addCapture(dataset, "former-member", [revision("former-member", "membership", membership(former, { teamId: former.homeTeamId, rawTeam: "BUF" }))]);
    const result = unavailable(dataset, "schedule-coverage-missing");
    expect(result.dependencies.map((item) => item.observationId)).toEqual(expect.arrayContaining(["former-member", "former-game"]));
    const conflict = passingYardsFixture(false); const coverageRow = row(conflict, "coverage-" + TEAM) as Revision<"schedule-coverage">;
    playerChanges(conflict, coverageRow.id, { gameIds: coverageRow.data.gameIds.filter((id) => id !== PRIOR[4]) });
    expect(unavailable(conflict, "schedule-coverage-mismatch").dependencies.map((item) => item.observationId)).toContain("schedule-synthetic-game-5");
  });
  it.each([{ fromSeason: 2023 }, { gameIds: [PRIOR[0], PRIOR[0]] }, { gameIds: ["unknown"] }])("validates coverage range and exact canonical IDs: %j", (values) => {
    const dataset = passingYardsFixture(false); playerChanges(dataset, "coverage-" + TEAM, values);
    expect(() => validateDataset(dataset)).toThrow();
  });
  it("does not let a later coverage correction introduce a gap at an earlier cutoff", () => {
    const dataset = passingYardsFixture(false); const original = row(dataset, "coverage-" + TEAM) as Revision<"schedule-coverage">;
    addCapture(dataset, "coverage-B", [revision("coverage-B", "schedule-coverage", { ...original.data, gameIds: [...original.data.gameIds, gameId(99)] }, original.id)], CAPTURE_B);
    expect(bundle(dataset)).toEqual(bundle());
    expect(buildPassingYardsBundle(dataset, request(CUTOFF_B)).reasons).toContain("schedule-row-missing");
  });
  it.each([1, 5])("retains confirmed absence in slot %d while allowing usable history and recording quality", (number) => {
    const dataset = passingYardsFixture(false); markOut(dataset, number);
    const result = bundle(dataset); expect(result.status).toBe("ready-inputs"); expect(result.quality).toContain("player-known-absences");
    expect(result.player[2]).toMatchObject({ expectedGames: 5, observedGames: 4, excludedGames: 1, unknownGames: 0 });
    expect(result.player[2].games.map((value) => value.gameId)).not.toContain(gameId(number));
    if (number === 5) {
      expect(result.player[0]).toMatchObject({ gameIds: [...PRIOR].reverse().slice(0, 4), observedGames: 3, attemptsSum: 60, passingYardsSum: 400, attemptsPerGame: 20 });
      expect(result.player[0].gameIds).not.toContain(PRIOR[0]);
    } else expect(result.player[0]).toMatchObject({ observedGames: 4, passingYardsSum: 700, attemptsSum: 100 });
  });
  it("withholds an all-absent window for its missing denominator, not for a known absence alone", () => {
    const dataset = passingYardsFixture(false); for (let i = 2; i <= 5; i++) markOut(dataset, i);
    const result = unavailable(dataset, "player-zero-or-missing-denominator");
    expect(result.reasons).not.toContain("player-history-incomplete");
    expect(result.player[0]).toMatchObject({ expectedGames: 4, observedGames: 0, excludedGames: 4, unknownGames: 0, passingYardsPerAttempt: null });
  });
});

describe("reconciliation-v1 cross-source decisions", () => {
  const second = "synthetic-second-v1";
  const fact = "player-game-stats:" + PRIOR[4] + ":" + PLAYER;
  const DECIDED = "2026-10-07T18:00:00.000Z";
  const twoSources = (passingYards: number) => {
    const dataset = passingYardsFixture(false); dataset.profiles.push(profile(second)); dataset.rightsDecisions.push(rights(second));
    const original = row(dataset, "player-synthetic-game-5") as Revision<"player-game-stats">;
    addCapture(dataset, "second-source", [revision("second-player-5", "player-game-stats", { ...original.data, passingYards })], CAPTURE_A, second);
    return dataset;
  };
  const heads = (dataset: Dataset, at = CUTOFF_A) => createReplay(dataset, at, request().computedAt).heads(fact);
  it("records disagreement as a conflict that keeps the fact unavailable", () => {
    const dataset = twoSources(305);
    const decision = reconcileFact("rec-conflict", fact, heads(dataset), DECIDED, "synthetic-proof");
    expect(decision.outcome).toEqual({ result: "conflict", selectedObservationId: null, rule: "material-discrepancy" });
    dataset.decisions.push(decision);
    const result = unavailable(dataset, "player-history-incomplete");
    expect(result.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "player-stats-ambiguous" });
    expect(result.reconciliations).toEqual([]);
  });
  it("selects agreeing providers deterministically and binds the decision into the bundle", () => {
    const dataset = twoSources(300);
    const decision = reconcileFact("rec-agree", fact, heads(dataset), DECIDED, "synthetic-proof");
    expect(decision.outcome).toEqual({ result: "selected", selectedObservationId: "player-synthetic-game-5", rule: "sources-agree" });
    expect(bundle(dataset).status).toBe("unavailable-inputs");
    dataset.decisions.push(decision);
    const result = bundle(dataset);
    expect(result.status).toBe("ready-inputs"); expect(result.player[0].passingYardsSum).toBe(700);
    expect(result.reconciliations).toEqual([{ decisionId: "rec-agree", entityKey: "reconciliation:" + fact, result: "selected", decidedAt: DECIDED }]);
    expect(result.dependencies.map((dep) => dep.observationId)).toEqual(expect.arrayContaining(["player-synthetic-game-5", "second-player-5"]));
  });
  it("refuses a reconciliation that omits a visible provider head", () => {
    const dataset = twoSources(300);
    dataset.decisions.push(reconcileFact("rec-partial", fact, heads(dataset).slice(0, 1), DECIDED, "synthetic-proof"));
    expect(() => bundle(dataset)).toThrow("reconciliation-inputs-not-heads");
  });
  it("applies a decision only from its decision time and only to the exact heads it judged", () => {
    const dataset = twoSources(300);
    dataset.decisions.push(reconcileFact("rec-late", fact, heads(dataset), CAPTURE_B, "synthetic-proof"));
    expect(unavailable(dataset, "player-history-incomplete").reconciliations).toEqual([]);
    expect(buildPassingYardsBundle(dataset, request(CUTOFF_B)).status).toBe("ready-inputs");
    const stale = twoSources(300);
    stale.decisions.push(reconcileFact("rec-stale", fact, heads(stale), DECIDED, "synthetic-proof"));
    const original = row(stale, "player-synthetic-game-5") as Revision<"player-game-stats">;
    addCapture(stale, "first-correction", [revision("first-correction", "player-game-stats", { ...original.data, passingYards: 300 }, original.id)], CAPTURE_B);
    expect(bundle(stale).status).toBe("ready-inputs");
    const later = buildPassingYardsBundle(stale, request(CUTOFF_B));
    expect(later.status).toBe("unavailable-inputs"); expect(later.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "player-stats-ambiguous" });
  });
  it.each([
    ["decision-input-after-decision", (decision: Reconciliation) => ({ ...decision, decidedAt: "2026-10-07T11:00:00.000Z" })],
    ["decision-entity-mismatch", (decision: Reconciliation) => ({ ...decision, inputs: [...decision.inputs.slice(0, 1), { observationId: "player-synthetic-game-4", role: "candidate" as const }] })],
    ["decision-mode-mismatch", (decision: Reconciliation) => ({ ...decision, mode: "production-research" as const })],
    ["decision-rule-mismatch", (decision: Reconciliation) => ({ ...decision, outcome: { result: "selected" as const, selectedObservationId: "second-player-5", rule: "sources-agree" as const },
      inputs: decision.inputs.map((input) => ({ ...input, role: input.observationId === "second-player-5" ? "selected" as const : "candidate" as const })) })],
    ["decision-input-missing", (decision: Reconciliation) => ({ ...decision, inputs: [...decision.inputs, { observationId: "unknown", role: "candidate" as const }] })],
  ] as const)("refuses a decision that misstates its evidence: %s", (code, change) => {
    const dataset = twoSources(305);
    dataset.decisions.push(change(reconcileFact("rec-bad", fact, heads(dataset), DECIDED, "synthetic-proof")));
    expect(() => bundle(dataset)).toThrow(code);
  });
  it("refuses branching decision chains for one fact", () => {
    const dataset = twoSources(305);
    const first = reconcileFact("rec-first", fact, heads(dataset), DECIDED, "synthetic-proof");
    dataset.decisions.push(first, { ...first, id: "rec-a", predecessorId: first.id }, { ...first, id: "rec-b", predecessorId: first.id });
    expect(() => bundle(dataset)).toThrow("decision-branch-refused");
  });
});

describe("absence-v1 coverage-aware disappearance", () => {
  const LATER = "2026-10-08T15:00:00.000Z";
  // The team-stats file is a season file, so a later complete season file can cover it.
  const scoped = (artifactId = "A-team-game-stats") => {
    const dataset = passingYardsFixture(false);
    Object.assign(dataset.artifacts.find((value) => value.id === artifactId)!, { scopeKind: "season-file", scopeSeason: 2026 });
    return dataset;
  };
  const disappear = (dataset: Dataset, options: { artifact?: Partial<Artifact>; capture?: Partial<Capture>; keepRow?: boolean; at?: string; ledgerAt?: string;
    sourceArtifact?: string; priorId?: string; fact?: string } = {}) => {
    const sourceArtifact = options.sourceArtifact ?? "A-team-game-stats"; const priorId = options.priorId ?? "team-synthetic-game-5";
    const at = options.at ?? CAPTURE_B;
    const kept = (JSON.parse(dataset.artifacts.find((value) => value.id === sourceArtifact)!.bytes) as Revision[]).filter((value) => options.keepRow || value.id !== priorId);
    const rows = options.artifact?.retrievalKind === "header-probe" ? [] : kept;
    addCapture(dataset, "covering-file", rows, at);
    const covering = dataset.artifacts.at(-1)!;
    Object.assign(covering, { scopeKind: "season-file", scopeSeason: 2026, ...options.artifact });
    Object.assign(dataset.captures.at(-1)!, options.capture);
    const prior = row(dataset, priorId) as Revision<"team-game-stats">;
    const routing = Object.fromEntries(["gameId", "playerId", "teamId", "season", "seasonType"].filter((field) => field in prior.data)
      .map((field) => [field, (prior.data as Record<string, unknown>)[field]]));
    const absence = revision("absent-" + priorId, "source-row-absent", { priorObservationId: prior.id,
      priorEntityKey: options.fact ?? "team-game-stats:" + PRIOR[4] + ":" + TEAM, coveringCaptureId: "capture-covering-file",
      scopeKind: covering.scopeKind, scopeSeason: covering.scopeSeason, scopeWeek: covering.scopeWeek, scopeGameId: covering.scopeGameId,
      scopeFilter: covering.scopeFilter, ...routing }, prior.id);
    addCapture(dataset, "absence-ledger", [absence], options.ledgerAt ?? at);
    return absence;
  };
  it("keeps earlier cutoffs unchanged and withholds a disappeared required input afterwards", () => {
    const dataset = scoped(); disappear(dataset);
    expect(bundle(dataset)).toEqual(bundle(scoped()));
    const later = buildPassingYardsBundle(dataset, request(CUTOFF_B));
    expect(later.status).toBe("unavailable-inputs");
    expect(later.reasons).toEqual(expect.arrayContaining(["required-input-disappeared", "team-history-incomplete"]));
    expect(later.team![0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "team-stats-absent" });
    expect(later.dependencies.map((dep) => dep.observationId)).toContain("absent-team-synthetic-game-5");
  });
  it("continues the same source chain when the row reappears in a later capture", () => {
    const dataset = scoped(); const absence = disappear(dataset);
    const prior = row(dataset, "team-synthetic-game-5") as Revision<"team-game-stats">;
    addCapture(dataset, "returned", [revision("team-5-returns", "team-game-stats", prior.data, absence.id)], LATER);
    expect(buildPassingYardsBundle(dataset, request(CUTOFF_B)).reasons).toContain("required-input-disappeared");
    const returned = buildPassingYardsBundle(dataset, request("2026-10-08T16:00:00.000Z"));
    expect(returned.status).toBe("ready-inputs"); expect(returned.team![0].passingYardsSum).toBe(869);
  });
  it("reports a disappeared player statistic as absent rather than as a participation gap", () => {
    const dataset = scoped("A-player-game-stats");
    disappear(dataset, { sourceArtifact: "A-player-game-stats", priorId: "player-synthetic-game-5", fact: "player-game-stats:" + PRIOR[4] + ":" + PLAYER });
    const result = buildPassingYardsBundle(dataset, request(CUTOFF_B));
    expect(result.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "player-stats-absent" });
    expect(result.reasons).toContain("required-input-disappeared");
  });
  it("requires game-scoped coverage to name the same game", () => {
    const matching = scoped();
    Object.assign(matching.artifacts.find((value) => value.id === "A-team-game-stats")!,
      { scopeKind: "game", scopeSeason: 2026, scopeGameId: PRIOR[4] });
    disappear(matching, { artifact: { scopeKind: "game", scopeSeason: 2026, scopeGameId: PRIOR[4] } });
    expect(() => validateDataset(matching)).not.toThrow();

    const different = scoped();
    Object.assign(different.artifacts.find((value) => value.id === "A-team-game-stats")!,
      { scopeKind: "game", scopeSeason: 2026, scopeGameId: PRIOR[4] });
    disappear(different, { artifact: { scopeKind: "game", scopeSeason: 2026, scopeGameId: PRIOR[3] } });
    expect(() => validateDataset(different)).toThrow("absence-coverage-refused");
  });
  it.each([
    ["an incomplete covering capture", { capture: { state: "incomplete" as const } }, "absence-coverage-refused"],
    ["a header-only probe", { artifact: { retrievalKind: "header-probe" as const } }, "absence-coverage-refused"],
    ["a changed filter", { artifact: { scopeFilter: "week=5" } }, "absence-coverage-refused"],
    ["a narrower week file", { artifact: { scopeKind: "week-file" as const, scopeWeek: 5 } }, "absence-coverage-refused"],
    ["a manual scope", { artifact: { scopeKind: "manual" as const, scopeSeason: null } }, "absence-coverage-refused"],
    ["a capture that still contains the row", { keepRow: true }, "absence-row-still-present"],
    ["an absence recorded before its covering capture", { ledgerAt: "2026-10-08T12:30:00.000Z" }, "absence-time-order-refused"],
  ] as const)("refuses an absence proven by %s", (_label, options, code) => {
    const dataset = scoped(); disappear(dataset, options);
    expect(() => validateDataset(dataset)).toThrow(code);
  });
  it.each([
    ["routing that differs from the prior row", { season: 2025 }, "absence-routing-mismatch"],
    ["a prior that is not its predecessor", { priorObservationId: "team-synthetic-game-4" }, "absence-prior-invalid"],
  ] as const)("refuses an absence with %s", (_label, change, code) => {
    const dataset = scoped(); const absence = disappear(dataset);
    playerChanges(dataset, absence.id, change);
    expect(() => validateDataset(dataset)).toThrow(code);
  });
});

describe("event-completion-v1 recorded decisions", () => {
  const headsAt = (dataset: Dataset, at: string) => markerHeadsAt(validateDataset(dataset).observations.values(), PRIOR[4], instant(at));
  const record = (dataset: Dataset, at = CAPTURE_A) => recordCompletion("completion-5", PRIOR[4], headsAt(dataset, at), at, "synthetic-proof");
  it("cites a record that judged exactly the current marker heads", () => {
    const dataset = passingYardsFixture(false); const recorded = record(dataset);
    expect(recorded.outcome).toEqual({ state: "completed", completionObservedAt: CAPTURE_A, actualEnd: null });
    expect(recorded.inputs.map((input) => input.observationId)).toEqual(["final-synthetic-game-5", "terminal-synthetic-game-5"]);
    dataset.decisions.push(recorded);
    const result = bundle(dataset);
    expect(result.status).toBe("ready-inputs");
    expect(result.completions).toEqual([{ decisionId: "completion-5", gameId: PRIOR[4], state: "completed", decidedAt: CAPTURE_A }]);
    expect(bundle(passingYardsFixture(false)).completions).toEqual([]);
  });
  it("stops citing a record once later markers change the heads it judged", () => {
    const dataset = passingYardsFixture(false); dataset.decisions.push(record(dataset));
    addCapture(dataset, "late-suspension", [revision("late-suspension", "event-state-marker", { gameId: PRIOR[4], markerType: "suspension-notice", markerValue: "notice", terminalPlayTimeOfDay: null })], CAPTURE_B);
    expect(bundle(dataset).completions).toHaveLength(1);
    const later = buildPassingYardsBundle(dataset, request(CUTOFF_B));
    expect(later.completions).toEqual([]);
    expect(later.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "completion-conflicting" });
  });
  it.each([
    ["completion-inputs-not-heads", (value: CompletionRecord) => ({ ...value, inputs: value.inputs.slice(0, 1) })],
    ["decision-rule-mismatch", (value: CompletionRecord) => ({ ...value, outcome: { state: "in-progress" as const, completionObservedAt: null, actualEnd: null } })],
    ["decision-rule-mismatch", (value: CompletionRecord) => ({ ...value, outcome: { ...value.outcome, completionObservedAt: "2026-10-07T11:00:00.000Z" } })],
    ["decision-mode-mismatch", (value: CompletionRecord) => ({ ...value, mode: "production-research" as const })],
  ] as const)("refuses a record that misstates its markers: %s", (code, change) => {
    const dataset = passingYardsFixture(false); dataset.decisions.push(change(record(dataset)));
    expect(() => bundle(dataset)).toThrow(code);
  });
  it("refuses a record decided before its markers were usable", () => {
    const dataset = passingYardsFixture(false);
    dataset.decisions.push({ ...record(dataset), decidedAt: "2026-10-07T11:00:00.000Z" });
    expect(() => bundle(dataset)).toThrow("completion-inputs-not-heads");
  });
  it("treats a disappeared marker as conflicting evidence", () => {
    const dataset = passingYardsFixture(false);
    Object.assign(dataset.artifacts.find((value) => value.id === "A-event-state-marker")!, { scopeKind: "season-file", scopeSeason: 2026 });
    const markers = (JSON.parse(dataset.artifacts.find((value) => value.id === "A-event-state-marker")!.bytes) as Revision[]).filter((value) => value.id !== "terminal-synthetic-game-5");
    addCapture(dataset, "marker-file", markers, CAPTURE_B);
    Object.assign(dataset.artifacts.at(-1)!, { scopeKind: "season-file", scopeSeason: 2026 });
    addCapture(dataset, "marker-absence", [revision("absent-terminal-5", "source-row-absent", { priorObservationId: "terminal-synthetic-game-5",
      priorEntityKey: "event-state-marker:" + PRIOR[4] + ":terminal-play", coveringCaptureId: "capture-marker-file", scopeKind: "season-file",
      scopeSeason: 2026, scopeWeek: null, scopeGameId: null, scopeFilter: null, gameId: PRIOR[4] }, "terminal-synthetic-game-5")], CAPTURE_B);
    const later = buildPassingYardsBundle(dataset, request(CUTOFF_B));
    expect(later.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "completion-conflicting" });
  });
});

describe("participation-v1 records and canonical outcome labels", () => {
  const T = instant(CAPTURE_A);
  const decided = (dataset: Dataset, at = CAPTURE_A, number = 5) => {
    const observations = validateDataset(dataset).observations; const t = instant(at); const game = gameId(number);
    const statsHeads = [...observations.values()].filter((value) => value.entityKey === "player-game-stats:" + game + ":" + PLAYER);
    return [
      recordCompletion("completion-" + number, game, markerHeadsAt(observations.values(), game, t), at, "synthetic-proof"),
      recordParticipation("participation-" + number, game, PLAYER, participationHeadsAt(observations.values(), game, PLAYER, t), at, "synthetic-proof"),
      reconcileFact("reconciliation-" + number, "player-game-stats:" + game + ":" + PLAYER, statsHeads, at, "synthetic-proof"),
    ];
  };
  const POST = "2026-10-10T13:00:00.000Z"; const FINAL = "2026-10-10T14:00:00.000Z";
  const provisional = (): Label => ({ id: "label-5-v1", playerId: PLAYER, gameId: PRIOR[4], seasonType: "REG", stat: "passing_yards", value: 300,
    state: "provisional", mode: "synthetic-proof", policyId: "canonical-label-finalization-v1", labelVersion: 1, predecessorId: null,
    completionDecisionId: "completion-5", participationDecisionId: "participation-5", reconciliationDecisionId: "reconciliation-5",
    selectedObservationId: "player-synthetic-game-5", eligibleFinalAt: null, postWindowCaptureId: null, finalizedAt: null, createdAt: "2026-10-07T13:00:00.000Z",
    playerBridgeObservationId: null });
  const final = (): Label => ({ ...provisional(), id: "label-5-v2", state: "final", labelVersion: 2, predecessorId: "label-5-v1",
    eligibleFinalAt: "2026-10-10T12:00:00.000Z", postWindowCaptureId: "capture-post-window", finalizedAt: FINAL, createdAt: FINAL,
    playerBridgeObservationId: "bridge-gsis" });
  // A GSIS-native roster bridge: raw ID = GSIS ID, linked to the stats profile.
  const bridge = (id: string, data: Partial<PlayerBridge> = {}, predecessor: string | null = null) => revision(id, "player-bridge",
    { provider: "gsis", rawPlayerId: PLAYER, playerId: PLAYER, effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z", ...data }, predecessor);
  const labelled = (post = POST) => {
    const dataset = passingYardsFixture(false); dataset.decisions.push(...decided(dataset));
    addCapture(dataset, "roster-bridges", [bridge("bridge-gsis")]);
    dataset.identityLinks.push({ id: "link-gsis", statsProfileId: PROFILE, bridgeProfileId: PROFILE, provider: "gsis", decidedAt: "2026-01-01T00:00:00.000Z" });
    // The post-window recapture reconfirms the same stats revision after the window.
    addCapture(dataset, "post-window", JSON.parse(dataset.artifacts.find((value) => value.id === "A-player-game-stats")!.bytes), post);
    return dataset;
  };
  const check = (dataset: Dataset, labels: Label[]) => {
    const validated = validateDataset(dataset);
    validateLabels(labels, { observations: validated.observations, decisions: new Map(dataset.decisions.map((value) => [value.id, value])),
      captures: new Map(dataset.captures.map((value) => [value.id, value])), artifactRevisions: validated.revisions, profiles: validated.profiles,
      identityLinks: validated.identityLinks });
  };
  it.each([
    ["2026-10-07T12:00:00.000Z", "2026-10-10T12:00:00.000Z"],
    ["2026-10-05T03:00:00.000Z", "2026-10-08T12:00:00.000Z"],
    ["2026-10-08T12:00:00.000Z", "2026-10-15T12:00:00.000Z"],
    ["2026-10-08T11:59:59.999Z", "2026-10-11T11:59:59.999Z"],
  ])("computes the operational-final time for a bound of %s", (bound, expected) => {
    expect(eligibleFinalAt(bound)).toBe(expected);
  });
  it("records participation from the current evidence and stats heads and cites it in the bundle", () => {
    const dataset = passingYardsFixture(false);
    const record = recordParticipation("participation-5", PRIOR[4], PLAYER, participationHeadsAt(validateDataset(dataset).observations.values(), PRIOR[4], PLAYER, T), CAPTURE_A, "synthetic-proof");
    expect(record.outcome).toEqual({ state: "offensive-participant" });
    dataset.decisions.push(record);
    expect(bundle(dataset).participations).toEqual([{ decisionId: "participation-5", gameId: PRIOR[4], state: "offensive-participant", decidedAt: CAPTURE_A }]);
  });
  it.each([
    ["participation-inputs-not-heads", (value: ParticipationRecord) => ({ ...value, inputs: [] })],
    ["decision-rule-mismatch", (value: ParticipationRecord) => ({ ...value, outcome: { state: "inactive-or-dnp" as const } })],
  ] as const)("refuses a participation record that misstates its evidence: %s", (code, change) => {
    const dataset = passingYardsFixture(false);
    const record = recordParticipation("participation-5", PRIOR[4], PLAYER, participationHeadsAt(validateDataset(dataset).observations.values(), PRIOR[4], PLAYER, T), CAPTURE_A, "synthetic-proof");
    dataset.decisions.push(change(record));
    expect(() => bundle(dataset)).toThrow(code);
  });
  it("accepts a provisional label and its final version bound to reconfirmed evidence", () => {
    expect(() => check(labelled(), [provisional(), final()])).not.toThrow();
  });
  it.each([
    [1, (dataset: Dataset, label: Label) => { dataset.decisions.push(...decided(dataset, CAPTURE_A, 4).slice(0, 1)); return { ...label, completionDecisionId: "completion-4" }; }],
    [2, (dataset: Dataset, label: Label) => { addCapture(dataset, "late-feed", [revision("late-feed", "participation-evidence",
      { gameId: PRIOR[4], playerId: PLAYER, teamId: TEAM, evidenceKind: "participation-feed", claim: "offensive-participant" })], "2026-10-07T12:30:00.000Z"); return label; }],
    [3, (dataset: Dataset, label: Label) => { dataset.decisions.push(...decided(dataset, CAPTURE_A, 4).slice(2)); return { ...label, reconciliationDecisionId: "reconciliation-4" }; }],
    [4, (_dataset: Dataset, label: Label) => ({ ...label, value: 301 })],
    [8, (_dataset: Dataset, label: Label) => ({ ...label, mode: "production-research" as const })],
  ] as const)("refuses a provisional label failing binding check %d", (number, change) => {
    const dataset = labelled(); const label = change(dataset, provisional());
    expect(() => check(dataset, [label])).toThrow("label-binding-" + number);
  });
  it.each([
    [5, () => labelled("2026-10-09T13:00:00.000Z"), (label: Label) => label],
    [5, () => labelled(), (label: Label) => ({ ...label, finalizedAt: "2026-10-10T11:00:00.000Z" })],
    [6, () => { const dataset = labelled(); dataset.captures.at(-1)!.ingestedAt = "2026-10-10T15:00:00.000Z"; return dataset; }, (label: Label) => label],
    [7, () => labelled(), (label: Label) => ({ ...label, labelVersion: 3 })],
    [7, () => labelled(), (label: Label) => ({ ...label, predecessorId: null })],
  ] as const)("refuses a final label failing binding check %d", (number, makeDataset, change) => {
    expect(() => check(makeDataset(), [provisional(), change(final())])).toThrow("label-binding-" + number);
  });
  it.each([
    ["no bridge on a final label", (dataset: Dataset, label: Label) => { void dataset; return { ...label, playerBridgeObservationId: null }; }],
    ["a bridge for another player", (dataset: Dataset, label: Label) => {
      addCapture(dataset, "other-bridge", [bridge("bridge-other", { rawPlayerId: "x-2", playerId: "00-0000002" })]); return { ...label, playerBridgeObservationId: "bridge-other" }; }],
    ["a bridge superseded before creation", (dataset: Dataset, label: Label) => {
      addCapture(dataset, "bridge-fix", [bridge("bridge-gsis-fix", { effectiveTo: "2027-06-01T00:00:00.000Z" }, "bridge-gsis")], "2026-10-09T00:00:00.000Z"); return label; }],
    ["a bridge whose window misses kickoff", (dataset: Dataset, label: Label) => {
      addCapture(dataset, "old-bridge", [bridge("bridge-old", { rawPlayerId: "old-id", effectiveFrom: "2025-01-01T00:00:00.000Z", effectiveTo: "2025-12-31T00:00:00.000Z" })]);
      return { ...label, playerBridgeObservationId: "bridge-old" }; }],
    ["a bridge namespace without an identity link", (dataset: Dataset, label: Label) => {
      addCapture(dataset, "unlinked", [bridge("bridge-unlinked", { provider: "other-ns" })]); return { ...label, playerBridgeObservationId: "bridge-unlinked" }; }],
    ["an identity link decided after creation", (dataset: Dataset, label: Label) => { dataset.identityLinks[0].decidedAt = "2026-10-11T00:00:00.000Z"; return label; }],
    ["another source mapping the same raw ID to a different player", (dataset: Dataset, label: Label) => {
      const other = "synthetic-roster-v1"; dataset.profiles.push(profile(other)); dataset.rightsDecisions.push(rights(other));
      addCapture(dataset, "rival-bridge", [bridge("bridge-rival", { playerId: "00-0000002" })], CAPTURE_A, other); return label; }],
  ] as const)("refuses a final label failing binding check 9: %s", (_label, change) => {
    const dataset = labelled(); const label = change(dataset, final());
    expect(() => check(dataset, [provisional(), label])).toThrow("label-binding-9");
  });
  it("labels a confirmed non-participant as excluded with no value, never as zero", () => {
    const dataset = passingYardsFixture(false); markOutForLabels(dataset);
    dataset.decisions.push(...decided(dataset).slice(0, 2));
    const excluded: Label = { ...provisional(), state: "excluded", value: null, selectedObservationId: null, reconciliationDecisionId: null };
    expect(() => check(dataset, [excluded])).not.toThrow();
    expect(() => check(dataset, [{ ...excluded, value: 0 }])).toThrow("label-binding-4");
    expect(() => check(dataset, [{ ...excluded, playerBridgeObservationId: "bridge-gsis" }])).toThrow("label-binding-9");
    expect(() => check(labelled(), [excluded])).toThrow("label-binding-2");
  });
  const markOutForLabels = (dataset: Dataset) => {
    omit(dataset, "player-synthetic-game-5");
    addCapture(dataset, "inactive-5", [revision("inactive-5", "participation-evidence",
      { gameId: PRIOR[4], playerId: PLAYER, teamId: TEAM, evidenceKind: "official-inactive-list", claim: "inactive-or-dnp" })]);
  };
});

describe("feature-run records", () => {
  it("binds rights and timing into the execution digest while the input digest stays the cutoff-time digest", () => {
    const result = bundle();
    const base = featureRunRecord(result, { rightsInForce: new Map([[PROFILE, "rights-" + PROFILE]]), synthetic: true, recordedAt: "2026-10-10T00:00:00.000Z" });
    expect(base.inputDigest).toBe(result.inputDigest);
    expect(base.id).toBe("feature-run:" + base.executionDigest);
    expect(base.dependencies.observations).toHaveLength(result.dependencies.length);
    expect(base.dependencies.policies).toEqual(["availability-v1", "event-completion-v1", "participation-v1"]);
    expect(base.dependencies.featureDefinitions).toEqual(["passing-yards-replay-v3"]);
    const renewed = featureRunRecord(result, { rightsInForce: new Map([[PROFILE, "rights-renewed"]]), synthetic: true, recordedAt: "2026-10-10T00:00:00.000Z" });
    expect(renewed.inputDigest).toBe(base.inputDigest); expect(renewed.executionDigest).not.toBe(base.executionDigest);
    const later = featureRunRecord(result, { rightsInForce: new Map([[PROFILE, "rights-" + PROFILE]]), synthetic: true, recordedAt: "2026-10-11T00:00:00.000Z" });
    expect(later.executionDigest).not.toBe(base.executionDigest);
    expect(featureRunRecord(result, { rightsInForce: new Map([[PROFILE, "rights-" + PROFILE]]), synthetic: true, recordedAt: "2026-10-10T00:00:00.000Z" })).toEqual(base);
  });
});

describe("bridge-v1 identity bridges", () => {
  const second = "synthetic-second-v1";
  const playerBridge = (id: string, raw: string, playerId: string, from = "2026-01-01T00:00:00.000Z", to = "2027-01-01T00:00:00.000Z", predecessor: string | null = null) =>
    revision(id, "player-bridge", { provider: "provider-x", rawPlayerId: raw, playerId, effectiveFrom: from, effectiveTo: to }, predecessor);
  const replayOf = (dataset: Dataset, cutoff = CUTOFF_A) => createReplay(dataset, cutoff, request().computedAt);
  it("resolves a provider's raw IDs to canonical identities, effective by date", () => {
    const dataset = passingYardsFixture(false);
    addCapture(dataset, "bridges", [playerBridge("bridge-a", "p123", PLAYER, "2026-01-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"),
      revision("alias-la", "team-alias", { provider: "provider-x", rawAlias: "LAR", teamId: "nfl:team:LA", effectiveFromSeason: 2016, effectiveToSeason: 2026 }),
      revision("alias-la-2", "team-alias", { provider: "provider-x", rawAlias: "LA", teamId: "nfl:team:LA", effectiveFromSeason: 2016, effectiveToSeason: 2026 }),
      revision("game-bridge", "game-bridge", { provider: "provider-x", rawGameId: "evt-9", gameId: TARGET }),
      revision("relation", "game-relation", { gameId: TARGET, predecessorGameId: gameId(99), relation: "replacement" })]);
    const replay = replayOf(dataset);
    expect(replay.resolvePlayer("provider-x", "p123", "2026-03-01T00:00:00.000Z")).toMatchObject({ state: "resolved", value: PLAYER });
    expect(replay.resolvePlayer("provider-x", "p123", "2026-07-01T00:00:00.000Z")).toMatchObject({ state: "missing", reason: "identity-bridge-missing" });
    expect(replay.resolveTeam("provider-x", "LAR", 2024)).toMatchObject({ state: "resolved", value: "nfl:team:LA" });
    expect(replay.resolveTeam("provider-x", "LA", 2024)).toMatchObject({ state: "resolved", value: "nfl:team:LA" });
    expect(replay.resolveTeam("provider-x", "LA", 2015)).toMatchObject({ state: "missing" });
    expect(replay.resolveGame("provider-x", "evt-9")).toMatchObject({ state: "resolved", value: TARGET });
    expect(replay.replacementOf(TARGET)).toMatchObject({ state: "resolved", value: gameId(99) });
  });
  it("resolves disagreeing providers as unresolved and applies a correction only at later cutoffs", () => {
    const dataset = passingYardsFixture(false); dataset.profiles.push(profile(second)); dataset.rightsDecisions.push(rights(second));
    addCapture(dataset, "bridge-1", [playerBridge("bridge-1", "p123", PLAYER)]);
    expect(replayOf(dataset).resolvePlayer("provider-x", "p123", CUTOFF_A)).toMatchObject({ state: "resolved" });
    addCapture(dataset, "bridge-2", [playerBridge("bridge-2", "p123", "00-0000002")], CAPTURE_A, second);
    expect(replayOf(dataset).resolvePlayer("provider-x", "p123", CUTOFF_A)).toMatchObject({ state: "unresolved", reason: "identity-bridge-conflict" });
    const corrected = passingYardsFixture(false);
    addCapture(corrected, "bridge-1", [playerBridge("bridge-1", "p123", PLAYER)]);
    addCapture(corrected, "bridge-fix", [playerBridge("bridge-fix", "p123", "00-0000002", undefined, undefined, "bridge-1")], CAPTURE_B);
    expect(replayOf(corrected).resolvePlayer("provider-x", "p123", CUTOFF_A)).toMatchObject({ state: "resolved", value: PLAYER });
    expect(replayOf(corrected, CUTOFF_B).resolvePlayer("provider-x", "p123", CUTOFF_A)).toMatchObject({ state: "resolved", value: "00-0000002" });
  });
  it("refuses one source mapping two raw IDs to one player over overlapping dates, or two raw game IDs to one game", () => {
    const overlap = passingYardsFixture(false);
    addCapture(overlap, "bridges", [playerBridge("bridge-a", "p123", PLAYER), playerBridge("bridge-b", "p456", PLAYER, "2026-05-01T00:00:00.000Z")]);
    expect(() => validateDataset(overlap)).toThrow("bridge-ambiguous");
    const sequential = passingYardsFixture(false);
    addCapture(sequential, "bridges", [playerBridge("bridge-a", "p123", PLAYER, "2026-01-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z"),
      playerBridge("bridge-b", "p456", PLAYER, "2026-05-01T00:00:00.000Z")]);
    expect(() => validateDataset(sequential)).not.toThrow();
    const games = passingYardsFixture(false);
    addCapture(games, "games", [revision("g1", "game-bridge", { provider: "provider-x", rawGameId: "evt-1", gameId: TARGET }),
      revision("g2", "game-bridge", { provider: "provider-x", rawGameId: "evt-2", gameId: TARGET })]);
    expect(() => validateDataset(games)).toThrow("bridge-ambiguous");
  });
  it.each([
    ["a raw ID containing a key separator", revision("bad", "player-bridge", { provider: "provider-x", rawPlayerId: "p:1", playerId: PLAYER, effectiveFrom: CAPTURE_A, effectiveTo: CAPTURE_B })],
    ["reversed alias seasons", revision("bad", "team-alias", { provider: "provider-x", rawAlias: "LA", teamId: "nfl:team:LA", effectiveFromSeason: 2026, effectiveToSeason: 2016 })],
    ["an unknown canonical team", revision("bad", "team-alias", { provider: "provider-x", rawAlias: "LA", teamId: "nfl:team:LAR", effectiveFromSeason: 2016, effectiveToSeason: 2026 })],
    ["a game replacing itself", revision("bad", "game-relation", { gameId: TARGET, predecessorGameId: TARGET, relation: "replacement" })],
  ])("refuses a bridge with %s", (_label, bad) => {
    const dataset = passingYardsFixture(false); addCapture(dataset, "bad", [bad]);
    expect(() => validateDataset(dataset)).toThrow();
  });
});

describe("local executable proof", () => {
  const run = (extra: Partial<NodeJS.ProcessEnv> = {}) => {
    const env = { NODE_ENV: "test" as const, PATH: process.env.PATH, ...extra };
    return spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/predictive/demo.ts"], { encoding: "utf8", env });
  };
  it("runs on Node 24 with no key, database, network or application imports", () => {
    const result = run(); expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.earlierReplayUnchanged).toBe(true);
    expect(report.capturedA.inputDigest).toBe(report.replayA.inputDigest);
    expect(report.laterB.player[0].passingYardsSum).toBe(720);
    expect(report.unavailable.status).toBe("unavailable-inputs");
  });
  it.each(["DATABASE_URL", "MIGRATION_DATABASE_URL", "ODDS_API_KEY", "NEON_API_KEY", "FIREBASE_ADMIN_PRIVATE_KEY", "PGHOST", "GOOGLE_APPLICATION_CREDENTIALS", "TEST_DATABASE_URL"])("refuses ambient %s without echoing it", (key) => {
    const result = run({ [key]: "sensitive-test-placeholder" });
    expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).not.toContain("sensitive-test-placeholder");
  });
});

describe("retention-policy-v1 replay notice", () => {
  it("reports removed evidence for an unavailable bundle or one still reading a retained profile, and leaves others unchanged", () => {
    const dataset = passingYardsFixture(false);
    const replay = createReplay(dataset, CUTOFF_A, request().computedAt);
    const ready = buildPassingYardsFromReplay(replay, request());
    expect(ready.status).toBe("ready-inputs");
    // An unrelated profile's removal does not affect a ready bundle.
    expect(buildPassingYardsFromReplay({ ...replay, retentionProfiles: ["synthetic-other-v1"] }, request())).toEqual(ready);
    // A bundle still reading a profile that lost evidence is withheld.
    const retained = buildPassingYardsFromReplay({ ...replay, retentionProfiles: [PROFILE] }, request());
    expect(retained).toMatchObject({ status: "unavailable-inputs", reasons: ["retained-evidence-removed"] });
    expect(retained.inputDigest).not.toBe(ready.inputDigest);
    // An already-unavailable bundle says removal may explain the missing inputs.
    const empty = createReplay(emptyDataset(), CUTOFF_A, request().computedAt);
    expect(buildPassingYardsFromReplay({ ...empty, retentionProfiles: ["synthetic-other-v1"] }, request()).reasons).toContain("retained-evidence-removed");
    expect(buildPassingYardsFromReplay(empty, request()).reasons).not.toContain("retained-evidence-removed");
  });
});

describe("snap evidence and snap-compatibility-v1", () => {
  const OTHER = "synthetic-other-v1";
  const snapDataset = (rows: { id: string; profile?: string; at?: string; revisions: Revision[] }[]) => {
    const dataset = emptyDataset(); dataset.profiles.push(profile(OTHER)); dataset.rightsDecisions.push(rights(OTHER));
    for (const item of rows) addCapture(dataset, item.id, item.revisions, item.at ?? CAPTURE_A, item.profile ?? PROFILE);
    return dataset;
  };
  const bothProviders = (otherTeamSnaps = 60, otherPlayerSnaps = 30) => snapDataset([
    { id: "snaps-a", revisions: [revision("a-team-5", "team-game-snaps", teamSnaps(game(5), 60)), revision("a-player-5", "player-game-snaps", playerSnaps(game(5), 30)),
      revision("a-team-4", "team-game-snaps", teamSnaps(game(4), 50)), revision("a-player-4", "player-game-snaps", playerSnaps(game(4), 40))] },
    { id: "snaps-b", profile: OTHER, revisions: [revision("b-team-5", "team-game-snaps", teamSnaps(game(5), otherTeamSnaps)),
      revision("b-player-5", "player-game-snaps", playerSnaps(game(5), otherPlayerSnaps))] },
  ]);
  const rowsOfDataset = (dataset: Dataset) => validateDataset(dataset).observations;
  const byId = (dataset: Dataset, id: string) => rowsOfDataset(dataset).get(id)!;
  const t = instant(CUTOFF_A);

  it("validates counts, flags, definitions and per-field missingness without zero-filling", () => {
    const valid = revision("snap", "player-game-snaps", playerSnaps(game(5), null));
    expect(() => validateRevision(valid)).not.toThrow();
    const team = revision("team-snap", "team-game-snaps", teamSnaps(game(5), 61));
    expect(() => validateRevision(team)).not.toThrow();
    const refusals: [string, Revision, string][] = [
      ["a blank without a reason", { ...valid, data: { ...valid.data, missing: { routesRun: "source-missing" } } } as Revision, "missingness-reason-required"],
      ["a reason beside a value", { ...valid, data: { ...valid.data, offenseSnaps: 3 } } as Revision, "unexpected-missingness-reason"],
      ["a count above 300", { ...team, data: { ...team.data, offenseSnaps: 301 } } as Revision, "invalid-numeric-value"],
      ["a non-boolean flag", { ...valid, data: { ...valid.data, played: "yes" } } as unknown as Revision, "invalid-snaps"],
      ["a missing play-counting definition", { ...team, data: { ...team.data, playCountingDefinition: "" } } as Revision, "invalid-snaps"],
    ];
    for (const [label, row, message] of refusals) expect(() => validateRevision(row), label).toThrow(message);
  });

  it("pools paired snaps over the same games and leaves gaps, blanks and zero denominators undefined", () => {
    const dataset = bothProviders();
    const pair = (player: string | null, team: string | null) => ({ player: player ? byId(dataset, player) : null, team: team ? byId(dataset, team) : null });
    const same = () => true;
    // (30 + 40) / (60 + 50), pooled rather than averaged per game.
    expect(snapShare([pair("a-player-5", "a-team-5"), pair("a-player-4", "a-team-4")], same)).toEqual({ value: 70 / 110, playerSnaps: 70, teamSnaps: 110, games: 2, reason: null });
    expect(snapShare([pair("a-player-5", "a-team-5"), pair("a-player-4", null)], same).reason).toBe("snap-pair-missing");
    expect(snapShare([pair("a-player-5", "a-team-4")], same).reason).toBe("snap-pair-invalid");
    const blank = snapDataset([{ id: "blank", revisions: [revision("blank-team", "team-game-snaps", teamSnaps(game(5), null)),
      revision("blank-player", "player-game-snaps", playerSnaps(game(5), 0)), revision("zero-team", "team-game-snaps", teamSnaps(game(4), 0)),
      revision("zero-player", "player-game-snaps", playerSnaps(game(4), 0)), revision("over-team", "team-game-snaps", teamSnaps(game(3), 10)),
      revision("over-player", "player-game-snaps", playerSnaps(game(3), 11))] }]);
    const of = (player: string, team: string) => ({ player: byId(blank, player), team: byId(blank, team) });
    expect(snapShare([of("blank-player", "blank-team")], same)).toMatchObject({ value: null, reason: "snap-value-missing" });
    expect(snapShare([of("zero-player", "zero-team")], same)).toMatchObject({ value: null, reason: "snap-denominator-zero" });
    expect(snapShare([of("over-player", "over-team")], same).reason).toBe("snap-pair-invalid");
    // Mixing providers in one window needs a current compatibility decision.
    const mixed = [pair("a-player-4", "a-team-4"), pair("b-player-5", "b-team-5")];
    expect(snapShare(mixed, (a, b) => a === b).reason).toBe("snap-source-incompatible");
    const decision = recordSnapCompatibility("compat", PROFILE, OTHER, rowsOfDataset(dataset).values(), CUTOFF_A, "synthetic-proof");
    expect(snapShare(mixed, (a, b) => snapProfilesCompatible([decision], rowsOfDataset(dataset).values(), a, b, t))).toMatchObject({ value: 70 / 110, reason: null });
  });

  it("decides compatibility from the complete overlap and refuses cherry-picked evidence", () => {
    const agreeing = bothProviders(); const observations = rowsOfDataset(agreeing);
    const compatible = recordSnapCompatibility("compat", OTHER, PROFILE, observations.values(), CUTOFF_A, "synthetic-proof");
    // Game 5 is the only game both cover; game 4's rows are outside the overlap.
    expect(compatible).toMatchObject({ entityKey: "snap-source-compatibility:" + OTHER + ":" + PROFILE, outcome: { result: "compatible", overlapGames: 1 } });
    expect(compatible.inputs.map((input) => input.observationId)).toEqual(["a-player-5", "a-team-5", "b-player-5", "b-team-5"]);
    expect(() => createReplay({ ...agreeing, decisions: [compatible] }, CUTOFF_A, request().computedAt)).not.toThrow();
    const cherryPicked = { ...compatible, inputs: compatible.inputs.filter((input) => input.observationId !== "b-player-5") };
    expect(() => validateSnapCompatibilityDecisions([cherryPicked], observations, validateDataset(agreeing).profiles)).toThrow("snap-compatibility-inputs-not-heads");
    expect(() => validateSnapCompatibilityDecisions([{ ...compatible, outcome: { result: "incompatible", overlapGames: 1 } }], observations,
      validateDataset(agreeing).profiles)).toThrow("decision-rule-mismatch");
    // Disagreeing player snaps, or a different play-counting definition, are incompatible.
    expect(recordSnapCompatibility("x", PROFILE, OTHER, rowsOfDataset(bothProviders(60, 31)).values(), CUTOFF_A, "synthetic-proof").outcome.result).toBe("incompatible");
    const definitions = bothProviders(); const team = definitions.artifacts.find((value) => value.id === "snaps-b")!;
    const rows = (JSON.parse(team.bytes) as Revision[]).map((row) => row.kind === "team-game-snaps" ? { ...row, data: { ...row.data, playCountingDefinition: "all-plays-v1" } } : row);
    Object.assign(team, { bytes: JSON.stringify(rows), sha256: digest(JSON.stringify(rows)) });
    expect(recordSnapCompatibility("y", PROFILE, OTHER, rowsOfDataset(definitions).values(), CUTOFF_A, "synthetic-proof").outcome.result).toBe("incompatible");
    // No shared game: insufficient overlap, with no inputs.
    const apart = snapDataset([{ id: "only-a", revisions: [revision("a-team-5", "team-game-snaps", teamSnaps(game(5), 60))] }]);
    expect(recordSnapCompatibility("z", PROFILE, OTHER, rowsOfDataset(apart).values(), CUTOFF_A, "synthetic-proof")).toMatchObject({ outcome: { result: "insufficient-overlap", overlapGames: 0 }, inputs: [] });
    // A later correction leaves the decision stale for later instants only.
    const corrected = bothProviders();
    addCapture(corrected, "b-fix", [revision("b-team-5-fix", "team-game-snaps", teamSnaps(game(5), 59), "b-team-5")], CAPTURE_B, OTHER);
    const later = rowsOfDataset(corrected);
    expect(snapOverlapHeadsAt(later.values(), [PROFILE, OTHER], instant(CUTOFF_B)).map((row) => row.revision.id)).toContain("b-team-5-fix");
    expect(snapProfilesCompatible([compatible], later.values(), PROFILE, OTHER, t)).toBe(true);
    expect(snapProfilesCompatible([compatible], later.values(), PROFILE, OTHER, instant(CUTOFF_B))).toBe(false);
  });
});
