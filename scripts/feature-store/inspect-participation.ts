import { readFile, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { parse } from "csv-parse";
import { openLocalObjectStore } from "../../src/lib/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/lib/featureStore/objectStore.ts";

// Supplemental diagnosis of the refused source row; this does not publish data.
const root = new URL("../../", import.meta.url);
const report = JSON.parse(await readFile(new URL("docs/evidence/feature-store-138/step-3-real-ingestion.json", root), "utf8")) as {
  storageRoot: string;
  results: { name: string; objectKey: string; wireSha256: string }[];
};
const file = report.results.find((row) => row.name === "pbp_participation_2024.csv");
if (!file) throw new Error("participation-receipt-missing");
const store = await openLocalObjectStore(report.storageRoot);
const bytes = await store.get(file.objectKey);
if (sha256(bytes) !== file.wireSha256) throw new Error("participation-object-integrity-failed");
const csv = parse({ columns: true, bom: true, max_record_size: 1024 * 1024 });
const found: { sourceOrdinal: number; gameId: string; playId: string; possessionTeam: string;
  invalidTokens: string[]; duplicateTokens: string[]; decision: string }[] = [];
let ordinal = 0;
for await (const row of Readable.from([bytes]).pipe(csv) as AsyncIterable<Record<string, string>>) {
  ordinal++;
  if (Number(row.nflverse_game_id.split("_")[1]) > 18 || !row.offense_players || row.offense_players === "NA") continue;
  const tokens = row.offense_players.split(";").map((value) => value.trim());
  const invalidTokens = tokens.filter((value) => !/^00-\d{7}$/.test(value));
  const duplicateTokens = [...new Set(tokens.filter((value, index) => tokens.indexOf(value) !== index))];
  if (invalidTokens.length || duplicateTokens.length) found.push({ sourceOrdinal: ordinal, gameId: row.nflverse_game_id,
    playId: row.play_id, possessionTeam: row.possession_team, invalidTokens, duplicateTokens,
    decision: "play-not-used-for-positive-participation" });
}
const evidence = { issue: 138, step: 3, recordedAt: new Date().toISOString(), wireSha256: file.wireSha256,
  recipePath: "scripts/feature-store/inspect-participation.ts", recipeSha256: sha256(await readFile(new URL(import.meta.url))),
  rowsInspected: ordinal, anomalies: found };
await writeFile(new URL("docs/evidence/feature-store-138/step-3-participation-anomaly.json", root), JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence));
