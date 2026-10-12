# #52 session handoff

Updated 2026-10-11 after independent review approved `d5c5c71` for push and PR. Resume from this state; do not restart the
completed work or repeat source downloads merely to recover context.

## Current state: PR A reviewed, approved for publication

- Workspace: `/Users/vernonneilly/Documents/VN2DEV/dfs-ev-demo`.
- Branch: `feature/dfsEV-52-evidence-schema`, taken from the relay WIP tip
  `1ef86ba` (the earlier synthetic-proof work was carried forward, not discarded).
- PR A (real-source schema and replay core) was built in ten steps, then the
  first review's nine findings, second review's four P1 blockers and two cleanup
  follow-up findings plus the final-file reference finding were fixed (below).
  Independent review found no confirmed defects in `d5c5c71`; the owner approved
  push and opening PR A on 2026-10-11. Migration 0003 is now frozen under the
  [review gate](database-migrations.md#pr-a-draft-period-reset-of-migration-0003).
  Publish this branch for review and require remote CI before merge. Parent #52
  remains open for PR B and the broader ingestion/operation criteria.
- [PR #102](https://github.com/ven2dev/dfs-ev-demo/pull/102) is open against
  `main`. Its first remote run passed app checks (including the default build),
  DB integration, aggregate CI and Vercel. CodeQL's result check flagged an
  `Accept`-header URL substring comparison and a fixture's intentional
  first-newline replacement. The follow-up uses the parsed request hostname
  (including redirects) and constructs only the malformed header explicitly.
  Two header regressions failed before the fix; exact API-host, redirect and
  lookalike-host controls pass. Recheck remote CI on the new head before merge.
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
4. App readiness minimum remains **2**; this branch's maximum-known is **3**.
   Production migrations, role setup and activation stay behind #95.
5. No paid access, API key or issue comment is authorized by this work.

## Next: PR B

The first real-data slice: QB passing yards from nflverse through this schema,
measuring correctness, memory and capture cost. PR B should stamp `decided_at`
knowledge times from the database clock (DDL section 14, step 8 nuance) and own
automatic absence detection from real files.

## Real-source findings and private evidence

The measured capture used 21 requests, **18,057,623** consumed response bytes
including metadata, 51,484 parsed rows, 5,989 ms elapsed and about **463 MiB**
maximum RSS. Private logical file bytes total 18,068,656. The profile caps
requests at 28, individual response bytes at 8 MB, total consumed bodies at
20 MB, parsed rows at 80,000 and acquisition elapsed time at 90 seconds. Memory
is measured, not capped; scheduled/larger use needs a reviewed memory budget.

There are 553 QB team/week roster candidates: 148 resolved statistics matches,
404 without a match and one unresolved identity. **All 553 have unresolved
offensive participation.** Five player-stat rows have missing identifier
matches. Player/team passing sum parity and schedule joins pass, but these are
same-provider consistency checks, not independent official reconciliation.

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
