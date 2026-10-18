import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { withFeatureStoreDatabase } from "./harness.ts";
import { readNormalizedAsOf, type AsOfRow } from "../../src/lib/featureStore/asOf.ts";
import { ingestSource } from "../../src/lib/featureStore/ingest.ts";
import { openLocalObjectStore } from "../../src/lib/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/lib/featureStore/objectStore.ts";
import type { SourceAsset, SourceFeed } from "../../src/lib/featureStore/source.ts";

const exec = promisify(execFile);
const root = new URL("../../", import.meta.url);
const output = new URL("docs/evidence/feature-store-138/step-3-real-ingestion.json", root);
const manifestPath = new URL("docs/evidence/feature-store-138/step-3-source-manifest.json", root);
const inventory = JSON.parse(await readFile(new URL("docs/evidence/feature-store-138/source-inventory.json", root), "utf8")) as { assets: SourceAsset[] };
const codeFiles = ["src/lib/featureStore/objectStore.ts", "src/lib/featureStore/localObjectStore.ts", "src/lib/featureStore/jobs.ts",
  "src/lib/featureStore/source.ts", "src/lib/featureStore/normalize.ts", "src/lib/featureStore/ingest.ts", "src/lib/featureStore/asOf.ts",
  "scripts/feature-store/harness.ts", "scripts/feature-store/ingest-spike.ts", "db/proposals/138_feature_store.sql", "package-lock.json"];
