# Delivery 2 test reasoning review

Review date: 2026-10-09. Scope: the 12 new predictive PostgreSQL cases, five
artifact/archive cases, the mandatory-report case, and existing migration/
readiness tests adjusted for v3. The governing behavior is documented in the
[ingestion contract](predictive-ingestion.md); these tests establish synthetic
local persistence behavior, not real-source qualification or model validity.

## Second implementation review regressions (2026-10-11)

These checks address the reported failures without using a shared pure function
as their sole oracle. The mandatory database report now requires all 32
predictive cases.

| Case | Contract and independent evidence |
| --- | --- |
| Execute-only retention | An actual NOSUPERUSER login holds only `predictive_retention_owner`. Raw blob/queue SELECT and queue DELETE fail with `42501`; store retention removes JSON and schema-valid CSV bytes and drains the queue. The CSV is attached to an incomplete diagnostic capture, with no claim of parser qualification. Injected unlink failure leaves a committed event and queued references, and resume removes them, including the CSV. A missing lock, traversal reference and REPEATABLE READ snapshot fail with their specific codes. Separate root JSON/CSV journals survive. |
| Rollback / orphan lifecycle | Changed bytes trigger the original `observation-id-conflict`; the new digest has neither a blob row nor a file. Failures after writing, during diagnostic registration and during feature-run recording also leave no unpublished final file. A simulated process death leaves aged JSON/CSV final and temp files; sweep removes exactly the untracked finals and aged temps, including a temp for a committed digest. Old committed JSON/CSV finals, a recent final/temp and root journals survive. This simulates abandoned filesystem state, not an actual process-kill/fsync fault. |
| Exact raw identity | Stats raw X are attributed to canonical A, while the linked roster has Y → A. PostgreSQL rejects the label transaction specifically at check 9 and leaves no labels. X → A is the positive control. Pure checks also cover a wrong namespace and a valid noncanonical provider bridge/link. |
| Bridge ambiguity | Pure validation and direct SQL reject both one raw ID → two canonical IDs and two raw IDs → one canonical ID for player/game bridges. Adjacent player effective windows and genuine corrections are valid controls. A conflicting historical revision followed by a later fix is rejected even though the final heads agree. |
| Label retention closure | A final label cites the removed bridge; its successor cites a different bridge in a surviving profile. Retention removes both labels while keeping that surviving bridge and the earlier unbridged provisional label. This distinguishes transitive label-lineage deletion from direct references alone. |
| Private database namespace | A symlinked/insecure `.db-blobs/` is refused when opened. Replacing it after registration makes reads and sweeps refuse while the original bytes remain intact. |
| CSV address parity | An independently computed digest plus the SQL media-type rule defines the expected `.csv` address. Write/read/reopen preserve exact bytes; removal succeeds. Traversal, wrong suffix/case/digest and unknown media types fail specifically with `artifact-reference-refused`. The regression produced `.json` on the old implementation. The stale committed-digest temp regression independently failed before its fix. |
| Exact final-file ownership (both media types) | Identical bytes (`123` plus a newline, valid JSON and CSV) have one digest but two filesystem addresses. Direct SQL must return true only for the registered `storage_ref`. Both regressions fail on the previous SQL with `sibling: true`. A retention-only non-superuser sweeps the aged sibling and temp while preserving the committed file and both root journals. After retention commits and unlink fails, registering the same digest under the opposite media type must let resume remove the previous address without removing the new one. A failed JSON diagnostic against committed CSV removes only its unpublished JSON file. The separate temp lock guard refuses missing locks and malformed digests; the existing reference-isolation check exercises the same guard. These are schema-valid diagnostic blobs, with no claim of real parser qualification. |

These proofs use disposable PostgreSQL and synthetic evidence. They do not
qualify hosted role provisioning, filesystem/backup operations under actual
process crashes, a real provider's identity adapter, licensing or model inputs.

## Publication CodeQL follow-up (2026-10-11)

PR #102's initial remote run passed the application/default-build and database
gates. CodeQL flagged a URL substring comparison used to select the response
format and an intentional first-newline fixture mutation. The request allowlist
already checks exact parsed hosts; the `Accept` header now does too, using the
current destination after redirects. A permitted GitHub filename containing
`api.github.com` and an API-to-asset redirect both incorrectly selected JSON
before the fix; the regressions now require CSV. Exact API-host selection stays
JSON, and lookalike hosts are refused before fetching. The bad-header fixture
constructs the header separately and preserves every data record, retaining the
existing schema-drift failure test without a sanitization-like replacement.

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

