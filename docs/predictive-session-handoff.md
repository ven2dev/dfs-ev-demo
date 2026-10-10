# #52 session handoff

Updated 2026-10-09. The owner is stopping this session because credits are low.
Resume from this state; do not restart the completed proof or repeat source
downloads merely to recover context.

## Checkout and completed work

- Workspace: `/Users/vernonneilly/Documents/VN2DEV/dfs-ev-demo-relay`.
- Branch: `feature/dfsEV-52-predictive-cutoff-replay`.
- Latest implementation commit: **`e963bba`**, pushed to origin. The working tree
  was clean before this documentation handoff.
- No PR has been opened for this work. Delivery 2 and delivery 3 remain WIP.
- Delivery 1: synthetic QB passing-yards cutoff replay is complete. All six
  original review findings and the former-team membership-gap finding are fixed.
- Delivery 2: private immutable artifacts, atomic local PostgreSQL publication,
  scoped read-only replay, quarantine, corrections and archive restoration are
  implemented and tested. The schema still accepts only synthetic proof data.
- Delivery 3: bounded public nflverse capture and offline qualification are
  implemented. Six feeds were fully captured; depth has only a 4 KB header
  probe. No real features, labels or SQL observations were published.

Key commits: `6cf71c1` former-team gaps; `882e5fd` persistence;
`52d853b` strengthened persistence assertions; `5e149a2` source prototype;
`e963bba` Rams identity fix and merge hold.

## Owner decisions and boundaries

1. **Confirmed absence keeps its chronological window slot.** Allow usable
   observed history with an absence quality flag; absence contributes no numeric
   statistic or denominator. Unknown participation still withholds. This was
   explicitly approved and does not need reconfirmation.
2. **Option B: hold delivery 2 off main until the real-source schema is designed.**
   The current combined branch is not a merge-ready delivery-1/2 PR. Keep source
   qualification WIP out of a delivery-1/2 PR. Do not open or merge a PR merely
   because local checks pass.
3. Registered migration SQL/checksums remain immutable. V3's Rams constraint
   accepted `LAR`, while the app accepts `LA`. Additive v4 repairs the constraint;
   v1/v2/v3 SQL and catalog contracts were preserved. This WIP repair is not
   approval of the final real-source product schema.
4. App readiness minimum remains **2**; this branch's maximum-known is **4**.
   Production migrations/activation remain separately gated by #95. Do not run
   Production `up`, activate hosted jobs or inspect application credentials.
5. No API key is needed for the current public-source prototype. No paid access,
   conditional PFR/FTN/official automated acquisition or public-data display has
   been authorized by this work. Do not send issue comments or other messages
   without explicit instructions.
6. The owner waived incremental review and authorized iteration. Routine fixes
   and tests can proceed; the recorded schema/rights/activation gates still apply.

## Latest fix and validation

The Rams regression failed against v3's `predictive_teams_id_check` before the
fix. After v4, the mandatory DB cases check all 32 app team IDs against the SQL
constraint, publish a Rams dataset and replay hand-calculated last-4 totals of
100 attempts / 700 yards. Valid populated v3 data and exact historical ledger
rows survive upgrading. A legacy SQL-created `LAR` row refuses upgrading and
rolls back the entire DDL/ledger transaction, preserving the v3 catalog and data.
No immutable identity is silently rewritten.

Latest checks passed on Node **24.18.1**:

- 831 jsdom + 374 Node tests, including 182 predictive/storage/source tests.
- Complete disposable PostgreSQL suite: 74 mandatory Node checks + 31 Vitest
  tests, including all **14** mandatory predictive cases.
- Typecheck, lint, production build, generated migration/catalog/readiness
  checks, whitespace and local Markdown links.
- Firestore rules, CI gate, DB guards and zero-vulnerability production audit
  passed during the preceding prototype iteration. These were not rerun for the
  Rams-only schema fix because their inputs did not change.

Readiness-ahead tests now append beyond the generated tip, and the artifact
drift test asserts its modified input differs from the original. Do not revert
these to hard-coded version 4 fixtures.

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

Retained private evidence (temporary storage is not a durable backup):

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

## Next session: real-source schema design

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
