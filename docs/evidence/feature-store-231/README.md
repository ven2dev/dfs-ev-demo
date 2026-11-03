# #231 final composite authorization evidence

All measurements use the approved loopback PostgreSQL **18.6**, **512 MiB** data
tmpfs/128 MiB shared memory and Node **24.18.1**. Qualification is **LOCAL-FIXTURE
ONLY**. The [feature design](../../feature-store-composite-authorization.md)
contains the Design basis, requirements and nine-criterion acceptance mapping.

## Receipts and durable full records

- [Final benchmark](final-benchmark.json) binds all 1,245 samples: 45 unchanged
  reference-first requests, then six interleaved cohorts containing 600 candidate
  and 600 reference requests. All six candidate cohorts pass ≤210 ms p95; worst
  **30.212 ms**, **89.93% headroom under 300 ms**. Reference-first p95: **8.153 ms**.
- [Context behavior](final-context.json) binds six metadata/PIT/version/last-valid/
  knowledge-clock/narrow-LOGIN/index/work probe groups.
- [Composite behavior](final-composite.json) binds 15 probe groups and 79 measured
  delivery/refusal budgets, including independent lineage, label invariance,
  exact-reference/pruning/mutation refusal, withdrawal races, paused-reader locks,
  model-only compatibility and shared-retained reports.

The corrected context probes pin knownAsOf between feature insertion and job
completion, then prove the selected value/visible head stay unchanged after the
job finishes. The completion-time microsecond boundary is explicit. Composite
probes assert P1666 status refusal for feature/source withdrawal and pruning at
Q1/Q2, including when an older valid feature survives; forged caller references
retain P2317. The source hashes bind these corrected SQL and probe sources.

Each receipt names `full-records.tar.gz#member/path.json`. SHA-256 and byte size
describe the **uncompressed member**. The committed bundle contains exactly these
three records; it needs no local cache, dependency directory, original worktree or
database. Entries are sorted regular USTAR files, mode 0644, mtime/uid/gid zero,
empty owner names, compressed with `gzip -n`. The TypeScript
`evidence-bundle.ts` helper creates deterministic archive bytes; its test verifies
ordering, metadata and unsafe-path refusals. No Python audit is used.

## Audit from a fresh checkout

With Node 24 and tar, including a checkout with no node_modules:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  services/pipeline/scripts/feature-store/artifact-governance-evidence.ts audit \
  docs/evidence/feature-store-231
