import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Client } from "pg";
import type { PredictionRequest } from "@dfs-ev/pipeline/feature-store/predict";

export const CAPACITY_RULES = Object.freeze({ requests: 100, minimumPlayers: 20, minimumTeams: 16,
  maximumPlayerShare: .05, seasons: [2021, 2022, 2023, 2024, 2025], bands: ["2-4", "5-8", "9-16"],
  n: Array.from({ length: 15 }, (_, i) => i + 2) });
export type CapacityRequest = { featureId: string; cutoff: string; season: number; team: string; n: number;
  request: PredictionRequest };
export type CapacityManifest = { schemaVersion: 1; rules: typeof CAPACITY_RULES; requests: CapacityRequest[] };
export const capacityHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const historyBand = (n: number) => n <= 4 ? "2-4" : n <= 8 ? "5-8" : "9-16";
const cell = (r: CapacityRequest) => `${r.season}/${historyBand(r.n)}`;
const coordinate = (r: CapacityRequest) => `${r.request.playerId}/${r.request.gameId}`;
const count = (values: string[]) => Object.fromEntries(values.map(v => [v, values.filter(x => x === v).length]));
export const capacityCoverage = (requests: CapacityRequest[]) => ({
  players: count(requests.map(r => r.request.playerId)), teams: count(requests.map(r => r.team)),
  cells: count(requests.map(cell)), n: count(requests.map(r => String(r.n))),
});
export const validateCapacityManifest = (manifest: CapacityManifest) => {
  assert.equal(manifest.schemaVersion, 1); assert.deepEqual(manifest.rules, CAPACITY_RULES);
  const { requests } = manifest, coverage = capacityCoverage(requests);
  assert.equal(requests.length, 100); assert.equal(new Set(requests.map(coordinate)).size, 100);
  assert(Object.keys(coverage.players).length >= 20, "capacity-player-diversity");
  assert(Object.keys(coverage.teams).length >= 16, "capacity-team-diversity");
  assert(Math.max(...Object.values(coverage.players)) <= 5, "capacity-player-share");
  assert.deepEqual(Object.keys(coverage.n).map(Number).sort((a, b) => a - b), CAPACITY_RULES.n);
  assert.deepEqual(Object.keys(coverage.cells).sort(), CAPACITY_RULES.seasons.flatMap(s => CAPACITY_RULES.bands.map(b => `${s}/${b}`)).sort());
  const run = requests[0].request.runId, known = requests[0].request.knownAsOf;
  for (const r of requests) {
    assert(r.featureId && r.team && Number.isInteger(r.n));
    assert(Number.isFinite(Date.parse(r.cutoff)) && Date.parse(r.cutoff) <= Date.parse(known));
    assert.deepEqual(r.request, { playerId: r.request.playerId, gameId: r.request.gameId, knownAsOf: known,
      // Independent audit pins for this experiment, not production policy.
      // Keep the offline auditor runnable without workspace links/dependencies.
      runId: run, modelVersion: "empirical-integer-v1", scoringPolicy: "qb-empirical-evaluation-v1",
      featureVersion: "qb-passing-yards-feature-v1", historyPolicy: "prior-eligible-reg-max16-min2-cutoff1h-v1",
      evidenceMode: "retrospective-reconstruction-v1", line: 225.5 });
  }
  return coverage;
};

