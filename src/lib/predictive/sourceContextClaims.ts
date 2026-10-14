import { parseSourceCsv, easternKickoff, type SourceRow } from "./sourceAdapters.ts";
import { canonical, digest, exact, PredictiveError, refuse, TEAM_IDS } from "./validation.ts";

export const SOURCE_CONTEXT_VERSION = "nflverse-original-context-claims-v1";
export const SOURCE_CONTEXT_BOUNDS = { bytes: 8_000_000, rows: 80_000 } as const;
export type ContextRequest = { captureId: string; feed: "schedule" | "identifiers"; wireSha256: string; wireBytes: number;
  seasonRange: { fromSeason: number; throughSeason: number } | null };
const namespaces = ["nfl_id", "espn_id", "pfr_id", "esb_id", "smart_id"] as const;
type Identity = { kind: "raw-player-identity"; gsisId: string; position: string;
  crosswalk: Record<(typeof namespaces)[number], string | null> };
type Schedule = { kind: "raw-schedule"; rawGameId: string; season: number; seasonType: "REG" | "POST"; week: number;
  rawHomeTeam: string; rawAwayTeam: string; rawGameday: string; rawGametime: string; kickoff: string };
export type ContextClaim = { id: string; rowOrdinal: number; rawKeySha256: string; selectedSha256: string;
  projection: Identity | Schedule | null; failureCode: string | null };
const teams = new Set(TEAM_IDS.map(id => id.slice("nfl:team:".length)));
const rawText = (value: string) => {
  if (!value || value.length > 128 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) refuse("context-identifier-refused");
  return value;
};
const project = (row: SourceRow, request: ContextRequest): Identity | Schedule => {
  if (request.feed === "identifiers") {
    if (!/^00-\d{7}$/.test(row.gsis_id)) refuse("context-gsis-refused");
    if (!/^[A-Z][A-Z0-9/-]{0,15}$/.test(row.position)) refuse("context-position-refused");
    return { kind: "raw-player-identity", gsisId: row.gsis_id, position: row.position,
      crosswalk: Object.fromEntries(namespaces.map(ns => [ns, !row[ns] || row[ns] === "NA" ? null : rawText(row[ns])])) as Identity["crosswalk"] };
  }
  const parts = /^(\d{4})_(\d{2})_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(row.game_id);
  const season = Number(row.season), week = Number(row.week);
  const seasonType = row.game_type === "REG" ? "REG" : ["POST", "WC", "DIV", "CON", "SB"].includes(row.game_type) ? "POST" : null;
  if (!parts || !/^\d{4}$/.test(row.season) || !/^\d{1,2}$/.test(row.week) || season < 1920 || week < 1 || week > 22 || !seasonType ||
      Number(parts[1]) !== season || Number(parts[2]) !== week || parts[3] !== row.away_team || parts[4] !== row.home_team ||
      !teams.has(row.home_team) || !teams.has(row.away_team) || row.home_team === row.away_team ||
      ![season, season + 1].includes(Number(row.gameday?.slice(0, 4)))) refuse("context-schedule-refused");
  const kickoff = easternKickoff(row.gameday, row.gametime);
  if (!kickoff) refuse("context-kickoff-refused");
  if (season < request.seasonRange!.fromSeason || season > request.seasonRange!.throughSeason) refuse("context-season-out-of-scope");
  return { kind: "raw-schedule", rawGameId: row.game_id, season, seasonType, week,
    rawHomeTeam: row.home_team, rawAwayTeam: row.away_team, rawGameday: row.gameday, rawGametime: row.gametime, kickoff };
};

/** Complete original CSV claims only. No canonical IDs, membership bounds or publication. */
export async function prepareSourceContextClaims(bytes: string, input: ContextRequest) {
  exact(input, ["captureId", "feed", "wireSha256", "wireBytes", "seasonRange"]);
  const request = structuredClone(input);
  if (!["schedule", "identifiers"].includes(request.feed) || typeof request.captureId !== "string" || !request.captureId.trim() ||
      request.captureId.length > 256 || /[\u0000-\u001f\u007f]/.test(request.captureId)) refuse("context-request-refused");
  if (request.feed === "identifiers") {
    if (request.seasonRange !== null) refuse("context-scope-refused");
  } else {
    exact(request.seasonRange, ["fromSeason", "throughSeason"]);
    const { fromSeason, throughSeason } = request.seasonRange!;
    if (!Number.isSafeInteger(fromSeason) || !Number.isSafeInteger(throughSeason) || fromSeason < 1920 || throughSeason > 9999 ||
        throughSeason - fromSeason !== 2) refuse("context-scope-refused");
  }
  if (typeof bytes !== "string" || !Number.isSafeInteger(request.wireBytes) || request.wireBytes < 1 || request.wireBytes > SOURCE_CONTEXT_BOUNDS.bytes ||
      Buffer.byteLength(bytes) !== request.wireBytes || !/^[a-f0-9]{64}$/.test(request.wireSha256) || digest(bytes) !== request.wireSha256) refuse("artifact-integrity-failed");
  const parsed = await parseSourceCsv(request.feed, bytes, SOURCE_CONTEXT_BOUNDS.rows);
  const rows: ContextClaim[] = parsed.rows.map((row, i) => {
    let projection: ContextClaim["projection"] = null, failureCode: string | null = null;
    try { projection = project(row, request); }
    catch (error) { if (!(error instanceof PredictiveError)) throw error; failureCode = error.code; }
    return { id: "context-row:" + digest(canonical([request.captureId, i + 1])), rowOrdinal: i + 1,
      rawKeySha256: digest(canonical([request.feed, request.feed === "schedule" ? row.game_id : row.gsis_id])),
      selectedSha256: digest(canonical(row)), projection, failureCode };
  });
  const byKey = new Map<string, ContextClaim[]>(), reverse = new Map<string, ContextClaim[]>();
  for (const row of rows) {
    const group = byKey.get(row.rawKeySha256) ?? []; group.push(row); byKey.set(row.rawKeySha256, group);
    if (request.feed === "identifiers") for (const ns of namespaces) {
      // Refused rows still participate in reverse ambiguity; a bad position or
      // missing GSIS must not make another row's shared provider ID look unique.
      const id = parsed.rows[row.rowOrdinal - 1][ns];
      if (!id || id === "NA" || id.length > 128 || id !== id.trim() || /[\u0000-\u001f\u007f]/.test(id)) continue;
      const key = canonical([ns, id]), group = reverse.get(key) ?? []; group.push(row); reverse.set(key, group);
    }
  }
  const conflicts = new Map<ContextClaim, string>();
  for (const group of byKey.values()) if (new Set(group.map(r => r.selectedSha256)).size > 1)
    for (const row of group) conflicts.set(row, "context-duplicate-key-conflict");
  for (const group of reverse.values()) if (new Set(group.map(r => parsed.rows[r.rowOrdinal - 1].gsis_id)).size > 1)
    for (const row of group) if (!conflicts.has(row)) conflicts.set(row, "context-reverse-identity-conflict");
  for (const [row, reason] of conflicts) { row.projection = null; row.failureCode = reason; }
  return { version: SOURCE_CONTEXT_VERSION, request, headerSha256: parsed.headerSha256, rows,
    claimsSha256: digest(canonical(rows)), selectedColumns: parsed.selectedColumns,
    canonicalEvidencePublished: false, membershipEffectiveBounds: "unqualified", independentScheduleCoverage: "unqualified",
    featuresPublished: false, labelsFinalized: false } as const;
}
