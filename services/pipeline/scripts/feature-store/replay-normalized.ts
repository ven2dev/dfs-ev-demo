import type { Client } from "pg";
import { assertFeatureStoreReplayTarget } from "./harness.ts";
import type { readReplayBaseline } from "./replay-restore.ts";
import { loadNormalizedRows } from "../../src/featureStore/ingest.ts";
import { normalizeVerifiedSource } from "../../src/featureStore/normalize.ts";
import { checkObjectReadLimit, parseObjectKey, sha256, type ObjectStore } from "../../src/featureStore/objectStore.ts";
import { INGEST_LIMITS, NORMALIZER_VERSION, type SourceAsset } from "../../src/featureStore/source.ts";

type Records = Awaited<ReturnType<typeof readReplayBaseline>>["records"];
type Database = Pick<Client, "query">;
type Row = Record<string, unknown>;
type Feed = SourceAsset["feed"];

const normalized = {
  schedules: { table: "norm_schedule", key: ["game_id"] },
  stats_player: { table: "norm_player_game_stats", key: ["player_id", "game_id"] },
  weekly_rosters: { table: "norm_identity", key: ["player_id", "season", "week", "team"] },
  pbp_participation: { table: "norm_participation", key: ["player_id", "game_id"] },
} as const;

const hash = (value: unknown) => sha256(Buffer.from(JSON.stringify(value)));
export const canonicalReplayTimestamp = (value: unknown): string => {
  const text = String(value);
  const fraction = /\.(\d{1,6})(?=Z|[+-]\d{2}(?::?\d{2})?$)/.exec(text)?.[1] ?? "";
  return new Date(text).toISOString().slice(0, -1) + fraction.padEnd(6, "0").slice(3) + "Z";
};

export const hashNormalizedRows = (feed: Feed, rows: Row[]) => {
  const keys = normalized[feed].key;
  const entries = new Map<string, Row>();
  for (const row of rows) {
    if (keys.some((key) => row[key] === undefined || row[key] === null)) throw new Error("replay-normalized-key-refused");
    const key = JSON.stringify(keys.map((field) => row[field]));
    if (entries.has(key)) throw new Error("replay-normalized-duplicate-key");
    const values: Row = {};
    for (const field of Object.keys(row).sort()) {
      if (field === "snapshot_id" || field === "job_id" || field === "normalizer_version") continue;
      values[field] = field === "kickoff" ? canonicalReplayTimestamp(row[field]) : row[field];
    }
    entries.set(key, values);
  }
  const sortedKeys = [...entries.keys()].sort();
  return { count: sortedKeys.length, keySha256: hash(sortedKeys), valueSha256: hash(sortedKeys.map((key) => entries.get(key))) };
};

export const captureReplayAccess = async (source: Database, snapshots: string[], since?: string) => {
  const { rows: [state] } = await source.query<{
    checkedAt: string; epochMicros: string; rightsChanged: boolean;
    references: { snapshotId: string; profileId: string; key: string; byteSize: string; eligible: boolean;
      deletedAt: string | null; decisionId: string | null; removalEventId: string | null; removalCompletedAt: string | null }[];
  }>(`
    WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS now),
    selected AS MATERIALIZED (SELECT s.* FROM fs138.source_snapshots s WHERE snapshot_id=ANY($1::uuid[])),
    profiles AS (SELECT DISTINCT profile_id FROM selected),
    rights AS MATERIALIZED (
      SELECT p.profile_id, r.decision_id, coalesce('research'=ANY(r.allowed_uses),false) AS eligible
      FROM profiles p CROSS JOIN clock LEFT JOIN LATERAL fs138.effective_rights(p.profile_id, now, now) r ON true
    )
    SELECT now::text AS "checkedAt", (extract(epoch FROM now)*1000000)::bigint::text AS "epochMicros",
      EXISTS (SELECT FROM profiles p JOIN fs138.rights_decisions r USING(profile_id)
        WHERE r.recorded_at >= TIMESTAMPTZ 'epoch' + $2::bigint * INTERVAL '1 microsecond' AND r.recorded_at <= now) AS "rightsChanged",
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'snapshotId',s.snapshot_id,'profileId',s.profile_id,'key',s.object_key,'byteSize',s.byte_size::text,
        'eligible',s.deleted_at IS NULL AND r.eligible,'deletedAt',s.deleted_at,'decisionId',r.decision_id,
        'removalEventId',o.event_id,'removalCompletedAt',o.completed_at
      ) ORDER BY s.snapshot_id)
      FROM selected s JOIN rights r USING(profile_id)
      LEFT JOIN fs138.object_removals o USING(object_key)),'[]') AS references
    FROM clock`, [snapshots, since ?? null]);
  if (!state || state.references.length !== snapshots.length) throw new Error("replay-source-state-unavailable");
  return { ...state, stateSha256: hash(state.references) };
};

const MiB = 1024 ** 2;
const wireLimit = 256 * MiB;
const defaultRowLimit = 125_000;

