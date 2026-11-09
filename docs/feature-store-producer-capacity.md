# Producer capacity matrices (#169)

## Design basis

**Pattern:** repeatable qualification of the existing bulk producers from pinned
inputs, with a parent process supervising deadlines, typed attempt journals and
one pure verdict shared by runner and auditor. Follow #138/#241's producer recipes
and #251's transfer helpers; no producer algorithm or SQL changes.

**Alternatives:** repinning to today's GitHub bytes changes the approved fixture.
Cached-only downloads omit network cost. A copied downloader or separate verdict
formulas invite drift. Self-hosting measures Cloudflare's path instead of GitHub's
production path; the existing edgetrace-fs-test bucket permits synthetic bytes only.

**Targets:** each representative ingestion takes at most 42 s, including network,
with a 60 s deadline per leg and exactly 12 SQL statements. Full-season 2025
features take at most 84 s under 120 s, exactly 8 SQL statements. Both have one
bulk operation and no per-example calls. Each workload has three cold and three
warm attempts; every attempt passes independently. No wall-clock gates run in CI.

**Requirement reasons:** source hashes and committed blob IDs prevent silent drift.
The original GitHub URL is observed with a complete timed transfer and hash, then
the exact original pin is ingested through a test-only loopback server using the
real downloader. Adding these legs conservatively includes transfer plus validation,
ObjectStore publication, normalization, ANALYZE and COMMIT. Upstream byte changes
are observations; transport, protocol and timeout failures stop qualification to
prevent survivor bias. The trial records loopback transport explicitly because
database provenance intentionally retains the original GitHub URL. Verify raw
destination hashes/sizes then delete through ObjectStore to avoid retaining raw
downloads. Fresh scratch databases and empty destinations prevent no-op results
qualifying. Append-only started/terminal records retain interrupted attempts.
Parent deadlines kill expired workers and terminate their backends before cleanup
so abandoned queries cannot overlap later work. Fixed 12/8 counts prevent row-wise
work. Clock offset over 250 ms refuses the environment without changing timestamps.

**Assumptions:** trusted local owner, restricted producer LOGIN, private local
ObjectStore and Node 24 native type stripping. Sixteen original source pins cover
2021–2025 (246,304,787 wire bytes); the feature workload produces 1,948 outputs and
31,168 lineage links with historical-availability-unverified. It is distinct from
the historical 2,504-row dataset. Local results make no hosted-capacity claim.

## Boundaries and resets

Four ingestion representatives: schedule, 2025 stats, 2021 roster and 2023
participation. Each block runs cold then warm in fresh scratch databases and empty
ObjectStore destinations. Lane-3 is fully torn down and brought up once per block
(three blocks per workload), never between its cold/warm attempts. Cold includes
spawn, native import and connection once. Warm prepares its process, imports and
connection outside timing and records that setup. All measured work ends after
COMMIT and IPC receipt; cleanup and parity queries are outside timing.

The fresh tmpfs server resets shared buffers and data, while input preparation
warms pages. OS/Docker/DNS/CDN caches are uncontrolled; this is no physical cold-cache
claim. Large-tier admission needs 608 MiB free; record actual 2 GiB mount and sampled
disk/WAL/temp/database sizes. Growth over 489,472,000 bytes (466.797 MiB) needs
requalification. Standard-tier behavior checks use only lane-3. Large work and final
timings require an owner-confirmed quiet window, preventing two unqualified large
lanes or shared-CPU interference.

## Diagnostics

The disposable spike's warm features were about 57% slower in all three pairs.
Final feature attempts retain every producer statement's elapsed time, before/after
pg_stat_checkpointer and pg_stat_wal snapshots, sampled autovacuum activity, and
per-table autovacuum counters/timestamps. Admin observer queries are separate from
the eight producer statements. Sampling can miss short activity; cumulative counters
can lag. These are diagnostics only, with no additional gate or target change and
no causal claim beyond what the observations support.

## Approval and evidence

