# Composite model and served-feature authorization (#231)

The owner approved the [measured roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/231#issuecomment-6592422691).
#231 supplies the independent context and authorization capability that #167's
local handler consumes. The current step implements metadata selection and its
narrow role; the composite Q1/Q2 extension follows in Step 2.

## Design basis

**Pattern.** Thin serving over producer-materialized point-in-time features, with
one composite authorize/use/recheck boundary. A model's provenance and the served
feature's own source lineage form one authorization scope. Training membership
does not govern which player-games can be served. Resolution releases metadata;
Q1 releases private history only after the combined authorization succeeds.

**Alternatives rejected.** Training-membership eligibility excludes new/unlabeled
games and lets target-label availability influence service eligibility. Nested
model/feature readers double rights checks. Caller-owned lineage can omit sources.
Model-pinned histories and newest-only selection violate point-in-time/last-valid
policy. Raw reconstruction/per-row verification repeats offline work. Locks or a
transaction across I/O would delay deletion and retain stale rights snapshots.

**Targets.** The complete path is context SQL → composite Q1 → descriptor GET →
computation → composite Q2 → serialization. Exactly **3 SQL statements, 2 combined
rights/status checks and 1 descriptor GET**, at every n=2–16. The model-only #166
path stays at **2 SQL**. Each successful probe asserts **2 × the independently
derived union profile count** effective-rights evaluations, with shared profiles
deduplicated. No fixture-specific profile count is a budget.

Full-path **p95 ≤210 ms**, at least **30% headroom under 300 ms**, on the 16 retained
nflverse wire inputs (2021–2025), natural 2,504-player-game retrospective cohort,
content SHA-256 `a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d`.
CI enforces work counts; repeated wall-clock qualification is opt-in.

**Requirement reasons.**

| Requirement | Risk prevented |
| --- | --- |
| Exact player/game and supported version/history-policy/mode pins; explicit runId at authorization. | Confusing same-game QBs, mutable model selection or silently changing policy. |
| Real computed/checkpoint clocks and microsecond knownAsOf selection. | Look-ahead and an incorrect choice at revision boundaries. |
| Metadata only before Q1; no label/training-member reads. | Unauthorized value disclosure and target-dependent availability. |
| Derive both lineages server-side at Q1/Q2; compare complete references and own scope across awaits. | Omitted sources, forged older selections, mutation or narrowing the final check. |
| Last valid value with flags; deletion/current rights refusal still refuses. | Blanketing useful permitted values or reviving withdrawn evidence through fallback. |
| Three SQL/two checks/one GET; zero reader DML/per-row verification/ordinary hashes/extra I/O. | Hidden nesting, per-example work or repeated producer verification. |
| Zero explicit reader coordination locks and no transaction across I/O/calculation. | Blocking deletion and delivering under an old rights snapshot. |
| Real EXECUTE-only LOGIN with non-inheriting/non-settable broad membership. | Direct table, writer or SET ROLE bypasses of the boundary. |
| Proposal SQL only and public workspace APIs. | Premature schema rollout or private-package coupling. |
| Relative receipts, full compressed records and hash-before-recompute TypeScript audit. | Lost or unverifiable evidence after checkout/cache removal. |
| Summary/approval before each commit; fresh push consent; split before exceeding five hours. | Unreviewed scope or remote publication. |

**Assumptions.** Trusted producer/database owner and private callback/ObjectStore;
research use only, dedicated idle READ COMMITTED connection, producer-qualified
histories bounded to 2–16. Current rights/deletion overrides historical selection.
The accepted post-Q2 statement-snapshot delivery gap remains. No hosted latency,
serving clearance, calibration or cold-cache claim. The real strict historical
cohort is zero; no clocks were backdated. Prospective/correction/race controls are
synthetic and labeled separately. #229 cleanup ownership remains unchanged.

## Prototype proof and final evidence

The approved disposable prototype passed all six 100-request candidate cohorts,
interleaved with the unchanged #163 reference. Baseline-first p95 was 7.930 ms.
Cold-connection candidate p95s were 24.970, 25.147 and 25.341 ms; warm p95s were
3.174, 4.128 and 3.714 ms. Worst headroom was 91.55%; all 600 candidate requests
passed, along with all-n client budgets and 15 behavioral/server-work probe groups.
Matched n=2/16 lineage/revision controls had identical relational work. A genuine
restricted LOGIN refused direct data/writer access and broader SET ROLE. The
paused-reader deletion probe passed without a reader transaction or coordination lock.

This is **local-fixture-only prototype proof**, not qualification of the final
reviewed sources. PostgreSQL 18.6 used a 512 MiB local data tmpfs/128 MiB shared
memory; Node 24.18.1; OS/DB/file caches unflushed. Final receipts separate cold
connection setup duration/share from the warm path. Final audited records belong
under `docs/evidence/feature-store-231/`, extending the existing TypeScript evidence
tool. No Python audit is added. #167 needs its final handler benchmark after #231
merges; another spike is needed only if the design changes.

## Metadata selection capability (Step 1)

Apply `@dfs-ev/db/assets/231_composite_authorization.sql` after the #166 proposal
on a registered local fixture. No frozen migration is added. Consumers use
`resolveModelContext` from `@dfs-ev/pipeline/feature-store/model-context`.

The resolver accepts playerId, gameId, featureVersion, historyPolicy, evidenceMode
and knownAsOf. It selects successful producer revisions whose computed_at and
checkpoint are visible at knownAsOf, ordered by checkpoint, computed_at and
feature_id descending. It selects the latest usable bounded history, retaining
the last valid selection when the newest visible result is unavailable. It never
reads history, labels or training membership, and makes no rights decision.

The result separates `feature` identity/clocks/version/sample metadata and complete
sorted `snapshotIds` from `selection` at knownAsOf and current `freshness`.
`selection.lastValid` identifies an unavailable head within the request's knowledge
boundary; `freshness.superseded/stale` and reasons describe the current successful
producer head without importing its values. All are private metadata, not a delivery
authorization. Step 2 independently validates/rederives the complete selection and
lineage at Q1/Q2, refusing withdrawal instead of selecting another value.

| SQLSTATE | Typed ModelContextError code |
| --- | --- |
| P2311 | model-context-request-refused |
| P2312 | model-context-unsupported-version |
| P2313 | model-context-future-knowledge |
| P2314 | model-context-insufficient-history |
| P2315 | model-context-unavailable |
| P2316 | model-context-lineage-refused |

P1667 keeps #166's typed session refusal for snapshot isolation. Unrelated SQL,
permission and connection errors remain intact. The TypeScript API owns scalar
request pins before awaiting SQL and sends neither caller history nor target data.

The `fs231_model_reader` capability has schema USAGE and resolver EXECUTE only.
It is a NOLOGIN role with non-inheriting/non-settable fs138_reader membership for
the existing role guard. A provisioned local restricted LOGIN receives:

```sql
GRANT fs231_model_reader TO restricted_login WITH INHERIT TRUE, SET FALSE;
```

No PUBLIC EXECUTE, direct feature/label/normalized/raw/registry reads or writer
grants are added. Step 2 grants only the composite capability to this same role;
the unscoped model-only API remains inaccessible to it. The existing #166 reader
and pipeline writer retain compatibility. These are proposal provisioning notes,
not hosted commands.

## Remaining steps and scope

Step 2 adds composite union Q1/Q2 to the shared reader, immutable scope and the
per-probe `2 × P` rights-call/work/lock/race tests. Step 3 qualifies final sources,
durable receipts/bundle and the TypeScript audit. The owner reviews each step
before commit. The approved estimate is 4–5 hours including prototype work; split
before more work if discovery exceeds five.

No final prediction handler, Next.js route, product UI, hosted service/access,
Production command, frozen migration, calibration, #168 capacity or #229 cleanup.
