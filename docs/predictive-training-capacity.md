# #118 local training capacity measurements

This opt-in benchmark exercises the ordered migration prefix and the guarded
training APIs. It measures different player/event values rather than cloning
one consumer body. It does not qualify real sources, historical availability,
population coverage or #54 Part B. The prior shared-context measurement remains
in [the evidence log](predictive-training-evidence.md).

## Interleaved baseline/draft comparison — 2026-10-14

The [paired evidence](evidence/predictive-training-capacity64-interleaved-review-drafts-2026-10-14.json)
compares the archived `938fa00` runtime with `93399ec` and the unchanged
0022–0024 proposals. It seeds the 64-QB/eight-profile fixture once, then runs
baseline → drafts → drafts → baseline on four clones of that immutable seed.
All trials use the same process, dependencies, artifact bytes and machine;
each API gets a fresh restricted connection. Frozen 0001–0020, current-rights
checks and the normal 10/30-second deadlines are unchanged. The evidence pins
the runtime revisions, source/benchmark hashes and every SQL proposal hash.

**The one-row dataset regression persists, at about 7% in this comparison.
The earlier 34–39% slowdown across all completed calls is not reproduced.**
These are two observations per version, not statistical capacity guarantees:

| Preparation | Baseline range (median) | Draft range (median) | Result |
| --- | ---: | ---: | --- |
| Run, 1 row | 2.026–2.097 s (2.062 s) | 2.033–2.148 s (2.091 s) | All complete; overlapping ranges |
| Dataset, 1 row | 13.939–14.180 s (14.060 s) | 14.978–15.131 s (15.055 s) | All complete; draft median about 7.1% slower |
| Run, 16 rows | 7.910–7.969 s (7.940 s) | 7.930–7.977 s (7.954 s) | All complete; overlapping ranges |
| Dataset, 16 rows | Refused at 30.019–30.023 s | Refused at 30.020–30.024 s | Both versions refuse twice |

The original retained baseline did complete 16-row preparation, as recorded
below. Both baseline trials now refuse it, so this comparison does not reproduce
a completion difference attributable to the drafts. The workload remains close
to or beyond its limit in both versions; a timeout is a censored observation,
not a completed 30-second duration.

The SQL closure regression is clearer. After excluding each trial/width's first
probe, one-member closure takes **52.4–54.3 ms baseline versus 377.5–407.4 ms
draft**. At 16 members it takes **52.2–54.3 ms versus 377.1–384.7 ms**. Warm
median ratios are about 7.3× and 7.1×. Warm shared-buffer hits rise from
379 to 3,450–3,456 at width1 and from 359 to 4,306 at width16. All 24 probes
preserve exactly the same closure: 381 references / 17 blobs at width1 and
476 references / 32 blobs at width16, including identical protected uses.
The successful one-row sealed manifests also match those closures.

Each completed call has identical client statement counts across versions:
nine for run preparation and 3,645 for one-row dataset preparation. The single
`predictive_prepare_training_dataset` call rises from 531–540 ms to
1,521–1,537 ms, close to the end-to-end increase. This localizes reproducible
extra cost to the database preparation path, consistent with the closure probes;
it does not establish whether planning, JIT or per-node execution dominates.
The grouped timings include client queue wait, not just server CPU, and their
sums must not be interpreted as independent elapsed-time shares. Both versions'
one-row preparation also makes 1,052 compressed-inspection queries and 311
rights-authorization queries: repeated application work remains another target.

**Do not promote 0023 as a performance improvement.** Its exact indexed
dependency traversal needs further profiling and optimization before promotion;
retain the approved deletion, lock-order and rights guarantees. The comparison
records 12 completed preparations and four refusals. Its diagnostic test passes
because the comparison and parity assertions complete; it is not a capacity gate
pass. It does not repeat numerical pages, standalone labels or width64, whose
last full matrix still fails. Full histories and representative file sizes are
also unproven.

