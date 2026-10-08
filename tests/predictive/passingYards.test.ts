import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildPassingYardsBundle } from "../../src/lib/predictive/passingYards.ts";
import { createReplay } from "../../src/lib/predictive/replay.ts";
import { digest, instant, RAW_ALLOWLISTS, validateDataset, validateRawHeader } from "../../src/lib/predictive/validation.ts";
import type { Dataset, Kind, Revision } from "../../src/lib/predictive/types.ts";
import { addCapture, artifact, CAPTURE_A, CAPTURE_B, CUTOFF_A, CUTOFF_B, gameId, OPPONENT, passingYardsFixture, PLAYER, PRIOR, request, revision, schedule, TARGET, TEAM } from "./fixtures/passingYards.ts";

function row(dataset: Dataset, id: string): Revision {
  return dataset.artifacts.flatMap((item) => JSON.parse(item.bytes) as Revision[]).find((item) => item.id === id)!;
}
// Deliberately invalid/altered source fixtures for refusal tests, not production
// correction APIs. Normal replay mutations use append-only addCapture below.
function edit(dataset: Dataset, id: string, change: (value: Revision) => void) {
  for (const item of dataset.artifacts) {
    const rows = JSON.parse(item.bytes) as Revision[];
    const value = rows.find((item) => item.id === id);
    if (!value) continue;
    change(value); item.bytes = JSON.stringify(rows); item.sha256 = digest(item.bytes); return;
  }
  throw new Error("fixture row missing");
}
function omit(dataset: Dataset, id: string) {
  for (const item of dataset.artifacts) {
    item.bytes = JSON.stringify((JSON.parse(item.bytes) as Revision[]).filter((value) => value.id !== id));
    item.sha256 = digest(item.bytes);
  }
}
function bundle(dataset = passingYardsFixture(false)) { return buildPassingYardsBundle(dataset, request()); }
function unavailable(dataset: Dataset, reason: string) {
  const result = bundle(dataset);
  expect(result.status).toBe("unavailable-inputs"); expect(result.reasons).toContain(reason); return result;
}
function playerChanges(dataset: Dataset, id: string, values: Record<string, unknown>) {
  edit(dataset, id, (value) => Object.assign(value.data, values));
}

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
    expect(result.opponent![0].games.every((game) => game.teamId !== OPPONENT)).toBe(true);
    expect(result.dependencies.some((dep) => dep.observationId.startsWith("opponent-offense"))).toBe(false);
    expect(result.scheduledRestHours).toBe(168);
    expect(result.availability).toEqual({ injury: "unknown", depth: "unknown", participation: "future-unknown" });
    expect(result.quality).toEqual(expect.arrayContaining(["injury-unverified", "depth-unverified", "player-short-history"]));
    expect(result.modelValidated).toBe(false); expect(result.populationCoverage).toBe("unqualified");
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
    const capture = dataset.captures.find((value) => value.artifactId === "A-player-passing")!;
    capture.availableAt = capture.ingestedAt = new Date(instant(CUTOFF_A) + offset).toISOString();
    const result = bundle(dataset);
    expect(result.status).toBe(offset <= 0 ? "ready-inputs" : "unavailable-inputs");
  });
  it("does not backdate a late ingestion from a known publication date", () => {
    const dataset = passingYardsFixture(false);
    const capture = dataset.captures.find((value) => value.artifactId === "A-player-passing")!;
    capture.publishedAt = "2026-10-06T12:00:00.000Z"; capture.publicationEvidence = "synthetic-publication-v1";
    capture.ingestedAt = CAPTURE_B;
    unavailable(dataset, "player-history-incomplete");
  });
  it("ignores an incomplete correction and withholds a missing required incomplete feed", () => {
    const dataset = passingYardsFixture();
    for (const capture of dataset.captures.filter((value) => value.artifactId.startsWith("B-"))) capture.state = "incomplete";
    expect(buildPassingYardsBundle(dataset, request(CUTOFF_B)).player[0].passingYardsSum).toBe(700);
    dataset.captures.find((value) => value.artifactId === "A-team-passing")!.state = "incomplete";
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
    expect(result.player.flatMap((summary) => summary.games).some((game) => game.gameId === TARGET)).toBe(false);
    expect(result.excludedSchedule).toEqual(expect.arrayContaining([
      { gameId: TARGET, reason: "target-game" }, { gameId: gameId(30), reason: "season-type" },
      { gameId: gameId(31), reason: "season-range" }, { gameId: gameId(32), reason: "not-prior-game" },
    ]));
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
    const result = unavailable(dataset, "player-zero-or-missing-denominator");
    expect(result.player[0]).toMatchObject({ observedGames: 4, excludedGames: 0, attemptsSum: 0, attemptsPerGame: 0, passingYardsPerAttempt: null });
  });
  it("treats blank as missing and never fills the newest gap with an older fifth game", () => {
    const dataset = passingYardsFixture(false);
    playerChanges(dataset, "player-synthetic-game-5", { passingYards: null, missingReason: "source-blank" });
    const result = unavailable(dataset, "player-history-incomplete");
    expect(result.player[0]).toMatchObject({ expectedGames: 4, observedGames: 3, passingYardsSum: 400,
      exclusions: [{ gameId: PRIOR[4], reason: "source-blank" }] });
    expect(result.player[0].gameIds).not.toContain(PRIOR[0]);
  });
  it.each(["absent", "unresolved"] as const)("does not substitute roster membership for %s participation", (state) => {
    const dataset = passingYardsFixture(false); playerChanges(dataset, "participation-synthetic-game-5", { state });
    const result = unavailable(dataset, "player-history-incomplete");
    expect(result.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "participation-" + state });
  });
  it.each(["missing", "unresolved"])("withholds %s completion without guessing elapsed game time", (state) => {
    const dataset = passingYardsFixture(false);
    if (state === "missing") omit(dataset, "complete-synthetic-game-5");
    else playerChanges(dataset, "complete-synthetic-game-5", { state: "unresolved", bound: null, boundKind: null });
    const result = unavailable(dataset, "player-history-incomplete");
    expect(result.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "completion-" + state });
  });
  it.each([-1, 0, 1])("requires completion strictly before cutoff (%+d ms)", (offset) => {
    const dataset = passingYardsFixture(false);
    const original = row(dataset, "complete-synthetic-game-5") as Revision<"completion">;
    addCapture(dataset, "cutoff-completion", [revision("cutoff-completion", "completion", {
      ...original.data, bound: new Date(instant(CUTOFF_A) + offset).toISOString(), boundKind: "actual-end",
    }, original.id)], CUTOFF_A);
    expect(bundle(dataset).status).toBe(offset < 0 ? "ready-inputs" : "unavailable-inputs");
  });
  it("refuses a completion bound after capture or before kickoff", () => {
    for (const bound of ["2026-10-07T12:00:00.001Z", "2026-10-04T17:00:00.000Z"]) {
      const dataset = passingYardsFixture(false); playerChanges(dataset, "complete-synthetic-game-5", { bound });
      unavailable(dataset, "player-history-incomplete");
    }
  });
  it("does not backdate first-observed completion from an unqualified earlier timestamp", () => {
    const dataset = passingYardsFixture(false);
    playerChanges(dataset, "complete-synthetic-game-5", { bound: "2026-10-06T12:00:00.000Z" });
    const result = unavailable(dataset, "player-history-incomplete");
    expect(result.player[0].exclusions[0].reason).toBe("completion-bound-unverified");
  });
  it.each(["schedule-synthetic-game-10", "member-synthetic-game-10"])("reports missing target dependency %s explicitly", (id) => {
    const dataset = passingYardsFixture(false); omit(dataset, id);
    const result = unavailable(dataset, id.startsWith("schedule") ? "target-schedule-missing" : "target-membership-missing");
    expect(result.player).toEqual([]);
  });
  it("withholds excluded players and cutoff-known identity conflicts", () => {
    const dataset = passingYardsFixture(false);
    playerChanges(dataset, "availability-target", { injury: "excluded" }); unavailable(dataset, "player-excluded");
    playerChanges(dataset, "availability-target", { injury: "unknown" });
    const membership = row(dataset, "member-synthetic-game-10") as Revision<"membership">;
    addCapture(dataset, "conflicting-membership", [revision("conflicting-member", "membership", { ...membership.data, teamId: OPPONENT, rawTeam: "DAL" })]);
    const result = unavailable(dataset, "target-membership-ambiguous");
    expect(result.dependencies.map((value) => value.observationId)).toEqual(expect.arrayContaining([membership.id, "conflicting-member"]));
  });
  it.each([{ rawTeam: "DAL" }, { effectiveTo: "2026-10-11T17:00:00.000Z" }, { position: "WR" }])("requires raw and dated target membership: %j", (values) => {
    const dataset = passingYardsFixture(false); playerChanges(dataset, "member-synthetic-game-10", values);
    unavailable(dataset, "target-membership-inapplicable");
  });
  it("keeps team scheduled rest distinct from a traded player's former-team history", () => {
    const dataset = passingYardsFixture(false);
    const former = schedule(40, "2026-10-05T17:00:00.000Z", "nfl:team:BUF", "nfl:team:NE");
    addCapture(dataset, "trade-game", [revision("trade-game", "schedule", former)]);
    const member = row(dataset, "member-synthetic-game-5") as Revision<"membership">;
    addCapture(dataset, "trade-member", [revision("trade-member", "membership", { ...member.data, gameId: former.gameId, teamId: former.homeTeamId, rawTeam: "BUF" })]);
    addCapture(dataset, "trade-completion", [revision("trade-completion", "completion", { gameId: former.gameId, state: "confirmed", bound: CAPTURE_A, boundKind: "completion-observed-at", evidenceVersion: "synthetic-complete-v1" })]);
    addCapture(dataset, "trade-participation", [revision("trade-participation", "participation", { gameId: former.gameId, playerId: PLAYER, state: "confirmed", evidenceVersion: "synthetic-offense-v1" })]);
    const base = { gameId: former.gameId, rawGameId: former.rawGameId, teamId: former.homeTeamId, rawTeam: "BUF", season: 2026, seasonType: "REG" as const, attempts: 10, passingYards: 60, missingReason: null };
    addCapture(dataset, "trade-player", [revision("trade-player", "player-passing", { ...base, playerId: PLAYER, rawPlayerId: PLAYER })]);
    addCapture(dataset, "trade-team", [revision("trade-team", "team-passing", base)]);
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
    expect(reduced.dependencies.some((value) => value.kind === "team-passing")).toBe(false);
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
  it("requires a pregame target and does not treat confirmed target completion as a prior input", () => {
    const dataset = passingYardsFixture(false); playerChanges(dataset, "schedule-synthetic-game-10", { kickoff: CUTOFF_A });
    unavailable(dataset, "target-not-pregame");
    playerChanges(dataset, "schedule-synthetic-game-10", { kickoff: "2026-10-11T17:00:00.000Z" });
    addCapture(dataset, "target-complete", [revision("target-complete", "completion", { gameId: TARGET, state: "confirmed", bound: CAPTURE_A, boundKind: "completion-observed-at", evidenceVersion: "synthetic-v1" })]);
    unavailable(dataset, "target-started-or-completed");
  });
});