```

The existing #166 TypeScript evidence tool now recognizes #231 records. It prints
one pass/hash/size result per member. Before parsing or recomputing, it checks the
member's SHA-256 and byte size against every receipt reference. It refuses unsafe,
absolute, missing, duplicate or unreferenced archive member paths and only reads
named files to stdout; it does not extract files to disk.

| Uncompressed member | Verdict | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| final/full-samples.json | pass | 1,483,111 | `33420718f3ce5a8ba9f5383a8927b5fba070abec50e5a58eddb73b817396808e` |
| behavior/full-composite.json | pass | 113,861 | `e54eb6da387e0d8f71888da061ad84d53e5523985991427f88977e95d6c5e766` |
| behavior/full-context.json | pass | 15,347 | `5d949afc3b874aa9eaf2fbfd66f73138b8c5b3ec02db8f59e6b94462adda9786` |

Benchmark replay recomputes complete-request nearest-rank p95s, headroom, cold
setup shares, per-n/client/server work and cohort membership, then checks the
entire compact receipt. Behavior replay checks all recorded probe verdicts,
all-n budgets, dynamic profile-call counts and matched relational-work/negative
controls. Other behavior details remain hash-bound recorded assertions; replay
does not rerun their SQL. Each detail has a digest in its compact receipt.

For one benchmark record:

```sh
tar -xOzf docs/evidence/feature-store-231/full-records.tar.gz final/full-samples.json | node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON services/pipeline/scripts/feature-store/artifact-governance-evidence.ts verify docs/evidence/feature-store-231/final-benchmark.json /dev/stdin
```

CI runs a database-free bundle membership/hash/size check and synthetic verifier
negative controls. It makes no live or recorded machine-speed assertion.

## Measurement and limits

The runner hash-checks the 16 retained wire inputs named by #138 evidence, rebuilds
the natural retrospective **2,504-player-game** fixture with content SHA-256
`a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d`, and publishes a
matching descriptor through the actual pipeline. Real strict historical rows:
**zero**. No producer clocks are backdated. Speed requests are preselected from
usable feature metadata at each n=2–16, with no label or training-membership gate;
their exact identities have a hash in the record. Synthetic correction/race/
outside-training probes live in the behavior receipts, not the speed cohort.

The complete path is metadata resolver → composite Q1 → one descriptor GET/parse
→ shared domain support/probability/pricing math → composite Q2 → full response
serialization. The unchanged #163 reference runs first, before candidate SQL
installation. Each cohort then uses ABBA, 50 requests per position. Every cohort
contains every n and uses the same request schedule in both arms. The gate is
`sorted(candidate totalMs)[ceil(0.95 * 100)-1] <= 210 ms`, and headroom is
`1 - p95 / 300`. Failed requests/cohorts stop the run and remain in full evidence;
none occurred. Stage percentiles are never summed.

| Cohort | Candidate total p95 ms | Reference total p95 ms | Setup p95 ms | Warm-path p95 ms | Aggregate setup share |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold connection 1 | 25.791 | 24.451 | 6.453 | 19.942 | 24.10% |
| Cold connection 2 | 25.686 | 20.503 | 6.537 | 19.195 | 23.67% |
| Cold connection 3 | 30.212 | 20.680 | 6.440 | 23.821 | 23.69% |
| Warm 1 | 4.502 | 7.698 | 0.000 | 4.502 | 0.00% |
| Warm 2 | 4.125 | 7.182 | 0.000 | 4.125 | 0.00% |
| Warm 3 | 5.249 | 7.123 | 0.000 | 5.249 | 0.00% |

Cold setup includes Client creation/connect/authentication in an already running
process. Close is outside timing. Warm-path duration is each sample's total minus
its own setup. Aggregate setup share is the sum of setup durations divided by the
sum of complete durations; the separate mean per-sample share is also retained.
OS/file/DB caches are unflushed. These are not cold-cache or fresh-process results;
hosted round trips, wake and region effects (#220) remain unmeasured.

Every candidate sample has **3 SQL, 2 combined checks, 1 descriptor GET, zero
hashes/HEAD/PUT/DELETE/LIST**. Model-only #166 stays at **2 SQL**. Separate server
instrumentation measures **2 × independently derived union profile count** at
every n, with per-profile assertions; it is removed before timing. The real
fixture happens to have 16 profiles, while synthetic overlap/independent controls
exercise other counts. Matched n=2/16 graphs retain identical relational work,
zero reader DML/label/member/normalized reads, scan/write negative controls and
paused-reader lock/concurrent-deletion proof. No fixed 16-profile CI budget exists.

The reference performs its existing per-row qualification and feature-only
authorization. The candidate authorizes model plus feature and trusts producer
qualification. Relative timings are informative; only the fixed 210/300 target
qualifies the candidate. Query/ObjectStore/hash observation affects both arms.
The trusted composition validates basic descriptor format/pins but is not #167's
final response/deadline/session-disposition contract. #167 needs its final handler
benchmark after #231 merges, with another spike only if its design changes.

## Rerun

With dependencies installed, the registered local fixture and retained #138 input
objects available, run the existing guarded scratch harness:

```sh
TEST_DATABASE_URL=postgresql://dfs_ev_test:dfs_ev_test@127.0.0.1:54329/dfs_ev_test \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  services/pipeline/scripts/feature-store/composite-authorization-benchmark.ts
```

Its default output is a unique **untracked `codex-briefs/231-final/benchmark-*`**
directory, outside /tmp and dependency caches. It records raw samples and a draft
receipt, source/fixture hashes and failures, then removes the scratch database.
`FS231_BENCHMARK_DIRECTORY` selects a different durable output directory. No app
credentials or .env files are loaded; no hosted or Production access occurs.

Fresh clocks, pins and timings produce a **new sample hash**. To replace evidence,
compact the new raw records with the tool's `composite` / `behavior` operation,
bundle the exact bytes with `deterministicEvidenceBundle`, and set receipt paths
to relative bundle members before committing. A hash alone cannot reconstruct
samples; the committed full bundle supplies those bytes. Behavioral reruns use
`FS231_CONTEXT_EVIDENCE` and `FS231_COMPOSITE_EVIDENCE` with durable local paths
while running `npm run test:feature-store:db`.

## Final validation

The complete feature-store PostgreSQL/receipt suite passes **187 tests**, including
fresh context and composite behavior records above. All **25 feature-store unit
tests**, **23 workspace boundary/layout tests**, focused TypeScript and lint pass.
All **8 public-package/path contracts** pass; the local review-server test was
rerun with loopback permission after the sandbox refused its bind.
The **10 database-free #166/#231 evidence checks** also pass after final packaging.
SQL and runtime source hashes match the corrected final benchmark's source
identity. Proposal SQL changes cover usable knowledge time and typed withdrawal;
no frozen migration or runtime TypeScript change is included in the corrections.

The documented audit and all 10 database-free evidence checks also pass in a
minimal copy containing only the audit sources, tests and committed evidence,
with no node_modules or cache. All three #231 records pass hash/size validation
and recomputation there; the checks also cover the unchanged #166 bundle. The
working-copy corrections await owner approval before commit and push.
