import { createHash } from "node:crypto";
import { NFL_TEAM_ABBREVIATIONS } from "../nflStadiums.ts";
import type { Dataset, Kind, Revision } from "./types.ts";

export class PredictiveError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export function refuse(code: string): never { throw new PredictiveError(code); }
export const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
// Stable code-unit order, independent of the machine's locale/ICU version.
export const compareText = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
}
export function instant(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) refuse("invalid-utc-instant");
  return Date.parse(value);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("invalid-record");
  return value as Record<string, unknown>;
}
export function exact(value: unknown, keys: string[]) {
  const row = object(value);
  if (Object.keys(row).sort().join(",") !== [...keys].sort().join(",")) refuse("schema-fields-refused");
  return row;
}
const text = (value: unknown) => { if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f]/.test(value)) refuse("invalid-identity"); };
const oneOf = (value: unknown, choices: readonly unknown[]) => { if (!choices.includes(value)) refuse("invalid-enum"); };
export const gameIdentity = (value: unknown) => { if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) refuse("invalid-game-identity"); };
export const playerIdentity = (value: unknown) => { if (typeof value !== "string" || !/^00-\d{7}$/.test(value)) refuse("invalid-player-identity"); };
const teams = new Set(Object.values(NFL_TEAM_ABBREVIATIONS).map((team) => "nfl:team:" + team));
const teamIdentity = (value: unknown) => { if (typeof value !== "string" || !teams.has(value)) refuse("invalid-team-identity"); };
const integer = (value: unknown, min: number, max: number) => { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) refuse("invalid-numeric-value"); };
const fields: Record<Kind, string[]> = {
  schedule: ["gameId", "rawGameId", "season", "seasonType", "week", "kickoff", "homeTeamId", "awayTeamId", "rawHomeTeam", "rawAwayTeam", "mappingVersion"],
  membership: ["gameId", "playerId", "rawPlayerId", "teamId", "rawTeam", "position", "effectiveFrom", "effectiveTo", "mappingVersion"],
  "player-passing": ["gameId", "rawGameId", "teamId", "rawTeam", "season", "seasonType", "attempts", "passingYards", "missingReason", "playerId", "rawPlayerId"],
  "team-passing": ["gameId", "rawGameId", "teamId", "rawTeam", "season", "seasonType", "attempts", "passingYards", "missingReason"],
  completion: ["gameId", "state", "bound", "boundKind", "evidenceVersion"],
  participation: ["gameId", "playerId", "state", "evidenceVersion"],
  availability: ["gameId", "playerId", "injury", "depth", "evidenceVersion"],
};

export function validateRevision(value: unknown): Revision {
  const row = exact(value, ["id", "kind", "predecessorId", "correctionReason", "data"]);
  text(row.id); oneOf(row.kind, Object.keys(fields));
  if (row.predecessorId !== null) text(row.predecessorId);
  if (row.correctionReason !== null) text(row.correctionReason);
  if ((row.predecessorId === null) !== (row.correctionReason === null)) refuse("correction-lineage-required");
  const kind = row.kind as Kind;
  const data = exact(row.data, fields[kind]);
  gameIdentity(data.gameId);
  if ("playerId" in data) playerIdentity(data.playerId);
  if ("rawPlayerId" in data) { text(data.rawPlayerId); if (data.rawPlayerId !== data.playerId) refuse("unqualified-player-bridge"); }
  for (const key of ["rawGameId", "rawTeam", "rawHomeTeam", "rawAwayTeam", "mappingVersion", "evidenceVersion"]) {
    if (key in data) text(data[key]);
  }
  for (const key of ["teamId", "homeTeamId", "awayTeamId"]) if (key in data) teamIdentity(data[key]);
  if ("season" in data) { integer(data.season, 1920, 9999); oneOf(data.seasonType, ["REG", "POST"]); }
  if (kind === "schedule") {
    integer(data.week, 1, 22); instant(data.kickoff);
    if (data.homeTeamId === data.awayTeamId) refuse("invalid-game-teams");
  } else if (kind === "membership") {
    text(data.position);
    if (instant(data.effectiveFrom) >= instant(data.effectiveTo)) refuse("invalid-effective-bounds");
  } else if (kind === "player-passing" || kind === "team-passing") {
    if (data.attempts !== null) integer(data.attempts, 0, 1_000);
    if (data.passingYards !== null) integer(data.passingYards, -10_000, 10_000);
    const missing = data.attempts === null || data.passingYards === null;
    if (missing) oneOf(data.missingReason, ["source-blank", "source-missing"]);
    else if (data.missingReason !== null) refuse("unexpected-missingness-reason");
  } else if (kind === "completion") {
    oneOf(data.state, ["confirmed", "unresolved"]);
    if (data.state === "confirmed") { instant(data.bound); oneOf(data.boundKind, ["actual-end", "completion-observed-at"]); }
    else if (data.bound !== null || data.boundKind !== null) refuse("unresolved-completion-bound");
  } else if (kind === "participation") oneOf(data.state, ["confirmed", "absent", "unresolved"]);
  else { oneOf(data.injury, ["unknown", "eligible", "excluded"]); oneOf(data.depth, ["unknown", "observed"]); }
  return value as Revision;
}

