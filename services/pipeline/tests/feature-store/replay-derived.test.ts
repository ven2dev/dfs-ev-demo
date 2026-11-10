import { expect, it } from "vitest";
import { assertDerivedParity } from "../../scripts/feature-store/replay-derived.ts";

const row = {
  player_id: "00-0000001", game_id: "2025_01_A_B", stat: "passing_yards", season: 2025,
  feature_version: "v1", history_policy: "p1", evidence_mode: "retrospective-reconstruction-v1",
  cutoff: "2025-09-07T17:00:00.000001Z", state: "usable", reasons: [], flags: [], sample_size: 2,
  history: [{ gameId: "a", yards: 9, kickoff: "2024-12-01T15:00:00Z" }, { gameId: "b", yards: 6, kickoff: "2024-11-24T15:00:00Z" }],
  history_gaps: [],
};

it("keeps historical order and microseconds while ignoring generated output identity", () => {
  const replayed = { ...row, feature_id: "fresh", computed_at: "fresh",
    cutoff: "2025-09-07 13:00:00.000001-04", history: row.history.map(({ gameId, yards, kickoff }) => ({ kickoff, yards, gameId })) };
  expect(assertDerivedParity("features", [row], [replayed]).rows).toBe(1);
  expect(() => assertDerivedParity("features", [row], [{ ...replayed, history: [...replayed.history].reverse() }]))
    .toThrow("replay-derived-value-mismatch");
  expect(() => assertDerivedParity("features", [row], [{ ...replayed, cutoff: "2025-09-07T17:00:00.000002Z" }]))
    .toThrow("replay-derived-value-mismatch");
  expect(() => assertDerivedParity("features", [row], [replayed, replayed])).toThrow("replay-derived-duplicate-key");
});

it("refuses an injected label value mismatch", () => {
  const label = { ...row, label_version: "v1", label_cutoff: row.cutoff, value: 24 };
  expect(() => assertDerivedParity("labels", [label], [{ ...label, value: 25 }])).toThrow("replay-derived-value-mismatch");
});