const hashes = Object.fromEntries(await Promise.all(codeFiles.map(async (path) => [path, sha256(await readFile(new URL(path, root)))])));
const code = { gitSha: (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(), contentSha256: sha256(Buffer.from(JSON.stringify(hashes))) };
const storageRoot = resolve(process.argv[2] ?? "../dfs-ev-demo-138-data/objects");
await mkdir(storageRoot, { recursive: true, mode: 0o700 });
const store = await openLocalObjectStore(await realpath(storageRoot));
type ReleaseAsset = { id: number; name: string; size: number; updated_at: string; digest: string | null; browser_download_url: string };
const tags = [...new Set(inventory.assets.map((asset) => asset.feed))];
const releases = await Promise.allSettled(tags.map(async (tag) => {
  const result = await exec("gh", ["api", "repos/nflverse/nflverse-data/releases/tags/" + tag], { maxBuffer: 8 * 1024 * 1024 });
  return [tag, JSON.parse(result.stdout).assets as ReleaseAsset[]] as const;
}));
const metadata = new Map<SourceFeed, ReleaseAsset[]>();
for (const result of releases) {
  if (result.status === "rejected") throw result.reason;
  metadata.set(...result.value);
}
const manifest = inventory.assets.map((previous) => {
  const current = metadata.get(previous.feed)!.find((asset) => asset.name === previous.name);
  if (!current) throw new Error("source-asset-no-longer-published: " + previous.name);
  const unchanged = current.id === previous.asset_id && current.size === previous.wire_bytes && current.updated_at === previous.asset_updated_at;
  const asset: SourceAsset = { feed: previous.feed, season: previous.season, name: current.name,
    asset_id: current.id, wire_bytes: current.size, columns: previous.columns,
    license_id: previous.license_id, attribution: previous.attribution,
    license_qualification: previous.license_qualification, license_evidence_url: previous.license_evidence_url,
    asset_updated_at: current.updated_at, url: current.browser_download_url, provider_digest: current.digest,
    sha256: current.digest?.startsWith("sha256:") ? current.digest.slice(7) : unchanged ? previous.sha256 : null };
  return { asset, inventorySha256: previous.sha256, metadataChanged: !unchanged,
    hashBasis: current.digest ? "provider-declared" : unchanged ? "previously-inspected" : "pin-on-successful-ingestion" };
}).sort((a, b) => (a.asset.feed === "schedules" ? -1 : b.asset.feed === "schedules" ? 1 : a.asset.name.localeCompare(b.asset.name)));
await writeFile(manifestPath, JSON.stringify({ issue: 138, recordedAt: new Date().toISOString(), assets: manifest }, null, 2) + "\n");
const results: Record<string, unknown>[] = [];
const report: Record<string, unknown> = { schemaVersion: 1, issue: 138, step: 3, recordedAt: new Date().toISOString(),
  code, codeHashes: hashes, storageRoot, runtime: process.version, machine: { arch: arch(), platform: platform(), cpus: cpus().length, totalMemoryBytes: totalmem() },
  mode: "initial real-source qualification, not a repeated cold/warm capacity verdict", evaluationRun: false,
  results, verdict: "running", baselineInventorySha256: sha256(await readFile(new URL("docs/evidence/feature-store-138/source-inventory.json", root))) };
const save = () => writeFile(output, JSON.stringify(report, null, 2) + "\n");
await save();
try {
  await withFeatureStoreDatabase(async ({ admin, writer, reader, queryCounts }) => {
    report.database = (await admin.query("SELECT version() AS version")).rows[0].version;
    report.pipelineLogin = (await writer.query("SELECT current_user AS name, rolsuper, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user")).rows[0];
    for (const entry of manifest) {
      const queriesBefore = queryCounts.writer;
      const started = performance.now();
      try {
        const result = await ingestSource(writer, store, entry.asset, code);
        const complete = result.status === "ingested";
        const recorded = { name: entry.asset.name, feed: entry.asset.feed, season: entry.asset.season,
          ...result, queries: queryCounts.writer - queriesBefore,
          bytesChangedFromInventory: complete ? result.wireSha256 !== entry.inventorySha256 : null,
          deadlineMs: 60_000, headroomLimitMs: 42_000,
          trialVerdict: complete && result.elapsedMs <= 42_000 ? "pass" : "fail",
          acceptanceVerdict: complete && result.elapsedMs <= 42_000 ? "pending-repeated-cold-warm-trials" : "fail" };
        results.push(recorded);
        console.log(JSON.stringify({ file: entry.asset.name, status: result.status, elapsedMs: result.elapsedMs, verdict: recorded.trialVerdict }));
      } catch (error) {
        results.push({ name: entry.asset.name, feed: entry.asset.feed, season: entry.asset.season, status: "refused",
          error: error instanceof Error ? error.message : "unknown-error", elapsedMs: performance.now() - started,
          queries: queryCounts.writer - queriesBefore, trialVerdict: "fail", acceptanceVerdict: "fail" });
        console.log(JSON.stringify(results.at(-1)));
      }
      await save();
    }
    const checkpoint = (await admin.query("SELECT clock_timestamp()::text AS clock")).rows[0].clock;
    report.checkpoint = checkpoint;
    const historicalCutoff = "2026-02-16T00:00:00Z";
    const strict = await readNormalizedAsOf(reader, { cutoff: historicalCutoff, checkpoint, mode: "strict-point-in-time-v1" });
    const before = queryCounts.reader;
    const rows = await readNormalizedAsOf(reader, { cutoff: historicalCutoff, checkpoint, mode: "retrospective-reconstruction-v1" });
    report.asOfQueries = { strict: 1, reconstruction: queryCounts.reader - before };
    report.strictHistoricalRows = strict.length;
    report.reconstructedRows = rows.length;
    report.normalizedContentSha256 = sha256(Buffer.from(JSON.stringify(rows.map(({ feed, naturalKey, data, state, reasons, flags }) => ({ feed, naturalKey, data, state, reasons, flags })))));
    const schedule = new Map(rows.filter((row) => row.feed === "schedule" && row.state === "usable").map((row) => [String(row.data!.game_id), row.data!]));
    const roster = new Set(rows.filter((row) => row.feed === "roster" && row.state === "usable").map((row) => row.naturalKey));
    const participation = new Set(rows.filter((row) => row.feed === "participation" && row.state === "usable").map((row) => row.naturalKey));
    const statRows = rows.filter((row) => row.feed === "stats");
    const missingParticipation: Record<string, unknown>[] = [];
    const seasonStats = (season: number) => statRows.filter((row) => row.naturalKey.split("/")[1]?.startsWith(String(season) + "_"));
    const hasIdentity = (row: AsOfRow) => {
      const data = row.data;
      if (!data) return false;
      const parts = String(data.game_id).split("_");
      return roster.has(`${data.player_id}/${Number(parts[0])}/${Number(parts[1])}/${data.team}`);
    };
    report.coverageBySeason = [2021, 2022, 2023, 2024, 2025].map((season) => {
      const selected = seasonStats(season);
      const absent = selected.filter((row) => !participation.has(row.naturalKey));
      for (const row of absent) missingParticipation.push({ season, playerId: row.data?.player_id, gameId: row.data?.game_id,
        passingAttempts: row.data?.passing_attempts, passingYards: row.data?.passing_yards, reason: "positive-offense-participation-missing" });
      return { season, scheduleGames: [...schedule.values()].filter((game) => game.season === season).length,
        qbStatsRows: selected.length, zeroAttemptRows: selected.filter((row) => row.data?.passing_attempts === 0).length,
        missingIdentity: selected.filter((row) => !hasIdentity(row)).length,
        missingSchedule: selected.filter((row) => !schedule.has(String(row.data?.game_id))).length,
        missingPositiveParticipation: absent.length, refusedStatsRows: selected.filter((row) => row.state !== "usable").length };
    });
    report.participationGaps = missingParticipation;
    report.snapshots = (await reader.query("SELECT snapshot_id, profile_id, sha256, byte_size::text, object_key, captured_at::text, available_at::text, ingested_at::text FROM fs138.source_snapshots ORDER BY profile_id")).rows;
    report.queryCounts = queryCounts;
  });
  report.verdict = results.length === 16 && results.every((result) => result.status === "ingested") ? "ingestion-correctness-completed" : "incomplete-or-refused";
  report.capacityVerdict = results.some((result) => result.trialVerdict === "fail") ? "fail-on-observed-trial" : "pending-repeated-cold-warm-trials";
} catch (error) { report.verdict = "failed"; report.error = error instanceof Error ? error.message : "unknown-error"; throw error; }
finally { report.peakRssBytes = process.resourceUsage().maxRSS * 1024; await save(); }
console.log(JSON.stringify({ report: output.pathname, verdict: report.verdict, capacityVerdict: report.capacityVerdict }));
if (report.verdict !== "ingestion-correctness-completed") process.exitCode = 1;
