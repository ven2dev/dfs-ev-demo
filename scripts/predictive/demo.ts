import assert from "node:assert/strict";
import { assertNoApplicationCredentials } from "../../tests/db/target.mts";
import { buildPassingYardsBundle } from "../../src/lib/predictive/passingYards.ts";
import { addCapture, CUTOFF_B, passingYardsFixture, PRIOR, request, revision } from "../../tests/predictive/fixtures/passingYards.ts";

try {
  assertNoApplicationCredentials(process.env);
  if (process.env.TEST_DATABASE_URL !== undefined || process.env.NEON_API_KEY !== undefined || process.argv.length !== 2) throw new Error("demo-configuration-refused");
  const capturedA = buildPassingYardsBundle(passingYardsFixture(false), request());
  const dataset = passingYardsFixture();
  const replayA = buildPassingYardsBundle(dataset, request());
  const laterB = buildPassingYardsBundle(dataset, request(CUTOFF_B));
  addCapture(dataset, "unresolved-completion", [revision("completion-unresolved", "completion", {
    gameId: PRIOR[4], state: "unresolved", bound: null, boundKind: null, evidenceVersion: "synthetic-suspended-v1",
  }, "complete-synthetic-game-5")], "2026-10-08T13:30:00.000Z");
  const unavailable = buildPassingYardsBundle(dataset, request(CUTOFF_B));
  assert.equal(capturedA.status, "ready-inputs");
  assert.equal(replayA.inputDigest, capturedA.inputDigest);
  assert.equal(laterB.status, "ready-inputs");
  assert.notEqual(laterB.inputDigest, replayA.inputDigest);
  assert.equal(unavailable.status, "unavailable-inputs");
  console.log(JSON.stringify({ proof: "synthetic-cutoff-replay-v1", earlierReplayUnchanged: true,
    capturedA, replayA, laterB, unavailable }, null, 2));
} catch {
  // Fixed text only: never echo ambient credentials or rejected artifact bytes.
  console.error("Predictive synthetic demo refused or its replay assertions failed.");
  process.exitCode = 1;
}