Setup takes 574.2 s; the complete comparison takes 805.8 s. Database clones
isolate trial writes but do not reset operating-system caches, thermal state
or background host load. Trial order reduces a simple time trend; two samples
cannot resolve all noise. The bundle includes both reviewed application changes
and all three SQL proposals, so API differences cannot be assigned exclusively
to 0023. The separate closure probes compare the SQL implementations directly.
A pg concurrent-query deprecation warning remains; this does not demonstrate
compatibility with pg@9. #54 Part B remains blocked by capacity and missing
qualified real evidence.

## Review drafts on prefix20 — 2026-10-14

The [review-draft matrix](evidence/predictive-training-capacity64-review-drafts-2026-10-14.json)
uses `87e5206` with the reserved 0022–0024 proposals applied outside the ordered
chain. It records each proposal hash separately; 0021 is unavailable and no
combined catalog approval is implied. All frozen migrations and application
deadlines remain unchanged. This is one warm local sample, not a controlled
performance comparison or an operating-capacity approval.

The draft run is **observably slower than the retained `938fa00` baseline** on
the same fixture and machine. All completed preparation calls take longer;
16-row dataset preparation now refuses where the baseline completed:

| Preparation | Baseline | With drafts | Observed change |
| --- | ---: | ---: | ---: |
| Run, 1 row | 1.53 s | 2.05 s | about 34% slower |
| Dataset, 1 row | 10.88 s | 15.12 s | about 39% slower |
| Run, 16 rows | 5.86 s | 8.00 s | about 37% slower |
| Dataset, 16 rows | 23.41 s, completed | refused at 30.02 s | completion lost |

The three completed calls have identical client SQL statement counts in the
two runs, so the slowdown is not explained by more client statements in those
calls. Equal statement counts do not establish that each statement became
slower; server work, client work and contention are not yet separated. Run
preparation does not use the closure but slowed similarly, which is evidence
against assigning the whole difference to 0023. Per-node PL/pgSQL traversal is
also a possible added cost. The runs were not interleaved, so workload noise
and draft overhead cannot be separated by these two runs alone. The interleaved
comparison above now isolates a repeatable closure/preparation regression;
0023 remains unpromoted. The original record establishes a failed gate, not a
performance improvement.

**The strict capacity gate fails: three measured operations complete and six
refuse. No numerical page or final-label read completes.** The benchmark now
offers an explicit require-complete mode, used for this run, so bounded deadline
refusals cannot produce a green capacity result.

| Operation | Selected rows | Result | Wall time | Client SQL statements |
| --- | ---: | --- | ---: | ---: |
| Prepare run | 1 | Completed | 2.05 s | 9 |
| Prepare dataset and pin | 1 | Completed | 15.12 s | 3,645 |
| Read page | 1 | Operation deadline | 10.03 s | 2,222 |
| Read final labels | 1 | Operation deadline | 10.02 s | 2,107 |
| Prepare run | 16 | Completed | 8.00 s | 9 |
| Prepare dataset and pin | 16 | Preparation deadline | 30.02 s | 3,664 |
| Read final labels | 16 | Operation deadline | 10.02 s | 9 |
| Prepare run | 64 | SQL statement timeout | 10.01 s | 9 |
| Read final labels | 64 | Operation deadline | 10.02 s | 9 |

Pages at width16 are not attempted after dataset preparation refuses; width64
dataset/pages are not attempted after run preparation refuses. Metadata selection
still takes only 0.331/1.457/4.530 ms. The guarded width16 feature check takes
5.035 s / 254,833 buffer hits; its label check exceeds the 15-second diagnostic
ceiling. The guarded width64 feature and label probes also exceed that ceiling.

