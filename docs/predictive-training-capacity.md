# #118 local training capacity measurements

This opt-in benchmark exercises the frozen 0001–0019 prefix and the guarded
training APIs. It measures different player/event values rather than cloning
one consumer body. It does not qualify real sources, historical availability,
population coverage or #54 Part B. The prior shared-context measurement remains
in [the evidence log](predictive-training-evidence.md).

## Observed checkpoint — 2026-10-14

The retained [raw measurements and plans](evidence/predictive-training-capacity-2026-10-14.json)
cover widths **1 and 16 in a populated 16-QB/two-profile inventory**, with one
gzip source. The 64-QB matrix is deferred because width 16 already exceeds the
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

Operating guidance remains deliberately limited: the sampled one-row access in
this 16-lineage inventory completed, and 16-row run/label batches did not. A
one-row response does not establish capacity for a larger inventory, and there
is no evidence here for a universal safe 16/64/256-row ceiling. The next increment
must profile and share repeated SQL validation under the existing guard, retaining
current use rights, original cutoff checks, complete raw lineages and per-record
association/finality checks. Then rerun the affected widths before the 64-row,
16-history-slot, opponent and realistic source-file cases. Any SQL contract/index
change needs a coordinated forward migration; frozen 0001–0019 must remain intact.

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
SQL decision/consumer recorders. The synthetic inputs remain unchanged during
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