export const stageReplayNormalization = async (
  db: { admin: Database; writer: Database }, source: Database, store: ObjectStore, records: Records,
  rowLimit = defaultRowLimit,
) => {
  assertFeatureStoreReplayTarget(db.admin, db.writer);
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 1 || rowLimit > defaultRowLimit ||
      !records.source_snapshots.length || records.source_snapshots.length > 32) throw new Error("replay-normalized-budget");
  const ids = records.source_snapshots.map(({ snapshot_id }) => String(snapshot_id));
  const initial = await captureReplayAccess(source, ids);
  const references = new Map(initial.references.map((ref) => [ref.snapshotId, ref]));
  const objects = new Map<string, Row[]>();
  let withdrawn = 0;
  for (const snapshot of records.source_snapshots) {
    const ref = references.get(String(snapshot.snapshot_id));
    if (!ref || ref.profileId !== snapshot.profile_id || ref.key !== snapshot.object_key ||
        ref.byteSize !== String(snapshot.byte_size)) throw new Error("replay-source-pin-mismatch");
    if (!ref.eligible) { withdrawn++; continue; }
    const group = objects.get(ref.key) ?? [];
    group.push(snapshot);
    objects.set(ref.key, group);
  }
  let verifiedWireBytes = 0;
  let normalizedRows = 0;
  const normalizedParity = [];
  const payloadMemory = [];
  const arrayBuffers = () => process.memoryUsage().arrayBuffers;
  const baselineArrayBuffers = arrayBuffers();
  const slackBytes = 16 * MiB;
  for (const [key, snapshots] of objects) {
    const byteSize = Number(snapshots[0].byte_size);
    checkObjectReadLimit(byteSize);
    if (byteSize > INGEST_LIMITS.wireBytes || verifiedWireBytes + byteSize > wireLimit ||
        snapshots.some((snapshot) => Number(snapshot.byte_size) !== byteSize || snapshot.sha256 !== parseObjectKey(key).sha256)) {
      throw new Error("replay-wire-budget-or-pin-mismatch");
    }
    const beforeRead = arrayBuffers();
    const wire = await store.getVerified(key, byteSize);
    const afterRead = arrayBuffers();
    try {
      if (wire.byteSize !== byteSize) throw new Error("replay-wire-size-mismatch");
      verifiedWireBytes += wire.byteSize;
      const staged = [];
      for (const snapshot of snapshots) {
        const asset = snapshot.source_manifest as SourceAsset;
        const expected = records[normalized[asset.feed].table].filter(({ snapshot_id }) => snapshot_id === snapshot.snapshot_id);
        const owner = expected[0]?.job_id;
        if (typeof owner !== "string" || expected.some(({ job_id, normalizer_version }) => job_id !== owner ||
            normalizer_version !== NORMALIZER_VERSION)) throw new Error("replay-normalized-owner-mismatch");
        const actual = await normalizeVerifiedSource(wire, asset, AbortSignal.timeout(INGEST_LIMITS.deadlineMs));
        if (actual.decodedSha256 !== snapshot.decoded_sha256 || actual.headerSha256 !== snapshot.header_sha256 ||
            actual.rowCount !== snapshot.row_count) throw new Error("replay-normalized-source-mismatch");
        const baseline = hashNormalizedRows(asset.feed, expected);
        const parity = hashNormalizedRows(asset.feed, actual.rows);
        if (baseline.count !== parity.count || baseline.keySha256 !== parity.keySha256 || baseline.valueSha256 !== parity.valueSha256) {
          throw new Error("replay-normalized-value-mismatch");
        }
        normalizedRows += parity.count;
        if (normalizedRows > rowLimit) throw new Error("replay-normalized-budget");
        staged.push({ asset, snapshotId: String(snapshot.snapshot_id), owner, rows: actual.rows, parity });
      }
      // Compare every eligible reference to this object before staging any rows from it.
      for (const { asset, snapshotId, owner, rows, parity } of staged) {
        await loadNormalizedRows(db.writer, asset.feed, snapshotId, owner, rows);
        normalizedParity.push({ snapshotId, ...parity });
      }
    } finally {
      const beforeRelease = arrayBuffers();
      wire.release();
      if (wire.byteSize !== 0) throw new Error("replay-wire-release-failed");
      payloadMemory.push({ byteSize, beforeRead, afterRead, beforeRelease, afterRelease: arrayBuffers() });
    }
  }
  const largestObjectBytes = Math.max(0, ...payloadMemory.map(({ byteSize }) => byteSize));
  const peakArrayBuffers = Math.max(baselineArrayBuffers,
    ...payloadMemory.flatMap(({ beforeRead, afterRead, beforeRelease, afterRelease }) => [beforeRead, afterRead, beforeRelease, afterRelease]));
  return { initial, withdrawn, verifiedObjects: objects.size, verifiedWireBytes, normalizedRows, normalizedParity,
    memory: { baselineArrayBuffers, largestObjectBytes, slackBytes, peakArrayBuffers, samples: payloadMemory } };
};