The new one-member closure probe takes 428 ms / 3,888 buffer hits, with exactly
the original 381 references, 17 blobs, 140,143 wire bytes and 180,510 charged bytes.
This checks the indexed traversal in the wider inventory but does not establish
its scaling at 16/64 members, since those datasets were not sealed. The remaining
end-to-end cost includes repeated SQL reconstruction and thousands of application
statements; exact attribution needs per-query profiling. The new indexes and
closure rewrite alone do not clear that bottleneck. Do not raise deadlines.

Checked fixture setup takes 488.4 s; the complete matrix takes 684.4 s. It uses
the same 64-QB/eight-profile, four-CSV/four-gzip inventory and one numerical
history slot without opponent context. Full history, larger source files,
qualified populations and real sources remain unproven. Local log:
`/private/tmp/dfs118-review-draft-capacity64.log`. The assertion failure is the
explicit capacity gate reporting the retained refusals; the five focused
behavior/permission/retention regressions pass separately.

## Prefix20 wider-inventory checkpoint — 2026-10-14

The [64-QB matrix](evidence/predictive-training-capacity64-prefix20-2026-10-14.json)
exercises widths 1/16/64 against the same eight-profile source inventory, with
four CSV and four gzip groups. It retains exact source/migration hashes, natural
plans, nested function timings and completed/refused calls. **No measured page
or final-label call completes in this inventory.** The benchmark test passes
because it records expected bounded refusals; that is not a capacity pass.

| Operation | Selected rows | Result | Wall time | Client SQL statements | Files opened |
| --- | ---: | --- | ---: | ---: | ---: |
| Prepare run | 1 | Completed | 1.53 s | 9 | 0 |
| Prepare dataset and pin | 1 | Completed | 10.88 s | 3,645 | 17 |
| Read page | 1 | Operation deadline | 10.02 s | 3,464 | 17 |
| Read final labels | 1 | Operation deadline | 10.02 s | 2,817 | 17 |
| Prepare run | 16 | Completed | 5.86 s | 9 | 0 |
| Prepare dataset and pin | 16 | Completed | 23.41 s | 3,681 | 32 |
| Read one-row page from 16-member dataset | 16 | Operation deadline | 10.01 s | 969 | 28 |
| Read 16-row page | 16 | Operation deadline | 10.01 s | 970 | 28 |
| Read 16 final labels | 16 | Operation deadline | 10.02 s | 9 | 0 |
| Prepare run | 64 | SQL statement timeout | 10.01 s | 9 | 0 |
| Read 64 final labels | 64 | Operation deadline | 10.01 s | 9 | 0 |

The 64-member dataset/pages are not attempted after run preparation refuses.
Metadata selection naturally uses the training lookup indexes and takes only
0.203/1.205/3.100 ms for widths 1/16/64. Guarded SQL feature checks take
1.162 s / 83,169 hits at width1 and 4.805 s / 263,999 hits at width16.
Guarded label checks take 1.733 s / 127,404 hits at width1 and
**14.808 s / 971,516 hits at width16**. Both guarded width64 probes exceed
their separate 15-second diagnostic ceiling. This isolates remaining SQL
reconstruction cost; it does not support raising production deadlines.

The successful one-member preparation verifies only 140,143 wire bytes yet
issues 3,645 client statements. Its SQL feature-check probe is much shorter
than total byte-backed preparation/page work. Application metadata and fresh
clock/access calls are therefore another investigation target; exact attribution
needs a query breakdown before changing policy or caches. Final-label width16
refuses before files, so optimizing file reads alone cannot resolve that case.
No cutoff-equivalence reuse or partial source-lineage verification is proposed.

The one-member closure has 381 references / 17 blobs and charges 180,510 bytes;
the 16-member closure has 476 references / 32 blobs and charges 416,475 bytes.
The latter preparation verifies 299,437 wire bytes. These are small synthetic
files, not realistic provider releases. Maximum sampled parent RSS is 254.6 MB,
including earlier calls/fixture allocations; database/VM memory is unmeasured.
No successful numerical response exists from which to claim decoded throughput.

