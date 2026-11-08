# Local integrity scrub operator runbook

## Design basis

The scrub reconciles local content-addressed raw inventory with snapshot rows and current research rights. It verifies each eligible address once. Database-only inventory misses orphans, while verifying every serving read repeats payload work and misses cold evidence. Recompute replay is tracked separately in #244.

Each command covers one cursor range. Defaults are 32 listed objects, 32 snapshot references, 256 MiB cumulative wire bytes, and a 64 MiB per-object ceiling. The local directory enumeration still scales with directory size. The range query bounds result size and query count. It may scan the snapshot table. Keep this workflow on the qualified local fixture scale.

## Run locally

1. The local operator owns alerts and recovery. Reserve a non-overlapping maintenance window and quiesce source writers, rights updates and cleanup until the receipt is written. Before and after database captures detect changes visible to those checks. Operator quiescence covers the gaps between storage and database observations.
2. Use a clean commit for the files the command hashes, Node 24, and a local PostgreSQL login with the existing restricted feature-store reader role. Supply its connection string privately in `FS170_DATABASE_URL`. Keep the app's `DATABASE_URL` configured if it exists so the CLI can refuse that target. Use the canonical private ObjectStore root and a fresh, absolute receipt path under a private directory.
3. From the repository root, run:

   ```sh
   node services/pipeline/scripts/feature-store/integrity-scrub.ts \
     --root /absolute/private/objects \
     --receipt /absolute/private/receipts/range-001.json
   ```

4. After a successful receipt, pass its `range.nextStartAfter` as `--start-after` on the next run and choose a fresh receipt path. Null means the namespace is exhausted. Whole-namespace coverage requires an uninterrupted chain of successful ranges under the same pinned evidence state, or one terminal run from the start. A receipt covers eligible references; withdrawn references are counted separately.
5. Keep the machine receipt byte-for-byte as written. Store annotations such as the fixture identity, database setup and verified cleanup in a separate wrapper that links the receipt by SHA-256. Treat `contentSha256` as the primary code identity.

## Failure and bounded recovery

Keep the current cursor on any failure. If a snapshot or byte budget is exceeded, reduce `--inventory-limit` and retry once from the same cursor. Escalate to the operator if the range still cannot fit or a single address exceeds a bound. For corruption, missing objects, orphans, or a changed or unverifiable rights or deletion state, stop and preserve the diagnostics. The operator verifies the source and rights state before retrying. If the pinned state changed between ranges, restart the sweep. Use a new receipt path for every retry.

Use the existing governed cleanup path to resolve deletion findings. A future cleanup scheduler must call `cleanupDeletedObjectsWithRecovery` so late uploads receive their bounded recovery revisits. Scheduling is a local operator procedure. This issue adds no job trigger, cloud schedule, or credentials.

## Handoff to #244

The replay normalizer will need a module-scoped `readVerifiedWire` accessor protected by the private verified state. Restrict imports to the trusted normalizer through lint boundaries. Keep bytes private, refuse access after release, and release the backing allocation after the normalized rows reach disposable scratch. The raw ingest path retains its own wire hash check.
