# Creator corpus synthetic test matrix

Verification date: 2026-10-12. Every fixture uses opaque synthetic creators,
videos and transcript text. No real creator identity, API payload or transcript
is present in the repository or test output.

| Required behavior | Synthetic proof |
| --- | --- |
| First import, identical no-op, owner-tail append and complete API snapshot replacement | `services/pipeline/tests/creator/corpusImport.test.ts` — `corpus importer publishes one atomic snapshot, appends only owner tails and reruns as a no-op` |
| Expired discovery is refused even when a new owner-history tail would otherwise append | `services/pipeline/scripts/creator-corpus/importPlanner.test.ts` — `refuses stale discovery even when new owner history would otherwise append` |
| Changed, truncated or structurally invalid owner history is refused | `services/pipeline/scripts/creator-corpus/importPlanner.test.ts` — `refuses changed, truncated and structurally invalid stored owner history` |
| Failed publication rolls back and concurrent import cannot take the advisory lock | `services/pipeline/tests/creator/corpusImport.test.ts` — `corpus importer fails on lock contention and rolls back a later publication error without partial rows` |
| Latest capture replacement and unavailable status remain separate from inclusion | `services/pipeline/scripts/creator-corpus/readinessReport.test.ts` — `keeps inclusion, active capture state, API freshness and public clearance separate for every video and slot` |
| Equal-time decisions use later file order; a final clear removes the active override | `services/pipeline/scripts/creator-corpus/readinessReport.test.ts` — `uses decision time and file position to resolve active decisions` |
| Readiness refuses expired API evidence; expiry then removes the complete creator snapshot under the shared advisory lock without deleting owner history | `services/pipeline/tests/creator/corpusImport.test.ts` — `corpus API expiry removes complete stale snapshots while preserving permanent owner history` |
| Transcript text, YouTube text and unbounded payload types cannot enter the projection | `packages/db/tooling/tests/corpus.test.ts` — `corpus schema stores only bounded metadata and keeps owner, API and derived statuses separate`; `services/pipeline/scripts/creator-corpus/importPlanner.test.ts` — `plans a first append without retaining private transcript or YouTube text and reports unapplied decisions` |
| Every preregistered slot remains visible when API evidence is empty; pick metrics remain unavailable rather than zero | `services/pipeline/scripts/creator-corpus/readinessReport.test.ts` — `uses the private registered creator set to show every empty slot and keeps pick metrics unavailable rather than zero` |
| The real report uses a verified private gate, one read-only database snapshot and leaves every table unchanged | `services/pipeline/tests/creator/corpusImport.test.ts` — `corpus readiness reads one consistent local projection and keeps coverage dimensions separate` |
| Import target checks happen before private corpus sources are opened | `services/pipeline/tests/creator/corpusImport.test.ts` — `corpus importer verifies the connected local role before loading any private source`; `services/pipeline/scripts/creator-corpus/cli.test.ts` — `rejects hosted and ambient database configuration before opening private corpus files` |

The mandatory database report registers each PostgreSQL case independently in
`scripts/db/db-test-contract.mjs`; removing or skipping one fails the suite. Run
the complete matrix with `npm test` and `npm run test:db:local`.
