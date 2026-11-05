# #167 evidence

Receipts and uniquely named deterministic gzip/USTAR bundles are append-only.
Every `fullRecord.path` identifies its archive and exact member with `#`.
The SHA-256 and byte size describe the uncompressed member. The bundles move
with the code; no worktree cache, database, original object store or dependencies
are needed to audit them with Node 24 and `tar`:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON services/pipeline/scripts/feature-store/artifact-governance-evidence.ts audit docs/evidence/feature-store-167
```

The auditor validates relative paths and exact archive membership, then checks
member SHA-256/size before parsing and recomputing. It recomputes the final
benchmark's request hashes, all 1,245 sample coordinates/work counts, separate
six-cohort p95/headroom values and cold setup shares. Source SHA-256 and git blob
IDs identify measured SQL/TypeScript, including the benchmark's uncommitted
harness bytes; `code.gitSha` is the base commit, not the entire candidate.
A rerun produces a new sample hash and new receipt/bundle filenames.

## Final public-handler qualification

[Final receipt](final-benchmark-20261105T1615Z.json) and
[full sample bundle](final-benchmark-full-records-20261105T1615Z.tar.gz).

Node 24.18.1, loopback PostgreSQL 18.6, 512 MiB data tmpfs/128 MiB shared memory;
16 exact retained nflverse inputs, 2,504 real retrospective examples. Content
SHA-256: `a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d`.
Strict historical eligibility is zero; no clocks were backdated.

The actual public `predictQbModel` executes request capture/validation → context
→ Q1 → descriptor GET/validation → forecast → Q2 → response/serialization →
final delivery/deadline check. Cold setup starts before client construction and
uses that same absolute 300 ms deadline. Close is outside timing. Observers and
output assertions add included overhead. Internal math and serialization stage
fields are zero because they are not separately instrumented; total time
includes them. Setup and warm-path percentiles are diagnostic, never added.

| Cohort | Full p95 ms | Headroom under 300 ms | Setup p95 ms | Warm-path p95 ms | Aggregate setup share |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold 1 | 38.466 | 87.18% | 11.247 | 29.614 | 27.75% |
| Cold 2 | 31.846 | 89.38% | 9.663 | 23.850 | 25.57% |
| Cold 3 | 35.091 | 88.30% | 8.588 | 27.207 | 22.83% |
| Warm 1 | 8.169 | 97.28% | 0 | 8.169 | 0% |
| Warm 2 | 10.948 | 96.35% | 0 | 10.948 | 0% |
| Warm 3 | 7.043 | 97.65% | 0 | 7.043 | 0% |

Each cohort independently passes ≤210 ms / ≥30% headroom, with 100 candidate
and 100 reference reads in ABBA order (50 per position). Every n=2–16 appears
in both arms. The unchanged #163 reference ran first for 45 requests before
model/composite SQL installation (p95 11.507 ms); reference ratios are
informational. There are 600 candidate + 645 reference samples, no failures or
discarded samples, and no benchmark rerun.

Each candidate uses 3 SQL / 2 checks / 1 descriptor GET, zero other ObjectStore
operations and zero request-path hashes. Model-only remains 2 SQL. Outside
timing, every n has exactly 2 × the independently derived union profile count
in rights calls; Q1/Q2 counters show no example-table reads or DML. Step 2's
actual-handler probes cover matched n=2/16 relational work, no reader locks,
permissions, refreshed Q2 flags/receipts, refusal races and deadlines.

Uncompressed sample SHA-256:
`b172c6549d7e9936592366fa11f2dfa8548514d405a4de36217a98fbd4c6186d`
(1,475,153 bytes). Local-fixture only: OS/file/database caches are unflushed;
these results do not establish hosted RTT/region (#220), cold-cache or
fresh-process performance, calibration or product-serving clearance.

## Reproduction and CI

[Final validation](final-validation-20261105T1705Z.json) retains the commands,
source identities and full logs: typecheck/lint, 1,468 Node 24 unit tests,
242 serial feature-store checks and 18 database-free evidence checks pass.
`artifact-cleaner.check.mts` passed; no cleaner failure was discarded. The first
unit attempt's sandbox `listen EPERM` failures and the corrected harness's initial
typecheck failure are retained alongside their successful final runs. Benchmark
qualification passed on its first run. Minimal-copy audits passed with no
dependencies, cache or database (#166: 8, #231: 3, #167 before validation: 59
records). All 52 measured source hashes/blob IDs and deterministic bundle bytes
were independently checked against the final candidate.

Speed reproduction requires the exact retained inputs named by #138's source
manifest/ingestion receipt, private local storage and the disposable fixture in
`compose.test.yml`. Use Node 24, no application credentials, and an exclusively
reserved loopback fixture. The recorded run held the database suite's session
lease (namespace 153045, primary DB oid) throughout, with no startup sweep.
The benchmark runner is
`services/pipeline/scripts/feature-store/prediction-benchmark.ts`; it accepts
`TEST_DATABASE_URL` and optional `FS167_BENCHMARK_DIRECTORY` (default
`codex-briefs/167-final`). Fixture rebuild/publication, server work observers and
connection close are outside timed requests. A miss stops with failed samples
retained; targets are never relaxed. Reproduction is opt-in, not a CI timer.

Database-free CI:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test services/pipeline/tests/feature-store/artifact-evidence.check.mts services/pipeline/tests/feature-store/composite-evidence.check.mts services/pipeline/tests/feature-store/prediction-evidence.check.mts services/pipeline/tests/feature-store/prediction-benchmark.check.mts
```

CI checks member hashes, schedule/work/setup arithmetic and synthetic negative
controls, with no live or recorded speed assertions. The opt-in audit above
also enforces the recorded six-cohort latency gate. Step 0 originals remain
intact alongside the corrected label receipt; merge/step validation records
remain historical evidence, not final-source speed qualifications.
