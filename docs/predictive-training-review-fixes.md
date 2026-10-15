# #118 foundation review fixes

The fix branch is `fix/dfsEV-118-foundation-review`, starting at
`938fa00ccac61fed9222e4fedb4bec96547b1941`. The independent review covered
#118 at `9cf2a8f`; the intervening commit changed evidence and documentation,
not the affected runtime or SQL. This document tracks fixes, not approval.

The independent read-only re-review of `938fa00..93399ec` accepted the
application fixes, the three draft SQL repairs and the regression reasoning.
It ran no tests or benchmarks and required a report correction: all completed
preparation calls in the retained draft run were slower than the original
baseline, and 16-row dataset preparation lost completion. The
[capacity report](predictive-training-capacity.md) now discloses that comparison.
Correctness acceptance does not approve performance or promote the drafts.

The owner accepted the corrected reporting at `0724027` and redirected the next
iteration to the dominant run-read, aggregation and repeated access work. The
[current plan](predictive-training-capacity-plan.md) supersedes closure-first
optimization: keep the original set-based closure in the intended reduced
0023 scope, profile nested statements first, and require repeated capacity with
30% deadline headroom (completion within 70%). The unchanged proposal file remains retained experimental
evidence until that reduction is prepared. The pg warning is now reproduced
without a benchmark proxy and traced to parallel before-file rights checks.

## Shared foundation scope exception

The owner approved a deliberate exception to one branch per issue: land the
shared #106/#118 foundation only after the review fixes, then resume the two
deliverables on separate branches. The foundation PR must use **Refs #106,
#118**, not closing references. Neither issue is complete. The #106 portion
still needs independent review; the #118 review does not approve it.

Generated catalog contracts, the generated schema reference and training
capacity evidence stay committed and CI-verified. GitHub collapses their diffs
using `.gitattributes`; this does not reduce review responsibility for their
generators or effective database behavior.

## Migration coordination

- Frozen 0001–0020 must remain byte-for-byte unchanged.
- #106 reserves **0021 only** for its context recorder. Any context tables used
  by validation must enter the read guard and memo dependency set in forward DDL.
- The owner reserved **0022–0024 for #118** review fixes. Finalize them only after
  integrating #106's frozen 0021 checkpoint and validating the combined prefix.
- Migration/catalog checks use a fresh administrative connection after training
  reads. Interrupted read connections must be replaced.

## Required fixes and evidence

| Finding | Required behavior and regression | Status |
| --- | --- | --- |
| 1. Consumer deletion blocked by sealed datasets | Derive dataset cleanup from actual consumer deletion, preserving invalidation and audits; reproduce mixed-profile label corrections | Draft 0022 implemented; focused regression passed |
| 2. Reader/retention deadlock | Acquire the shared retention advisory lock before table locks; test concurrent ordering | Draft 0022 implemented; concurrent-reader/writer regression passed |
| 3. Pure label selection time backstop | Withhold later labels even when a supplied selection bypasses ordinary head filtering; retain inclusive as-of behavior | Implemented; focused checks passed |
| 4. Readiness access callback replacement | Preserve earlier compressed-file access checks across all assigned datasets | Implemented; restricted-login multi-shard and affected scheduled-revocation cases passed |
| 5. Full-table closure scans | Preserve exact closure; measure inventory growth before replacing set-based traversal | Per-node draft has parity but regresses; withdrawn from planned promotion; kickoff indexes retained in intended reduced scope |
| 6. Unindexed kickoff lookup | Provide indexed ordinary/source schedule lookups and inspect natural query plans | Draft 0023 implemented; natural plans use both new indexes at 4,096 unrelated schedule rows |
| 7. String-patched functions and nested guards | Publish complete effective function bodies in forward DDL; centralize the guard relation list | Drafts 0022/0024 implemented; effective policy, ACL, rollback and audit parity passed |
| 8. Direct SQL temporal rules | Bypass TypeScript validation and test all three fit-clock refusals independently | Passed; includes both training label/event fit boundaries |
| 9. Memo rights-epoch coverage | Directly test witness/plan caches across scheduled rights changes | Passed for CSV dispatch, gzip plan and witness caches |
| Memo dependency coverage | Inspect the installed cached kernels and transitive helper bodies for evidence-table dependencies | Passed for the frozen prefix20 kernels and 36-table list |

