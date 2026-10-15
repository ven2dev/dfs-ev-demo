# #118 foundation review fixes

The fix branch is `fix/dfsEV-118-foundation-review`, starting at
`938fa00ccac61fed9222e4fedb4bec96547b1941`. The independent review covered
#118 at `9cf2a8f`; the intervening commit changed evidence and documentation,
not the affected runtime or SQL. This document tracks fixes, not approval.

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
| 1. Consumer deletion blocked by sealed datasets | Derive dataset cleanup from actual consumer deletion, preserving invalidation and audits; reproduce mixed-profile label corrections | Pending |
| 2. Reader/retention deadlock | Acquire the shared retention advisory lock before table locks; test concurrent ordering | Pending |
| 3. Pure label selection time backstop | Withhold later labels even when a supplied selection bypasses ordinary head filtering; retain inclusive as-of behavior | Implemented; focused checks passed |
| 4. Readiness access callback replacement | Preserve earlier compressed-file access checks across all assigned datasets | Implemented; restricted-login multi-shard and affected scheduled-revocation cases passed |
| 5. Full-table closure scans | Traverse only selected dependency addresses through indexes; preserve exact closure and deletion behavior | Pending |
| 6. Unindexed kickoff lookup | Provide indexed ordinary/source schedule lookups and inspect natural query plans | Pending |
| 7. String-patched functions and nested guards | Publish complete effective function bodies in forward DDL; centralize the guard relation list | Pending |
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