Measured spike: all 30 attempts passed; ingestion 0.820–11.257 s, features
6.595–10.427 s, 12/8 SQL. Feature sampled peak 311.305 MiB, growth 265.109 MiB.
Discovery stops (mutable schedule, clock skew, withdrawn overlap assertion) remain
historical records. The approved estimate is 4.75–5 h including discovery; stop and
propose a split if scope exceeds five hours.

Step 1 implements supervision and attempt contracts; Step 2 adds the hash-first
auditor and refusal proofs; Step 3 qualifies final committed sources in a separate
window and publishes append-only evidence. Each step stops for commit approval.

The opt-in runner is
`services/pipeline/scripts/feature-store/producer-capacity-benchmark.ts --qualify`.
It requires `DB_TEST_LANE=lane-3`, `DB_TEST_TIER=large`, an explicit
`FS169_QUIET_WINDOW` describing the owner's fresh confirmation, a canonical
`FS169_SOURCE_ROOT`, and a new absolute `FS169_OUTPUT` directory. It derives the
database URL with the lane CLI, owns the lease through cleanup and verifies
container absence after each block. The quiet-window setting records authorization;
it cannot independently detect competing CPU work. Qualification refuses dirty
sources and records source SHA-256 plus committed git blob IDs, including the
loaded #241 proposal and migration/bootstrap dependencies. Run the standard-tier
`producer-capacity.check.mts` separately for behavior/work proofs; it is not a speed
qualification.

## Independent audit

The run journal now saves each preflight result, scratch database/LOGIN identity,
initially empty raw destination, worker PID and block/container identity. The
auditor checks the complete 30-attempt schedule (or a stopped prefix), distinct
processes and databases, exactly one server reset per block, and completed
teardown. It recalculates clock offsets from all ten raw observations rather than
trusting the saved pass flag. Missing markers, replacement samples and work after
a failure are refused to prevent incomplete evidence from appearing qualified.

Before dispatch, the journal freezes exact source bytes as base64 alongside the
SHA-256 and committed git blob inventory. The auditor independently calculates
both addresses from those bytes, including #241's loaded SQL. Base64 preserves
exact bytes; it does not conceal secrets. Only repository source files enter this
record. This lets a clean extract audit historical evidence without Git history
or today's source tree. The sixteen original input pins remain unchanged.

`producer-capacity-evidence.ts check-journal DIRECTORY` performs read-only
recomputation. It checks live protocol/host outcomes, disclosed drift, the paired
sum, exact 12/8 work, parent/worker timing arithmetic, loopback pins, raw cleanup,
feature content/lineage, and required diagnostics. Censored or incomplete attempts
remain unqualified; even a failed run with an unknown format is refused. CI uses
synthetic observations and controlled clocks, without asserting machine speed.

Publication uses ObjectStore for the exact detailed record and the existing
deterministic USTAR/gzip helper for an identical in-tree mirror. New timestamped
archive and compact receipt files use exclusive creation, preventing historical
evidence from being overwritten. The common TypeScript evidence auditor verifies
uncompressed hash/size before parsing, then compares the entire recomputed compact
projection. Compact receipts keep every duration and refusal verdict; source bytes,
full statement timings and PostgreSQL observations stay in the detailed record.

## Final qualification

The final matrix on committed sources `55d512b15c3e340c128d8b4195783faa00e29385`
passed all 30 attempts on 2026-11-09. Each row has three cold/warm blocks; values
below are seconds, with both ingestion legs included. No attempt was retried or
replaced. The common auditor recalculates every result from the saved observations.

| Workload | Cold 1 | Warm 1 | Cold 2 | Warm 2 | Cold 3 | Warm 3 | SQL each |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Schedule | 0.800 | 0.550 | 1.154 | 0.495 | 0.800 | 0.820 | 12 |
| Stats 2025 | 1.311 | 1.139 | 3.066 | 1.116 | 1.309 | 1.147 | 12 |
| Roster 2021 | 2.375 | 2.730 | 2.941 | 2.055 | 3.725 | 2.553 | 12 |
| Participation 2023 | 9.710 | 26.511 | 18.117 | 11.276 | 9.787 | 6.996 | 12 |
| Features 2025 | 6.602 | 6.732 | 6.835 | 6.435 | 6.949 | 6.507 | 8 |

