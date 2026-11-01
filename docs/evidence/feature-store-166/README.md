# #166 compact evidence

All results use disposable local PostgreSQL and a private local ObjectStore.
Hosted RTT/Neon wake/region (#220) is unmeasured. The
[feature design](../../feature-store-artifact-governance.md) contains the Design
basis and acceptance mapping. Review corrections remain uncommitted pending
owner approval; no push is authorized.

## Receipts and full records

- [Final benchmark](final-benchmark.json): source hashes, fixture identity,
  baseline-first p95s, every candidate block's p95/headroom, work counts and
  verdict. All 36 blocks pass; worst p95 is **4.806 ms**, **83.98% headroom**.
  Baseline-first p95s: **4.414 ms** (0 rows) and **3.577 ms** (2,504 rows).
  It binds the full 3,650-sample record with SHA-256 and byte size.
- [Lifecycle](final-lifecycle.json): 15 probes, including the lost-COMMIT retry
  of an exact live run after deletion of another run sharing its report. Changed
  file sets/new descriptors, denied rights and invalidated runs refuse. Repeat
  deletion receipts contain only newly invalidated run IDs, so no-op repeats
  have empty `run_ids`.
- [Read boundary](final-read-boundary.json): 11 probes covering eight shapes,
  0/2,504 actual members, selected GETs, internal database work/locks, negative
  controls, current rights/status changes and trusted calculation composition.
- [Cleaner](final-cleaner.json): nine probes covering four SQL per deletion,
  three per refusal, one eligible page, server work including ack's recheck,
  shared retention/final-reference grace, actual disconnects and page progress.
  Observed addresses honor the later of orphan grace and pending `remove_after`.
- [Final validation](final-validation.json): suite/static check results, compact
  receipt/source hashes, independent sample verification and scratch cleanup.
- [Historical preimplementation spike](preimplementation-spike.json): compact
  prototype block timings, source hashes and verdicts, with SHA-256 references
  to the full record and its original verification/oracle. It justified the
  approved design and does not qualify the final implementation.

Superseded per-step receipts and duplicate verification/archive files are removed.
Full samples, raw counters and original historical records are retained beneath
the ignored `node_modules/.cache/feature-store-166/` directory. Each receipt's
`fullRecord.path`, `sha256` and `byteSize` identify the exact durable local bytes;
the files are outside the final Git tree. JSON counter arrays are summarized
as all-table, example-table, queue and non-queue totals. Negative-control
nonzero counts remain visible. Source hashes and all probe verdicts remain in
the compact behavior receipts.

## Reproducing and auditing the result

Use Node 24 and the registered local `TEST_DATABASE_URL` with the 512 MiB
`compose.test.yml` fixture. The benchmark reads the retained 16 exact wire files
identified by #138 source evidence, builds fresh 0/2,504-member datasets and
publishes fresh matching descriptors/reports using actual runtime APIs.

```sh
FS166_BENCHMARK_EVIDENCE=docs/evidence/feature-store-166/final-benchmark.json \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  services/pipeline/scripts/feature-store/artifact-governance-benchmark.ts
```

The runner writes the full sample record into its unique ignored local fixture
directory and writes only the compact receipt to the requested evidence path.
It preserves every sample, including failures, and hashes the final full file.
The final gate uses six ABBA blocks per shape, 25 reads per position: nearest-rank
`sorted(Q1+Q2)[ceil(0.95*n)-1]` over each block's 50 candidate reads must be
≤21 ms under the 30 ms allocation. Headroom is `1 - p95/30`; every block needs
at least 30%. Separate Q1 and Q2 percentiles are never added.

To audit the historical result, obtain the full record named by the compact
receipt (it is retained locally), then run:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  services/pipeline/scripts/feature-store/artifact-governance-evidence.ts verify \
  docs/evidence/feature-store-166/final-benchmark.json /path/to/full-samples.json
```

The verifier checks the file SHA-256 before recomputing all sample coordinates,
work counts, Q1/Q2 sums, baseline and block p95s, headroom and the entire compact
receipt. It accepts a copied full record at another path if its bytes match.
A hash alone cannot reconstruct samples: another checkout needs those exact
retained bytes to audit this run. Rerunning the benchmark is reproducible as an
experiment, but creates fresh clocks/pins/timings and a different sample hash.
CI uses synthetic arithmetic/tampering controls for this verifier, never real
elapsed-time assertions.

For fresh behavior evidence, direct `FS166_LIFECYCLE_EVIDENCE`,
`FS166_READ_EVIDENCE` and `FS166_CLEANER_EVIDENCE` to full-record paths under
the ignored directory, then run `npm run test:feature-store:db`. Compact each
result using the same tool's `behavior RECEIPT FULL_RECORD` operation; `verify`
also audits those receipts against the full raw counters.

The speed result is **local-fixture only**: warm/unflushed OS/file/database
caches and an existing restricted LOGIN. Full-read/callback time is informative;
the callback only sums byte lengths and does not simulate #167 serving/context
work or #168 capacity. #229 still owns cleanup handoff and late-PUT recovery.
Mandatory removal may remain pending through the default 24-hour observation
retirement window after bytes disappear; cleaner evidence records byte removal,
observation retirement and queue completion separately. Test-only grace/observation
ages are shifted; knowledge/event clocks are not backdated.