// Stratified deterministic greedy selection. All constraints are subsequently
// asserted; an impossible fixture refuses instead of weakening the workload.
export const selectCapacityManifest = (candidates: CapacityRequest[]): CapacityManifest => {
  const remaining = [...candidates].sort((a, b) => coordinate(a).localeCompare(coordinate(b)) || a.featureId.localeCompare(b.featureId));
  const selected: CapacityRequest[] = [], players = new Map<string, number>(), teams = new Map<string, number>();
  const cells = new Map<string, number>(), seenN = new Set<number>(), coordinates = new Set<string>();
  while (selected.length < CAPACITY_RULES.requests) {
    const eligible = remaining.filter(r => !coordinates.has(coordinate(r)) && (players.get(r.request.playerId) ?? 0) < 5);
    const score = (r: CapacityRequest) => [cells.has(cell(r)) ? 1 : 0, seenN.has(r.n) ? 1 : 0,
      players.get(r.request.playerId) ?? 0, teams.get(r.team) ?? 0, cells.get(cell(r)) ?? 0];
    eligible.sort((a, b) => {
      const x = score(a), y = score(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
      return coordinate(a).localeCompare(coordinate(b)) || a.featureId.localeCompare(b.featureId);
    });
    const next = eligible[0]; assert(next, "capacity-workload-exhausted"); selected.push(next);
    coordinates.add(coordinate(next)); seenN.add(next.n);
    for (const [map, key] of [[players, next.request.playerId], [teams, next.team], [cells, cell(next)]] as const)
      map.set(key, (map.get(key) ?? 0) + 1);
  }
  const manifest: CapacityManifest = { schemaVersion: 1, rules: CAPACITY_RULES, requests: selected };
  validateCapacityManifest(manifest); return manifest;
};

// Setup-only query. Identity/schedule metadata identifies team and position;
// labels, outcomes and dataset membership never decide which requests can run.
export const discoverCapacityRequests = async (admin: Client, runId: string, knownAsOf: string): Promise<CapacityRequest[]> => {
  const [{ MODEL_VERSION }, { QB_EVALUATOR_VERSION }, { FEATURE_VERSION, HISTORY_POLICY }, { NORMALIZER_VERSION }] =
    await Promise.all([import("@dfs-ev/domain/baseline"), import("@dfs-ev/domain/qb-evaluation"),
      import("../../src/featureStore/derived.ts"), import("../../src/featureStore/source.ts")]);
  return (await admin.query(`SELECT DISTINCT ON(f.player_id,f.game_id) f.feature_id,f.player_id,f.game_id,f.season,
    f.sample_size,f.cutoff::text,team.team FROM fs138.feature_values f JOIN fs138.job_runs j USING(job_id)
    CROSS JOIN LATERAL (SELECT i.team FROM fs138.norm_identity i JOIN fs138.norm_schedule g
      ON g.season=i.season AND g.week=i.week AND i.team IN(g.home_team,g.away_team)
      JOIN fs138.source_snapshots si ON si.snapshot_id=i.snapshot_id
      JOIN fs138.source_snapshots sg ON sg.snapshot_id=g.snapshot_id
      WHERE i.player_id=f.player_id AND g.game_id=f.game_id AND i.season=f.season AND i.position='QB'
       AND i.state='usable' AND g.state='usable' AND si.deleted_at IS NULL AND sg.deleted_at IS NULL
       AND i.normalizer_version=$4 AND g.normalizer_version=$4 ORDER BY i.team LIMIT 1) team
    WHERE f.state='usable' AND f.sample_size BETWEEN 2 AND 16 AND f.cutoff IS NOT NULL
      AND f.feature_version=$1 AND f.history_policy=$2 AND f.evidence_mode='retrospective-reconstruction-v1'
      AND f.computed_at<=$3 AND f.checkpoint<=$3 AND j.status='succeeded' AND j.finished_at<=$3
    ORDER BY f.player_id,f.game_id,f.checkpoint DESC,f.computed_at DESC,f.feature_id DESC`,
  [FEATURE_VERSION, HISTORY_POLICY, knownAsOf, NORMALIZER_VERSION])).rows.map(row => ({
    featureId: row.feature_id, n: row.sample_size, cutoff: row.cutoff, season: row.season, team: row.team,
    request: { runId, playerId: row.player_id, gameId: row.game_id, knownAsOf,
      modelVersion: MODEL_VERSION, scoringPolicy: QB_EVALUATOR_VERSION, featureVersion: FEATURE_VERSION,
      historyPolicy: HISTORY_POLICY, evidenceMode: "retrospective-reconstruction-v1", line: 225.5 },
  }));
};