Worst ingestion was 26.511 s against 42 s, with 55.8% headroom under 60 s.
That participation warm attempt retained its 24.025 s live transfer and 2.486 s
pinned leg. Every leg met its 60 s deadline. Worst features were 6.949 s against
84 s, with 94.2% headroom under 120 s. Every feature trial produced the same
1,948 rows / 31,168 lineage links and content SHA-256
`315806925202863e226a4a93f5d477b8a6d32cd38c5a4977a1d98f889bf242a9`.

All 24 pinned ingestion receipts identify the test-only loopback transport,
original pin, one request and one ObjectStore read. GitHub observations contacted
`github.com` then `release-assets.githubusercontent.com`. The live schedule was
516,594 bytes with SHA-256
`3844c95be80df89d4756ab8ea0212101f0cc5c3cb628e72f8d2d7eea69c185fb`,
versus the unchanged 515,250-byte original. All six observations recorded drift;
the other three representatives matched their pins. This neither refreshes the
fixture nor treats changed upstream bytes as a failed transfer. Verified trial
raw downloads were deleted through ObjectStore; no raw downloads enter git.

Fifteen distinct block containers confirm one reset before each cold/warm block.
All 30 attempts used distinct processes, fresh scratch databases and empty
destinations. The actual mount was 2,147,483,648 bytes. Sampled peak use was
326,615,040 bytes (311.484 MiB); peak growth was 278,175,744 bytes (265.289 MiB),
below the unchanged 489,472,000-byte growth basis. Ingestion peak was 73.539 MiB.
All admissions passed the 608 MiB free rule. The largest absolute block clock
estimate was 1.624 ms, below 250 ms. Lane-3 was removed and absence verified at
05:08:15.229Z; that quiet window is closed.

### Final diagnostics

The spike's approximately 57% warm slowdown did not recur: final warm totals
changed by +1.98%, -5.85% and -6.36% relative to their paired cold totals.
Every SQL duration remains in the detailed record; the two dominant statements
and observed WAL deltas are shown below. These are observations, not gates.

| Feature trial | Input selection (ms) | Materialization (ms) | WAL bytes delta | Sampled active autovacuum |
| --- | ---: | ---: | ---: | --- |
| Cold 1 | 2278.254 | 4026.180 | 13,729,935 | none |
| Warm 1 | 2297.631 | 4281.133 | 14,144,272 | one observation |
| Cold 2 | 2391.033 | 4098.056 | 13,805,007 | none |
| Warm 2 | 2282.087 | 4006.097 | 13,736,892 | none |
| Cold 3 | 2305.516 | 4345.367 | 13,770,100 | none |
| Warm 3 | 2291.608 | 4066.140 | 13,742,052 | none |

Checkpointer snapshots were identical before/after each individual trial.
This is a statement about the snapshots, whose counters can lag, rather than
proof of no checkpoint work. WAL record deltas were 104,081–106,805; full-page
image deltas were one except warm 1's thirteen. Warm 1 sampled a worker running
`VACUUM ANALYZE fs138.norm_participation` at 05:06:15.233Z, shortly after the
05:06:15.171Z diagnostics boundary. Its table's autoanalyze count advanced from
zero to one; its vacuum count stayed one. Other warm table maintenance counters
were already present before timing, and no other active workers were sampled.
Short activity can be missed and stats can lag. These observations do not
establish what caused the earlier spike slowdown.

The [evidence README](evidence/feature-store-169/README.md) identifies the compact
receipts, exact compressed records, offline audit commands and retained discovery
stops. The final record freezes all 77 source SHA-256 hashes, git blob IDs and exact
source bytes, including `241_job_visibility.sql`. Documentation and evidence added
after this run do not change the measured runner, auditor or producer sources.
