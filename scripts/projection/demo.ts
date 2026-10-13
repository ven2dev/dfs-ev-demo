import { evaluate } from "../../src/lib/projection/evaluation.ts";
import { serializeReport } from "../../src/lib/projection/report.ts";
import type { Input, Observation } from "../../src/lib/projection/baseline.ts";

// Synthetic proof only. No provider, database or production credentials are used.
const history: Observation[] = [-2, 0, 2, 2].map((value, index) => ({
  id: `synthetic-label-${index}`, eventId: `synthetic-game-${index}`,
  eventTime: `2026-09-0${index + 1}T00:00:00Z`,
  featureAvailableAt: "2026-09-10T00:00:00Z", identityAvailableAt: "2026-09-10T00:00:00Z",
  labelAvailableAt: "2026-09-10T00:00:00Z", featureVersion: "synthetic-f1",
  labelVersion: "synthetic-l1", value, participation: "offensive",
}));
const input: Input = {
  market: "player_pass_yds", targetEventId: "synthetic-target", targetEventTime: "2026-10-02T00:00:00Z",
  cutoff: "2026-10-01T00:00:00Z", featureVersion: "synthetic-f1", labelVersion: "synthetic-l1",
  minimumSamples: 2, history,
};
const label: Observation = { ...history[0], id: "synthetic-target-label", eventId: input.targetEventId,
  eventTime: input.targetEventTime, labelAvailableAt: "2026-10-03T00:00:00Z", value: 0 };
const report = evaluate([0, .5, 100].map(line => ({ input, label, line })), {
  evaluatedAt: "2026-10-04T00:00:00Z", codeArtifactId: "synthetic-demo-v1",
  coverage: { training: { covered: 4, excluded: 0, unresolved: 0 }, evaluation: { covered: 1, excluded: 0, unresolved: 0 },
    featureHistory: { covered: 4, excluded: 0, unresolved: 0 }, qualifiedLedgerVersion: null },
});
console.log(serializeReport(report));
