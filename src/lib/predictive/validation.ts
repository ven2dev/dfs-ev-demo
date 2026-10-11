import { createHash } from "node:crypto";
import { NFL_TEAM_ABBREVIATIONS } from "../nflStadiums.ts";
import { KINDS, STAT_FIELDS, type Artifact, type Capture, type Dataset, type Kind, type Observation,
  type Profile, type Revision, type RightsDecision, type Use } from "./types.ts";

export class PredictiveError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export const refuse: (code: string) => never = (code) => { throw new PredictiveError(code); };
export const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
// Stable code-unit order, independent of the machine's locale/ICU version.
export const compareText = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;
export const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
};
export const instant = (value: unknown): number => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) refuse("invalid-utc-instant");
  return Date.parse(value);
};
export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("invalid-record");
  return value as Record<string, unknown>;
};
export const exact = (value: unknown, keys: string[]) => {
  const row = object(value);
  if (Object.keys(row).sort().join(",") !== [...keys].sort().join(",")) refuse("schema-fields-refused");
  return row;
};
const text = (value: unknown) => { if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f]/.test(value)) refuse("invalid-identity"); };
const optionalText = (value: unknown) => { if (value !== null) text(value); };
const oneOf = (value: unknown, choices: readonly unknown[]) => { if (!choices.includes(value)) refuse("invalid-enum"); };
const boolean = (value: unknown) => { if (typeof value !== "boolean") refuse("invalid-enum"); };
export const gameIdentity = (value: unknown) => { if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) refuse("invalid-game-identity"); };
export const playerIdentity = (value: unknown) => { if (typeof value !== "string" || !/^00-\d{7}$/.test(value)) refuse("invalid-player-identity"); };
export const TEAM_IDS: readonly string[] = [...new Set(Object.values(NFL_TEAM_ABBREVIATIONS).map((team) => "nfl:team:" + team))].sort(compareText);
const teams = new Set(TEAM_IDS);
const teamIdentity = (value: unknown) => { if (typeof value !== "string" || !teams.has(value)) refuse("invalid-team-identity"); };
const integer = (value: unknown, min: number, max: number) => { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) refuse("invalid-numeric-value"); };
const optionalInteger = (value: unknown, min: number, max: number) => { if (value !== null) integer(value, min, max); };
const USES: readonly Use[] = ["adapter-testing", "internal-research", "model-input", "outcome-label", "public-display"];

