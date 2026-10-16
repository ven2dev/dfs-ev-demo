# #127: verify-on-write spike

Baseline: held `fix/dfsEV-118-foundation-review` at `4064557`. This branch is an
experiment, not a migration or a production reader. Frozen 0001–0020 stay intact.

The approved pattern is immutable, content-addressed verification certificates
created by the trusted recorder, followed by set-based reads of those records.
Current rights, evidence removal, expiry and file hashes remain read-time work.
Full reconstruction on read is rejected because work grows with the evidence
pool. Request-local deduplication still repeats that work on each request.
Periodic materialization leaves a stale authorization/deletion interval.

The experiment keeps the existing checked source recorder. This isolates its
current SQL guarantees; it does not prove that the existing SQL checks completely
replace the TypeScript reconstruction against forged numerical/native context.
That is a correctness limitation of the certificate proposal, to be reported
separately from fixture parity and latency rather than approved by a fast read. Its proposal wrapper
adds a certificate and dependency closure atomically after successful validation.
It does not backfill certificates. The proposal metadata recorder preserves the
frozen run-selection rules and kickoff checks, using certified consumers instead
of reconstructing their statistics. Run creation is measured separately from
dataset sealing; their sum is reported too. Sealing consumes an already recorded
immutable run, as the existing API does. The proposed reader does not invoke the table guard,
use session memoization, decode source statistics again, or rebuild statistics.
No production guard or deletion function is removed or changed.

All certificate references are obtained from checked SQL records, not submitted
by callers. Direct certificate writes are denied to application roles to prevent
forged verification. Every unique file opened uses the existing private artifact
interface and hash/size checks, to detect filesystem corruption. Authorization
runs before file access and mutable-state checks run again immediately before
delivery, to catch revocation/deletion during the read. These are counted as two
rights queries if both check rights: the one-query target is not reinterpreted.
Two-step physical deletion and background scrubbing are outside this spike.

Workloads: preserve the original 64-QB fixture's first target; add three distinct
future target events per QB for the 256-example workload. The frozen policy
correctly withholds the later three events because their earlier target games
intervene after the feature cutoff: 64 usable and 192 unavailable rows. Keep
those refusals rather than fabricate completed future games. These are correlated
synthetic examples, not 256 independent QBs or 256 usable bundles. The scale workload uses 256 distinct
QBs and one target per QB, sharing the same eight source/team groups (32 players
per group) to stay inside the frozen 16-profile limit. All retain one numerical
history slot, exploratory population, missing target labels, and no opponent
context. Label benchmarks separately read the usable historical-game labels.
The fixture does not establish a usable real-data slice or training readiness.

Protocol: one checked seed per population, cloned for each baseline/prototype
trial in ABBA order; fresh restricted connections per measured API. Timed calls
use the unchanged 30-second preparation and 10-second read deadlines. Refusals
remain refusals, never completed latency samples. Repeated page/label calls
provide p95 using nearest rank; small sample sizes are disclosed. Buffer counts
come from database-scoped `pg_stat_statements` deltas (outside the timed region;
top-level statements only, to avoid double-counting nested functions). SQL/query
and file-verification counts come from adapter instrumentation.
Feature/label recording is interleaved separately with the same checked bodies,
including immutable file publication, database commit and certificate creation.

Report every target, without relaxing it: seal 256 examples ≤5 seconds; 256-row
page/labels p95 ≤1 second; ≥30% deadline headroom on every completed candidate
operation; one rights query/request; file verification calls ≤unique files; SQL
statement count independent of row count; both populations; recording overhead
≤20%. The prototype alone accepts a 256-row page to test the issue's target;
the frozen public API still caps individual pages/label requests at 64 rows.
Comparisons therefore also include equivalent sequences of four public calls.
Those sequences get four original deadlines, with the aggregation disclosed.

Correctness compares selected IDs, row states, cutoff/history policy, protected
uses and label outcomes against the held implementation. Revoked rights,
deleted evidence, exact-reference refusal and corrupted-file cases are retained.
Evidence records source/proposal hashes, runtime, fixture counts, samples and
explicit limitations. No result clears #118 or #54 Part B on its own.
