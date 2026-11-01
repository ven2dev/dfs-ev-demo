# #166 evidence

All results here use disposable local PostgreSQL and a private local ObjectStore.
Hosted Neon/region/network round trips are unmeasured (#220).

## Approved preimplementation spike

- [Full spike receipt](preimplementation-spike.json): all 3,600 interleaved
  samples, baseline-first samples, six shapes, per-block p95s, source hashes,
  fixture identity and 13 behavior probes.
- [Supplemental server-work oracle](preimplementation-work-oracle.json):
  hidden-DML negative control in addition to the scan/tuple counters.
- [Original verification](preimplementation-verification.json) and
  [archive hashes](preimplementation-archive.json): lossless JSON archival;
  only whitespace changed. Original verification hashes refer to the original
  bytes; the archive receipt supplies hashes for these committed files.

The spike used disposable prototype SQL and orchestration. Its source paths
and storage root are historical identifiers, not files needed by this checkout.
No prototype source is shipped as implementation. These measurements justified
the design; they do not qualify the final implementation or CI budgets.

Baseline-first p95(Q1+Q2): 6.826 ms for 0 rows, 3.974 ms for 2,504 rows.
The worst candidate block p95 was 10.268 ms: 65.77% headroom under the approved
30 ms local allocation. Each candidate block passed the ≤21 ms gate. The final
benchmark repeats that per-block gate against the final source bytes in step 4.

## Step 1 implementation

[Lifecycle receipt](step-1-lifecycle.json) records exact affected/surviving IDs,
actual restricted LOGIN refusal probes, real derived/member/provider-row scope,
both publication/deletion lock orders, rollback, typed permanent refusal,
first-publication immutability and a lost-COMMIT-reply retry. Its source hashes
identify the implementation under test. Graph-control reports are explicitly
synthetic; the pipeline retry probes use actual scoring/publication code with
zero-row input envelopes.

[Step-1 validation](step-1-validation.json) records 131 passing feature-store
database tests, the refreshed 15-test lifecycle run, 19 package/import/path
contract tests, targeted TypeScript/ESLint, frozen-migration verification and
scratch cleanup. Test totals include Node's parent tests; the lifecycle receipt
contains 14 individual probes. The broader suite preceded the last explicit
unchanged-pin assertions; the refreshed lifecycle run covers those assertions
against the same runtime/SQL bytes.

Regenerate that receipt with Node 24 and the registered local test target:

```sh
FS166_LIFECYCLE_EVIDENCE=docs/evidence/feature-store-166/step-1-lifecycle.json \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test \
  services/pipeline/tests/feature-store/artifact-governance.check.mts
```

The harness applies fresh proposal SQL only in a disposable database and drops
its database and LOGINs afterward. `TEST_DATABASE_URL` identifies the registered
local test target. No hosted environment file is loaded.

## Step 2 implementation

[Read-boundary receipt](step-2-read-boundary.json) records eight successful
read shapes across single/paired modes, 0/2,504 actual members and descriptor-only
versus all artifacts. Each uses exactly two SQL calls and the selected GET count,
with zero example-table work and all-table DML inside both authorization calls.
All raw server counters remain in the receipt; metadata probe counts are allowed
to vary with PostgreSQL plan choice. A measurement-only in-statement lock probe,
hidden-scan and hidden-DML controls, actual LOGIN refusals, 12 mid-operation
revocation/deletion cases, paused-reader concurrency checks and shared-retained
delivery cover the read contract. Source hashes identify the implementation.
The trusted callback and dedicated idle connection preconditions are described
in the [feature design](../../feature-store-artifact-governance.md).
[Step-2 validation](step-2-validation.json) records all 143 passing feature-store
database tests, 15 package/import contract tests, targeted TypeScript/ESLint,
frozen-migration verification and complete scratch cleanup. Step 1 is committed
as `0484bd6`; step 2 is committed as `becbcd0`.

Regenerate the receipt with the same registered local test target:

```sh
FS166_READ_EVIDENCE=docs/evidence/feature-store-166/step-2-read-boundary.json \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test \
  services/pipeline/tests/feature-store/model-artifacts.check.mts
```

## Step 3 implementation

[Cleaner receipt](step-3-cleaner.json) records fixed client and database-side
budgets at 0/2,504 actual members, shared-retained/final-reference grace,
model/audit requeue, actual lock waits, unlink-before-ack exceptions and real
disconnects, lost COMMIT replies and restricted LOGIN refusals. A combined queue
fixture defers 1,025 observed addresses before the page limit, completes 1,025
shared attempts and reaches later removable bytes. Full raw server counters and
source hashes are retained. There is no elapsed-time CI assertion.
[Step-3 validation](step-3-validation.json) records all 153 passing feature-store
database tests, 15 package/import contract tests, targeted TypeScript/ESLint,
frozen-migration verification and complete scratch cleanup. Step 3 is committed
as `39947fb`. Per-step JSON receipts preserve their original precommit status;
the final validation identifies the current source bytes.

The observed-address probe records **bytesRemovedAt**, **observationsRetiredAt**
and **queueCompletedAt** separately. It proves the scoped sweep removes bytes
after orphan grace while observation and removal intent survive, then mandatory
cleanup completes only after retirement, without errors deleting missing bytes.
Test-only observation/grace ages are shifted; database knowledge/event clocks
are not backdated. Pending status can outlast byte presence through the 24-hour
retirement window. #229 retains cleanup handoff and completed-removal late-PUT
recovery; this receipt does not claim those guarantees.

Regenerate the receipt against the registered disposable local target:

```sh
FS166_CLEANER_EVIDENCE=docs/evidence/feature-store-166/step-3-cleaner.json \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test \
  services/pipeline/tests/feature-store/artifact-cleaner.check.mts
```

## Step 4 final implementation

- [Final benchmark](final-benchmark.json): 50 baseline-first reads and all
  3,600 ABBA samples across six shapes, including 1,800 candidate reads.
  Every one of 36 candidate blocks passes p95(Q1+Q2) ≤21 ms under 30 ms.
  Worst block: **6.380 ms**, **78.73% headroom**. Baseline-first p95s are
  **4.368 ms** (0 members) and **3.230 ms** (2,504 members).
- [Fresh lifecycle](final-lifecycle.json), [read boundary](final-read-boundary.json)
  and [cleaner](final-cleaner.json): 14, 11 and 9 behavior/work-budget probes
  respectively, rerun against the current implementation. These preserve the
  CI two-statement read and four-statement-per-deletion budgets, including
  internal database work and the observed-address ownership rule.
- [Independent verification](final-verification.json): exact sample groups,
  work counts, Q1+Q2 sums, nearest-rank block percentiles, 47 current source
  hashes and five unique freshly published descriptor/report objects checked
  separately from the benchmark runner. No samples are discarded.
- [Final validation](final-validation.json): 153 passing database tests,
  19 package/import/path contract tests, targeted TypeScript/ESLint,
  frozen-migration checks and complete scratch cleanup. The first contract run
  encountered sandbox `EPERM` binding its loopback server; the unrestricted
  rerun passes all 19 tests. Both attempts' output hashes are recorded.

The [feature design](../../feature-store-artifact-governance.md#final-acceptance-and-premise-first-review)
maps the acceptance criteria to these fresh receipts and records the review in
premise → targets → correctness order. The owner has approved all four step
commits. Evidence receipts retain their precommit status; push requires fresh
owner consent.

The benchmark exercises actual runtime APIs and fresh reports with matching
scratch-database pins. Its source was written independently of the disposable
spike. Fresh report sizes are 9,290,167 and 306,542 bytes; archived payload sizes
are historical evidence. Ordinary timed reads use exactly two authorization
queries, one GET per selected file, zero ordinary hashes/HEADs/writes and a
trivial private byte-length calculation. Server-work measurement runs in the
separate behavior lane, not inside timing.

Reproduce the final speed experiment with Node 24, the registered local
`TEST_DATABASE_URL`, the private retained wire objects identified by the #138
source evidence and the 512 MiB `compose.test.yml` fixture:

```sh
FS166_BENCHMARK_EVIDENCE=docs/evidence/feature-store-166/final-benchmark.json \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  services/pipeline/scripts/feature-store/artifact-governance-benchmark.ts
```

For fresh integrated behavior receipts, set `FS166_LIFECYCLE_EVIDENCE`,
`FS166_READ_EVIDENCE` and `FS166_CLEANER_EVIDENCE` to their `final-*.json` paths,
then run `npm run test:feature-store:db` against that disposable local target.
No environment files or hosted credentials are needed.

All final speed results remain **local-fixture only**, with warm/unflushed
OS/file/database caches and an existing restricted LOGIN. Query timing includes
local loopback and decoding. Full-read timing is informational; the callback
does not simulate #167 context/projection work. Hosted RTT/region/Neon wake
(#220), cold caches and #168 capacity are unmeasured. #229 still owns cleanup
handoff and late-PUT recovery; observed removals can remain pending through the
24-hour retirement window after their bytes have disappeared.