// Schedule `gametime` is Eastern regardless of venue (nflverse dictionary).
// Repeated or nonexistent local times around DST changes are refused.
export const easternKickoff = (day: string, time: string): string | null => {
  if (!day || !time) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) refuse("source-kickoff-refused");
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const matches = [4, 5].map((offset) => {
    const value = Date.parse(`${day}T${time}:00.000Z`) + offset * 3_600_000;
    if (!Number.isFinite(value)) return null;
    const fields = Object.fromEntries(formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
    return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}` === `${day}T${time}`
      ? new Date(value).toISOString() : null;
  }).filter((value): value is string => value !== null);
  if (matches.length !== 1) refuse("source-kickoff-refused");
  return matches[0];
};

const STATS_BASE = ["gameId", "rawGameId", "teamId", "rawTeam", "season", "seasonType", ...STAT_FIELDS, "missing"];
const fields: Record<Kind, string[]> = {
  schedule: ["gameId", "rawGameId", "season", "seasonType", "week", "kickoff", "rawGameday", "rawGametime",
    "homeTeamId", "awayTeamId", "rawHomeTeam", "rawAwayTeam", "rawRoof", "rawSurface", "rawStadiumId"],
  "schedule-coverage": ["teamId", "fromSeason", "throughSeason", "gameIds", "state"],
  membership: ["gameId", "playerId", "teamId", "rawTeam", "position", "rosterStatus", "season", "seasonType", "week", "effectiveFrom", "effectiveTo"],
  "player-game-stats": [...STATS_BASE, "playerId"],
  "team-game-stats": STATS_BASE,
  "event-state-marker": ["gameId", "markerType", "markerValue", "terminalPlayTimeOfDay"],
  "participation-evidence": ["gameId", "playerId", "teamId", "evidenceKind", "claim"],
  availability: ["gameId", "playerId", "teamId", "rawReportStatus", "rawPracticeStatus", "rawDepthRank"],
};
const MARKERS = ["provider-final-status", "terminal-play", "final-team-totals", "suspension-notice", "postponement-notice"];

const validateStats = (data: Record<string, unknown>) => {
  const missing = object(data.missing);
  for (const key of Object.keys(missing)) {
    if (!(STAT_FIELDS as readonly string[]).includes(key)) refuse("schema-fields-refused");
    oneOf(missing[key], ["source-blank", "source-missing"]);
  }
  for (const field of STAT_FIELDS) {
    const value = data[field];
    if (value === null) { if (!(field in missing)) refuse("missingness-reason-required"); continue; }
    if (field in missing) refuse("unexpected-missingness-reason");
    if (field.endsWith("Yards")) integer(value, -10_000, 10_000); else integer(value, 0, 1_000);
  }
  if (data.attempts !== null && data.completions !== null && Number(data.completions) > Number(data.attempts)) refuse("completions-exceed-attempts");
  if (data.targets !== null && data.receptions !== null && Number(data.receptions) > Number(data.targets)) refuse("receptions-exceed-targets");
};

export const validateRevision = (value: unknown): Revision => {
  const row = exact(value, ["id", "kind", "sourceRecordId", "predecessorId", "correctionReason", "data"]);
  text(row.id); oneOf(row.kind, KINDS);
  if (typeof row.sourceRecordId !== "string" || row.sourceRecordId.length > 256 || /[\u0000-\u001f|]/.test(row.sourceRecordId)) refuse("invalid-identity");
  if (row.predecessorId !== null) text(row.predecessorId);
  if (row.correctionReason !== null) text(row.correctionReason);
  if ((row.predecessorId === null) !== (row.correctionReason === null)) refuse("correction-lineage-required");
  const kind = row.kind as Kind;
  const data = exact(row.data, fields[kind]);
  if (kind !== "schedule-coverage") gameIdentity(data.gameId);
  if ("playerId" in data) playerIdentity(data.playerId);
  for (const key of ["rawGameId", "rawTeam", "rawHomeTeam", "rawAwayTeam", "position", "rosterStatus", "markerValue"]) if (key in data) text(data[key]);
  for (const key of ["teamId", "homeTeamId", "awayTeamId"]) if (key in data) teamIdentity(data[key]);
  if ("season" in data) { integer(data.season, 1920, 9999); oneOf(data.seasonType, ["REG", "POST"]); }
  if (kind === "schedule") {
    integer(data.week, 1, 22); instant(data.kickoff);
    if (data.homeTeamId === data.awayTeamId) refuse("invalid-game-teams");
    for (const key of ["rawRoof", "rawSurface", "rawStadiumId"]) optionalText(data[key]);
    if ((data.rawGameday === null) !== (data.rawGametime === null)) refuse("source-kickoff-refused");
    if (data.rawGameday !== null && easternKickoff(String(data.rawGameday), String(data.rawGametime)) !== data.kickoff) refuse("source-kickoff-refused");
  } else if (kind === "schedule-coverage") {
    integer(data.fromSeason, 1920, 9999); integer(data.throughSeason, 1920, 9999);
    if (Number(data.throughSeason) - Number(data.fromSeason) !== 2) refuse("invalid-coverage-range");
    oneOf(data.state, ["complete", "incomplete"]);
    if (!Array.isArray(data.gameIds) || data.gameIds.length > 256 || new Set(data.gameIds).size !== data.gameIds.length) refuse("invalid-coverage-games");
    data.gameIds.forEach(gameIdentity);
  } else if (kind === "membership") {
    integer(data.week, 1, 22);
    if (instant(data.effectiveFrom) >= instant(data.effectiveTo)) refuse("invalid-effective-bounds");
  } else if (kind === "player-game-stats" || kind === "team-game-stats") {
    validateStats(data);
  } else if (kind === "event-state-marker") {
    oneOf(data.markerType, MARKERS);
    if (data.markerType === "terminal-play") {
      if (typeof data.terminalPlayTimeOfDay !== "string" || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(data.terminalPlayTimeOfDay)) refuse("invalid-marker-time");
    } else if (data.terminalPlayTimeOfDay !== null) refuse("invalid-marker-time");
  } else if (kind === "participation-evidence") {
    oneOf(data.evidenceKind, ["participation-feed", "official-inactive-list", "provider-snap-count"]);
    oneOf(data.claim, ["offensive-participant", "zero-offensive-participation", "inactive-or-dnp"]);
    if (data.evidenceKind === "official-inactive-list" && data.claim !== "inactive-or-dnp") refuse("invalid-participation-claim");
  } else {
    optionalText(data.rawReportStatus); optionalText(data.rawPracticeStatus); optionalInteger(data.rawDepthRank, 1, 20);
  }
  return value as Revision;
};

// Entity key: what the fact is about, never which provider said it. Identical
// to public.predictive_entity_key in migration 0003.
export const entityKey = (revision: Revision): string => {
  if (revision.kind === "schedule-coverage") {
    const data = revision.data;
    return "schedule-coverage:" + data.teamId + ":" + data.fromSeason + ":" + data.throughSeason;
  }
  if (revision.kind === "event-state-marker") return "event-state-marker:" + revision.data.gameId + ":" + revision.data.markerType;
  if (revision.kind === "participation-evidence") {
    const data = revision.data;
    return "participation-evidence:" + data.gameId + ":" + data.playerId + ":" + data.evidenceKind;
  }
  if (revision.kind === "team-game-stats") return "team-game-stats:" + revision.data.gameId + ":" + revision.data.teamId;
  const data = revision.data;
  return revision.kind + ":" + data.gameId + ("playerId" in data ? ":" + data.playerId : "");
};
// Source key: one provider's revision chain for that fact.
export const sourceKey = (revision: Revision, profileId: string) => entityKey(revision) + "|" + profileId + "|" + revision.sourceRecordId;

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
export const validateRawHeader = (feed: keyof typeof RAW_ALLOWLISTS, header: string[], required: string[]) => {
  const allowed = RAW_ALLOWLISTS[feed];
  if (!allowed || !header.length || new Set(header).size !== header.length ||
      header.some((column) => !allowed.includes(column)) || required.some((column) => !header.includes(column))) refuse("raw-header-refused");
};

const PROFILE_FIELDS = ["id", "purpose", "provider", "feed", "releaseTag", "assetPattern", "headerProfileSha256",
  "parserVersion", "allowlistVersion", "license", "attribution", "evidenceKinds", "registeredAt"];
export const validateProfile = (value: unknown): Profile => {
  const row = exact(value, PROFILE_FIELDS);
  if (typeof row.id !== "string" || !/^[a-z0-9][a-z0-9.-]{2,127}$/.test(row.id)) refuse("invalid-profile");
  oneOf(row.purpose, ["source", "owner-decision", "synthetic-test"]);
  for (const key of ["provider", "feed", "parserVersion", "allowlistVersion", "license"]) text(row[key]);
  for (const key of ["releaseTag", "assetPattern", "attribution"]) optionalText(row[key]);
  if (row.headerProfileSha256 !== null && (typeof row.headerProfileSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.headerProfileSha256))) refuse("invalid-profile");
  if (!Array.isArray(row.evidenceKinds) || !row.evidenceKinds.length || new Set(row.evidenceKinds).size !== row.evidenceKinds.length) refuse("invalid-profile");
  row.evidenceKinds.forEach((kind) => oneOf(kind, KINDS));
  instant(row.registeredAt);
  return value as Profile;
};
const RIGHTS_FIELDS = ["id", "profileId", "predecessorId", "allowedUses", "effectiveFrom", "effectiveTo", "decidedAt", "evidenceKind", "evidenceReference"];
export const validateRightsDecision = (value: unknown, profiles: Map<string, Profile>): RightsDecision => {
  const row = exact(value, RIGHTS_FIELDS);
  text(row.id); text(row.evidenceReference);
  const profile = profiles.get(String(row.profileId)) ?? refuse("profile-missing");
  if (row.predecessorId !== null) text(row.predecessorId);
  if (!Array.isArray(row.allowedUses) || new Set(row.allowedUses).size !== row.allowedUses.length) refuse("invalid-rights");
  row.allowedUses.forEach((use) => oneOf(use, USES));
  oneOf(row.evidenceKind, ["terms-review", "written-confirmation", "license-file", "revocation", "synthetic"]);
  if (row.evidenceKind === "revocation" && row.allowedUses.length) refuse("invalid-rights");
  if (profile.purpose === "synthetic-test" && (row.evidenceKind !== "synthetic" || row.allowedUses.includes("public-display"))) refuse("synthetic-rights-refused");
  if (profile.purpose !== "synthetic-test" && row.evidenceKind === "synthetic") refuse("synthetic-rights-refused");
  const from = instant(row.effectiveFrom); instant(row.decidedAt);
  if (row.effectiveTo !== null && instant(row.effectiveTo) <= from) refuse("invalid-rights");
  return value as RightsDecision;
};
// One linear chain per profile: one root, at most one successor per decision,
// same-profile predecessors and non-decreasing knowledge time.
const validateRightsChains = (decisions: RightsDecision[]) => {
  const byId = new Map<string, RightsDecision>();
  for (const decision of decisions) {
    if (byId.has(decision.id)) refuse("duplicate-rights-decision");
    byId.set(decision.id, decision);
  }
  const roots = new Set<string>(), successors = new Set<string>();
  for (const decision of decisions) {
    if (decision.predecessorId === null) {
      if (roots.has(decision.profileId)) refuse("rights-chain-branch-refused");
      roots.add(decision.profileId); continue;
    }
    const prior = byId.get(decision.predecessorId) ?? refuse("rights-predecessor-missing");
    if (prior.profileId !== decision.profileId) refuse("rights-predecessor-profile-refused");
    if (successors.has(prior.id)) refuse("rights-chain-branch-refused");
    successors.add(prior.id);
    if (instant(decision.decidedAt) < instant(prior.decidedAt)) refuse("rights-decision-order-refused");
  }
};
// The decision that applies at effective instant e using only decisions known by
// instant k: the last link of the profile's chain that is known and effective.
export const rightsInForce = (decisions: RightsDecision[], profileId: string, e: number, k: number): RightsDecision | null => {
  const chain = decisions.filter((decision) => decision.profileId === profileId);
  const next = new Map(chain.filter((decision) => decision.predecessorId !== null).map((decision) => [decision.predecessorId!, decision]));
  let link = chain.find((decision) => decision.predecessorId === null);
  let found: RightsDecision | null = null;
  while (link) {
    const effectiveTo = link.effectiveTo === null ? Infinity : instant(link.effectiveTo);
    if (instant(link.decidedAt) <= k && instant(link.effectiveFrom) <= e && e < effectiveTo) found = link;
    link = next.get(link.id);
  }
  return found;
};
export const allows = (decision: RightsDecision | null, use: Use) => decision !== null && decision.allowedUses.includes(use);

const ARTIFACT_FIELDS = ["id", "sha256", "bytes", "profileId", "retrievalKind", "origin", "providerEtag", "providerLastModified",
  "releaseUpdatedAt", "scopeKind", "scopeSeason", "scopeWeek", "scopeFilter"];
const CAPTURE_FIELDS = ["id", "artifactId", "capturedAt", "availableAt", "ingestedAt", "publishedAt", "publicationEvidence", "state",
  "bodyComplete", "headerVerified", "parserSucceeded", "parsedRows"];

export const datasetContainer = (value: unknown) => {
  const root = exact(value, ["formatVersion", "profiles", "rightsDecisions", "artifacts", "captures"]);
  if (root.formatVersion !== 2 || !Array.isArray(root.profiles) || !Array.isArray(root.rightsDecisions) ||
      !Array.isArray(root.artifacts) || !Array.isArray(root.captures)) refuse("dataset-bounds-refused");
  return { formatVersion: 2 as const, profiles: root.profiles, rightsDecisions: root.rightsDecisions, artifacts: root.artifacts, captures: root.captures };
};

const captureOrder = (a: Observation, b: Observation): number =>
  instant(a.capture.ingestedAt) - instant(b.capture.ingestedAt) ||
  instant(a.capture.availableAt) - instant(b.capture.availableAt) ||
  instant(a.capture.capturedAt) - instant(b.capture.capturedAt) || compareText(a.capture.id, b.capture.id);

export const observation = <K extends Kind>(revision: Revision<K>, capture: Capture, artifact: Artifact): Observation<K> =>
  ({ revision, capture, artifact, entityKey: entityKey(revision), sourceKey: sourceKey(revision, artifact.profileId) });

// Publication/ingestion validation and replay use the same identity and lineage
// rules. Replay supplies only published, cutoff-known captures to this check.
export const validateObservations = (rows: Observation[]): Map<string, Observation> => {
  const observations = new Map<string, Observation>();
  for (const row of rows) {
    const { revision } = row;
    const prior = observations.get(revision.id);
    if (prior && (canonical(prior.revision) !== canonical(revision) || prior.artifact.profileId !== row.artifact.profileId)) refuse("observation-id-conflict");
    if (!prior || captureOrder(row, prior) < 0) observations.set(revision.id, row);
  }
  const successors = new Set<string>();
  for (const row of observations.values()) {
    const revision = row.revision;
    if (revision.predecessorId === null) continue;
    const prior = observations.get(revision.predecessorId);
    // A correction stays inside one provider's chain for one fact.
    if (!prior || prior.sourceKey !== row.sourceKey ||
        instant(prior.capture.availableAt) > instant(row.capture.availableAt) ||
        instant(prior.capture.ingestedAt) > instant(row.capture.ingestedAt)) refuse("invalid-correction-lineage");
    if (successors.has(prior.revision.id)) refuse("correction-branch-refused");
    successors.add(prior.revision.id);
    const seen = new Set([revision.id]);
    let ancestor: Revision | undefined = prior.revision;
    while (ancestor) {
      if (seen.has(ancestor.id)) refuse("cyclic-correction-lineage");
      seen.add(ancestor.id);
      ancestor = ancestor.predecessorId === null ? undefined : observations.get(ancestor.predecessorId)?.revision;
    }
  }
  return observations;
};

export const validateDataset = (value: unknown) => {
  const root = datasetContainer(value);
  if (root.profiles.length > 64 || root.rightsDecisions.length > 256 || root.artifacts.length > 256 || root.captures.length > 512) refuse("dataset-bounds-refused");
  const profiles = new Map<string, Profile>();
  for (const item of root.profiles) {
    const profile = validateProfile(item);
    if (profiles.has(profile.id)) refuse("duplicate-profile");
    profiles.set(profile.id, profile);
  }
  const rightsDecisions = root.rightsDecisions.map((item) => validateRightsDecision(item, profiles));
  validateRightsChains(rightsDecisions);
  const revisions = new Map<string, Revision[]>();
  const artifacts = new Map<string, Artifact>();
  for (const value of root.artifacts) {
    const artifact = exact(value, ARTIFACT_FIELDS);
    text(artifact.id); text(artifact.origin);
    if (typeof artifact.origin !== "string" || !/^(https|fixture):\/\//.test(artifact.origin)) refuse("invalid-artifact-origin");
    const profile = profiles.get(String(artifact.profileId)) ?? refuse("profile-missing");
    oneOf(artifact.retrievalKind, ["full", "header-probe"]);
    oneOf(artifact.scopeKind, ["season-file", "week-file", "game", "all-seasons", "manual"]);
    for (const key of ["providerEtag", "providerLastModified", "scopeFilter"]) optionalText(artifact[key]);
    if (artifact.releaseUpdatedAt !== null) instant(artifact.releaseUpdatedAt);
    optionalInteger(artifact.scopeSeason, 1920, 9999); optionalInteger(artifact.scopeWeek, 1, 22);
    if ((artifact.scopeKind === "week-file") !== (artifact.scopeWeek !== null)) refuse("invalid-artifact-scope");
    if (typeof artifact.bytes !== "string" || Buffer.byteLength(artifact.bytes) > 1_000_000 || artifact.sha256 !== digest(artifact.bytes)) refuse("artifact-integrity-failed");
    if (artifacts.has(String(artifact.id))) refuse("duplicate-artifact-id");
    artifacts.set(String(artifact.id), artifact as Artifact);
    let parsed;
    try { parsed = JSON.parse(artifact.bytes); } catch { refuse("invalid-artifact-json"); }
    if (!Array.isArray(parsed) || parsed.length > 2_048) refuse("artifact-row-bounds-refused");
    if (artifact.retrievalKind === "header-probe" && parsed.length) refuse("header-probe-rows-refused");
    const rows = parsed.map(validateRevision);
    if (rows.some((row) => !profile.evidenceKinds.includes(row.kind))) refuse("artifact-kind-not-in-profile");
    if (new Set(rows.map((row) => row.id)).size !== rows.length) refuse("duplicate-artifact-observation");
    revisions.set(String(artifact.id), rows);
  }
  const captureIds = new Map<string, string>();
  for (const value of root.captures) {
    const capture = exact(value, CAPTURE_FIELDS);
    text(capture.id); text(capture.artifactId); oneOf(capture.state, ["published", "incomplete"]);
    for (const key of ["bodyComplete", "headerVerified", "parserSucceeded"]) boolean(capture[key]);
    integer(capture.parsedRows, 0, 1_000_000);
    const artifact = artifacts.get(String(capture.artifactId)) ?? refuse("artifact-missing");
    const captured = instant(capture.capturedAt), available = instant(capture.availableAt), ingested = instant(capture.ingestedAt);
    if (available < captured || ingested < available) refuse("capture-time-order-refused");
    if ((capture.publishedAt === null) !== (capture.publicationEvidence === null)) refuse("publication-evidence-required");
    if (capture.publishedAt !== null) {
      if (instant(capture.publishedAt) > captured) refuse("publication-time-refused");
      text(capture.publicationEvidence);
    }
    if (capture.state === "published") {
      if (!capture.bodyComplete || !capture.headerVerified || !capture.parserSucceeded) refuse("incomplete-capture-published");
      if (capture.parsedRows !== revisions.get(artifact.id)!.length) refuse("capture-row-count-mismatch");
      // Historical authorization: only rights known when the bytes were captured.
      const decision = rightsInForce(rightsDecisions, artifact.profileId, captured, captured);
      if (!allows(decision, "internal-research")) refuse("rights-not-in-force");
    }
    const prior = captureIds.get(String(capture.id));
    if (prior && prior !== canonical(capture)) refuse("capture-id-conflict");
    captureIds.set(String(capture.id), canonical(capture));
  }
  const dataset = value as Dataset;
  const observations = validateObservations(dataset.captures.flatMap((capture) => capture.state !== "published" ? [] :
    revisions.get(capture.artifactId)!.map((revision) => observation(revision, capture, artifacts.get(capture.artifactId)!))));
  return { dataset, profiles, rightsDecisions, revisions, observations };
};
