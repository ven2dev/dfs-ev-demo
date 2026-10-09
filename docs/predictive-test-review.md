# Delivery 2 test reasoning review

Review date: 2026-10-09. Scope: the 12 new predictive PostgreSQL cases, five
artifact/archive cases, the mandatory-report case, and existing migration/
readiness tests adjusted for v3. The governing behavior is documented in the
[ingestion contract](predictive-ingestion.md); these tests establish synthetic
local persistence behavior, not real-source qualification or model validity.

## PostgreSQL cases and evidence

| Case | Required behavior and independent evidence |
| --- | --- |
| A/B replay | Hand-calculated last-4 A totals are 100 attempts / 700 yards; B is 100 / 720. Team A/B yards are 869 / 889. Game order, 168-hour rest, correction provenance, absence of target outcomes and the exact cutoff boundary are checked, alongside full parity with pure replay. |
| Corrections outside scope | Direct membership and schedule SQL must include later revisions that move dates/teams outside the initial predicate. The earlier cutoff excludes them; later replay agrees with the full dataset and withholds inapplicable membership. An entity read cannot hide a broken membership query. |
| Former-team gap / unrelated schedules | A dated BUF range retains a missing game as a chronological slot. Last-8 explicitly contains seven expected games, six observed games, one unknown exclusion and totals of 120 attempts / 810 yards. Unrelated SEA–ARI evidence changes neither a ready bundle nor the unavailable gap bundle. |
| Retries / recaptures | Exact retries preserve counts. Later captures and changed source formatting increase capture/artifact counts without duplicating revisions. Full bundle equality at a cutoff where both captures are visible proves earliest provenance, beyond merely excluding late captures at A. |
| Atomicity / concurrent retry | Three distinct PostgreSQL backends are used. All seven tables remain invisible while the first insertion is held. `pg_blocking_pids`, ungranted locks and the advisory wait event must show the retry blocked behind the holder before release. One publication and one reuse result after commit. Cleanup settles both operations. |
| Diagnostic quarantine | One incomplete capture quarantines the entire batch. Counts, every capture state, zero observations/links and retained failed bytes are inspected directly. A later valid publication remains usable. A generic unavailable bundle alone is insufficient evidence. |
| Rollback / conflicts | Specific observation, capture, run-ID and lineage errors are required. A capture conflict occurs after run/artifact inserts. Exact snapshots of all seven tables prove rollback and unchanged earlier replay. |
| PostgreSQL constraints | UPDATE, DELETE and TRUNCATE are refused on all seven tables with the append-only error. Valid controls for all eight evidence kinds pass deferred checks. Invalid fields/enums/missingness must fail the payload constraint specifically; wrong correction kind and wrong same-kind natural key must fail the composite FK specifically. Zero/signed yards, explicit blanks and valid lineage remain accepted. |
| Byte / SQL integrity | Same-size altered JSON defeats size-only checking. Replay withholds; writes refuse replacement; manual restoration restores exact equality. Missing files also withhold. A legal SQL revision absent from intact source bytes must fail `stored-observation-mismatch`. |
| Indexed / read-only reads | Other-player and out-of-range membership decoys prove query scoping. EXPLAIN with sequential scans disabled proves index usability, not a production performance claim. Inside replay's actual transaction, settings must be read-only/repeatable-read and a write must fail with `25006`; a savepoint restores the probe and the session exits read-only mode. |
| Archive restoration | The CLI restores A, B and unavailable scenarios from retained bytes into newly registered scratch databases and compares complete results. The separate archive unit case checks exact capture metadata and source bytes on reopening the store. |
| v2 upgrade / no-op | A v2 application row and exact historical ledger rows survive v3. A no-op rerun preserves the complete upgraded ledger, including original timestamps and provenance. |

The pure replay oracle is useful for persistence equivalence because both paths
must implement the same feature contract. It is not an independent oracle for
the feature calculation. Concrete totals, game IDs, exclusions, byte checks,
SQL constraints and database state observations supply that independent evidence.

## Artifact, archive and report cases

The five filesystem cases establish exact bytes at an independently computed
SHA-256 address, restrictive file permissions, unchanged inode on an identical
write, temporary-file cleanup, concurrent identical writes, refused checkout/
symlink/insecure roots, traversal/hash/size/tamper/missing-file refusal, hard-link
and changed-registration refusal, and exact journal restoration. The archive
fixture deliberately uses distinct publication, capture, availability and
ingestion times plus an incomplete state; losing those fields cannot pass by
defaulting to null. Tampered and missing referenced source files refuse restore.

The predictive report case requires every named case and rejects deletion,
skipping, todo, failure, pending status and duplication. Existing static lease
and readiness requirements remain independently enforced. Migration/readiness
updates preserve immutable historical fixtures and hashes, verify the v3 tip,
and keep the application's supported minimum at v2.

## Fault injection and practical limits

An isolated exported copy was first checked with all 12 PostgreSQL and five
artifact cases passing. Each injected fault then had to produce a failed test
assertion, rather than a startup or configuration error:

- Drop natural-key correction closure.
- Change ingestion cutoff equality from inclusive to exclusive.
- Make replay's transaction writable.
- Remove the publication advisory lock.
- Remove exact source-revision / SQL-row parity.
- Choose newest recapture provenance.
- Disable one append-only trigger.
- Drop the typed payload constraint.
- Remove byte-hash integrity validation.
- Strip source publication metadata from the restore journal.

All ten were detected. Faults were applied only to the temporary copy; runtime
and migration files in the working branch were unchanged. This checks the
assertions' sensitivity to selected defects; it is not exhaustive mutation
coverage. The index test supplies no real-roster throughput benchmark. The
filesystem suite checks ordinary operations and failures, not power-loss
recovery or resistance to an administrator changing the schema/filesystem.
Real-source population completeness, acquisition budgets and hosted recovery
remain separate gates.

The strengthened suite passed all 110 pure predictive/storage tests and three
consecutive complete disposable database runs, each requiring 74 Node checks
and 29 Vitest tests. TypeScript and lint also passed. Test case counts were kept
unchanged: the review strengthens the existing mandatory cases instead of
inflating the count with duplicate scenarios.
