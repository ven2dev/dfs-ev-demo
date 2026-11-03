# #231 final composite authorization evidence

All measurements use the approved loopback PostgreSQL **18.6**, **512 MiB** data
tmpfs/128 MiB shared memory and Node **24.18.1**. Qualification is **LOCAL-FIXTURE
ONLY**. The [feature design](../../feature-store-composite-authorization.md)
contains the Design basis, requirements and nine-criterion acceptance mapping.

## Receipts and durable full records

- [Final benchmark](final-benchmark.json) binds all 1,245 samples: 45 unchanged
  reference-first requests, then six interleaved cohorts containing 600 candidate
  and 600 reference requests. All six candidate cohorts pass ≤210 ms p95; worst
  **27.729 ms**, **90.76% headroom under 300 ms**. Reference-first p95: **11.623 ms**.
- [Context behavior](final-context.json) binds six metadata/PIT/version/last-valid/
  knowledge-clock/narrow-LOGIN/index/work probe groups.
- [Composite behavior](final-composite.json) binds 15 probe groups and 78 measured
  delivery/refusal budgets, including independent lineage, label invariance,
  exact-reference/pruning/mutation refusal, withdrawal races, paused-reader locks,
  model-only compatibility and shared-retained reports.

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
| final/full-samples.json | pass | 1,483,533 | `380982fb0426e5ddb511c883852701682c76721ec8895857747b632bd4436ccc` |
| behavior/full-composite.json | pass | 112,279 | `c468282b39c4ef5bee5e419191b74028d6f846853360b37e01e2643d25203b98` |
| behavior/full-context.json | pass | 14,972 | `b0b0be86f8ada235a612e5d17ec3ea0df9dfc96a96766a4c3f2f14769a5f5860` |

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
| Cold connection 1 | 27.729 | 22.533 | 6.888 | 21.587 | 23.36% |
| Cold connection 2 | 24.580 | 21.723 | 6.123 | 18.526 | 23.64% |
| Cold connection 3 | 24.279 | 32.370 | 6.287 | 19.146 | 23.28% |
| Warm 1 | 4.491 | 7.029 | 0 | 4.491 | 0% |
| Warm 2 | 4.235 | 6.528 | 0 | 4.235 | 0% |
| Warm 3 | 5.123 | 6.542 | 0 | 5.123 | 0% |

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
SQL and runtime source hashes match the final benchmark's source identity; the
only Step 3 work is benchmark/evidence tooling, tests, records and documentation.
No frozen migration or runtime/SQL change was needed after Step 2.

Before the Step 3 approval checkpoint, the documented audit and all 10 evidence
checks were repeated in a clean archive of committed sources with the intended
Step 3 audit/evidence files overlaid. That copy contained **no node_modules or
cache**, and all three records passed hash/size checks and recomputation. It is
a clean source-copy proof, not a claim that the unapproved Step 3 commit already
exists. Owner review/commit approval and fresh push consent remain required.
