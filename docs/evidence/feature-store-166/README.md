# #166 compact evidence

All results use disposable local PostgreSQL and a private local ObjectStore.
Hosted RTT/Neon wake/region (#220) is unmeasured. The
[feature design](../../feature-store-artifact-governance.md) contains the Design
basis and acceptance mapping.

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
The committed [full-records.tar.gz](full-records.tar.gz) contains exactly eight
full records: the final benchmark, three final behavior records and four
historical preimplementation records. Each relative `fullRecord.path` uses
`full-records.tar.gz#member/path.json`; its SHA-256 and byte size describe the
**uncompressed member**, whose bytes are unchanged. The historical spike's
three supplemental records and final validation's benchmark reference resolve
into the same bundle. No cache or original worktree is required.

The bundle is a deterministic USTAR archive: sorted file entries, mtime/uid/gid
zero, empty owner/group names, mode 0644, then `gzip -n -9` (no timestamp or
filename). It excludes superseded steps and older scratch benchmarks. JSON
counter arrays remain summarized as all-table, example-table, queue and
non-queue totals, retaining negative controls, source hashes and probe verdicts.

## Reproducing and auditing the result

From a fresh clone, use **Node 24 and tar**, with no dependencies, local cache or
database required, to audit all eight records:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  services/pipeline/scripts/feature-store/artifact-governance-evidence.ts audit \
  docs/evidence/feature-store-166
```

This prints one `pass` verdict and SHA-256 per member. It checks every receipt
reference, including supplemental records and final validation, before
recomputing the four final compact receipts and the historical prototype's
summary/probe projection. Supplemental records are checked byte-for-byte by
their recorded SHA-256. The benchmark replay checks all sample coordinates,
work counts, Q1/Q2 sums, baseline and block p95s, headroom and the entire compact
receipt. The prototype remains historical design evidence, not final qualification.

To verify just the final benchmark via extraction to stdout:

```sh
tar -xOzf docs/evidence/feature-store-166/full-records.tar.gz final-benchmark-S12ECw/full-samples.json | node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON services/pipeline/scripts/feature-store/artifact-governance-evidence.ts verify docs/evidence/feature-store-166/final-benchmark.json /dev/stdin
```

In both commands, SHA-256 is checked **before** parsing or recomputation. A
copied/extracted full record is also accepted when its bytes match. CI checks
all references for relative paths, bundle membership, hashes and byte sizes,
without timing assertions; synthetic arithmetic/tampering controls remain.

To rerun the experiment, use Node 24 and the registered local
`TEST_DATABASE_URL` with the 512 MiB
`compose.test.yml` fixture. The benchmark reads the retained 16 exact wire files
identified by #138 source evidence, builds fresh 0/2,504-member datasets and
publishes fresh matching descriptors/reports using actual runtime APIs.

```sh
FS166_BENCHMARK_EVIDENCE=docs/evidence/feature-store-166/final-benchmark.json \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  services/pipeline/scripts/feature-store/artifact-governance-benchmark.ts
```

The runner initially writes the full sample record into its unique ignored local
fixture directory and the compact receipt to the requested evidence path. Bundle
new full records and set receipt references to relative bundle members before
committing replacement evidence, so dependency/cache cleanup cannot erase proof.
The runner preserves every sample, including failures, and hashes the full file.
The final gate uses six ABBA blocks per shape, 25 reads per position: nearest-rank
`sorted(Q1+Q2)[ceil(0.95*n)-1]` over each block's 50 candidate reads must be
≤21 ms under the 30 ms allocation. Headroom is `1 - p95/30`; every block needs
at least 30%. Separate Q1 and Q2 percentiles are never added.

A hash alone cannot reconstruct samples; the bundle supplies those exact bytes.
Rerunning the benchmark is reproducible as an experiment, but creates fresh
clocks/pins/timings and a different sample hash. The original source hashes
remain historical measurement pins; the evidence-only bundle/verifier follow-up
does not change SQL or runtime source and requires no speed rerun.

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
