import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { readVerifiedSourcePrototype } from "../../src/lib/predictive/sourcePrototype.ts";
import { inventoryQbSlice } from "../../src/lib/predictive/qbSliceInventory.ts";
import { assertNoApplicationCredentials } from "../../tests/db/target.mts";

export async function runQbInventory(args: string[], environment: NodeJS.ProcessEnv) {
  assertNoApplicationCredentials(environment);
  const [rootFlag, root, journalFlag, reference, bytesFlag, bytes, playerFlag, playerId, teamFlag, rawTeam, gameFlag, rawTargetGameId, cutoffFlag, proposedCutoff, ...extra] = args;
  if (rootFlag !== "--artifact-root" || journalFlag !== "--journal" || bytesFlag !== "--journal-bytes" || playerFlag !== "--player" ||
      teamFlag !== "--team" || gameFlag !== "--game" || cutoffFlag !== "--cutoff" || !root || !/^[a-f0-9]{64}\.json$/.test(reference ?? "") ||
      !/^\d+$/.test(bytes ?? "") || !Number.isSafeInteger(Number(bytes)) || Number(bytes) < 1 || Number(bytes) > 8_000_000 || extra.length) throw new Error("slice-inventory-arguments-refused");
  const store = await openArtifactStore(root, 8_000_000);
  const verified = await readVerifiedSourcePrototype(store, { reference, sha256: reference.slice(0, -5), byteSize: Number(bytes) });
  const report = inventoryQbSlice(verified.samples, { playerId, rawTeam, rawTargetGameId, proposedCutoff });
  return { ...report, sourceJournal: { reference, sha256: reference.slice(0, -5), byteSize: Number(bytes) },
    sourceFinishedAt: verified.finishedAt, evidenceAvailableAt: verified.sourceCaptures.map(c => ({ feed: c.feed, capturedAt: c.capturedAt, ingestedAt: c.ingestedAt })),
    inventoryMeaning: "discovery-only-no-canonical-publication" };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runQbInventory(process.argv.slice(2), process.env), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "slice-inventory-refused"); process.exitCode = 1; }
}
