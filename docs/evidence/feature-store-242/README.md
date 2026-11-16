# #242 final prediction capacity qualification

The first qualification attempt passed on committed sources
`4edb69881e0ebb2388ae4b81be7d319a9b78626e`. All **62** recorded source SHA-256s
and Git blob IDs match those committed bytes, including the #241 proposal loaded
by the unchanged fixture harness. Combined source digest:
`1f9491ce8bab3b3329a28223df2c7bc2193539b7b7960430eb58251fbde8ed6c`.

## Trial gates

| Trial | Available/attempts | Full-path p95 ms | Headroom under 300 ms | Startup p95 ms | Startup maximum ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| C1 | 100/100 | 170.547 | 43.15% | 133.561 | 139.986 |
| W1 | 100/100 | 7.202 | 97.60% | setup separate | — |
| C2 | 100/100 | 169.319 | 43.56% | 131.608 | 142.633 |
| W2 | 100/100 | 8.563 | 97.15% | setup separate | — |
| C3 | 100/100 | 162.780 | 45.74% | 133.548 | 175.631 |
| W3 | 100/100 | 8.676 | 97.11% | setup separate | — |

Each trial independently meets full-path p95 ≤210 ms and ≥30% headroom. Each
cold startup p95 independently meets ≤210 ms. All individual startup and
full-path durations are ≤300 ms. Minimum headroom is **43.15%**.
The largest full-path sample is 210.428 ms;
a single full-path value above 210 ms is allowed by the trial rule. No samples
were refused, retried or replaced. Expected rights/deletion refusals remain
separate controls, never latency successes. There was no failed timed attempt.

Schema 2 / issue 242 uses the fixed trial-p95 startup policy and explicit 300 ms
sample deadline. Startup is inside the parent-observed full path. Each cold
sample starts a fresh Node 24 process and connection; timing starts before fork
and ends with the complete serialized IPC result. Cleanup is outside timing.
Startup is bootstrap + import + store + connect. Spawn-event time overlaps
bootstrap and is never added twice. The parent deadline/latch still rejects late
replies; phase percentiles are diagnostic and are not added together.

## Cold startup tail

Indices are zero-based in the pinned request list. The full receipt and raw
record also retain PID and feature ID for every listed sample. Ties are ordered
by ascending original index.

| Trial | Five slowest startups (index: milliseconds) |
| --- | --- |
| C1 | #73: 139.986; #75: 138.935; #98: 137.443; #99: 135.149; #0: 134.055 |
| C2 | #6: 142.633; #64: 139.563; #79: 137.115; #57: 136.321; #4: 132.832 |
| C3 | #1: 175.631; #34: 146.171; #11: 137.443; #23: 135.783; #91: 133.822 |

| Cold phase | Across-cold-samples p95 ms (diagnostic only) |
| --- | ---: |
| spawnMs | 1.190 |
| bootstrapMs | 41.886 |
| importMs | 74.086 |
| storeMs | 5.203 |
| connectMs | 16.707 |
| handlerMs | 35.569 |
| residualMs | 1.991 |
| startupMs | 133.548 |

Cold startup's aggregate share of full-path time is **78.95%**.
The cold connection/setup cost remains distinct from the warm path. Warm setup
outside request timing: W1 119.783 ms; W2 135.209 ms; W3 126.608 ms.

## Work and pinned workload

All 600 measured predictions use exactly 3 SQL / 2 combined rights-status checks /
1 descriptor GET / 0 request hashes. Independent server probes at every n=2–16
retain 2P rights calls for independently derived union profile count P, no reader
DML, per-example verification or coordination locks; model-only calls retain
2 SQL / 1 GET. Warm controls observe rights revocation and deletion in the same
existing process/connection.

The pre-timing manifest hash is
`d462346aad49014d61be3bca03f7b18504562cb9e8d05614b64cf03869cfac7d`.
Every trial executes the same 100 ordered requests. There are 100 QBs,
32 teams, maximum player share 1.00%,
all five seasons × three history bands (6–7 requests per cell), and every n=2–16.
The ordered player/game, season/team, history size and cutoff coordinates exactly
match #168's list. Fresh run/feature identities and knownAsOf produce a new
manifest hash. Selection still excludes target labels and training membership.
There are 300 distinct cold PIDs and 3 distinct warm PIDs.

## Environment and limits

