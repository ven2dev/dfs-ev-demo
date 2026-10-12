import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { assertNoApplicationCredentials } from "../../tests/db/target.mts";
import { createScratchHarness } from "../../tests/db/scratch.mjs";
import { checkMigrationArtifacts } from "../db-migrations/files.mjs";
import { createCatalogVerifier, loadCatalogContracts } from "../db-migrations/contracts.mjs";
import { runScratchMigrations } from "../db-migrations/core.mjs";
import { openArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { createLocalPredictiveStore } from "../../src/lib/predictive/persistence.ts";
import { prepareSourceClaims, type SourceStatsPublication } from "../../src/lib/predictive/sourceClaims.ts";
import { readVerifiedSourcePrototype } from "../../src/lib/predictive/sourcePrototype.ts";
import { SOURCE_PROFILE_VERSION } from "../../src/lib/predictive/sourceAdapters.ts";
import type { Profile, RightsDecision } from "../../src/lib/predictive/types.ts";
import { refuse } from "../../src/lib/predictive/validation.ts";
import { ensurePredictiveRoles } from "./harness.ts";

// Guarded, owner-run, disposable proof. No fetch, hosted credentials, migrations
// against persistent dev/Production, invented corrections or finalized labels.
export const runSourceClaimsProof = async (args: string[], environment: NodeJS.ProcessEnv = process.env) => {
  assertNoApplicationCredentials(environment);
  const [mode, rootFlag, directory, journalFlag, reference, bytesFlag, size, ...extra] = args;
  if (extra.length || mode !== "prove" || rootFlag !== "--artifact-root" || !directory || journalFlag !== "--journal" ||
      !/^[a-f0-9]{64}\.json$/.test(reference ?? "") || bytesFlag !== "--journal-bytes" || !/^\d+$/.test(size ?? "") ||
      !Number.isSafeInteger(Number(size)) || Number(size) < 1 || Number(size) > 8_000_000) refuse("source-proof-arguments-refused");
  const archive = await openArtifactStore(directory, 8_000_000);
  const verified = await readVerifiedSourcePrototype(archive, { reference, sha256: reference.slice(0, 64), byteSize: Number(size) });
  if (verified.reportStatus === "refused") refuse("source-proof-capture-refused");
  const inputs: SourceStatsPublication[] = [];
  for (const feed of ["player", "team"] as const) {
    const source = verified.sourceCaptures.find((capture) => capture.feed === feed);
    if (!source?.source || source.state !== "captured" || !source.capturedAt || !source.headerSha256) refuse("source-proof-capture-refused");
    const profile: Profile = { id: "nflverse-csv-claims-v1-" + feed, purpose: "source", provider: "nflverse", feed,
      releaseTag: source.asset.tag, assetPattern: source.asset.name, headerProfileSha256: source.headerSha256,
      parserVersion: SOURCE_PROFILE_VERSION, allowlistVersion: "predictive-raw-allowlist-v1", license: "CC-BY-4.0; internal research only",
      attribution: "nflverse contributors; NFL data via nflverse", evidenceKinds: [feed === "player" ? "player-game-stats" : "team-game-stats"],
      registeredAt: verified.finishedAt };
    // Cite the already-approved review carried by the verified v1 journal. This
    // records its original internal-research use, not new public/paid clearance.
    const rights: RightsDecision = { id: "nflverse-internal-research-2026-10-05:" + feed, profileId: profile.id,
      predecessorId: null, allowedUses: ["internal-research"], effectiveFrom: "2026-10-05T00:00:00.000Z", effectiveTo: null,
      decidedAt: "2026-10-05T00:00:00.000Z", evidenceKind: "terms-review",
      evidenceReference: "nflverse-internal-research-2026-10-05; docs/predictive-data-sources.md" };
    inputs.push({ id: "source-proof:" + feed, captureId: "source-proof:capture:" + feed, capturedAt: source.capturedAt,
      profile, rightsDecisions: [rights], artifact: { id: "source-proof:artifact:" + feed, profileId: profile.id,
        sha256: source.source.sha256, bytes: await archive.read(source.source.reference, source.source.sha256, source.source.byteSize),
        origin: source.asset.url, retrievalKind: "full", providerEtag: null, providerLastModified: null,
        releaseUpdatedAt: new Date(source.upstreamUpdatedAt).toISOString(), scopeKind: "season-file", scopeSeason: verified.season,
        scopeWeek: null, scopeGameId: null, scopeFilter: null } });
  }
  const harness = await createScratchHarness(environment);
  const privateRoot = await realpath(await mkdtemp(join(tmpdir(), "dfs52-source-proof-db-")));
  try {
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    return await harness.withDatabase(async (client: Client, expected: object) => {
      const target = { expected, assertTarget: harness.assertTarget };
      await ensurePredictiveRoles(client);
      const migration = await runScratchMigrations(client, { ...target, files, verify: createCatalogVerifier(contracts) });
      const artifacts = await openArtifactStore(privateRoot, 8_000_000);
      const store = await createLocalPredictiveStore(client, target, artifacts);
      const reports = [];
      for (const input of inputs) {
        const prepared = await prepareSourceClaims(input);
        const started = performance.now(); await store.publishSourceStats(input); const publishMs = performance.now() - started;
        const imported = (await client.query(`SELECT to_char(ingested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time
          FROM public.predictive_captures WHERE id=$1`, [input.captureId])).rows[0].time as string;
        const candidate = prepared.rows.find((row) => row.projection !== null)?.projection ?? refuse("source-proof-no-projection");
        const request = { profileId: input.profile.id, rawGameId: candidate.rawGameId, rawTeam: candidate.rawTeam,
          rawPlayerId: candidate.rawPlayerId, cutoff: imported };
        const replayStarted = performance.now(); const replay = await store.replaySourceStats(request); const replayMs = performance.now() - replayStarted;
        if (replay.status !== "observed-source-claim") refuse("source-proof-replay-refused");
        const prior = await store.replaySourceStats({ ...request, cutoff: new Date(Date.parse(imported) - 1).toISOString() });
        if (prior.reason !== "source-capture-missing") refuse("source-proof-backdated-import");
        const retry = await store.publishSourceStats(input);
        const afterRetry = await store.replaySourceStats(request);
        if (!retry.reused || afterRetry.inputDigest !== replay.inputDigest) refuse("source-proof-idempotency-refused");
        const normalizationStarted = performance.now();
        const normalization = await store.planSourceStatsNormalization(request);
        const normalizationMs = performance.now() - normalizationStarted;
        // The retained journal supplies raw claims, not registered canonical
        // bridges. Familiar NFL/GSIS IDs must not silently substitute for them.
        if (normalization.status !== "unavailable-source-normalization" || normalization.reason !== "game-bridge-missing" || normalization.candidate !== null)
          refuse("source-proof-invented-identity");
        reports.push({ feed: input.profile.feed, rows: prepared.rows.length, projected: prepared.rows.filter((row) => row.projection).length,
          refused: prepared.rows.filter((row) => row.failureCode).length, capturedAt: input.capturedAt, ingestedAt: imported,
          rawBytes: Buffer.byteLength(input.artifact.bytes), rawSha256: input.artifact.sha256, publishMs: Math.round(publishMs),
          replayMs: Math.round(replayMs), preImportUnavailable: true, retryPreservedReplay: true, inputDigest: replay.inputDigest,
          normalizationMs: Math.round(normalizationMs), normalizationStatus: normalization.status, normalizationReason: normalization.reason });
      }
      const sizes = (await client.query(`SELECT pg_relation_size('public.predictive_source_stats_rows') AS heap,
        pg_indexes_size('public.predictive_source_stats_rows') AS indexes, pg_total_relation_size('public.predictive_source_stats_rows') AS total`)).rows[0];
      const observations = (await client.query("SELECT count(*)::integer AS count FROM public.predictive_observations")).rows[0].count;
      if (observations !== 0) refuse("source-proof-canonical-publication-refused");
      return { schemaVersion: migration.schemaVersion, requests: 0, sourceJournal: reference, reports, sourceRowStorageBytes: sizes,
        canonicalObservations: observations, featuresPublished: false, labelsFinalized: false, populationCoverage: "unqualified",
        peakRssBytes: process.resourceUsage().maxRSS * 1024, scratchRemoved: true };
    });
  } finally { try { await harness.close(); } finally { await rm(privateRoot, { recursive: true, force: true }); } }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await runSourceClaimsProof(process.argv.slice(2)), null, 2) + "\n"); }
  catch { process.stderr.write("predictive-source-local: proof-refused\n"); process.exitCode = 1; }
}
