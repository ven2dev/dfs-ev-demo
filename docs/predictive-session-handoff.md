# #52 session handoff

Updated 2026-10-12 after PR B persisted research decisions (0009). Resume from this state; do not restart the
completed work or repeat source downloads merely to recover context.

The owner asked whether the issue's ACs are complete. **No:** the
[nine-criterion audit](predictive-pr-b.md#parent-52-acceptance-criteria-audit-2026-10-12)
maps the tested foundation to the remaining full-parent scope. Real-file proof
still yields no usable bundle. Shared downstream head activation, qualified
source evidence, remaining feed/market mappings and bounded operating proofs
remain outstanding. The audit describes code checkpoint `e8e76e7`; the shared
consumer witnesses and coordinated merge validation follow below. Neither
checkpoint closes the parent issue or qualifies real predictive inputs.

## Current migration coordination (2026-10-12)

The owner approved **#90 merging first and owning 0004**. PR #103 merged as
`3daf1dc` at 2026-10-12 19:27:45 UTC. Main is merged into PR B without rebasing;
PR B's three unmerged migrations move from **0004–0006 to 0005–0007**, preserving
their SQL bytes/checksums and regenerating prefix/readiness artifacts. Released
0001–0004 stay frozen. The owner confirmed the old private prefixes ran only in
disposable databases. Recreate those databases; never repair an obsolete ledger.
The final merge verification is recorded in the latest checkpoint below.

The old relay handoff now has this notice too. Do not use its historical October 9
instructions as current schema/merge guidance. Preserve the creator session's
database: PR B uses Docker project `dfs-ev-52-prb-test` and `[::1]:54329`, not the
default project at `127.0.0.1:54329`.

Historical checkpoint logs/paragraphs below retain the original private prefix
numbers; current files are 0005 (claims), 0006 (bindings), 0007 (unavailable
plans), 0008 (SQL witnesses) and 0009 (research decisions). The old maximum-known 6 is historical: current maximum-known is 9 and
minimum readiness remains 2. No hosted activation is authorized.

## Current state: PR A merged; PR B bound source revisions in internal research staging

- PR B workspace: `/private/tmp/dfs-ev-52-pr-b`; branch:
  `feature/dfsEV-52-real-source-ingestion`, created from merged main `d934432`.
  Dependencies use Node 24.18.1. PR B is local, unpushed and not open. The branch
  initially tracks origin/main; push only with an explicit feature destination.
  Preserve the creator and PR A workspaces.
- Historical PR A branch: `feature/dfsEV-52-evidence-schema`, taken from relay tip
  `1ef86ba` (the earlier synthetic-proof work was carried forward, not discarded).
- PR A (real-source schema and replay core) was built in ten steps, then the
  first review's nine findings, second review's four P1 blockers and two cleanup
  follow-up findings plus the final-file reference finding were fixed (below).
  Independent review found no confirmed defects in `d5c5c71`; the owner approved
  push and opening PR A on 2026-10-11. Migration 0003 is now frozen under the
  [review gate](database-migrations.md#pr-a-draft-period-reset-of-migration-0003).
  Further changes need forward migrations; never reset 0003. Parent #52
  remains open for PR B and the broader ingestion/operation criteria.
- [PR #102](https://github.com/ven2dev/dfs-ev-demo/pull/102) merged into `main` as
  `d934432e8aa32a38226c65306592b77e04e05f01`, after reviewed `d5c5c71` and
  CodeQL fixes `614742e`. Remote app/default-build, PostgreSQL, CodeQL, aggregate
  CI and Vercel checks passed before merge.
- PR B adds typed raw statistics and offline `predictive:source assess`, preserving
  v1 journals/output and applying F3 to individual positive usage. It now also
  stages complete player/team CSV snapshots under forward migration 0004,
  preserving every typed/refused record and exact raw bytes. Database-clock
  ingestion, cutoff replay, idempotency, current rights, full-file row verification,
  rollback cleanup and retention/resume are implemented. These are raw claims,
  with a guard against direct canonical publication. Canonical normalization
  planning is now implemented too: exact source-row/bridge/schedule bindings,
  kickoff-effective player identity, current internal-research rights and scoped
  conflict detection. The persisted planner works read-only through replay-only
  access; that checkpoint is committed locally as `f2c681b`. A subsequent pure
  raw-lineage contract now defines append/attach/withhold, including identity
  rerouting and cutoff selection before canonical routing. Actual canonical
  binding storage and hydration are now implemented in forward migration 0005
  as internal research staging; activation in features/decisions/labels remains
  next. See
  [PR B progress and measurements](predictive-pr-b.md).
- PR B validation: 831 jsdom + 529 Node tests, typecheck, lint, and the complete
  disposable PostgreSQL gate (74 Node checks + 58 DB tests, all 41 mandatory
  predictive cases) pass. Retained-file import/replay proof also passes with
  zero downloads. Released migration 0003 and old contracts remain unchanged.
  Only disposable databases received migration 0004. App tests/proof required
  sandbox permission for local loopback listeners/connections.
  Production Webpack build, CI gate and diff whitespace checks also pass.
  The subsequent planner passes 561 Node tests, 74 DB Node checks and 62 DB
  tests (all 45 mandatory predictive cases), typecheck and lint. Its real-file
  proof returns `game-bridge-missing` for both feeds with zero active canonical writes.
  It changes no SQL/catalog/readiness artifacts or app route. The earlier
  browser/build numbers describe the CSV-storage checkpoint.
  The subsequent raw-lineage contract passes all 603 Node tests (42 new cases),
  alongside the 831 jsdom cases and unchanged full PostgreSQL gate. Typecheck
  and lint pass. It adds no migration or canonical publication path. Final
  Node evidence is `/private/tmp/dfs52-prb-lineage-node.log`; the full DB log is
  `/private/tmp/dfs52-prb-normalization-db.log`. The jsdom portion of
  `/private/tmp/dfs52-prb-lineage-app.log` passed all 831; that command's Node
  portion exposed a team fixture with an invalid player identity link, fixed
  before the final complete Node run.
- The bound-revision checkpoint passes 831 jsdom + 603 Node tests (two workers),
  74 Node DB checks + 75 DB tests, all 58 mandatory predictive cases, typecheck,
  lint, CI-gate, whitespace and changed-guide links. Default worker-count app
  runs timed out in untouched UI/creator tests under machine load; the same full
  suites pass with `--maxWorkers=2`. Test timeouts/configuration were unchanged.
  Evidence: `/private/tmp/dfs52-prb-bindings-jsdom.log`,
  `/private/tmp/dfs52-prb-bindings-node.log`,
  `/private/tmp/dfs52-prb-bindings-db.log`. Only disposable Docker databases
  received 0005; the harness removed them. No provider files were downloaded.
- The approved design is [`predictive-real-source-schema.md`](predictive-real-source-schema.md)
  revision 2 and [`predictive-evidence-ddl.md`](predictive-evidence-ddl.md)
  revision 2. Section 14 of the DDL lists what each step built and every
  refinement.

| Step | Commit | What it added |
| --- | --- | --- |
| 1 | `bcf3d37` | Approved real-source schema and contract amendments recorded in docs |
| 2 | `19da332` | Migration reset to the new 0003, with the real-source envelope: profiles, rights, blobs, runs, artifacts, captures, 32 seeded teams, observations with entity/source keys |
| 3 | `8707d1b` | Role privileges and rights authorization proven in PostgreSQL |
| 4 | `3acea3e` | Persisted reconciliation decisions; current access uses the database clock |
| 5 | `0a923ff` | Coverage-aware source-row absences (`absence-v1`) |
| 6 | `f0f37cb` | Completion decisions over exact marker heads |
| 7 | `7aa9ad5` | Participation decisions and bound outcome labels (eight binding checks) |
| 8 | `9da3e72` | Feature runs with sealed manifests and two digests |
| 9 | `6f1bc3f` | Identity bridges with strict same-source ambiguity checks |
| 10 | `2085bc1` | Owner-only scoped retention with audit and backup re-apply |

(An earlier version of this table mislabeled steps 1–3; step 3 never added snap
kinds. They arrived with review fix 9.)

First Codex review fixes (2026-10-10; DDL section 14 has a note per fix):

| Fix | Commit | What it changed |
| --- | --- | --- |
| 1 | `b7f923a` | Reconciliation decisions must cite every visible head, in SQL and TypeScript |
| 6 | `d448220` | Persisted replay loads participation decisions |
| 7 | `2d14a1e` | Feature-run decision dependencies must be current at the cutoff |
| 3 | `c416ce4` | Game-scoped absence coverage binds a typed game identity |
| 8 | `9eb1eac` | Canonical retention digest; no control characters in any ID |
| 9 | `23c306d` | Snap evidence kinds, `snap-source-compatibility`, pooled `snapShare` |
| 5 | `9f462d7` | Final labels pin a current, linked, unambiguous player bridge (check 9) |
| 2 | `f7fab0d` | Feature runs recorded only through a `clock_timestamp()`-stamped recorder function |
| 4 | `bf8a029` | Per-digest session locks for blob files and a resumable removal queue |

Validation after the fixes on Node 24.18.1: 831 jsdom + 454 Node tests; the
complete disposable PostgreSQL suite (74 Node checks + 44 Vitest tests, all
**27** mandatory predictive cases); typecheck, lint, CI gate, DB guards, and the
migration and readiness checks.

Second implementation review fixes (2026-10-11):

1. Retention cleanup uses execute-only, role-checked definer APIs for the queue,
   committed-reference recheck, acknowledgement and history. A real
   non-superuser login with only retention membership proves the complete retain
   and resume paths; direct table access remains denied.
2. SQL-owned files move to private `.db-blobs/`, separate from archive journals.
   Failed publication, diagnostics and feature-run recording remove unreferenced
   final files under digest locks. An owner-run age-gated orphan sweep recovers
   abandoned final/temp files after crashes or cleanup failure. Journals and
   backups still need separate owner retention. Every root belongs to one
   authoritative database and cooperating sequential sessions.
3. Player-scoped source evidence retains its exact raw ID and ID namespace.
   Label check 9 compares the selected stats row with its pinned bridge; a
   profile link alone is insufficient. The reported raw-X/bridge-Y scenario is
   refused in SQL and TypeScript.
4. Player/game bridges reject both ambiguity directions over overlapping
   knowledge ranges (and player effective ranges). Later corrections cannot
   hide an earlier conflict. Pure and direct-SQL regressions include adjacent
   effective windows and valid correction controls.

The suggested retention regression also proves that deleting a cited bridge
removes its final label and later label versions, even when the later label
cites a different surviving bridge. Its earlier unbridged provisional label
remains.

Cleanup follow-up (2026-10-11): aged temporary files are removed under the digest
lock even when their final digest is committed; committed final bytes and recent
files remain protected. The artifact store writes/reads/removes exact JSON and
CSV addresses and discovers CSV orphans. Regressions failed on the previous
implementation, then passed for stale committed-digest temps, CSV orphan and
committed-file behavior, and CSV retention/resume through the non-superuser
owner. This follow-up changes no SQL, migration manifest or catalog contract;
real CSV parser qualification stays in PR B.

Exact-reference follow-up (2026-10-11): final-file ownership binds the exact
`storage_ref`, including the media suffix. Queue cleanup and orphan sweep pass
the actual filename; current publication rollback checks its known JSON address.
Temporary cleanup uses a separate role-checked digest-lock guard, without asking
whether the digest is referenced. Both-direction regressions failed against the
previous SQL, then passed through a retention-only non-superuser login. They
also cover failed unlink followed by republication under the opposite media
type, and JSON diagnostic rollback with a committed CSV sibling. Only draft
0003 and its generated artifacts were reset under the approved procedure.

Validation on Node 24.18.1: 831 jsdom + 458 Node tests (266 pure predictive
cases); the full disposable PostgreSQL gate (74 Node checks + 49 Vitest tests,
including all **32** mandatory predictive cases); typecheck, lint and
migration/catalog/readiness verification. The earlier cleanup follow-up also
passed CI gate, DB guards, Firestore rules, the production dependency audit
(zero vulnerabilities) and the production build with
`npm run build -- --webpack`; default Turbopack fails because its CSS worker
cannot bind a local port in this execution environment. Only draft 0003 and its generated
artifacts change; released v1/v2 stay intact. No real dev, Neon or Production
migrations were run. See the [test reasoning review](predictive-test-review.md)
for test oracles and crash-simulation limits.

## Owner decisions still in force

1. Schema decisions F1–F6 (2026-10-10): JSONB payloads with typed routing
   columns; coverage-aware absences that block; positive usage counts as
   individual participation evidence; PFR rejected; two PRs; SportsDataIO only
   after licensing qualification. Snap share is required for RB/WR/TE.
2. Q1 scoped deletion of files and rows with a minimal audit record; Q2 save
   every feature run, unpinned runs expire after 90 days; Q3 bridges are
   evidence, with strict ambiguity validation. Step 6 recompute-and-cite.
3. The §7b candidate features (weather, venue, depth/teammate absences,
   targets per snap) and a defensive-scheme slot are reserved, not implemented.
4. App readiness minimum remains **2**; this branch's maximum-known is **9**.
   Production migrations, role setup and activation stay behind #95.
5. No paid access, API key or issue comment is authorized by this work.

## Continue PR B

The first real-data slice remains QB passing yards from nflverse through this schema,
measuring correctness, memory and capture cost. PR B should stamp `decided_at`
knowledge times from the database clock (DDL section 14, step 8 nuance) and own
automatic absence detection from real files.

Bound canonical source revisions now persist and hydrate in internal research
staging under 0006; see [the storage checkpoint](predictive-source-lineage.md#storage-checkpoint-implemented-in-0006).
The recorder revalidates exact raw/context/current rights with database time;
replay recomputes original plans from verified files and withholds unrecorded
changes. Retention removes complete affected raw lineages, including ancestors,
and associated canonical source revisions. These rows remain outside
`predictive_observations`, features, decisions and labels. Positive plans, unavailable captures, raw-row failures and unavailable
context are now recordable through forward 0007/v2. Existing v1 plans keep exact
historical hydration and retries. Implement one
binding-aware head contract across SQL replay, reconciliation, participation,
label and post-window checks before activating them. Changing only feature
replay is insufficient. Preserve unresolved completion/population/membership.
0005–0007 are local and unmerged, now sequenced after #90's released 0004.
Further behavior changes require a forward migration; the coordinated
renumbering preserves SQL bytes. Released 0001–0004 remain frozen. No persistent
dev, hosted or Production migration was run.

## Real-source findings and private evidence

The measured capture used 21 requests, **18,057,623** consumed response bytes
including metadata, 51,484 parsed rows, 5,989 ms elapsed and about **463 MiB**
maximum RSS. Private logical file bytes total 18,068,656. The profile caps
requests at 28, individual response bytes at 8 MB, total consumed bodies at
20 MB, parsed rows at 80,000 and acquisition elapsed time at 90 seconds. Memory
is measured, not capped; scheduled/larger use needs a reviewed memory budget.

The preserved v1 report has 553 QB team/week candidates, all participation-unresolved.
PR B's separate F3 assessment finds **148 positive-usage individuals and 405
unresolved** (404 missing stats, one missing identity), with no confirmed absences.
Typed projection accepts 4,512 of 4,517 player rows; five lack raw GSIS IDs. All
130 team rows project. Independent Python CSV/hash checks reproduce the candidate
partition. Player/team passing parity remains a same-provider consistency check.
Offline assessment measured 1.86 s wall and 444,760,064 bytes maximum RSS (~424 MiB).
Raw SQL claims publication now imports all 4,517 player and 130 team records,
with all five player refusals preserved. Active canonical publication and ready-inputs
remain unimplemented/unqualified. The final retained-file proof at 2026-10-12
02:29 UTC (2026-10-11 Los Angeles) measured player publish/replay at 3,031/289 ms,
team at 111/12 ms, source-row relation storage at 5,922,816 bytes and whole-process
peak RSS at 444,497,920 bytes (~424 MiB). Before-import unavailability and exact
retry replay both passed. The scratch database and its SQL-owned files were
removed, with zero canonical observations, features or labels published.

Still unqualified: completion, independent offensive participation and complete
population enumeration, independent schedule coverage, canonical event/team
bridges, weekly membership effective bounds, injury report cycles, full depth
capture and prior-season source samples/historical cutoff availability. A
current historical download cannot establish what was known at an earlier
cutoff. Reports return `unavailable-inputs`, unqualified population and
`modelValidated: false`; they always have `featuresPublished: false`.

Retained private evidence. **`/private/tmp` is not durable; the owner should copy
it somewhere permanent outside the checkout.**

- Directory: `/private/tmp/dfs-ev-52-source-proof.utpDdL`.
- Journal: `f496e74d6823d5507b301568d2c9c1dbc6f562fe93c8cbb52f621bd6674a5b31.json`,
  **10,967 bytes**, plus every referenced metadata/source file.
- Capture/verify reports: `/private/tmp/dfs-ev-52-source-capture-report.json` and
  `/private/tmp/dfs-ev-52-source-verified.json`.
- Independent Python parity: `/private/tmp/dfs-ev-52-source-parity.py` and
  `/private/tmp/dfs-ev-52-source-parity.json`.
- Projection digest:
  `20b3612bb591839f0e6e4238b7f7da122c2cefefacfcf27cf8cbca28a9052443`.
- PR B assessment/metrics: `/private/tmp/dfs52-prb-assessment.json` and
  `/private/tmp/dfs52-prb-assessment-metrics.txt`; independent check:
  `/private/tmp/dfs52-prb-parity.py` and `/private/tmp/dfs52-prb-parity.json`.
- PR B candidate evidence digest:
  `e4e59e643e54de3f9e5096d0944958ff65ee7d85fc0edc692ecc8b8df3b6dfd1`.
- Raw CSV storage-checkpoint proof: `/private/tmp/dfs52-prb-csv-proof-83de5fd.json` (actual ingestion
  timestamps are part of its replay digests; reruns legitimately differ).
- Final validation logs: `/private/tmp/dfs52-prb-csv-app.log`,
  `/private/tmp/dfs52-prb-csv-db-full.log`, `/private/tmp/dfs52-prb-csv-typecheck.log`
  and `/private/tmp/dfs52-prb-csv-lint.log`.
- Normalization proof: `/private/tmp/dfs52-prb-normalization-proof.json`, at
  2026-10-12 03:17 UTC / 2026-10-11 Los Angeles. Player publish/replay/plan
  3,037/274/270 ms; team 108/12/31 ms; peak RSS 414,973,952 bytes (~396 MiB).
  Both plans are unavailable because no canonical game bridge is registered.
- Planner validation: `/private/tmp/dfs52-prb-normalization-node.log`,
  `/private/tmp/dfs52-prb-normalization-db.log`,
  `/private/tmp/dfs52-prb-normalization-typecheck.log` and
  `/private/tmp/dfs52-prb-normalization-lint.log`.

Offline TypeScript verification and independent Python CSV/hash/ZoneInfo checks
agree on the source hashes/counts, selected digest, roster partition, player/team
passing totals and target kickoff. Preserve real capture times; release
`updated_at` is diagnostic metadata, never earlier row publication evidence.

## Earlier plan: real-source schema design (done in PR A)

Start with a concrete, reviewable schema proposal covering passing, rushing and
receiving, while retaining passing yards as the first end-to-end implementation
case. Address capture/run state and bounds, exact private artifacts, source
profiles/rights, immutable observation revisions and corrections, canonical
bridges, dated membership, independent schedule/completion/participation evidence
and provisional/finalized outcome labels. Explicitly explain how the WIP
synthetic proof schema would evolve and what would enter the final PR. Do not
loosen synthetic constraints to accept real data before the evidence contracts
are designed.

In parallel with that design, identify permitted sources for completion and
participation and their identity, availability, zero-opportunity and correction
semantics. Preserve unresolved candidates. Current stats, weekly ACT, schedule
scores or missing rows cannot close these gates by inference. Conditional source
routes need their existing rights qualification before acquisition; do not ask
for a key or purchase until a concrete measured gap requires it.

## POC versus MVP landscape

The implemented builder supports **QB passing yards only**, in stats-only and
player/opponent-enriched variants. The public downloads include other positions
and columns; that does not mean those feature builders or models are implemented.

The agreed broader contract covers nine over/under markets:

| Family | Markets | Registry positions |
| --- | --- | --- |
| Passing | Yards, attempts, completions, touchdowns, interceptions | QB |
| Rushing | Yards, attempts | QB/RB/FB/WR/TE |
| Receiving | Yards, receptions | RB/FB/WR/TE |

Anytime/first/last touchdown scorer markets remain outside this predictive
scope. The last discussion proposed a staged launch of passing yards, rushing
yards/attempts and receiving yards/receptions, followed by other passing
markets. **That five-market launch subset is a recommendation, not an approved
scope change.** Model sufficiency and sparse-event handling remain #54 decisions.

Expansion needs more than columns: qualify common evidence, implement each
family's paired counts/denominators and zero/missing rules, then validate models
in #54 with cutoff-honest evaluation, calibration, uncertainty and push-aware
probabilities. #53 owns product integration, visible versions/cutoffs/quality and
price/settlement comparisons. Public rights and monitored hosting, recovery,
memory/storage/cost budgets must pass before activation. Weather/depth/routes/
pace can remain optional; a validated stats-only candidate is the proposed
initial path, with explicit availability quality and exclusions.

## References and execution

- [Ingestion and merge hold](predictive-ingestion.md).
- [Source prototype, budgets and evidence](predictive-source-prototype.md).
- [Test reasoning](predictive-test-review.md).
- [Nine-market feature/label contract](predictive-feature-contract.md).
- [Source decision](predictive-data-sources.md) and [operating policy](predictive-data-operations.md).
- [Database testing](database-testing.md) and [migration policy](database-migrations.md).
- [#52 proposal](https://github.com/ven2dev/dfs-ev-demo/issues/52#issuecomment-6054299022).

Use `/Users/vernonneilly/.nvm/versions/node/v24.18.1/bin` on PATH. Read AGENTS.md
and the relevant installed Next.js guide before code changes. Run
`npm run test:db:local` for complete disposable DB validation; it cleans up its
Docker service. Use offline `predictive:source verify` with the journal above
instead of downloading again. Raw records remain outside Git. No subagents
were authorized for this work.


## Latest checkpoint: unavailable normalization states

0006 independently reconstructs all unavailable witnesses and pins source/cited
context rights on v2 failure plans. It preserves v1 plans and exact-ID retries;
new records require v2. All cited equal-time conflict files are verified. Current
context rights are checked before opening bytes. Capture-less bindings are
conservatively removed with their whole lineage whenever their source is scoped
for deletion. Shared feature/decision/label head activation remains outstanding.

The default disposable IPv4 Docker project was also in use by a creator worktree
with a different migration 0004. This checkpoint's final database validation uses
an isolated `dfs-ev-52-prb-test` project, the same pinned PostgreSQL image, tmpfs
and throwaway credentials, on the harness-permitted `[::1]:54329` loopback. Its
temporary Compose file is `/private/tmp/dfs52-prb-compose.yml`. Do not operate
on another session's default container. Use the normal Compose lifecycle for
this isolated project and `npm run test:db` with the IPv6 test URL; all scratch
databases still require normal harness registration. No harness guard was relaxed.


Validation for the 0006 checkpoint: **831 jsdom + 604 Node tests**, **74 Node database
checks + 84 database tests**, all **67 mandatory predictive cases**, typecheck,
lint, CI-gate, migration/catalog/readiness verification, whitespace checks and
21 local documentation links pass. The retained-file proof ran at
2026-10-12 16:38 UTC with **zero requests**: 4,517 player rows (4,512 typed,
five refused) and 130 typed team rows; each feed recorded/replayed its
`game-bridge-missing` binding and verified an exact-ID retry. Active canonical
observations remain zero. Peak whole-process RSS was 476,119,040 bytes
(~454 MiB), measured rather than capped. Registered scratch databases and the
isolated PR-B Docker container were removed; the creator container was left
alone after isolation. No persistent dev, Neon or Production migration ran.

Evidence: `/private/tmp/dfs52-prb-unavailable-jsdom.log`,
`/private/tmp/dfs52-prb-unavailable-node.log`,
`/private/tmp/dfs52-prb-unavailable-db.log`,
`/private/tmp/dfs52-prb-unavailable-proof.log`.

## Retention compatibility review follow-up

The independent review of `564549b` found no blockers. The suggested regression
now executes empty/nonempty legacy retention events under pre-0006 SQL in v5,
then re-imports the same evidence/IDs into v6 and re-applies them through a
non-superuser retention-only login. Counts and digest match exactly in full and
digest-only modes; files are removed, unrelated evidence survives, and a second
reapplication is unchanged. No runtime SQL change was required. Capture-less
whole-lineage deletion is consciously retained and documented above.

Validation: **74 Node database checks + 85 database tests**, including all
**68 mandatory predictive cases**, typecheck, changed-file lint, CI-gate and
whitespace checks pass. The application code and migration artifacts did not
change; the earlier 831 jsdom + 604 Node result remains the last app-suite run.
Evidence: `/private/tmp/dfs52-prb-retention-db.log`,
`/private/tmp/dfs52-prb-retention-focused.log`,
`/private/tmp/dfs52-prb-retention-typecheck.log`,
`/private/tmp/dfs52-prb-retention-lint.log`,
`/private/tmp/dfs52-prb-retention-ci.log`.

## Latest checkpoint: canonical stats read adapter

`sourceFacts.ts` and `replaySourceStatsFacts()` implement read-only canonical
research reads from verified bindings. The reader discovers every recorded raw
lineage in explicit profiles, checks all historical source/context rights before
opening files, verifies original witnesses at their own clocks/versions,
replans at the cutoff, follows raw heads, and only then filters canonically.
An unrecorded destination is discovered even without its own stored revision.
Stale reads return failure/routing metadata, never historical numeric payloads.
Unresolved current routing remains explicit for every canonical filter; an old
destination cannot prove the unknown current claim is unrelated to another one.

Selected heads pin binding IDs/tokens separately from statistical revision IDs.
Recapture/reappearance can reuse a revision with new provenance and retain its
first recorder time. Equivalent current rights renewal preserves the snapshot.
The preliminary selector exposes selected/missing/ambiguous/withheld states,
including multiple providers and a withheld expected provider. Coverage is
**recorded-lineages-only**, not a complete eligible population. Limits are 16
profiles, 64 canonical filters, 256 raw lineages, 8,192 total events, plus existing
per-lineage/file-verification bounds. Overflow refuses, never truncates.

No migration was added or renumbered. #90's PR #103 is still open at this
checkpoint. SQL must still implement the same current head rule before wiring
features, reconciliation/participation decisions, labels and post-window capture
checks together. This research reader activates none of those existing paths.
The later coordinated merge now includes #90 and renumbers these private
migrations to 0005–0007; see the latest checkpoint before adding a forward
activation migration.
Large-roster indexed discovery must preserve unrecorded destination and unresolved
routing semantics; the profile-wide research reader is not a scale qualification.

Validation: **831 jsdom + 616 Node tests**, **74 Node database checks + 92
database tests**, all **75 mandatory predictive cases**, typecheck, full lint,
CI gate, migration/catalog/readiness verification and whitespace checks pass.
The twelve pure and seven database cases have hand-specified routing/provenance
oracles; the overflow test is a mocked query-result boundary, not a DB load test.
The app suite required local loopback permission for unchanged creator-server
tests; no timeout/configuration was changed.

The final retained-file proof ran at 2026-10-12 17:46 UTC with zero requests:
4,517 player rows (4,512 typed, five refused) and 130 typed team rows. Each
canonical fact read has zero usable heads and one `game-bridge-missing` binding
with unresolved routing. Player/team fact reads measured 357/50 ms; whole-process
wall time 7.77 seconds and maximum RSS 465,534,976 bytes (~444 MiB), measured,
not capped. Active canonical observations/features/labels remain zero. Scratch
databases/private proof files and the isolated PR-B container were removed;
the retained archive and the creator session's database were preserved.

Evidence: `/private/tmp/dfs52-prb-facts-jsdom.log`,
`/private/tmp/dfs52-prb-facts-node.log`, `/private/tmp/dfs52-prb-facts-db.log`,
`/private/tmp/dfs52-prb-facts-typecheck.log`, `/private/tmp/dfs52-prb-facts-lint.log`,
`/private/tmp/dfs52-prb-facts-ci.log`, `/private/tmp/dfs52-prb-facts-proof.log`,
`/private/tmp/dfs52-prb-facts-proof-metrics.log`.

## Latest checkpoint: shared consumer witnesses

`sourceWitness.ts` pins binding IDs/tokens separately from statistical revision
IDs, scopes missing and withheld evidence, and compares exact source head sets
without treating a query clock change as an evidence change. Reconciliation-v1
and F3 usage helpers share the released policy predicates. The post-window
source-capture helper checks the exact selected binding and its own raw capture;
an unchanged revision can be reconfirmed by a later recapture, but an earlier
capture cannot be substituted. These remain read-only research helpers: no
SQL activation or active feature/decision/label write path has been added.

Commit `4319a6b` adds seventeen pure cases and two mandatory database cases for
those invariants, including a non-superuser replay-only login. After merging
main/#90 and renumbering, the complete gates pass **873 jsdom + 633 Node tests**,
**75 Node DB checks + 103 database tests**, all **78 mandatory predictive** and
**8 creator-corpus** cases. Typecheck, full lint, CI gate, Firebase Admin runtime,
the production Webpack build, migration/catalog/readiness checks, whitespace and
55 local file/heading links pass. The DB/app suites needed loopback permission
for local connections/listeners; guards and timeouts were unchanged.

Evidence: `/private/tmp/dfs52-prb-consumers-node.log`,
`/private/tmp/dfs52-prb-consumers-focused.log`,
`/private/tmp/dfs52-prb-consumers-jsdom.log`,
`/private/tmp/dfs52-prb-consumers-db.log`,
`/private/tmp/dfs52-prb-consumers-typecheck.log`,
`/private/tmp/dfs52-prb-consumers-lint.log`,
`/private/tmp/dfs52-prb-consumers-ci.log`,
`/private/tmp/dfs52-prb-consumers-build.log`.

## Latest checkpoint: merged #90 and renumbered PR B

Main `3daf1dc` (#90/PR #103) is merged without rebasing. Released SQL and catalog
contracts 0001–0004 match main byte for byte. PR B's renamed 0005–0007 SQL retains
its old checksums; generated catalog prefixes, schema/manifest and readiness
now include the creator-corpus migration. Minimum readiness remains 2 and
maximum-known is 7. A new mandatory released-v4 upgrade test seeds every
creator-corpus table, preserves all rows and the first four ledger records,
imports predictive CSV and proves the migration rerun is a no-op. Existing raw
binding upgrades and cross-version retention tests now use the correct v5/v6/v7
boundaries. Old private disposable ledgers must be recreated; no guard was
relaxed and no persistent dev, Neon or Production migration ran.

The retained-file proof ran at 2026-10-12 20:00 UTC with **zero requests** under
schema version 7. It restored 4,517 player rows (4,512 typed, five refused) and
130 typed team rows. Both canonical reads have zero usable heads, one unresolved
`game-bridge-missing` binding and an unavailable consumer witness. Player/team
fact reads measured 360/51 ms. Whole-process wall time was 7.97 seconds and
maximum RSS 498,810,880 bytes (~476 MiB), measured rather than capped. No active
canonical observation, feature or label was published. Scratch databases/private
proof files and PR B's isolated container were removed; the retained source
archive and creator session's default database were preserved.

Proof evidence: `/private/tmp/dfs52-prb-consumers-proof.log`,
`/private/tmp/dfs52-prb-consumers-proof-metrics.log`.
Catalog regeneration: `/private/tmp/dfs52-prb-renumber-contracts.log`.

**Next:** implement the shared binding-aware SQL head rule and forward recorder/
application integration across features, reconciliation, participation, labels
and post-window checks together. The #90 sequencing hold is resolved; future
schema work can append 0008. Do not modify released 0001–0004 or repurpose the
renumbered files for behavioral changes. Source qualification and the parent AC
audit remain open; research witnesses and passing tests are not usable real
predictive inputs. PR B remains local/unpushed; use an explicit feature
destination if later authorized to push.

## Latest checkpoint: SQL witness parity (0008)

The shared SQL head/witness kernel now exists in forward 0008. It reconstructs
every recorded raw chain in explicit profiles before canonical filtering,
reproduces historical v1/v2 plans, replans cutoff-visible routing and mirrors
application head/binding/token/withheld/missing evidence. The guarded public
reader uses the database clock for current rights; only replay/recorder members
can execute it and neither can call the private kernels or provide an access
clock. Every canonical research read independently verifies files, then compares
its witness with SQL in the same read-only/repeatable-read transaction. Any
mismatch refuses. The private current-use checker rejects rehashed forgeries,
stale recaptures, missing/withheld and unchanged empty evidence, while historical
cutoffs preserve their original binding.

**Scope:** this checkpoint does not activate features, decisions or labels and
adds no consumer table/retention procedure. The original consumer FKs still
point to ordinary observations; real-source writers remain gated. SQL metadata
cannot replace byte proof, qualified completion/population/membership or
use-specific rights. **Next:** append 0009 for coordinated consumer recorder,
manifest, replay and retention integration. Do not modify 0001–0008 to add that
behavior. Parent #52 and PR B remain incomplete and PR B stays local/unpushed.

Final gates pass **873 jsdom + 633 Node tests**, **75 Node DB checks + 110 database
tests**, all **85 mandatory predictive** and **8 creator-corpus** cases,
typecheck, full lint, CI gate and the production Webpack build. Seven new SQL
cases cover typed parity, rehashed forgeries, currentness/recapture/empty sets,
unrecorded and unresolved routing, non-superuser roles/access clock, v7 upgrade
and injected mismatch rollback. Released 0001–0004 and existing private
0005–0007 SQL/catalog contracts are unchanged; readiness is minimum 2/maximum 8.
Legacy literal-v7 ledger assertions were updated to v8; historical fixture/data
expectations were preserved. The browser suite required permission for its
loopback listeners. Evidence:
`/private/tmp/dfs52-prb-sql-witness-{db,node,jsdom,typecheck,lint,ci,build}.log`.

The schema-8 retained-file proof at 2026-10-12 21:28 UTC made zero requests. It
restored the same 4,517 player rows (4,512 typed/five refused) and 130 typed team
rows. Both SQL-cross-checked witnesses are unavailable with unresolved
`game-bridge-missing`; no active canonical observation/feature/label exists.
Player/team fact reads measured 389/59 ms, whole-process wall time 8.08 seconds,
maximum RSS 428,195,840 bytes (~408 MiB), measured rather than capped. Evidence:
`/private/tmp/dfs52-prb-sql-witness-proof.log` and
`/private/tmp/dfs52-prb-sql-witness-proof-metrics.log`. Scratch databases/private
proof files were removed. Preserve the retained archive; no new fetch is needed.

## Latest checkpoint: persisted research decisions (0009)

Forward 0009 adds an isolated research ledger for reconciliation-v1 and
participation-v1, using exact CSV binding/revision/token witnesses and native
participation provenance. SQL independently reconstructs the policies and mode;
the execute-only recorder takes evidence/publication locks before its database
clock, compares current evidence and checks the expected predecessor. Exact
retries preserve original history. Read-only/repeatable-read replay verifies
files, every recorded event and its full binding/native/right association sets.
Current source/context/native rights and SQL head bounds precede any file reads.
Unavailable states record null results; recovery gets fresh provenance without
rewriting earlier cutoffs. Current insufficient/conflicting/unresolved outcomes
remain unusable for final labels.

Retention removes the entire affected decision scope lineage, including an
ancestor that did not cite a later deleted native claim. A contradictory
successor's deletion cannot revive that ancestor as current. All visible binding
history inside the explicit profiles is cited conservatively. Capture-less
scopes are conservatively removed even by narrow time-window deletion. Unrelated
scopes survive; restored-backup re-apply matches independent audit counts/digests.
No new blobs or active feature/label paths are introduced. Internal research
rights still authorize neither model inputs nor outcome labels.

Final validation passes **873 jsdom + 637 Node tests**, **75 Node DB checks + 124
database tests**, all **99 mandatory predictive** and **8 corpus** cases,
typecheck, lint, CI gate, Firebase Admin runtime and the production Webpack build.
Four pure and fourteen mandatory DB cases are described in
[the test reasoning review](predictive-test-review.md#pr-b-persisted-research-decision-tests-0009-2026-10-12).
The catalog extension test now handles its synthetic version 10 with four-digit
padding. Prior SQL/catalog prefixes 0001–0008 remain byte-for-byte unchanged;
readiness stays minimum 2/maximum 9. Draft 0009 was regenerated only in disposable
PR B databases; the obsolete disposable ledger was recreated, never repaired.
After moving SQL metadata authorization ahead of file hydration, the fourteen
focused DB cases were rerun and passed. Logs:
`/private/tmp/dfs52-prb-decisions-{db,db-focused,node,jsdom,typecheck,lint,ci,build,runtime}.log`.

The schema-9 offline proof at **2026-10-13 04:08 UTC** (October 12 Pacific) made
**zero requests**, restored 4,517 player rows (4,512 typed/five refused) and 130
typed team rows. Both feeds have zero usable heads and unresolved
`game-bridge-missing`; there is no qualified canonical game on which to record a
real participation/reconciliation result. No active canonical observation,
feature or label was published. Fact reads measured 379/62 ms; whole-process
wall time 8.15 seconds; maximum RSS 495,828,992 bytes (~473 MiB), measured rather
than capped. Proof files/scratch databases were removed by the harness.
Evidence: `/private/tmp/dfs52-prb-decisions-proof{,-metrics}.log`. Preserve the
retained source archive; PR B's isolated Docker project is shut down after checks.

**Next delivery:** integrate the verified source decisions/witnesses in feature
reads and sealed run manifests, final-label/post-window selection and exact raw
identity provenance, with their use-specific rights and complete retention
closure in a forward migration. Existing observation-only consumers remain
gated for real CSV evidence. Qualified completion, membership, schedule/history,
participation/population sources and remaining feed/market/operating proofs are
still outstanding. Parent #52 and PR B are incomplete. The branch remains
local/unpushed; development and local commits are authorized, but remote push
or opening PR B needs owner instruction. Do not modify 0001–0009 to add new
behavior after this checkpoint. No hosted, persistent-dev or Production
migration, paid/key setup, new provider request or scheduler was run.