v24.18.1, Node 24 native type stripping; Apple M3 Pro, arm64,
19327352832 bytes RAM, darwin 27.2.0.
Loopback PostgreSQL 18.6 uses the standard compose.test.yml mount: **512 MiB data /
128 MiB shared memory**, with no setting changes or larger-disk substitution.
ALT's quiet-window confirmation preceded fixture preparation; the owner received
Relay's all-clear after the benchmark process exited. No other client sessions
were present at the preflight or postflight observations.

The unchanged 16-file fixture reproduced 2,504 retrospective rows and content
hash `a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d`.
Strict historical eligibility remains zero. Retrospective results retain
historical-availability-unverified, with real producer clocks unchanged.
OS/file/DB caches were unflushed and warmed by preparation; fresh process does
not mean cold disk/database. No hosted latency or concurrency-throughput claim
is made. #168 is historical evidence, not an interleaved baseline for this run;
these timings do not establish a controlled speed regression or improvement.

Boundary disk observations were 110.719 MiB (22% rounded) used before and
222.719 MiB (43% rounded) used after cleanup, with 80 MiB and 192 MiB WAL
respectively. These are boundary observations, not sampled peaks. Temporary
files were zero at both boundaries. Scratch databases/roles were cleaned up;
the standard container was not restarted or reconfigured.

## Durable evidence and audit

Raw full-record SHA-256:
`cb729388732ec50daa0e25dedbe5abe2e68a226de23f8dc583e3577eaa1efe13` (4714220 bytes).

At qualification, `final-benchmark-full-records-20261108T064349Z.tar.gz` was a deterministic USTAR/gzip -n mirror,
213413 bytes, SHA-256
`3a37ddc23b7cfbd3f8420d1dbe6e3862c4c262c2b856315b4a4899db7904c778`.
Both the exact raw record and bundle were persisted through the private local
ObjectStore before writing this mirror. The separate validation receipt names
the bundle ObjectStore key/hash/size and retains environment and validation logs.
Each bundle has sorted safe members, fixed timestamps, owners and modes.

From a clean checkout with Node 24 and tar, without node_modules, cache or a DB:

```sh
node services/pipeline/scripts/feature-store/artifact-governance-evidence.ts audit docs/evidence/feature-store-242
node services/pipeline/scripts/feature-store/artifact-governance-evidence.ts audit docs/evidence/feature-store-168
```

Since #261, that forecast archive is retained privately and replaced by its
`.reference.json` and minimal `.public.json` projection. The owner accepted its
existing history exposure; no history rewrite took place. Original compact
receipts, timings and source identities are unchanged. Public audits label that
record `public-metadata`; the other 23 validation members remain `full-bytes`.

Public checks recompute available request coverage, process/work/phase accounting
and recorded p95/startup/tail arithmetic from receipts and projections. New
per-sample fields contain only response hash, size, status/refusal and timing.
They cannot independently verify private forecast/context linkage, raw
per-table SQL-oracle counters or private logs. CI has no live machine-speed gate.
Maximum/tail tampering is rejected. #168 keeps its original per-sample startup
rule; its publication cleanup changes no measured result. All #242
receipts/bundles are new timestamped files; reruns append new records.

To reproduce the original complete audit with retained bytes:

```sh
node services/pipeline/scripts/feature-store/artifact-governance-evidence.ts audit-private \
  docs/evidence/feature-store-242 "$PRIVATE_OBJECTSTORE"
```

The ObjectStore directory is explicit and stays out of committed references.
Missing or corrupt private bytes fail; a hash-only record is not a full-audit
pass. [#261 evidence](../feature-store-261/README.md) records the readbacks and parity.

Validation retains 942 jsdom and 653 Node unit passes (one opt-in skip) from
the exact Step 1 source bytes, 62 focused capacity tests, 23 CI-gate checks,
11 import-boundary checks and the runtime contract. The final evidence changes
pass typecheck, ESLint and 21 evidence checks. Initial sandbox-only loopback
failures are retained alongside the unrestricted passing unit logs.

`final-validation-20261108T064903Z.json` names 23 supplemental members in the
20,267-byte `final-validation-full-records-20261108T064903Z.tar.gz` bundle,
SHA-256 `0156d43ee5b27bbe09912fedd1e38cb12780b6e2e236a4c5fb93b2668b5939de`.
It includes the preflight/postflight observations, qualification output,
independent source/request checks and validation logs. All supplemental records
and this deterministic bundle were persisted through ObjectStore before the
in-tree mirror. The benchmark raw member is separately named, not duplicated.
