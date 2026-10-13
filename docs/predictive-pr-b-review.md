# PR B independent review and final-candidate record

Status: **conditional independent assessment received for `2f897e9`; affected-code
and migration 0011 re-review are pending. Implementation and merge are not approved.**
The owner supplied the assessment below on 2026-10-13 after three independent,
read-only reviews. Reviewer identities and a signed/linked approval were not
supplied. This records their findings, not approval by the implementation author.

## Scope and baseline

- Draft [PR #105](https://github.com/ven2dev/dfs-ev-demo/pull/105), branch
  `feature/dfsEV-52-real-source-ingestion`.
- Historical baseline and fetched remote main:
  `3daf1dc26f1bf737da57b094b0075446381eb92c`, including PR A and creator-corpus #90.
- Independently reviewed head: `2f897e9472c83bf895a7dd234c4e06545efc927d`.
- Updated review scope: migrations **0005–0011**, application consumers,
  recorders/readers, rights/roles, replay, finalization, retention and recovery.
- Capability: fixture-backed QB passing-yards features and final labels.
- Limitation: the retained **schema-9 real proof produced zero usable canonical
  heads, bundles or labels**. The schema-10 consumer proof and schema-11 review
  regressions are fixture-backed. No new real proof ran; #52 remains open.

## Written architecture disposition supplied by the owner

Reviewer verdict: **merge with conditions; no redesign needed for this QB-only
foundation**. The reviewers found database-function security, locking, SQL/application
agreement, source-use rights and source-label finalization sound at the reviewed
head. Their conditions and accepted boundaries are recorded here.

| Assessment | Disposition and follow-up |
| --- | --- |
| Rights | Source consumers check the requested use at recording, reading and replay, before bytes. Ordinary outcome-label rights are weaker: [#116](https://github.com/ven2dev/dfs-ev-demo/issues/116) must enforce them or retire the writer before hosted activation. |
| Cutoffs | At-or-before selection is correct, but later source deletions polluted historical replay, and ordinary receipts were caller-timed. Both receive fixes below and require renewed review. |
| Finalization | Source-label completion, participation, reconciliation, exact raw identity and selected post-window capture checks held up. This does not qualify a real completion/participation provider. |
| Retention | Existing role boundaries, blob recovery and dependent-label closure held up. Six historical full procedure copies are a maintenance cost: [#115](https://github.com/ven2dev/dfs-ev-demo/issues/115) introduces forward per-ledger helpers without rewriting history. |
| Market expansion | Passing yards is hard-coded and source labels lack a stat key. [#114](https://github.com/ven2dev/dfs-ev-demo/issues/114) blocks second-market work in #109; current QB-only records do not authorize expansion. |
| Association growth | Profile-wide binding associations can grow as consumers × binding history and make deletion broad. Keep the conservative closure; measure and review narrowing in [#111](https://github.com/ven2dev/dfs-ev-demo/issues/111) / [#117](https://github.com/ven2dev/dfs-ev-demo/issues/117). |
| #54 handoff | Use verified source-consumer APIs for CSV data; no automatic ordinary-table fallback. Fixture/scaffolding work may proceed, but real-data-dependent evaluation remains unqualified. |

The separate ledgers are the present compatibility strategy. The conditional
assessment does not approve permanent duplication of policy, a second market,
hosted operation or an ordinary-label rights bypass for source consumers.
Forward refactoring must preserve exact provenance and historical replay.

## Review fixes in the new candidate

1. `readSourcePassingYards` now filters source retention scopes by
   `capturedFrom <= request.cutoff`, including unbounded scopes, matching the
   ordinary reader. The regression records an unavailable feature, performs a
   later unrelated deletion that actually removes evidence, and reproduces both
   its earlier calculation and sealed replay unchanged. It failed before the fix.
2. Forward **0011** extends the existing capture trigger: new non-synthetic
   ordinary receipts use the database clock after the profile publication lock.
   `captured_at` and `available_at` remain source provenance; existing capture
   rows are not rewritten. Only non-CSV synthetic fixtures in the disposable
   harness retain caller times; the prior qualified-CSV clock rule stays intact.
   Restricted application and direct-SQL writers cannot backdate receipt times.
   Tests check old-cutoff refusal, exact-receipt visibility, retry stability,
   harness confinement and v10 upgrade/no-op behavior.

The implementation selected the database-clock option because trusted caller
timestamps do not enforce the no-look-ahead contract. The new migration and
changed retention query need independent re-review; the original assessment and
green checks for `2f897e9` do not approve these changes. Frozen SQL/catalog
prefixes **0001–0010 remain unchanged**. Readiness stays minimum 2 / maximum 11.

Minor direct-SQL ordering, diagnostic, expiry/narrow-retention coverage and
correction metadata findings are tracked in
[#117](https://github.com/ven2dev/dfs-ev-demo/issues/117). Database profile IDs
already have an ASCII constraint: reproduce the reported ordering discrepancy
before changing that contract. The existing broad deletion test already removes
complete label lineages; narrower lineage coverage remains useful.

## Final commit and validation

| Final-candidate field | Recorded result |
| --- | --- |
| PR/review links | [Draft PR #105](https://github.com/ven2dev/dfs-ev-demo/pull/105); owner-supplied assessment above |
| Full final head SHA | Record in PR #105 after committing/pushing this candidate |
| Integrated target main SHA | `3daf1dc26f1bf737da57b094b0075446381eb92c`; recheck before merge |
| Reviewer and full approved SHA | Pending affected-code/0011 review and attributable approval |
| Architecture disposition | Conditional assessment of `2f897e9`, recorded above |
| Review blocker resolution/reapproval | Both implemented; renewed independent review pending |
| Required local gate results | 873 jsdom + 637 Node; 75 Node DB checks + 136 DB tests (111 mandatory predictive, 8 corpus); all required local gates passed. See the schema-11 handoff checkpoint |
| Remote CI/check run links and head SHA | Record final pushed SHA and results in PR #105; earlier green CI is historical evidence only |

Required gates are types, lint, application tests, Firestore rules, CI-gate tests,
database guards, migration/readiness/catalog contracts, disposable PostgreSQL
integration, production build and production dependency audit. Remote App checks,
DB integration, aggregate CI, CodeQL and applicable branch checks must pass on
the final candidate. Record generated merge-ref and target SHAs where applicable.
Local production verification uses Webpack because the default Turbopack worker
port is restricted locally; remote App checks must pass the default build.

Do not merge until the [acceptance checklist](predictive-pr-b.md#revised-pr-b-acceptance-boundary-2026-10-13)
is satisfied. Review fixes invalidate approval of affected code. If main advances,
inspect migration numbering and validate the integrated state. No hosted schema
activation is included in this PR.
