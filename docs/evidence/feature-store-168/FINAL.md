# Final #168 capacity qualification

The first final qualification passed on committed sources
`a9a81e1ade238deb61df6491f1332ecc692c71f4`, with no measurement-source changes
during or after timing. The receipt pins all 59 source SHA-256s and Git blob IDs,
dependency/SQL inputs and the actual runtime/environment. The six trials use
the same real 16-file / 2,504-row fixture as #167; its evidence remains unchanged.

| Trial | Available / attempts | Full-path p95 | Headroom under 300 ms | Maximum |
| --- | ---: | ---: | ---: | ---: |
| C1 | 100 / 100 | 123.947 ms | 58.68% | 142.130 ms |
| W1 | 100 / 100 | 6.022 ms | 97.99% | 26.326 ms |
| C2 | 100 / 100 | 127.873 ms | 57.38% | 235.586 ms |
| W2 | 100 / 100 | 5.722 ms | 98.09% | 24.613 ms |
| C3 | 100 / 100 | 137.044 ms | 54.32% | 215.118 ms |
| W3 | 100 / 100 | 5.682 ms | 98.11% | 30.349 ms |

Every trial independently passes p95 ≤210 ms and ≥30% headroom, using
nearest-rank `ceil(.95 * N) - 1`. No refusal counts as success. No failed samples,
retries or replacement attempts occurred in the six measured trials. Two
expected negative controls (rights revoked, then dataset deleted) remain outside
those trials, together with their preceding available control request.

All 600 predictions retain 3 SQL / 2 combined rights-status checks / 1 descriptor
GET / 0 request hashes. Independent all-n server-work probes observe 2P actual
rights calls for a separately derived union profile count P (16 in this fixture),
no reader DML, example verification or explicit coordination locks. Model-only
reads retain 2 SQL. The same warm process/connection sees both negative controls.

## Pinned requests

Manifest SHA-256:
`d10d1238dad39bcf8bc3621f8f1f7567f4aca09aaae355dbac82ce76e02dbce2`.
The complete manifest, including selection rules and request pins, is inside
the full record and receipt. It was hashed and persisted before timing.

Each trial covers 100 distinct player/game coordinates, 100 QBs and all 32 teams;
maximum player share is 1%, exceeding the approved minima of 20 QBs / 16 teams
and staying below the 5% cap. Every exact n=2–16 appears. The same schedule runs
in each cold and warm trial. Selection reads feature/job and roster/schedule
metadata without labels, outcomes or dataset-membership eligibility.

| Season | n=2–4 | n=5–8 | n=9–16 |
| --- | ---: | ---: | ---: |
| 2021 | 7 | 7 | 7 |
| 2022 | 7 | 7 | 6 |
| 2023 | 7 | 7 | 6 |
| 2024 | 7 | 6 | 7 |
| 2025 | 6 | 6 | 7 |

## Startup and cache disclosure

Loader: Node 24.18.1 native type stripping, with compile cache disabled and no
inherited loader options. Every cold prediction has a fresh process and connection:
300 distinct cold PIDs. Timing begins in the parent before fork and ends at the
receipt of the complete serialized prediction. Each warm trial has one dedicated
process/connection, with setup outside its measured requests. The parent owns
the full 300 ms deadline and rejects late messages.

The following diagnostics summarize 300 individually retained cold breakdowns.
They are not added to derive a total percentile. Spawn-event time overlaps the
spawn-to-bootstrap interval; residual includes IPC and observer overhead.

| Cold phase | p95 |
| --- | ---: |
| Parent spawn event | 0.702 ms |
| Spawn to child bootstrap | 32.990 ms |
| Dynamic import / native type stripping | 59.323 ms |
| ObjectStore setup | 5.057 ms |
| Connection/authentication | 12.553 ms |
| Handler through serialization | 29.840 ms |
| IPC/observer residual | 1.563 ms |

Per-sample startup (bootstrap + import + store + connect) has p95 101.791 ms,
maximum 209.445 ms and aggregate share 77.42% of the cold full path. The maximum
remains visible and stayed below the 210 ms startup stop threshold. Cold-trial
startup p95s are C1 97.734 / C2 101.509 / C3 104.952 ms. Warm setup is reported
separately: W1 86.186 / W2 82.841 / W3 86.702 ms. Warm handler-only p95 is
5.279 ms; all gates use the complete parent-observed per-trial durations.

Apple M3 Pro / arm64 / 18 GiB RAM / Darwin 27.2.0; loopback PostgreSQL 18.6,
512 MiB data tmpfs / 128 MiB shared memory. OS/file/DB caches remain unflushed
and warmed by fixture preparation. Fresh application process does not mean cold
disk or database. No hosted RTT/wake/region, concurrent throughput or product
clearance claim is made. Strict historical eligibility remains zero;
retrospective results retain historical-availability-unverified. The fixture does
not establish population completeness, and knowledge clocks are not backdated.

## Durable records and independent audit

`final-benchmark-full-records-20261106T161720Z.tar.gz` holds the exact raw
`final-benchmark/full-samples.json` (4,708,455 uncompressed bytes):

`2e97bb8ec7cef19e40e4678542ddc8a7d36e88cd2bf713a374cc70eeef0acee3`.

The full record was persisted through ObjectStore at its content-addressed
`audits/` key. The 211,356-byte deterministic USTAR/gzip -n bundle was also
persisted through ObjectStore before writing this in-tree audit mirror. Sorted
members have fixed timestamps, uid/gid and modes. The final-validation receipt
also pins the compressed bundle's ObjectStore key/hash/size.

From a checkout with Node 24 and tar, without node_modules, cache or database:

```sh
node services/pipeline/scripts/feature-store/artifact-governance-evidence.ts audit docs/evidence/feature-store-168
```

The auditor hashes each safe named member and checks its size before parsing,
then recomputes the receipt, manifest/coverage, all samples' work/process
provenance, and each of the six p95/headroom gates. Normal CI recomputes the same
recorded arithmetic with the speed gate disabled; it runs no live latency test.
Synthetic slow-trial tests exercise gate refusal separately. Validation logs are
hash-verified against their durable mirror. Reruns produce a new sample hash
and new files; earlier #167/#168 evidence is never overwritten.