## First fix checkpoint

No ordered migration or catalog artifact changes in this increment. The planned
SQL grouping is 0022 for retention/lock liveness, 0023 for indexed closure/kickoff
work, and 0024 for remaining readable effective definitions and dependency
consistency. This grouping can be refined within the allocated range; none is
frozen until integrated with #106's 0021 and validated together.

Focused validation passed **54 training Node tests**, **seven distinct PostgreSQL
cases**, six DB-report contract checks, TypeScript, affected-file ESLint and
whitespace checks. The PostgreSQL cases include the direct SQL forgery/time-rule
table, the new restricted-login multi-shard callback regression, the
migration/memo safety case extended with direct epoch and transitive dependency
coverage, and four affected scheduled-rights regressions. They do not constitute the aggregate
database gate. The disposable PostgreSQL 18 service uses only throwaway databases.

Removing the label-time selection guard makes the new Node case expose the
future value and fail. Removing callback chaining makes the multi-shard case
observe zero earlier-capture rechecks after second-shard authorization and fail.
These negative controls reproduce the old behavior; the fixes were restored.
The epoch probes explicitly warm each cache before a scheduled rights boundary,
then compare its answer/refusal with the uncached kernel at that exact boundary.
They use explicit audit clocks rather than sleeps. Dependency discovery follows
installed effective function bodies, over-approximating references against real
public relations and transitive helper identifiers; it does not claim to analyze
arbitrary dynamically assembled SQL.

Local logs: `/private/tmp/dfs118-review-focused-db.log`,
`/private/tmp/dfs118-label-regression-red.log`, and
`/private/tmp/dfs118-access-regression-red.log`,
`/private/tmp/dfs118-access-regression-green.log`, and
`/private/tmp/dfs118-label-regression-green.log`. GitHub issues and the eventual PR
remain the durable review record; local logs are working evidence only.

## Forward SQL preparation checkpoint

#106 reported pushed checkpoint `680a3d7`, but its context recorder is still a
prototype and the ordered chain ends at 0020. There is no frozen 0021 to integrate
yet. The three reserved #118 drafts live in [db/proposals](../db/proposals/README.md),
are exercised only in owned disposable databases, and are **not deployable
migrations or a frozen 0022–0024 checkpoint**. All ordered SQL/catalog artifacts
through 0020 remain unchanged.

Draft 0022 removes datasets referencing the consumer actually being deleted,
including an older label reached by a later provider's correction. Its regression
first reproduces the old `23503` failure, then verifies deletion through a
retention-only login, dataset/pin cleanup, supplemental audit and invalidation.
The separate lock regression proves that a reader waiting behind exclusive
retention holds no table SHARE locks, concurrent readers succeed, and retention
proceeds when their guard is released.

Draft 0023 follows indexed dependency addresses instead of materializing every
evidence edge. Sealed CSV and gzip feature/label manifests keep exactly their
original closure, rights obligations, blob list and manifest digest; a later
label correction does not enter the historical closure. A separate plan-only
test uses 4,096 uncommitted unrelated schedule observations, rolls them back,
and observes natural index selection for both kickoff lookup predicates (three
shared buffer hits each). These rows are not published evidence, and tiny
lookup timings do not establish complete read capacity.

Draft 0024 contains full static definitions of the effective retention executor,
training retention hook and run recorder. It preserves their existing bodies
and execute-only ACLs. It also makes memo initialization use 0022's central
58-relation inventory / 36-relation dependency subset. The test checks DDL
rollback, repeatable replacement, effective policy and permissions, transitive
memo-table coverage, actual protected OIDs, write-lock cache refusal, unchanged
sealed manifests through a replay-only login, and exact pre/post deletion counts,
digests and dataset audit records through a retention-only login. The comparison
uses the same committed evidence after rolling back the original deletion; it
does not claim a full external backup restoration test.