Checked setup takes 422.2 s; the complete matrix takes 622.4 s. An
[earlier setup attempt](evidence/predictive-training-capacity64-setup-2026-10-14.json)
was intentionally stopped after 477.7 s without reaching reader measurements.
The fixture now stages synthetic blob metadata before invoking unchanged SQL
recorders under the complete guard. This enables 0020 reuse during validation;
recorder writes still disable reuse afterward. The source snapshot and numerical
assertions remain independently byte-backed. Staged setup artifacts belong only
to the owned scratch database/private directory, both removed on completion.
The default unguarded seed path used by the prefix19 upgrade safety case is
unchanged. Reader/SQL deadlines and frozen migrations are unchanged.

Operating guidance remains limited to the earlier 16-QB/two-profile, one-slot
sample below. Even a one-row response in the wider inventory is unsupported by
this evidence. #118 remains incomplete. Next: separate SQL label reconstruction
from repeated application metadata/access calls, optimize with exact identities
and fresh rights gates, then repeat this matrix. Full histories, opponent inputs,
provider file sizes and independent review remain. No migration after 0020 is
allocated; coordinate any forward DDL with #106. The
[review handoff](predictive-training-review.md) records the outstanding gates.

## Prefix20 guarded-validation checkpoint — 2026-10-14

The [final prefix20 measurements](evidence/predictive-training-capacity-prefix20-2026-10-14.json)
retain the full migration checksums, tested source hashes, plans and nested SQL
function timings. All measured operations complete under the unchanged SQL and
10/30-second API budgets. Each case is one warm local sample, with the same
16-QB/two-profile, CSV/gzip, one-history-slot inventory as the earlier bottleneck
measurement. This establishes that the immediate 16-row refusal is resolved for
this fixture; it does not establish a universal supported batch size.

| Operation | Requested rows | Wall time | Client SQL statements | Protected files |
| --- | ---: | ---: | ---: | ---: |
| Prepare run | 1 | 0.46 s | 9 | 0 |
| Prepare dataset and pin | 1 | 2.73 s | 774 | 5 |
| Read page | 1 | 2.42 s | 766 | 5 |
| Read final labels | 1 | 2.51 s | 671 | 5 |
| Prepare run | 16 | 2.27 s | 9 | 0 |
| Prepare dataset and pin | 16 | 6.78 s | 810 | 20 |
| Read one-row page from 16-member dataset | 16 | 5.75 s | 802 | 20 |
| Read 16-row page | 16 | 5.77 s | 802 | 20 |
| Read 16 final labels | 16 | 7.70 s | 687 | 20 |

Guarded SQL feature checks for 16 records take **1.332 s / 43,188 buffer hits**,
compared with prefix19's 13.883 s / 1,006,951 hits. Guarded final-label checks take
3.873 s / 167,891 hits. These are separate EXPLAIN probes, not API wall times.
The unguarded 16-record diagnostic hits its 15-second SQL limit; the optimization
requires the evidence guard and makes no unguarded capacity claim. Natural
metadata selection remains small: 1.809 ms / 292 hits.

The 16-member closure has 200 references and 20 blobs, charging 287,638 bytes.
Its pages verify 198,654 unique wire bytes and decode 6,132 bytes / eight gzip
rows, irrespective of whether one or 16 response rows are returned. The
one-row page still verifies the whole assigned shard. Maximum sampled parent RSS
among measured calls is 205.7 MB; process high water including setup is 243.8 MB;
maximum isolated decoder RSS is 104.2 MB. These decimal-MB samples do not measure
database/VM memory or establish a memory guarantee. Fixture setup takes 72.1 s,
outside measured API calls; the complete matrix takes 132.0 s.