export function revisionKey(revision: Revision): string {
  const data = revision.data;
  return revision.kind + ":" + data.gameId + ("playerId" in data ? ":" + data.playerId : "teamId" in data ? ":" + data.teamId : "");
}

// Documentation allowlist v1 is executable; actual CSV adapter/header profiles
// are deliberately unregistered until exact release assets are qualified.
export const RAW_ALLOWLISTS = {
  player: "player_id player_name player_display_name position position_group season week season_type game_id team opponent_team attempts completions passing_yards passing_tds passing_interceptions carries rushing_yards targets receptions receiving_yards".split(" "),
  team: "season week season_type game_id team opponent_team attempts completions passing_yards passing_tds passing_interceptions carries rushing_yards targets receptions receiving_yards".split(" "),
  schedule: "game_id season game_type week gameday gametime away_team home_team location roof surface stadium_id stadium old_game_id gsis nfl_detail_id espn pfr".split(" "),
  identifiers: "gsis_id display_name common_first_name first_name last_name short_name football_name suffix nfl_id espn_id pfr_id smart_id esb_id position position_group".split(" "),
  roster: "season week game_type team gsis_id full_name first_name last_name football_name position jersey_number status status_description_abbr espn_id pfr_id sportradar_id".split(" "),
  injuries: "season season_type game_type team week gsis_id position full_name first_name last_name report_primary_injury report_secondary_injury report_status practice_primary_injury practice_secondary_injury practice_status".split(" "),
  depth: "dt team player_name espn_id gsis_id pos_grp_id pos_grp pos_id pos_name pos_abb pos_slot pos_rank".split(" "),
} as const;
export function validateRawHeader(feed: keyof typeof RAW_ALLOWLISTS, header: string[], required: string[]) {
  const allowed = RAW_ALLOWLISTS[feed];
  if (!allowed || !header.length || new Set(header).size !== header.length ||
      header.some((column) => !allowed.includes(column)) || required.some((column) => !header.includes(column))) refuse("raw-header-refused");
}

export function validateDataset(value: unknown): { dataset: Dataset; revisions: Map<string, Revision[]> } {
  const root = exact(value, ["formatVersion", "artifacts", "captures"]);
  if (root.formatVersion !== 1 || !Array.isArray(root.artifacts) || !Array.isArray(root.captures) ||
      root.artifacts.length > 256 || root.captures.length > 512) refuse("dataset-bounds-refused");
  const revisions = new Map<string, Revision[]>();
  const artifactIds = new Set<string>();
  for (const value of root.artifacts) {
    const artifact = exact(value, ["id", "sha256", "bytes", "source", "origin", "feed", "schemaVersion", "parserVersion", "rightsReviewVersion"]);
    text(artifact.id); text(artifact.origin); text(artifact.parserVersion); oneOf(artifact.feed, Object.keys(fields));
    if (artifact.source !== "synthetic" || artifact.schemaVersion !== "predictive-proof-v1" ||
        artifact.parserVersion !== "synthetic-json-v1" || artifact.rightsReviewVersion !== "synthetic-only-v1") refuse("unqualified-source-adapter");
    if (typeof artifact.bytes !== "string" || Buffer.byteLength(artifact.bytes) > 1_000_000 || artifact.sha256 !== digest(artifact.bytes)) refuse("artifact-integrity-failed");
    if (artifactIds.has(String(artifact.id))) refuse("duplicate-artifact-id");
    artifactIds.add(String(artifact.id));
    let parsed;
    try { parsed = JSON.parse(artifact.bytes); } catch { refuse("invalid-artifact-json"); }
    if (!Array.isArray(parsed) || parsed.length > 2_048) refuse("artifact-row-bounds-refused");
    const rows = parsed.map(validateRevision);
    if (rows.some((row) => row.kind !== artifact.feed)) refuse("artifact-feed-mismatch");
    revisions.set(String(artifact.id), rows);
  }
  const captureIds = new Map<string, string>();
  for (const value of root.captures) {
    const capture = exact(value, ["id", "artifactId", "capturedAt", "availableAt", "ingestedAt", "publishedAt", "publicationEvidence", "state"]);
    text(capture.id); text(capture.artifactId); oneOf(capture.state, ["published", "incomplete"]);
    if (!artifactIds.has(String(capture.artifactId))) refuse("artifact-missing");
    const captured = instant(capture.capturedAt), available = instant(capture.availableAt), ingested = instant(capture.ingestedAt);
    if (available < captured || ingested < available) refuse("capture-time-order-refused");
    if ((capture.publishedAt === null) !== (capture.publicationEvidence === null)) refuse("publication-evidence-required");
    if (capture.publishedAt !== null) {
      if (instant(capture.publishedAt) > captured) refuse("publication-time-refused");
      text(capture.publicationEvidence);
    }
    const prior = captureIds.get(String(capture.id));
    if (prior && prior !== canonical(capture)) refuse("capture-id-conflict");
    captureIds.set(String(capture.id), canonical(capture));
  }
  return { dataset: value as Dataset, revisions };
}