## Source prototype test reasoning

Delivery 3 adds 72 cases; their fixtures and boundaries are separate from the
synthetic SQL publication tests above. The [source prototype evidence](predictive-source-prototype.md#evidence-and-validation)
records the live sample and an independent Python parity check.

| Tests | Reasoning and independent expectation | Limit |
| --- | --- | --- |
| `sourceAdapters.test.ts` | Quoted delimiters/newlines/BOM must preserve selected values; planted fantasy/efficiency columns must be absent. Mutated headers, excess rows, malformed/large records and lossy numbers must fail. Known summer/winter UTC offsets and real DST transition dates supply the time oracle. | Registered sampled headers are a drift boundary, not source truth or rights clearance. |
| `sourceQualification.test.ts` | Two hand-built QB candidates yield one stats match and one missing match, both participation-unknown. Missing/conflicting identifiers, roster/stat corrections and broken joins must leave explicit unresolved counts. Hand-set zero/signed/blank totals check sum parity without inferring completion. | Provider parity is not official reconciliation; candidate enumeration does not establish a complete market population. |
| `sourceTransport.test.ts` | Controlled HTTP streams, monotonic time and sleeps establish exact request/byte/retry counts; hanging requests must abort. Redirect escape, permanent failures, malformed encoding, truncation and budget overflow must stop, with cancellation checked. Interrupted retry bytes remain charged. | Fake HTTP behavior checks client controls; it cannot measure actual network billing or prove a hard process-memory/watchdog ceiling. |
| `sourcePrototype.test.ts` | Nine fixture rows must restore from exact private files. Probe/HTTP/header/digest/row failures cannot publish features. Fourteen independently rehashed journal corruptions must fail with the relevant schema/state/restoration code; source tampering and deletion must also fail. Invalid CLI input cannot register a directory. A 1,000,001-byte file proves the default synthetic cap is still active while an explicit research store can retain it. | Hash-addressed restoration checks integrity, not independent provenance authentication or a hosted backup. |

The real sample's row counts, hashes, selected digest, QB match partition,
player/team sums and Eastern kickoff were separately checked with Python's CSV,
SHA-256 and ZoneInfo implementations. Those observed aggregates are recorded in
the qualification document rather than used as synthetic NFL outcomes. The full
application and mandatory disposable DB suites also passed; there is no claim
that these tests qualify real participation, historical versions or publication.

## Rams identity regression and merge hold

**Superseded by the 2026-10-10 migration reset** (the v3/v4 proof migrations below no longer exist; the
new v3 seeds exactly 32 teams and refuses inserts). Historical record follows.

The branch review exposed v3 SQL accepting `LAR` while the application registry
accepts `LA`. The new all-team case failed on real PostgreSQL before the fix:
`predictive_teams_id_check` rejected an application-valid team. V4 corrects that
frozen SQL list while retaining the registered v3 bytes and catalog contract.

The first new mandatory case inserts all 32 app-registry IDs into PostgreSQL,
compares the SQL constraint's full accepted list with the registry, and checks
specific constraint failures for `LAR`, an unknown ID and a lowercase ID. Its
Rams dataset passes pure validation, publishes through `ingestLocalDataset` and
replays the same bundle, with hand-calculated last-4 totals of 100 attempts and
700 yards. A future registry change now exposes SQL drift in the DB gate.

The second case migrates a populated v3 proof to v4, checking all seven tables,
original ledger rows, replay equality and no-op preservation. A separate v3
database seeded with the previously SQL-valid `LAR` ID must refuse v4 with a
check violation. Verification then confirms the complete v3 catalog and exact
rows/history survived rollback. This avoids changing immutable provenance to
make an invalid old identity appear canonical.

Readiness-ahead fixtures now append beyond the generated known tip, rather than
hard-coding version 4. The readiness artifact drift test also asserts its edited
content differs from the original, so a new tip cannot make the corruption probe
an accidental no-op. All 14 required predictive cases ran in the full DB suite:
74 mandatory Node checks + 31 Vitest tests passed. Typecheck, lint and all 1,205
app/Node tests passed. V1/v2/v3 migration SQL and catalog contracts are unchanged.

The owner selected option B: delivery 2 stays off main until the real-source
schema is designed. These are WIP proof repairs, not approval to merge the
synthetic schema or include source qualification in a delivery-1/2 PR.