describe("strict source and correction contracts", () => {
  it.each(Object.keys(RAW_ALLOWLISTS) as (keyof typeof RAW_ALLOWLISTS)[])("executes %s raw allowlist and refuses forbidden, duplicate, or missing fields", (feed) => {
    const allowed = [...RAW_ALLOWLISTS[feed]];
    expect(() => validateRawHeader(feed, allowed, [allowed[0]])).not.toThrow();
    for (const forbidden of ["spread_line", "total_line", "fantasy_points", "weather", "target_share", "height", "weight"]) {
      expect(() => validateRawHeader(feed, [...allowed, forbidden], [allowed[0]])).toThrow("raw-header-refused");
    }
    expect(() => validateRawHeader(feed, [...allowed, allowed[0]], [])).toThrow("raw-header-refused");
    expect(() => validateRawHeader(feed, allowed.slice(1), [allowed[0]])).toThrow("raw-header-refused");
  });
  it("verifies bytes before replay and refuses external adapters or extra payload fields", () => {
    const dataset = passingYardsFixture(false); dataset.artifacts[0].bytes += " ";
    expect(() => bundle(dataset)).toThrow("artifact-integrity-failed");
    dataset.artifacts[0].sha256 = digest(dataset.artifacts[0].bytes);
    Object.assign(dataset.artifacts[0], { source: "nflverse" }); expect(() => bundle(dataset)).toThrow("unqualified-source-adapter");
    Object.assign(dataset.artifacts[0], { source: "synthetic" });
    Object.assign(dataset.artifacts[0], { parserVersion: "unregistered-parser" }); expect(() => bundle(dataset)).toThrow("unqualified-source-adapter");
    Object.assign(dataset.artifacts[0], { parserVersion: "synthetic-json-v1" });
    playerChanges(dataset, "player-synthetic-game-5", { fantasy_points: 20 }); expect(() => bundle(dataset)).toThrow("schema-fields-refused");
  });
  it.each([{ attempts: -1 }, { attempts: 1.2 }, { passingYards: "0" }, { passingYards: null, missingReason: null }])("refuses malformed numeric/missing values %j", (values) => {
    const dataset = passingYardsFixture(false); playerChanges(dataset, "player-synthetic-game-5", values);
    expect(() => bundle(dataset)).toThrow();
  });
  it("refuses unknown GSIS/team identity and unqualified player bridges", () => {
    const dataset = passingYardsFixture(false);
    expect(() => buildPassingYardsBundle(dataset, { ...request(), playerId: "player-name" })).toThrow("invalid-player-identity");
    playerChanges(dataset, "member-synthetic-game-10", { rawPlayerId: "00-0000002" }); expect(() => bundle(dataset)).toThrow("unqualified-player-bridge");
    playerChanges(dataset, "member-synthetic-game-10", { rawPlayerId: PLAYER, teamId: "nfl:team:unknown" }); expect(() => bundle(dataset)).toThrow("invalid-team-identity");
  });
  it("refuses changed observation IDs, missing predecessors and backward corrections", () => {
    const dataset = passingYardsFixture();
    edit(dataset, "player-correction-B", (value) => { value.id = "player-synthetic-game-5"; });
    expect(() => bundle(dataset)).toThrow("observation-id-conflict");
    const missing = passingYardsFixture(); edit(missing, "player-correction-B", (value) => { value.predecessorId = "missing"; });
    expect(() => bundle(missing)).toThrow("invalid-correction-lineage");
    const backward = passingYardsFixture(); backward.captures.find((value) => value.artifactId === "B-player")!.capturedAt = "2026-10-06T12:00:00.000Z";
    backward.captures.find((value) => value.artifactId === "B-player")!.availableAt = "2026-10-06T12:00:00.000Z";
    backward.captures.find((value) => value.artifactId === "B-player")!.ingestedAt = "2026-10-06T12:00:00.000Z";
    expect(() => bundle(backward)).toThrow("invalid-correction-lineage");
  });
  it("refuses correction cycles and treats branching heads as ambiguous", () => {
    const dataset = passingYardsFixture(false);
    edit(dataset, "player-synthetic-game-5", (value) => { value.predecessorId = "player-synthetic-game-5"; value.correctionReason = "cycle"; });
    expect(() => bundle(dataset)).toThrow("cyclic-correction-lineage");
    const branch = passingYardsFixture(); const original = row(branch, "player-synthetic-game-5") as Revision<"player-passing">;
    addCapture(branch, "branch", [revision("branch-player", "player-passing", { ...original.data, passingYards: 310 }, original.id)], CAPTURE_B);
    expect(buildPassingYardsBundle(branch, request(CUTOFF_B)).status).toBe("unavailable-inputs");
  });
  it("keeps later membership correction from resolving earlier ambiguity", () => {
    const dataset = passingYardsFixture(false); const original = row(dataset, "member-synthetic-game-10") as Revision<"membership">;
    addCapture(dataset, "identity-B", [revision("member-B", "membership", { ...original.data, teamId: OPPONENT, rawTeam: "DAL", mappingVersion: "synthetic-identity-v2" }, original.id)], CAPTURE_B);
    expect(bundle(dataset).teamId).toBe(TEAM);
    expect(buildPassingYardsBundle(dataset, request(CUTOFF_B)).teamId).toBe(OPPONENT);
  });
  it("refuses invalid timestamps, inconsistent publication/capture identity, and oversized artifacts", () => {
    for (const date of ["2026-10-08", "2026-02-30T00:00:00.000Z", "2026-10-08T12:00:00Z"]) expect(() => instant(date)).toThrow("invalid-utc-instant");
    const dataset = passingYardsFixture(false); dataset.captures[0].publishedAt = CAPTURE_B; dataset.captures[0].publicationEvidence = "synthetic";
    expect(() => validateDataset(dataset)).toThrow("publication-time-refused");
    dataset.captures[0].publishedAt = null; dataset.captures[0].publicationEvidence = null;
    dataset.captures.push({ ...dataset.captures[0], ingestedAt: CAPTURE_B }); expect(() => validateDataset(dataset)).toThrow("capture-id-conflict");
    dataset.captures.pop(); dataset.artifacts[0].bytes = " ".repeat(1_000_001); dataset.artifacts[0].sha256 = digest(dataset.artifacts[0].bytes);
    expect(() => validateDataset(dataset)).toThrow("artifact-integrity-failed");
  });
  it("refuses cross-kind artifacts and retains exact raw bytes", () => {
    const dataset = passingYardsFixture(false);
    dataset.artifacts.push(artifact("bad-feed", "schedule" as Kind, [row(dataset, "member-synthetic-game-10")]));
    expect(() => createReplay(dataset, CUTOFF_A)).toThrow("artifact-feed-mismatch");
  });
});

describe("local executable proof", () => {
  function run(extra: Partial<NodeJS.ProcessEnv> = {}) {
    const env = { NODE_ENV: "test" as const, PATH: process.env.PATH, ...extra };
    return spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/predictive/demo.ts"], { encoding: "utf8", env });
  }
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
