# #52 session handoff

Updated 2026-10-10 after PR A step 10. Resume from this state; do not restart the
completed work or repeat source downloads merely to recover context.

## Current state: PR A implemented, awaiting review

- Workspace: `/Users/vernonneilly/Documents/VN2DEV/dfs-ev-demo`.
- Branch: `feature/dfsEV-52-evidence-schema`, taken from the relay WIP tip
  `1ef86ba` (the earlier synthetic-proof work was carried forward, not discarded).
- PR A (real-source schema and replay core) is complete in ten committed steps.
  No PR is open. The next action is the owner's `codex review --base main`.
- The approved design is [`predictive-real-source-schema.md`](predictive-real-source-schema.md)
  revision 2 and [`predictive-evidence-ddl.md`](predictive-evidence-ddl.md)
  revision 2. Section 14 of the DDL lists what each step built and every
  refinement.

| Step | Commit | What it added |
| --- | --- | --- |
| 1 | `bcf3d37` | Migration reset: synthetic 0003/0004 replaced by the new 0003 |
| 2 | `19da332` | Real-source envelope: profiles, rights, blobs, runs, artifacts, captures, 32 seeded teams, observations with entity/source keys |
| 3 | `8707d1b` | Snap and participation evidence kinds |
| 4 | `3acea3e` | Persisted reconciliation decisions; current access uses the database clock |
| 5 | `0a923ff` | Coverage-aware source-row absences (`absence-v1`) |
| 6 | `f0f37cb` | Completion decisions over exact marker heads |
| 7 | `7aa9ad5` | Participation decisions and bound outcome labels (eight binding checks) |
| 8 | `9da3e72` | Feature runs with sealed manifests and two digests |
| 9 | `6f1bc3f` | Identity bridges with strict same-source ambiguity checks |
| 10 | `2085bc1` | Owner-only scoped retention with audit and backup re-apply |

Validation at step 10 on Node 24.18.1: 831 jsdom + 442 Node tests; the complete
disposable PostgreSQL suite (74 Node checks + 42 Vitest tests, all **25**
mandatory predictive cases); typecheck, lint, CI gate, DB guards, and the
migration and readiness checks.

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
