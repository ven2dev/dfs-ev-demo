# Composite model and served-feature authorization (#231)

The owner approved the [measured roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/231#issuecomment-6592422691).
#231 supplies the independent context and authorization capability that #167's
local handler consumes. Steps 1–2 implement metadata selection, its narrow role
and the composite Q1/Q2 boundary. Step 3 qualifies the reviewed composition and
retains auditable full evidence with the code.

## Design basis

**Pattern.** Thin serving over producer-materialized point-in-time features, with
one composite authorize/use/recheck boundary. A model's provenance and the served
feature's own source lineage form one authorization scope. Training membership
does not govern which player-games can be served. Resolution releases metadata;
Q1 releases private history only after the combined authorization succeeds.
The materialized-feature lookup follows the serving pattern described by
[Databricks](https://docs.databricks.com/aws/en/machine-learning/feature-store/online-workflows);
availability-time filtering follows the point-in-time concern documented by
[Feast](https://docs.feast.dev/getting-started/concepts/point-in-time-joins).
The composite two-check authorization is this project's rights/deletion contract,
not a requirement prescribed by those feature-store systems.

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
| Real computed/checkpoint/job-finished clocks and microsecond knownAsOf selection. | Treating an inserted but unusable feature as known, look-ahead and incorrect revision boundaries. |
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

**Resolver metadata disclosure.** The resolver deliberately releases sample size,
cutoff, identity/version/clock metadata, flags and complete source snapshot IDs
without a rights evaluation. EXECUTE is limited to the trusted composite research
caller and existing research reader/pipeline-writer roles; PUBLIC has no grant.
This is acceptable within that operator trust boundary: metadata supports private
selection and inspection, while history, artifact bytes and predictions stay
behind Q1/Q2. It is not a public or rights-filtered metadata endpoint. A future
product boundary must keep this metadata private, preventing the resolver from
becoming an unauthorized delivery channel. Real LOGIN probes cover the grants
and table/role-switch refusals; no claim is made that resolver metadata is hidden
from a trusted operator whose current source rights have been revoked.

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
and knownAsOf. It selects successful producer revisions whose computed_at,
checkpoint and producer job finished_at are visible at knownAsOf, ordered by checkpoint, computed_at and
feature_id descending. It selects the latest usable bounded history, retaining
the last valid selection when the newest visible result is unavailable. It never
reads history, labels or training membership, and makes no rights decision.
Both selected and visible-head queries require `job.finished_at <= knownAsOf`;
the current freshness head requires `job.finished_at <= observedAt`. A request
between insertion and completion therefore keeps its previous valid selection
even after the newer job finishes. A microsecond completion-boundary probe and
a real running-to-finished probe establish this contract without backdating.

**#138 follow-up:** its older as-of query also needs review of job-completion
visibility. This PR changes only #231's resolver; #138 SQL stays unchanged.

The result separates `feature` identity/clocks/version/sample metadata and complete
sorted `snapshotIds` from `selection` at knownAsOf and current `freshness`.
`selection.lastValid` identifies an unavailable head within the request's knowledge
boundary; `freshness.superseded/stale` and reasons describe the current successful
producer head without importing its values. All are private metadata, not a delivery
authorization. The composite boundary independently validates/rederives the
complete selection and lineage at Q1/Q2, refusing withdrawal instead of selecting
another value.

| SQLSTATE | Typed ModelContextError code |
| --- | --- |
| P2311 | model-context-request-refused |
| P2312 | model-context-unsupported-version |
| P2313 | model-context-future-knowledge |
| P2314 | model-context-insufficient-history |
| P2315 | model-context-unavailable |
| P2316 | model-context-lineage-refused |
| P2317 | model-context-reference-refused (caller metadata/lineage or an existing older selection mismatches) |

P1667 keeps #166's typed session refusal for snapshot isolation. Unrelated SQL,
permission and connection errors remain intact. The TypeScript API owns scalar
request pins before awaiting SQL and sends neither caller history nor target data.

The `fs231_model_reader` capability has schema USAGE and resolver/composite EXECUTE only.
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

## Composite shared boundary (Step 2)

Consumers pass the resolver's `context` with `runId` and selected `slots` to
`withModelArtifacts` or `readModelArtifacts` from
`@dfs-ev/pipeline/feature-store/model-artifacts`. The handler composition is:

```ts
const context = await resolveModelContext(client, request);
const result = await withModelArtifacts(client, store,
  { runId, slots: ["descriptor"], context }, input => {
    // Trusted private calculation consumes input.history and descriptor bytes.
    // #167 owns descriptor-pin validation and the final prediction contract.
    return calculate(input);
  });
// Delivery uses result.value and the final result.context freshness flags.
```

Q1 and Q2 each execute `authorize_model_context_read`, which requires a context.
The private `authorize_model_scope` core also backs the existing model-only
`authorize_model_read` signature. Only its definer can execute the core directly;
the narrow LOGIN cannot omit context by calling it or the model-only wrapper.
Existing broad #166 reader/writer grants and model-only two-statement reads remain.

Both checks re-resolve the feature from the normalized request and compare its
entire immutable feature metadata and complete sorted snapshot reference.
Withdrawal, missing/pruned features or lost lineage at Q1/Q2 refuse with P1666
(`model-read-status-refused`), including when re-resolution could fall back to an
older valid feature. Existing feature references with forged metadata/lineage or
an older selection for a newer request keep P2317. An absent referenced identity
is treated as unavailable; this is a refusal, not proof of prior possession.
Standalone resolution retains its P2314/P2315/P2316 diagnostics. Q2 never
substitutes an older value. Each check independently derives the model's cited
dataset sources and the feature's own sources, then checks current status and one
deduplicated union of rights profiles. The requested artifact subset does not
narrow the model's source authorization. Shared-retained removal intent remains
compatible with delivery of an unaffected live run.

Only Q1 returns private materialized history, together with the database-owned
model/file pins. The trusted callback and selected GETs finish before Q2. The
TypeScript orchestrator owns a serialized context and copies run/slot pins before
the first await; caller or callback mutation cannot narrow Q2. No reader BEGIN,
coordination lock, history expansion/verification or byte hash is introduced.
The returned `context` is Q2's refreshed metadata/flags for the original value;
the callback's input metadata describes Q1. Missing bytes, calculation failures
and a refused/lost Q2 release no result.

### Deterministic Step 2 proof

`composite-authorization.check.mts` adds 15 PostgreSQL probe groups, including
independent unlabeled features outside training datasets, label add/change/remove
independence, distinct QBs in one game, exact-reference/pruning/mutation refusals,
model/feature revocation and deletion at both boundaries, source state, real narrow
LOGIN refusals, model-only 0/2,504-row compatibility and shared-retained files.

At each n=2–16, both overlapping and independent lineage controls assert exactly
3 client SQL statements, 2 combined checks, 1 descriptor GET and zero byte hashes.
Each successful probe independently derives P from database-owned lineage and
asserts exactly 2P effective-rights calls, twice for every distinct profile. Early
refusals assert their exact completed batches (0, 1 or 2) × P. A measurement-only
NOTICE wrapper counts actual rights calls even when a SQL statement rolls back.

A separate transaction-local server observer compares complete relational
counters for matched n=2/16 graphs at Q1 and Q2. Both are identical, with zero
reader DML, label/member/normalized reads or forbidden locks. Scan/write negative
controls prove that the observer sees hidden database work. Pauses during GET and
calculation show an idle backend with no transaction or locks while another
writer commits deletion. Measurement wrappers are confined to disposable test
databases and removed before speed qualification.

Validation also passes 69 context/#163/#166 regression tests, 7 focused unit tests,
23 package-boundary/layout checks, focused TypeScript and lint. The synthetic
controls establish behavior and work budgets; they do not establish real historical
availability or qualify final-source speed. The existing CI feature-store glob
discovers the PostgreSQL suite; wall-clock assertions remain outside CI.

## Final qualification (Step 3)

The final-source benchmark uses the actual resolver and composite reader, a real
descriptor GET/parse, shared domain support/probability/pricing math, Q2 and full
JSON serialization. It preselects one real feature at each n=2–16 from metadata
without labels or training membership. The unchanged #163 reference is measured
first (45 requests, **8.153 ms p95**), then interleaved ABBA, 50 requests per
position. Every cohort has 100 candidate and 100 reference requests. All **600
candidate requests and six cohorts pass**; no timing/work miss was discarded.

| Cohort | Reference p95 ms | Full candidate p95 ms | Setup p95 ms | Warm-path p95 ms | Aggregate setup share | Headroom |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold connection 1 | 24.451 | 25.791 | 6.453 | 19.942 | 24.10% | 91.40% |
| Cold connection 2 | 20.503 | 25.686 | 6.537 | 19.195 | 23.67% | 91.44% |
| Cold connection 3 | 20.680 | 30.212 | 6.440 | 23.821 | 23.69% | 89.93% |
| Warm 1 | 7.698 | 4.502 | 0.000 | 4.502 | 0.00% | 98.50% |
| Warm 2 | 7.182 | 4.125 | 0.000 | 4.125 | 0.00% | 98.62% |
| Warm 3 | 7.123 | 5.249 | 0.000 | 5.249 | 0.00% | 98.25% |

The gate uses each request's complete duration, including setup on cold samples;
stage percentiles are descriptive and are never added. Setup share is the sum of
setup time divided by the sum of complete candidate time in that cohort. Warm-path
time is each complete time minus its own setup. Connection close is outside timing.
Cold means a new connection in an already running Node process; caches remain
unflushed. The reference performs its unchanged per-row qualification and checks
feature lineage; the candidate checks model plus feature lineage and trusts the
producer. Their ratio is informational. **Local-fixture-only qualification** does
not establish hosted latency, cold-cache/fresh-process startup or #167 handler speed.

The fixture again reproduces 16 wire inputs, the exact 2,504-row retrospective
content hash and zero strict historical rows with real clocks. At every n, actual
database calls match **2 × the independently derived union profile count** (the
real fixture happens to have 16 union profiles). Matched synthetic n=2/16 graphs
prove equal relational work separately; the actual real-request counters and all
full samples remain in the bundle. The 16-profile observation is not a CI budget.

See [final evidence and audit instructions](evidence/feature-store-231/README.md).
Three compact receipts reference relative members in a deterministic committed
bundle. The existing TypeScript audit checks uncompressed SHA-256 and size before
recomputing all six full-path percentiles, work counts, setup shares and compact
projections. CI checks references/hashes without timing assertions. A clean copy
needs Node 24 and tar only to audit; no database, dependencies or original cache.

## Acceptance mapping

| Criterion | Implementation and proof |
| --- | --- |
| Independent feature scope, no target influence | Metadata resolver and composite source union; outside-training unlabeled probe, label add/change/remove invariance, same-game QBs distinct; zero label/member reads. |
| Point-in-time and last-valid policy | Exact pins, successful producer clocks and microseconds; Step 1 boundary/last-valid probes; Step 2 older-reference/pruning/race refusals and final freshness flags. |
| Shared boundary | One private SQL core and TypeScript orchestrator; all-n 3 SQL/2 combined checks/1 GET; model-only 2 SQL. |
| Both lineages/races | Independently derived 2P rights budget per successful probe; overlap and independent profiles; model/feature withdrawal at either boundary; no output on refusal. |
| Narrow authority | Real LOGIN, EXECUTE-only resolver/composite capability, private-core/unscoped/table/writer/SET ROLE refusals. |
| Hidden work and locks | Equal matched relational counters, zero reader DML/per-example verification, scan/write negative controls; paused reader has no transaction/locks and deletion commits. |
| Fixed speed | Six complete real-fixture cohorts at ≤210 ms p95, minimum 89.93% headroom under 300 ms; cold setup reported separately. |
| Package/proposal/evidence hygiene | Public workspace APIs, proposal SQL only, compact receipts/full deterministic bundle, hash-first TypeScript audit and database-free CI membership check. |
| Owner workflow | Approved roadmap comment, fresh-main feature branch, per-step review before commit, no trailers, fresh push consent and five-hour split boundary. |

The owner reviews each step before commit. The approved estimate remains 4–5
hours including prototype work. #167 consumes this boundary and needs its final
handler benchmark after #231 merges; another spike is required only if the design
changes.

No final prediction handler, Next.js route, product UI, hosted service/access,
Production command, frozen migration, calibration, #168 capacity or #229 cleanup.

## Carried requirements for #167

The served feature's evidence mode must be one of the run's dataset modes;
the handler's descriptor validation refuses otherwise, preventing a retrospective
feature from being served under a strict-only model or an unsupported mode pin.
This checks mode compatibility, not membership of the feature in training rows.
Keep the explicit runId/version/policy pins and the single composite boundary.
#167 requires its final handler benchmark after #231 merges, not another spike
unless its design changes. The #138 as-of completion-time finding above remains
a separate follow-up and does not expand this PR.