Migration 0020 shares repeated reconstruction only in an owner-created private
temporary table inside a guarded READ COMMITTED transaction. It requires all 36
relevant evidence-table SHARE locks; write-capable locks disable reuse. Exact
requests, cutoffs, versions and historical rights clocks remain separate keys.
Access-clock reuse also requires the same global rights epoch; scheduled rights
transitions miss the cache. Consumer hits reauthorize current reconstructed
context, and the application still checks current rights before every unique
file and delivery. No blob, byte-reading, retention or deadline interface changes.

Successful checks and reconstructed plans, including legitimate unavailable
plans, may be shared. Errors and absent consumer records are not cached. Hashes
index full JSON keys, which must also compare equal. The private cache admits at
most 4,096 entries and 64,000,000 serialized key/value bytes, then falls back to
the released validators; this is not an RSS ceiling. Caller-owned shadow temp
relations and direct helper/cache writes are refused. Commit/rollback disposes
the cache. Frozen 0001–0019 SQL and catalog files remain unchanged.

A committed guarded read leaves PostgreSQL's empty TEMP namespace in that
session after dropping the memo table. Catalog/migration administration retains
its strict refusal of TEMP namespaces and must use a fresh administrative
connection, as the migration CLI already does. An initial rolled-back read may
also roll back namespace creation; it is not a substitute for that separation.

The wider 64-QB inventory above now identifies another capacity limit. Full
16-slot histories, opponent context and representative provider file sizes remain.
Independent review of
0020 and the existing reader/retention implementation remains outstanding.
#118 is incomplete; real-source/population qualification still blocks #54 Part B.

## Prefix19 bottleneck checkpoint — 2026-10-14

The retained [raw measurements and plans](evidence/predictive-training-capacity-2026-10-14.json)
cover widths **1 and 16 in a populated 16-QB/two-profile inventory**, with one
gzip source. At prefix19 the 64-QB matrix was deferred because width 16 exceeded the
normal SQL/read deadlines before files open. The benchmark accepts all three
widths; its configured 64-row default is not a claim that it completes successfully
or that 64-row operations meet their deadlines.

| Operation | Requested rows | Result | Wall time | Client SQL statements | Protected files |
| --- | ---: | --- | ---: | ---: | ---: |
| Prepare run | 1 | Completed | 1.93 s | 9 | 0 |
| Prepare dataset and pin | 1 | Completed | 8.36 s | 774 | 5 |
| Read page | 1 | Completed | 5.39 s | 766 | 5 |
| Read final labels | 1 | Completed | 5.03 s | 671 | 5 |
| Prepare run | 16 | SQL statement timeout | 10.01 s | 9 | 0 |
| Read final labels | 16 | Operation deadline | 10.02 s | 9 | 0 |

The natural 16-row metadata selection took **1.486 ms / 292 buffer hits**;
16 full SQL consumer checks took **13.883 s / 1,006,951 buffer hits**. One check
in the same inventory took 0.891 s / 64,725 hits. These probes identify repeated
SQL policy/evidence validation as the immediate cost; selection/page serialization
and decoder byte size do not explain a refusal occurring before any file opens.
The small 32-consumer table used sequential scans naturally; this is not a
large-table index benchmark.

The successful page verified 42,780 wire bytes, decoded 6,132 bytes / eight CSV
rows, and returned 13,301 bytes. It performed 275 cached metadata SELECTs and 85
verification operations, while total client statements were 766. Those counts
make uncached access/clock/proof calls visible instead of counting only coalesced
metadata queries. The dataset's conservative closure has 105 references and five
blobs, with 58,513 database-charged bytes. Parent sampled peak RSS was 132.8 MB for
the successful label call; process high water including setup was 195.7 MB, and
maximum decoder RSS among these successful calls was 104.5 MB. These are decimal
MB, local single samples, not production memory guarantees.

