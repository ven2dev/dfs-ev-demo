# Local recompute replay (#244)

## Design basis

Replay uses the existing normalizer and producer jobs against the pinned #241
graph and the exact #138 wire files. A disposable scratch database preserves the
original source and normalization owner clocks so the producer sees the same
inputs at the original checkpoints. Actual replay execution clocks are recorded
separately. Reimplementing the producers would risk drifting from their logic.
Advancing the checkpoint would change the set of evidence knowable at the time.

The run is bounded to the pinned 20 feature and label contexts, up to 32 snapshot
references, 256 MiB of wire payload and 125,000 normalized rows. It keeps the
normalizer's per-file limits. Each eligible object is verified once and released
before reading the next. The work gates are one set-based materialization per
derived job and zero per-example queries. There is no elapsed-time assertion.

## Local operation

Reserve `lane-2` for the 2 GiB tier, including teardown. Keep the source catalog
and object root quiesced through receipt delivery. The audit checks current
research rights and deletion state at both boundaries. It stops on a missing or
corrupt payload, a normalized mismatch, or a changed or incomplete source state.
An eligible reference can use a shared address while a withdrawn reference is
counted separately. An incomplete pinned replay cannot certify.

The command expects a pre-existing local `fs244_source` catalog on lane-2 with
the pinned snapshot identities and current rights. Supply its restricted reader
connection in `FS244_SOURCE_DATABASE_URL` privately. The command uses a
read-only connection and checks the role. The disposable replay database is
separate and is allocated and removed by the existing scratch harness. The
qualification probe provisions synthetic research grants in disposable databases
and tests mechanics. Those grants do not establish rights for a real audit.

```bash
export DB_TEST_LANE=lane-2 DB_TEST_TIER=large
export TEST_DATABASE_URL="$(env -u TEST_DATABASE_URL node scripts/db/test-db.mjs url)"
node scripts/db/test-db.mjs up
node services/pipeline/scripts/feature-store/recompute-replay.ts \
  --root /absolute/private/objects \
  --receipt /absolute/private/receipts/replay.json
node scripts/db/test-db.mjs down
```

Use a fresh receipt path. The receipt is written exclusively after successful
scratch cleanup and a final state check. Normalized and derived parity are
recorded separately. The normalized comparison runs before staging each
object's rows. The derived comparison retains natural keys, semantic array
order, timestamp precision, and stable source lineage across fresh output IDs.

## Planner statistics and memory evidence

Replay analyzes the restored scratch inputs before checking each pinned
context separately. The initial batched discovery query exceeded its
statement timeout with fresh scratch statistics. Producer timing belongs to
#169. Normal ingest already analyzes after loading, and this audit changes
no production planner settings or producer SQL.

The receipt records heap use after loading the baseline and samples
`arrayBuffers` before and after each payload read and release. The
qualification compares sampled buffer memory to the largest object plus
16 MiB of slack. Process RSS also includes the parsed #241 graph,
normalized rows, producer results and runtime memory.
