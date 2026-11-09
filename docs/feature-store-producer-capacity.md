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