The isolated one-QB smoke also passes. The 16-QB fixture took 67.8 s to prepare,
outside the measured calls; its complete benchmark took 124.8 s. An initial
per-record setup exceeded the 600-second test budget without reaching any reader
measurements. An intermediate 64-QB setup exposed a benchmark-only multi-target
label snapshot error; it was corrected and the 16-QB run rechecked. Neither failed
setup is reader-capacity evidence. The opt-in test's total 900-second budget
includes setup plus the full matrix; individual API/SQL budgets are unchanged.

Prefix19 operating guidance was deliberately limited: the sampled one-row access in
this 16-lineage inventory completed, and 16-row run/label batches did not. A
one-row response does not establish capacity for a larger inventory, and there
was no evidence for a universal safe 16/64/256-row ceiling. This checkpoint
motivated 0020's guarded reuse of repeated SQL validation. The 64-row,
16-history-slot, opponent and realistic source-file cases remain unmeasured.
Any further SQL contract/index change needs a coordinated forward migration;
frozen 0001–0019 remain intact.

## Reproduce

Use Node 24 and an owned disposable PostgreSQL 18 service. Its loopback target
must satisfy the same test-target guard as the correctness harness. The codec's
pinned Docker image must already be available locally. No application environment
or hosted database is used; application credentials in the environment refuse
the run. Do not overlap benchmarks with other database/codec workloads.

```sh
TEST_DATABASE_URL='postgresql://dfs_ev_test:dfs_ev_test@[::1]:54329/dfs_ev_test' npm run bench:predictive:training
```

`PREDICTIVE_CAPACITY_MAX_ROWS=1` runs a smoke case; `16` truncates the workload
to 16 QBs. The default is 64. The benchmark creates a registered scratch database
and a private temporary artifact directory, validates the complete catalog,
then removes both. It does not reset the primary harness database. This test is
outside the normal correctness gate; changes to parsing, recorders or readers
need their own affected correctness cases.

For the focused interleaved comparison, archive the pinned historical runtime
outside the repository and share only the installed dependencies. The comparison
checks every archived source/script/target file against its Git blob before
importing it:

```sh
capacity_baseline=$(mktemp -d /private/tmp/dfs118-baseline.XXXXXX)
git archive 938fa00ccac61fed9222e4fedb4bec96547b1941 src scripts tests/db/target.mts | tar -xf - -C "$capacity_baseline"
ln -s "$PWD/node_modules" "$capacity_baseline/node_modules"
TEST_DATABASE_URL='postgresql://dfs_ev_test:dfs_ev_test@[::1]:54329/dfs_ev_test' PREDICTIVE_CAPACITY_INTERLEAVED=1 PREDICTIVE_CAPACITY_MAX_ROWS=64 PREDICTIVE_CAPACITY_BASELINE_ROOT="$capacity_baseline" npm run bench:predictive:training
```

This mode seeds once, clones registered disposable snapshots, and measures
baseline → drafts → drafts → baseline in one process. Each trial analyzes the
same initial rows; each API uses a fresh restricted connection. Three guarded
closure probes at each width precede dataset preparation and check exact
reference/blob/rights parity. It records the four preparation comparisons at
widths 1/16, not the full matrix or numerical reads. A successful diagnostic
test means the comparison completed and its assertions held; deadline refusals
remain failures to demonstrate capacity. Use the separate require-complete
matrix for capacity approval. Snapshots and private artifacts are removed on
completion; the archived source directory can be removed afterward.

## Workload and interpretation

The full fixture has 64 distinct canonical/raw QB identities and numerical
values, eight prior games and eight future target games, eight independent source
profiles/captures and eight native context files. Four source files are plain CSV
and four are gzip. Each eight-QB group shares one team's one-game observed
history, with synthetic three-season coverage evidence. It uses the existing
`stats-v1:player_pass_yds` candidate and `passing-yards-source-v1`; it does not
change the history policy. This is deliberately a short-history workload, with
no opponent candidate, full 16-slot history or large provider release files.