All **five focused PostgreSQL draft cases** pass together (28.53 seconds), as do
the six report-contract cases. They are mandatory named cases so skipping or
removing one fails the aggregate report contract. Logs:
`/private/tmp/dfs118-review-drafts-db.log` and
`/private/tmp/dfs118-kickoff-draft.log`. TypeScript and affected ESLint pass.
Finalization must reconcile these definitions and inventories with 0021 before
generating the combined catalog.

The [completed broader matrix](evidence/predictive-training-capacity64-review-drafts-2026-10-14.json)
records draft hashes separately from the ordered prefix20 hashes. Its strict
capacity assertion **fails: three operations complete and six refuse**. No page
or final-label read completes in the 64-QB/eight-profile inventory. One-member
dataset preparation takes 15.12 s and 3,645 client statements; the indexed
closure probe takes 428 ms. Width16 preparation exceeds its 30-second ceiling,
and width64 run preparation exceeds its SQL statement limit. The focused SQL
fixes preserve behavior but do not resolve the wider validation/access cost.
Next performance work needs per-query profiling and reduced repeated validation
while preserving current rights/deletion checks, rather than raised deadlines.
See the [capacity report](predictive-training-capacity.md) for the complete
scope, warm-run limits and omitted operations. The aggregate correctness gate
has not been rerun or claimed green.

## Capacity report correction and paired comparison

The [interleaved evidence](evidence/predictive-training-capacity64-interleaved-review-drafts-2026-10-14.json)
compares the pinned `938fa00` runtime against `93399ec` plus unchanged proposals,
using one checked 64-QB seed and four isolated clones in baseline/draft/draft/
baseline order. It records source/benchmark/SQL hashes and per-query groups.
Two trials per version show nearly unchanged run preparation, about 7.1% slower
one-row dataset preparation, and two 16-row dataset deadline refusals per
version. Warm closure probes are about seven times slower with the draft,
with exact closure and protected-use parity at both widths. The old broad
34–39% slowdown is not reproduced, but the closure regression is repeatable.
That checkpoint proposed optimizing 0023. The revised plan now withdraws its
per-node closure rewrite and prioritizes nested run-read/aggregation profiling;
no proposal SQL changed in this reporting increment. See the [capacity report](predictive-training-capacity.md)
for ranges, attribution limits and reproduction.

The paired diagnostic completes in 805.8 seconds, including 574.2 seconds of
checked setup. Its 12 completed preparations and four refusals are not a green
capacity gate; it does not repeat numerical page/label reads. A separate one-QB
smoke comparison and the registered-snapshot isolation/refusal regression pass.
The latter is now a required named database case. Six report-contract cases,
typecheck, affected ESLint and frozen SQL/catalog equality checks pass. There is
no new application or SQL change, so the previous affected correctness results
remain relevant; no aggregate database gate was repeated. #106's frozen 0021
integration, dependency/table-list rechecks, successful capacity gates and final
aggregate validation remain outstanding.

## Merge gates

Fixes land before the shared foundation. The merge candidate requires affected
independent review, independent coverage of #106, a green aggregate
`test:db:local` and remote CI, and successful capacity gates at the agreed
workloads. Report actual successful operations and refusals separately: a
benchmark that expects deadline refusals is not a capacity pass. Do not raise
timeouts to conceal repeated validation work.

Use focused Node checks for pure edits and affected PostgreSQL cases for database
behavior. Run the aggregate database gate once at the final combined candidate;
repeat only when later affected changes require it. Keep benchmark ceilings
separate from demonstrated capacity. #54 Part B remains blocked by training-read
capacity and qualified real/population evidence from #106/#107; hosted operation
remains gated by #95.
