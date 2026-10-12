# Creator corpus synthetic test matrix

Verification date: 2026-10-12. Every fixture uses opaque synthetic creators,
videos and transcript text. No real creator identity, API payload or transcript
is present in the repository or test output.

| Required behavior | Synthetic proof |
| --- | --- |
| First import, identical no-op, owner-tail append and complete API snapshot replacement | `tests/db/corpusImport.test.ts` — `corpus importer publishes one atomic snapshot, appends only owner tails and reruns as a no-op` |
| Changed, truncated or structurally invalid owner history is refused | `scripts/creator-corpus/importPlanner.test.ts` — `refuses changed, truncated and structurally invalid stored owner history` |
| Failed publication rolls back and concurrent import cannot take the advisory lock | `tests/db/corpusImport.test.ts` — `corpus importer fails on lock contention and rolls back a later publication error without partial rows` |
| Latest capture replacement and unavailable status remain separate from inclusion | `scripts/creator-corpus/readinessReport.test.ts` — `keeps inclusion, active capture state, API freshness and public clearance separate for every video and slot` |
| Equal-time decisions use later file order; a final clear removes the active override | `scripts/creator-corpus/readinessReport.test.ts` — `uses decision time and file position to resolve active decisions` |
| Stale API evidence is visible, then physically removed under the shared advisory lock as a complete creator snapshot without deleting owner history | `scripts/creator-corpus/readinessReport.test.ts` — `keeps inclusion, active capture state, API freshness and public clearance separate for every video and slot`; `tests/db/corpusImport.test.ts` — `corpus API expiry removes complete stale snapshots while preserving permanent owner history` |
| Transcript text, YouTube text and unbounded payload types cannot enter the projection | `tests/db/corpus.test.ts` — `corpus schema stores only bounded metadata and keeps owner, API and derived statuses separate`; `scripts/creator-corpus/importPlanner.test.ts` — `plans a first append without retaining private transcript or YouTube text and reports unapplied decisions` |
| Every preregistered slot remains visible when API evidence is empty; pick metrics remain unavailable rather than zero | `scripts/creator-corpus/readinessReport.test.ts` — `uses the private registered creator set to show every empty slot and keeps pick metrics unavailable rather than zero` |
| The real report uses a verified private gate, one read-only database snapshot and leaves every table unchanged | `tests/db/corpusImport.test.ts` — `corpus readiness reads one consistent local projection and keeps coverage dimensions separate` |
| Import target checks happen before private corpus sources are opened | `tests/db/corpusImport.test.ts` — `corpus importer verifies the connected local role before loading any private source`; `scripts/creator-corpus/cli.test.ts` — `rejects hosted and ambient database configuration before opening private corpus files` |

The mandatory database report registers each PostgreSQL case independently in
`scripts/db-test-contract.mjs`; removing or skipping one fails the suite. Run
the complete matrix with `npm test` and `npm run test:db:local`.
