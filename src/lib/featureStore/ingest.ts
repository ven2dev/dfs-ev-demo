import type { Client } from "pg";
import { finishJob, startJob } from "./jobs.ts";
import { normalizeSource } from "./normalize.ts";
import { objectKey, sha256, type ObjectStore } from "./objectStore.ts";
import { downloadSource, feedKind, INGEST_LIMITS, NORMALIZER_VERSION, policyDigest, profileId,
  type IngestLimits, type SourceAsset } from "./source.ts";

// Only these typed, code-owned table/column names enter SQL. Source data always
// uses parameters, and each file publishes normalized rows in one bulk statement.
const targets = {
  stats_player: { table: "norm_player_game_stats", fields: "player_id text, game_id text, team text, passing_attempts integer, passing_yards integer, state text, reasons text[]" },
  weekly_rosters: { table: "norm_identity", fields: "player_id text, season integer, week integer, team text, display_name text, position text, state text, reasons text[]" },
  pbp_participation: { table: "norm_participation", fields: "player_id text, game_id text, offense_play_count integer, state text, reasons text[]" },
  schedules: { table: "norm_schedule", fields: "game_id text, season integer, week integer, game_type text, kickoff timestamptz, home_team text, away_team text, home_score integer, away_score integer, state text, reasons text[]" },
} as const;
export type IngestDependencies = { download?: typeof downloadSource; limits?: IngestLimits };

export const ingestSource = async (
  client: Pick<Client, "query">, store: ObjectStore, asset: SourceAsset, code: { gitSha: string; contentSha256: string },
  dependencies: IngestDependencies = {},
) => {
  const started = performance.now();
  const limits = dependencies.limits ?? INGEST_LIMITS;
  const signal = AbortSignal.timeout(limits.deadlineMs);
  const receipt = await (dependencies.download ?? downloadSource)(asset, signal, limits);
  const downloadedMs = performance.now() - started;
  const normalized = await normalizeSource(receipt.bytes, asset, signal, limits);
  const validatedMs = performance.now() - started - downloadedMs;
  signal.throwIfAborted();
  const key = objectKey("raw", receipt.bytes);
  const stored = await store.putIfAbsent(key, receipt.bytes);
  const storedMs = performance.now() - started - downloadedMs - validatedMs;
  signal.throwIfAborted();
  const profile = profileId(asset);
  const policy = sha256(Buffer.from(JSON.stringify({ policy: policyDigest(asset, limits), implementation: code.contentSha256 })));
  const job = await startJob(client, { kind: "ingest", codeSha: code.gitSha, policySha256: policy,
    inputSetSha256: sha256(Buffer.from(JSON.stringify([profile, normalized.wireSha256]))) });
  if (!job.created) {
    const prior = await client.query<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM fs138.source_snapshots WHERE profile_id = $1 AND sha256 = $2", [profile, normalized.wireSha256]);
    return { status: job.status === "succeeded" ? "already-processed" as const : "job-unavailable" as const, jobId: job.jobId, jobStatus: job.status,
      snapshotId: prior.rows[0]?.snapshot_id ?? null, elapsedMs: performance.now() - started };
  }
  let snapshotId: string;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const license = { id: asset.license_id, attribution: asset.attribution, qualification: asset.license_qualification,
      evidenceUrl: asset.license_evidence_url, scope: "local research spike; no commercial-clearance claim" };
    await client.query(`INSERT INTO fs138.source_profiles (profile_id, provider, feed, parser_version, license)
      VALUES ($1, 'nflverse', $2, $3, $4) ON CONFLICT DO NOTHING`, [profile, feedKind[asset.feed], NORMALIZER_VERSION, license]);
    const existing = (await client.query("SELECT feed, parser_version, license FROM fs138.source_profiles WHERE profile_id = $1", [profile])).rows[0];
    // JSONB key ordering is not a policy decision; compare named values.
    if (existing.feed !== feedKind[asset.feed] || existing.parser_version !== NORMALIZER_VERSION ||
        Object.keys(existing.license).length !== Object.keys(license).length ||
        Object.entries(license).some(([key, value]) => existing.license[key] !== value)) throw new Error("source-profile-conflict");
    const inserted = await client.query<{ snapshot_id: string }>(`INSERT INTO fs138.source_snapshots
      (profile_id, job_id, sha256, byte_size, object_key, media_type, decoded_sha256, header_sha256,
       row_count, captured_at, available_at, evidence_basis, source_manifest)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'retrospective',$12)
      ON CONFLICT (profile_id, sha256) DO NOTHING RETURNING snapshot_id`,
    [profile, job.jobId, normalized.wireSha256, receipt.bytes.byteLength, key,
      asset.name.endsWith(".gz") ? "application/gzip" : "text/csv", normalized.decodedSha256,
      normalized.headerSha256, normalized.rowCount, receipt.capturedAt, asset.asset_updated_at,
      { ...asset, code, sha256: normalized.wireSha256, normalizerVersion: NORMALIZER_VERSION, policySha256: policy,
        historicalAvailability: "unverified", diagnostics: normalized.diagnostics }]);
    if (inserted.rows[0]) snapshotId = inserted.rows[0].snapshot_id;
    else snapshotId = (await client.query("SELECT snapshot_id FROM fs138.source_snapshots WHERE profile_id = $1 AND sha256 = $2",
      [profile, normalized.wireSha256])).rows[0].snapshot_id;
    const target = targets[asset.feed];
    const columns = target.fields.split(", ").map((field) => field.split(" ")[0]).join(", ");
    await client.query(`INSERT INTO fs138.${target.table} (snapshot_id, normalizer_version, job_id, ${columns})
      SELECT $1::uuid, $2::text, $3::uuid, r.* FROM jsonb_to_recordset($4::jsonb) AS r(${target.fields})`,
    [snapshotId, NORMALIZER_VERSION, job.jobId, JSON.stringify(normalized.rows)]);
    await client.query("INSERT INTO fs138.job_inputs (job_id, snapshot_id) VALUES ($1,$2)", [job.jobId, snapshotId]);
    await finishJob(client, job.jobId, { counts: { rawRows: normalized.rowCount, normalizedRows: normalized.rows.length,
      wireBytes: receipt.bytes.byteLength, decodedBytes: normalized.decodedBytes } });
    signal.throwIfAborted();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    await finishJob(client, job.jobId, { counts: {}, errorCode: "ingest-publication-failed" });
    // A validated create-once object can remain after rollback. Step 5's grace-
    // period sweep discovers it through ObjectStore.list; deleting immediately
    // could remove bytes a concurrent successful publication now references.
    throw error;
  }
  return { status: "ingested" as const, jobId: job.jobId, snapshotId, profileId: profile, objectKey: key,
    wireSha256: normalized.wireSha256, decodedSha256: normalized.decodedSha256, headerSha256: normalized.headerSha256,
    wireBytes: receipt.bytes.byteLength, decodedBytes: normalized.decodedBytes, rawRows: normalized.rowCount,
    normalizedRows: normalized.rows.length, diagnostics: normalized.diagnostics, newObject: stored.created,
    elapsedMs: performance.now() - started, stagesMs: { download: downloadedMs, validationAndNormalization: validatedMs,
      objectWrite: storedMs, databasePublication: performance.now() - started - downloadedMs - validatedMs - storedMs },
    work: { downloadRequests: receipt.requests, csvValidationPasses: 1, normalizationPasses: 1, bulkNormalizedInserts: 1 },
  };
};
