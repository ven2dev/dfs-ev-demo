# #127 spike results

**No-go for promotion.** The isolated prototype exposes a correctness gap in
the proposed certification boundary, and it exceeds the literal one-rights-query
budget. Feature recording also exceeds the allowed overhead. The 64-QB ABBA
comparison completed; the separate 256-QB setup timed out before measurement.
Performance measurements cannot override the failed correctness target.

The spike starts from held `4064557` on `spike/dfsEV-127-verify-on-write`.
SQL/reader checkpoint: `dc2f158`; metric instrumentation: `d319713`;
restricted-recorder reproduction: `213a664`. SQL lives exclusively in
[`db/proposals/spike127_verified_reads.sql`](../db/proposals/spike127_verified_reads.sql).
The held branch, migrations 0001–0020, manifest, catalog contracts and generated
schema are unchanged. Nothing is frozen, promoted or run on a hosted database.

## Premise and correctness

The approved pattern remains verify on write with immutable certificates,
set-based reads, current authorization/removal/expiry checks and unique-file
hashing. This experiment tests a minimal certificate appended by the existing
SQL recorder, rather than assuming that recorder is already a complete trusted
verification boundary. Reconstructing on read, request-local reuse and periodic
materialization retain the costs or stale-state problems described in the
[#118 roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/118#issuecomment-6209728115).

The adversarial probe keeps valid source dependencies, removes all games from
the feature's numerical windows, sets the sums to zero, and computes valid
digests. The existing SQL recorder accepts it. The held reader reconstructs the
feature and refuses it with `stored-source-consumer-mismatch`. The prototype
instead certifies it and delivers a zero-valued feature. Therefore this wrapper
cannot be the production verify-on-write boundary. This is a failed correctness
target, not an accepted relaxation of verification.

The [restricted-recorder reproduction](evidence/predictive-127-restricted-probe.json)
confirms the same counterexample through a `NOSUPERUSER` login with only the
recorder/replay memberships and the synthetic-harness membership required by
the fixture. The harness stages valid blob metadata; the certifier runs under
the restricted login. No append-only protection is disabled. This disproves
the roadmap's assumption that the existing SQL recorder already provides all
the verification needed for a certificate. The held reader continues to refuse
the bad record correctly.

The other focused comparisons agree on usable and missing labels, exact-ref and
as-of refusals, current rights, protected uses, complete dependency closure,
authorized deletion and corrupted-file refusal. A restricted login cannot write,
update or truncate certificates. Revocation is checked before files are opened;
revocation/deletion committed during file access withholds delivery. Different
internal rights error codes are retained in evidence; the refusal states agree.
The parity runner records negative experimental findings without turning them
into CI gates: a successful benchmark process does not mean acceptance passed.

## Measured targets

The complete 64-QB candidate repetitions show the following. Its two baseline
arms are retained in the linked JSON, including every refusal. A target requiring
the separate scale workload fails acceptance when that workload is unmeasured;
that does not turn a missing observation into a measured latency failure.

Raw evidence: [small adversarial ABBA](evidence/predictive-127-fixture-probe.json),
[restricted-recorder ABBA](evidence/predictive-127-restricted-probe.json),
[64-QB ABBA](evidence/predictive-127-qb64.json),
[256-QB failed attempt](evidence/predictive-127-qb256.json), and
[aggregate verdict](evidence/predictive-127-verdict.json).

| Target | 64-QB fixture | 256-QB scale | Disposition |
| --- | --- | --- | --- |
| Seal 256 examples ≤5 s | 4.875 / 4.870 s, 64 usable +192 unavailable: local pass | Setup failed; unmeasured | **Fail**: scale not established |
| 256-row page p95 ≤1 s | 0.347 s, 6 samples: local pass | Unmeasured | **Fail**: scale not established |
| 256 distinct labels p95 ≤1 s | Only 64 distinct labels exist (p95 0.081 s) | Unmeasured | **Fail**: 256-label workload not established |
| ≥30% API-deadline headroom | All candidate read/seal/inventory calls within 7/21 s: local pass | Unmeasured | **Fail**: scale not established |
| One rights query/request | Reads 2, seal 3; inventory retains per-slot checks | Unmeasured | **Fail**: measured budget overrun |
| File verifications ≤unique files | Equal: 32 /80 /272 for pages at widths 16 /64 /256: local pass | Unmeasured | **Fail**: scale not established |
| Flat SQL statement count | Client calls flat: seal 5, page 4, labels 6; nested inventory rights checks grow 371 /2,291 /16,775 | Unmeasured | **Fail**: server work is not flat |
| Recording cost ≤20% overhead | Feature +37.49% (fail); label +18.34% (pass) | Unmeasured | **Fail**: measured feature overrun |
| Same results under adversarial inputs | Fail: small probe certifies an altered numerical window | Same certifier | **Fail**: incorrect delivered value |
| Required fixtures and widths | 16 /64 /256 examples completed | Setup failed before all widths | **Fail**: required scale comparison incomplete |
| Proposal SQL only; frozen prefix unchanged | SQL only in `db/proposals/`; application and frozen artifacts match held baseline | Same source audit | **Pass** |
| Interleaved evidence with hashes and work counters | ABBA and raw SQL/buffer/file samples committed | Setup failure and source hashes retained | **Pass** for recording evidence; scale timings remain absent |

Candidate run-inventory preparation took up to 0.241 /1.356 /8.231 seconds for
16 /64 /256 rows. A fresh 256-row request plus sealing therefore takes up to
13.106 seconds in the paired arm. The ≤5-second result describes the existing
sealing API with an already recorded inventory, not an end-to-end dataset request.
Passing the looser 30-second deadline does not change either measured duration.

The 64-QB write medians are 1.939 s baseline versus 2.666 s prototype for a
feature, and 3.066 s versus 3.628 s for a label (six observations per mode and
kind, upper median as specified by the runner). Feature overhead fails even with
the incomplete certifier; adding the missing verification still needs measuring.
Its seed took 962.787 s and created 320 consumers/certificates. Setup time is
excluded from API timings and is not an ingestion-throughput claim.

The 64-QB operation table preserves the distinction between one seal and repeated
reads. Values are the slower of two run/seal calls, or empirical p95 across six
page samples. Labels at width 64 have twelve samples because the width-256
fixture still supplies only 64 distinct historical keys.

| Operation | 16 examples | 64 examples | 256 examples |
| --- | ---: | ---: | ---: |
| Run inventory | 0.241 s | 1.356 s | 8.231 s |
| Seal existing inventory | 1.010 s | 1.789 s | 4.875 s |
| Page p95 | 0.062 s | 0.116 s | 0.347 s |
| Distinct historical-label p95 | 0.031 s (16) | 0.081 s (64) | Not 256 labels |

Baseline preparation at 16 rows completed in 8.394 /8.441 s. Every baseline
seal/page/label measurement was refused, as were 64/256-row run requests.
These retain the original SQL/API limits. The 64-QB matrix has 60 completed
prototype observations, 14 completed baseline observations (including recording)
and 46 baseline refusals. Small-fixture correctness comparisons provide the
successful held-reader parity observations; broad-fixture timeouts do not prove
output parity at scale.

The separate 256-QB attempt failed with `Query read timeout` during fixture
seeding, before any binding progress, certificate setup or timed ABBA arm.
Vitest reported 85.745 s for the failed test, including setup and cleanup.
The scratch client retains its 15-second server statement timeout and 20-second
client query timeout. A read-only activity snapshot during cleanup showed an
active `COMMIT`; this is insufficient to isolate which deferred validation
dominated. No timeout was raised and no checked write was bypassed. The failed
evidence has zero measurements, not zero-cost measurements. It does not supply
the larger-pool nested-statement or buffer results originally sought.

## Protocol and limits

The two modes use the same checked seed, cloned into a fresh owned disposable
database for each ABBA arm. Timed API operations use fresh non-superuser logins.
The held production TypeScript path is unchanged. No witness-reuse proposal,
0022–0024 draft, production guard removal or deletion rewrite is applied.

The prototype stores immutable certificate closures during checked recording and
unions them at sealing. Reads use short snapshot transactions, then the existing
private artifact interface for exact wire-byte hashes, followed by a fresh final
state check. Page and label reads perform two batched rights queries; sealing
performs three. The run metadata recorder also retains its per-slot historical
kickoff checks. The one-query target therefore fails; no query is hidden as
bookkeeping or renamed to count it out.

The 64-QB fixture's first 64 target examples are usable; the additional three
games per player correctly produce 192 unavailable examples because games
intervene after the cutoff. The 256-QB fixture uses 256 separate identities in
the same eight profiles. Both retain one numerical history slot, no opponent
context and unqualified population. Future target labels are missing. Label
reads use separate usable historical-game labels: at most 64 unique labels in
the 64-QB fixture, and 256 in the scale fixture. Repeated keys are not fabricated
to make a 256-label workload.

The frozen public API has a 64-row limit. The prototype 256-row result composes
the same pure formatters; the equivalent baseline request comprises up to four
public calls. Each baseline call keeps its original 10-second deadline. An
aggregate baseline refusal is never a completed latency observation. Dataset
sealing keeps its 30-second deadline; all targets remain unchanged.

Empirical p95 uses nearest rank from all retained candidate repetitions, with
the small sample count stated. This is a local tail observation, not a statistical
confidence bound. SQL counts are client statements, with nested server work
reported separately. Buffer hits/reads are `pg_stat_statements` top-level shared
block deltas; they count accesses, not unique pages. Instrumentation is enabled
equally for both modes. Each timed call resets only its owned database's stats.
Cancelled statements can leave incomplete or zero buffer statistics; those
observations do not mean the refused operation performed no database work.

Source hashes in the small probe and 64-QB matrix pin the executed code at
`dc2f158`. Their `applicationRevision` is the report-time HEAD: the metrics-only
`d319713` commit was made while the 64-QB process was already running. It adds
total and nested server-statement counters, without changing the SQL or reader.
The 256-QB process started from `d319713`, with no source changes during execution.
The final small reproduction executes `213a664` and records complete nested
statement totals. Its seed took 22.233 s; all 40 timed API/recording observations
completed, while the explicit certification acceptance case still fails. In
total, the evidence retains 200 timing observations across three completed
ABBA comparisons and one failed scale setup.
The 64-QB JSON has only its twelve most expensive nested statement groups, not a
complete server-statement total. Its local `flat-client-sql-statements` verdict
is also false because there is no 256-label sample; the aggregate report must
distinguish that missing width from statement growth. Likewise its local
correctness flag covers that file's fixture comparisons, not the separate failed
adversarial probe. Neither flag overrides the cross-experiment no-go.
The small probe also reports the runner's default one target game in its
`workload` field despite the explicit four-game environment override; the
reproduction command and aggregate metadata correct that descriptive field.
Its measurements and correctness cases are unchanged.

Recording measurements isolate persistence of identical prebuilt checked bodies:
immutable file publication, the same original SQL validation, commit, and the
candidate's additional certificate/closure. They measure incremental persistence
overhead, not total end-to-end feature construction. The same TypeScript producer
remains before both recorders; its cost is not included in these ratios. A stronger
certifier would add work and needs a new write-cost measurement.

The [fixture diagnostics](evidence/predictive-127-fixture-diagnostics.json)
retain the initial large setup failure and its small reproduction. No timed
samples came from those failures. The corrected
[small mixed-format comparison](evidence/predictive-127-fixture-probe.json)
records the forged-window counterexample and the remaining parity cases. The
same diagnostics also retain the 256-QB setup failure. All source hashes were
verified against the execution checkpoints, and all twenty migration hashes
match the held prefix.

Reproduce with Node 24 and the isolated
[`spike127-compose.yml`](../tests/db/prototypes/spike127-compose.yml) service
(`docker compose -p dfs-ev-127-spike -f tests/db/prototypes/spike127-compose.yml up -d --wait`).
It binds IPv6 loopback and enables `pg_stat_statements.track=all`; it does not
use application environment files or a hosted database. Run each population
sequentially to avoid resource contention during timed samples:

```sh
TEST_DATABASE_URL='postgresql://dfs_ev_test:dfs_ev_test@[::1]:54329/dfs_ev_test' SPIKE127_QBS=64 SPIKE127_REPEATS=3 SPIKE127_EVIDENCE=docs/evidence/predictive-127-qb64.json node node_modules/vitest/vitest.mjs run --config vitest.spike127.config.mts
TEST_DATABASE_URL='postgresql://dfs_ev_test:dfs_ev_test@[::1]:54329/dfs_ev_test' SPIKE127_QBS=256 SPIKE127_REPEATS=3 SPIKE127_EVIDENCE=docs/evidence/predictive-127-qb256.json node node_modules/vitest/vitest.mjs run --config vitest.spike127.config.mts
```

For the small adversarial comparison, use `SPIKE127_QBS=9`,
`SPIKE127_TARGET_GAMES=4`, `SPIKE127_REPEATS=1` and a separate evidence path.
At `213a664` this also exercises the restricted-recorder counterexample; the
recorded path is `docs/evidence/predictive-127-restricted-probe.json`.
This process deliberately records the forged-certificate failure rather than
pretending the production design is accepted. Shut down the owned service with
the matching Compose project/file after the run.

Final focused validation: TypeScript typecheck, ESLint on the spike modules,
local document links, evidence/source hashes and `git diff --check` pass.
The small experiment runner completes successfully while recording its expected
negative certification verdict. The scale runner fails during setup as reported.
A full aggregate database gate was not repeated for this isolated, unpromoted
experiment.

## Next decision

Keep #127 and #118 open. Before another performance iteration, specify the trusted
ingestion boundary that reconstructs and verifies the complete canonical result
before it can mint a certificate, including how an ordinary recorder role is
prevented from bypassing it. Also reconcile one rights query with authorization
before files and a final mutable-state check. A version/expiry token or a changed
budget requires an explicit reviewed design; this spike implements neither.

Only after that boundary is agreed should another spike reduce certificate
recording overhead and retry the required 256-QB fixture. Increasing deadlines
or promoting this incomplete certifier would hide failed requirements. The
current experiment returns a no-go to the owner; it does not authorize the
redesign's implementation or backfill stages.

Two-step physical deletion, DB knowledge clocks for all mutable decisions,
background scrubbing, hosted implementation and any new DDL allocation remain
outside this experiment. Neither fast fixture reads nor the recorded overhead
clears #54 Part B or the missing real-source evidence in #106.
