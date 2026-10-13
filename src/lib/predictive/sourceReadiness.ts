import type { ArtifactStore } from "./artifacts.ts";
import type { SourceFeed, SourceRow } from "./sourceAdapters.ts";
import { SOURCE_SAMPLE_SEASON, sourceInteger } from "./sourceAdapters.ts";
import { readVerifiedSourcePrototype, type SourceReference } from "./sourcePrototype.ts";
import { qualifySourceSamples } from "./sourceQualification.ts";
import { hasPositiveSourceUsage, indexSourceRows, projectSourceStats, SOURCE_STATS_VERSION, sourceSeasonType, sourceStatsKey,
  type SourceStats } from "./sourceStats.ts";
import { canonical, compareText, digest, PredictiveError, refuse } from "./validation.ts";

type Samples = Partial<Record<SourceFeed, SourceRow[]>>;
const rosterKey = (row: SourceRow) => canonical([row.season, sourceSeasonType(row), row.week, row.team, row.gsis_id]);
const scheduleKey = (row: SourceRow, team: string) => canonical([row.season, sourceSeasonType(row), row.week, team]);
const refusalCode = (error: unknown) => error instanceof PredictiveError ? error.code : "source-stats-projection-refused";

// PR B qualification over verified selected fields. Positive usage establishes
// an individual source claim, never completion, a zero/DNP or full population.
export const assessSourceSamples = (samples: Samples, season: number, targetGameId: string) => {
  if (season !== SOURCE_SAMPLE_SEASON) refuse("source-scope-refused");
  const baseline = qualifySourceSamples(samples, season, targetGameId);
  const schedules = indexSourceRows(samples.schedule ?? [], (row) => row.game_id);
  const identifiers = indexSourceRows(samples.identifiers ?? [], (row) => row.gsis_id);
  const players = indexSourceRows(samples.player ?? [], (row) => sourceStatsKey(row));
  const roster = indexSourceRows(samples.roster ?? [], rosterKey);
  // A contradictory non-QB row cannot erase a QB candidate. Malformed current
  // season QB context is counted as unresolved rather than silently dropped.
  const qbKeys = new Set((samples.roster ?? []).filter((row) => row.position === "QB" && Number(row.season) === season).map(rosterKey));
  const projections = new Map<string, SourceStats>(); const refused = new Map<string, string>();
  const statsInventory = { player: { sourceRows: 0, projectedRows: 0, refusedRows: 0, reasons: {} as Record<string, number> },
    team: { sourceRows: 0, projectedRows: 0, refusedRows: 0, reasons: {} as Record<string, number> } };
  for (const feed of ["player", "team"] as const) for (const row of samples[feed] ?? []) {
    const inventory = statsInventory[feed]; inventory.sourceRows++;
    try {
      const projected = projectSourceStats(feed, row);
      if (projected.season !== season) refuse("source-stats-scope-refused");
      inventory.projectedRows++;
      if (feed === "player") projections.set(sourceStatsKey(row), projected);
    } catch (error) {
      const code = refusalCode(error); inventory.refusedRows++; inventory.reasons[code] = (inventory.reasons[code] ?? 0) + 1;
      if (feed === "player") refused.set(sourceStatsKey(row), code);
    }
  }
  const gamesByTeamWeek = new Map<string, SourceRow[]>();
  for (const row of schedules.map.values()) for (const team of [row.home_team, row.away_team]) {
    const key = scheduleKey(row, team); const games = gamesByTeamWeek.get(key) ?? []; games.push(row); gamesByTeamWeek.set(key, games);
  }
  const participation = { candidates: 0, positiveUsageIndividuals: 0, confirmedAbsent: 0, unresolved: 0,
    unresolvedReasons: {} as Record<string, number> };
  const hashes = (index: ReturnType<typeof indexSourceRows>, key: string) => [...(index.fingerprints.get(key) ?? [])].sort(compareText);
  const candidates: { key: string; state: "positive-usage" | "unresolved"; reason: string | null;
    roster: string[]; identities: string[]; schedules: string[]; statistics: string[] }[] = [];
  for (const row of roster.map.values()) {
    if (!qbKeys.has(rosterKey(row))) continue;
    participation.candidates++;
    const key = rosterKey(row); let reason: string | null = null; let stats: SourceStats | undefined;
    const games = gamesByTeamWeek.get(scheduleKey(row, row.team)) ?? [];
    const statKeys = games.map((game) => sourceStatsKey({ game_id: game.game_id, team: row.team, player_id: row.gsis_id }));
    let validRosterContext = false;
    try { validRosterContext = sourceInteger(row.season, season, season) === season && sourceInteger(row.week, 1, 22) !== null && sourceSeasonType(row) !== null; }
    catch { /* An invalid candidate is still part of the unresolved count. */ }
    if (!/^00-\d{7}$/.test(row.gsis_id) || !identifiers.map.has(row.gsis_id)) reason = "player-identity-missing";
    else if (identifiers.conflicts.has(row.gsis_id)) reason = "player-identity-ambiguous";
    else if (roster.conflicts.has(key)) reason = "roster-conflicting";
    else if (!validRosterContext) reason = "player-roster-context-refused";
    else if (games.length !== 1 || games.some((game) => schedules.conflicts.has(game.game_id))) reason = "player-schedule-unresolved";
    else {
      const game = games[0]; const match = sourceStatsKey({ game_id: game.game_id, team: row.team, player_id: row.gsis_id });
      stats = projections.get(match);
      if (players.conflicts.has(match)) reason = "player-stats-conflicting";
      else if (refused.has(match)) reason = refused.get(match)!;
      else if (!stats) reason = "player-stats-missing";
      else if (stats.season !== season || stats.seasonType !== sourceSeasonType(game) || stats.week !== Number(game.week) ||
          stats.rawOpponent !== (row.team === game.home_team ? game.away_team : game.home_team)) reason = "player-stats-schedule-conflicting";
      else if (!hasPositiveSourceUsage(stats)) reason = "offensive-participation-unresolved";
    }
    if (reason) { participation.unresolved++; participation.unresolvedReasons[reason] = (participation.unresolvedReasons[reason] ?? 0) + 1; }
    else participation.positiveUsageIndividuals++;
    candidates.push({ key, state: reason ? "unresolved" : "positive-usage", reason,
      roster: hashes(roster, key), identities: hashes(identifiers, row.gsis_id),
      schedules: [...new Set(games.flatMap((game) => hashes(schedules, game.game_id)))].sort(compareText),
      statistics: [...new Set(statKeys.flatMap((match) => hashes(players, match)))].sort(compareText) });
  }
  candidates.sort((a, b) => compareText(a.key, b.key));
  return { assessmentVersion: "nflverse-source-readiness-v1", projectionVersion: SOURCE_STATS_VERSION,
    season, target: baseline.target, candidate: "stats-v1:player_pass_yds", statistics: statsInventory, qbParticipation: participation,
    candidateEvidenceDigest: digest(canonical(candidates)), selectedProjectionDigest: baseline.selectedProjectionDigest,
    sourceDiagnostics: baseline.counts, populationCoverage: "unqualified", historicalCutoffCoverage: "unverified",
    featureStatus: "unavailable-inputs", featuresPublished: false, labelsFinalized: false, modelValidated: false,
    gates: ["completion-source-unqualified", "complete-offensive-population-unqualified", "independent-schedule-enumeration-unqualified",
      "canonical-event-bridge-unqualified", "weekly-membership-effective-bounds-unqualified", "prior-season-source-samples-missing",
      "csv-persistence-not-implemented"],
    notes: ["Positive attempts, carries or targets support only an individual source participation claim under approved F3.",
      "Zero, missing stats and weekly ACT never establish absence, a zero label or complete population coverage.",
      "Source projections retain raw identities; they are not canonical SQL observations or finalized outcome labels."] };
};

export const assessSourcePrototype = async (store: ArtifactStore, journal: SourceReference) => {
  const verified = await readVerifiedSourcePrototype(store, journal);
  if (verified.reportStatus === "refused") refuse("source-assessment-capture-refused");
  return { journal, captureFinishedAt: verified.finishedAt, assessment: assessSourceSamples(verified.samples, verified.season, verified.targetGameId) };
};