Fixture setup uses production publication/normalization, an independently
byte-verified full source snapshot, the pure feature/label builders and checked
SQL decision/consumer recorders. The prefix20 benchmark stages synthetic blob
metadata before guarded consumer recording so its own blob INSERT does not
disable transaction-local validation reuse. Each recorder still validates the
complete proposed body before publication; no direct consumer/decision insertion
or seal bypass is used. The synthetic inputs remain unchanged during
setup. SQL checks the plans, current clocks, rights, evidence and associations;
no consumer rows or seals are inserted by bypassing recorders. Feature and label
computations use a shared snapshot cutoff, while recording times come from the
database. Setup time is separate from read time. Every measured call still
performs the ordinary rights, byte, cutoff and closure verification.

Each 1/16/64 request fixes its complete membership. Pages contain usable features
and explicit missing target labels; labels for the completed prior events are
measured separately. This exercises both consumer kinds without fabricating
final outcomes for future targets. Runs remain population-unqualified and cannot
authorize fitting. Completed pages/labels are checked against each player's
independently specified value, not just another reader's output. Calls use fresh
non-superuser logins holding only recorder/replay memberships and the normal
operation ceilings. Known deadline/work/statement-limit refusals are measurements,
not successful capacity cases. Other errors fail the benchmark.

All three widths in the full matrix use the same populated 64-QB source
inventory and eight-profile selection. A single selected consumer still checks
every visible raw lineage in those profiles before filtering by canonical
identity; that rule prevents a rerouted correction from reviving an ancestor.
Thus its cost differs from the isolated one-QB smoke case. Membership width and
source-inventory width are separate dimensions; neither page size nor a smaller
dataset automatically reduces the source-inventory verification cost.

The matrix times run preparation, dataset preparation/pinning, page sizes of
1/16/64 as applicable, and standalone labels. A one-row page on a larger dataset
still verifies that dataset's entire assigned shard and retained closure. It
cannot be made cheaper merely by shrinking the response page. A timed-out session
is retired; later matrix calls reconnect rather than reuse it.

Total client SQL statements include guard/rights/clock/setup queries inside the
API. `verification` separately reports cached metadata queries, coalesced SQL
statements, returned metadata rows/bytes, verification keys, unique verified wire
bytes, actual decoded gzip bytes/rows and peak isolated-worker RSS. Those counters
are transaction-local and outside evidence/page/readiness digests. Fresh rights
checks still run before protected files and delivery.

The artifact wrapper records exact text/binary addresses and bytes and asserts
each unique file is opened once per successful operation. RSS/heap samples are
absolute parent-process values at 10 ms intervals, including Vitest and fixture
allocations; they are lower bounds on an operation's true peak. Process RSS high
water includes setup and earlier cases, so it is not a per-call delta. Decoder
RSS is measured separately; it must not be added as if all workers ran together.
This does not measure PostgreSQL or Docker VM peak memory.

Natural `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` selection and consumer-check
probes run after `ANALYZE`, outside timed API calls. They prime caches; the matrix
is a warm local run, not a cold-read or concurrent service benchmark. The JSON
contains actual scan/index choices, loops, rows and buffer/temp work. A function
scan's inclusive work covers its internal SQL, but its displayed loop count does
not expose every nested PL/pgSQL loop. Small tables may correctly use sequential
scans; their presence does not prove a missing index, and forcing indexes would
not demonstrate natural selection. Manifest evidence records closure references,
blob count, wire bytes, serialized manifest and database charged bytes.

## Review boundary

Do not promote the 64-row, 256-slot, 20 MB verification or retention quota ceilings
to demonstrated capacity from a short synthetic fixture. Before #118 closes,
review the raw measurements, worst applicable history/source sizes and numeric
operating guidance. Capacity improvements must preserve complete membership,
rights before bytes, current expiry, exact provenance and mandatory deletion.
Independent review remains necessary; this benchmark is implementation evidence,
not approval of the implementation. #106/#107 real-evidence qualification and
the #95 hosted rollout gate remain separate.
