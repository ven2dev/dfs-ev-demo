import type { Client } from "pg";
import { checkObjectPageRequest, type ObjectStore } from "./objectStore.ts";

const MiB = 1024 * 1024;
const maxObjectBytes = 64 * MiB;

type Database = Pick<Client, "query">;
type ScrubOptions = {
  startAfter?: string;
  inventoryLimit?: number;
  snapshotLimit?: number;
  wireByteLimit?: number;
};
type Snapshot = {
  key: string;
  snapshotId: string;
  profileId: string;
  byteSize: string;
  deletedAt: string | null;
  decisionId: string | null;
  eligible: boolean;
};
type ScrubState = {
  checkedAt: string;
  snapshots: Snapshot[];
  removals: { key: string; eventId: string; completedAt: string | null; outcome: string | null }[];
};
type Finding = {
  key: string;
  kind: "missing" | "orphan" | "size-mismatch" | "corrupt";
};

const captureState = async (
  db: Database, startAfter: string, endInclusive: string, snapshotLimit: number, listedKeys: string[],
): Promise<ScrubState> => {
  const result = await db.query<ScrubState>(`
    WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS now),
    snapshots AS MATERIALIZED (
      SELECT snapshot_id, profile_id, object_key, byte_size, deleted_at
      FROM fs138.source_snapshots
      WHERE object_key COLLATE "C" > $1 AND object_key COLLATE "C" <= $2
      ORDER BY object_key COLLATE "C", snapshot_id LIMIT $3
    ), profiles AS (
      SELECT DISTINCT profile_id FROM snapshots
    ), decisions AS MATERIALIZED (
      SELECT p.profile_id, r.decision_id, coalesce('research'=ANY(r.allowed_uses), false) AS eligible
      FROM profiles p CROSS JOIN clock
      LEFT JOIN LATERAL fs138.effective_rights(p.profile_id, now, now) r ON true
    ), addresses AS (
      SELECT object_key FROM snapshots UNION SELECT unnest($4::text[])
    )
    SELECT now::text AS "checkedAt",
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'key', s.object_key, 'snapshotId', s.snapshot_id, 'profileId', s.profile_id,
        'byteSize', s.byte_size::text, 'deletedAt', s.deleted_at, 'decisionId', d.decision_id,
        'eligible', s.deleted_at IS NULL AND d.eligible
      ) ORDER BY s.object_key COLLATE "C", s.snapshot_id)
      FROM snapshots s JOIN decisions d USING (profile_id)), '[]') AS snapshots,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'key', r.object_key, 'eventId', r.event_id, 'completedAt', r.completed_at, 'outcome', r.outcome
      ) ORDER BY r.object_key COLLATE "C")
      FROM addresses a JOIN fs138.object_removals r USING (object_key)), '[]') AS removals
    FROM clock`, [startAfter, endInclusive, snapshotLimit + 1, listedKeys]);
  const state = result.rows[0];
  if (!state) throw new Error("integrity-scrub-state-unavailable");
  if (state.snapshots.length > snapshotLimit) throw new Error("integrity-scrub-snapshot-budget");
  return state;
};

const requireLimit = (value: number, ceiling: number): void => {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new Error("integrity-scrub-limit-refused");
};

const readFailure = (error: unknown): Finding["kind"] => {
  if (!(error instanceof Error)) throw error;
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
  if (["object-size-refused", "object-size-changed"].includes(error.message)) return "size-mismatch";
  if (["object-digest-mismatch", "object-file-refused"].includes(error.message)) return "corrupt";
  throw error;
};

// This checkpoint returns in-process findings. Certification also requires the
// final state check and receipt boundary.
export const inspectRawScrubRange = async (db: Database, store: ObjectStore, {
  startAfter, inventoryLimit = 32, snapshotLimit = 32, wireByteLimit = 256 * MiB,
}: ScrubOptions = {}) => {
  requireLimit(inventoryLimit, 32);
  requireLimit(snapshotLimit, 32);
  requireLimit(wireByteLimit, 256 * MiB);
  checkObjectPageRequest("raw", { limit: inventoryLimit, startAfter });
  const page = await store.listPage("raw", { limit: inventoryLimit, startAfter });
  const listed = new Map(page.entries.map((entry) => [entry.key, entry]));
  // An exhausted object listing still covers database-only tail addresses.
  const endInclusive = page.nextStartAfter ?? `raw/${"f".repeat(64)}`;
  const state = await captureState(db, startAfter ?? "raw/", endInclusive, snapshotLimit, [...listed.keys()]);
  const referenced = new Set(state.snapshots.map(({ key }) => key));
  const removed = new Set(state.removals.map(({ key }) => key));
  const eligible = new Map<string, Snapshot[]>();
  let withdrawnReferences = 0;
  for (const snapshot of state.snapshots) {
    if (!snapshot.eligible) {
      withdrawnReferences++;
      continue;
    }
    const references = eligible.get(snapshot.key) ?? [];
    references.push(snapshot);
    eligible.set(snapshot.key, references);
  }

  const findings: Finding[] = [];
  for (const key of listed.keys()) {
    if (!referenced.has(key) && !removed.has(key)) findings.push({ key, kind: "orphan" });
  }

  const reads: { key: string; byteSize: number; references: Snapshot[] }[] = [];
  let reservedBytes = 0;
  for (const [key, references] of eligible) {
    const object = listed.get(key);
    if (!object) {
      findings.push({ key, kind: "missing" });
    } else if (references.some(({ byteSize }) => byteSize !== String(object.byteSize))) {
      findings.push({ key, kind: "size-mismatch" });
    } else {
      reservedBytes += object.byteSize;
      if (object.byteSize > maxObjectBytes || reservedBytes > wireByteLimit) {
        throw new Error("integrity-scrub-wire-budget");
      }
      reads.push({ key, byteSize: object.byteSize, references });
    }
  }

  let verifiedObjects = 0;
  let verifiedWireBytes = 0;
  let verifiedReferences = 0;
  for (const { key, byteSize, references } of reads) {
    try {
      const wire = await store.getVerified(key, byteSize);
      if (wire.byteSize !== byteSize) {
        findings.push({ key, kind: "size-mismatch" });
        continue;
      }
      verifiedObjects++;
      verifiedWireBytes += byteSize;
      verifiedReferences += references.length;
    } catch (error) {
      findings.push({ key, kind: readFailure(error) });
    }
  }

  return {
    range: { startAfter: startAfter ?? null, endInclusive, lastListedKey: page.entries.at(-1)?.key ?? null,
      nextStartAfter: page.nextStartAfter },
    initialState: state,
    counts: { listed: listed.size, snapshotReferences: state.snapshots.length, withdrawnReferences,
      verifiedObjects, verifiedReferences, verifiedWireBytes },
    findings,
  };
};
