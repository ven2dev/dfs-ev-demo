# #173 readiness evidence

`step-1-ledger.json` is an inventory and preliminary verdict, not a new database
or performance run. It binds the original criteria and owner amendments to
existing evidence at checkpoint `286f4d0`, with receipt SHA-256 and Git blob IDs.
It distinguishes measured identities, final merged PR heads and independently
confirmed review history. Unestablished reviewed SHAs remain gaps.

Read it with [the design and provisional verdict](../../feature-store-thin-slice-verdict.md).
The ledger's dataset and prediction capacity entries were blocked when step 1
was written. Both owner-approved step 3 reruns below now pass at the approved
checkpoint; the immutable ledger retains its earlier assessment. No lane, timing
or database check ran in step 1. Historical passes and failures retain their
original qualification scope.

The source comparisons hash committed bytes at the pinned checkpoint against
the named receipt's source map. A mismatch records byte drift; its explanation
separates runtime, comment-only and setup/environment changes. A matching source
map is not an independent re-execution of a benchmark. Likewise, a hash match of
a receipt is not independent proof of that receipt's behavioral assertions.

Add future receipts and bundles with new names; do not overwrite this ledger or
any predecessor issue's evidence. Detailed persisted artifacts use ObjectStore;
durable in-tree compressed mirrors keep the owner-approved audit policy. Keep
all failed attempts and any stopped run with its error and boundary metadata.

## Step 2: integrated assessment

[`step-2-assessment-20261109T075101Z.json`](step-2-assessment-20261109T075101Z.json)
summarizes source inspection and offline validation at `be53387`. The companion
[`step-2-records-20261109T075101Z.tar.gz`](step-2-records-20261109T075101Z.tar.gz)
contains 18 detailed records: full assessment/source identities, commands and
logs, archive/wrapper consistency checks, report artifact verification and the
disposable validation scripts. Each member and the bundle were persisted and
read back through local ObjectStore before the deterministic mirror was written.
The receipt records all hashes, sizes, ObjectStore keys and member names; a
reader can verify the mirror without access to that local storage root.

The receipt uses `fs173-offline-assessment-receipt-v1`; the ledger and this
assessment are inventory schemas, not the generic artifact-governance auditor's
receipt-projection schema. Verify the bundle hash/size and every member against
`storage.members`, then cross-check `assessment-full.json` with the compact
receipt. The full assessment includes SHA-256 and Git blob IDs for 23 reviewed
source files. Do not interpret a successful integrity check as independent
review or fresh DB execution.

Seven audits cover 319 historical records; 24 offline evidence checks and four
focused integration tests passed under Node 24.18.1. All 52 original #138
archive files match their index. #170/#244 wrappers, replay parity records and
#164 retained report hashes also verify. No lane, DB query or timing run was
performed. Dataset and prediction capacity remain blocked pending the approved
quiet-window reruns. Historical evidence and `step-1-ledger.json` are unchanged.

## Step 3: stopped fixture preparation

[`step-3-stopped-20261109T081107Z.json`](step-3-stopped-20261109T081107Z.json)
and its [deterministic mirror](step-3-stopped-records-20261109T081107Z.tar.gz)
retain the single actual qualification attempt at `43a3802`. Prediction fixture
preparation exceeded the standard tier's 128 MiB per-process temporary-file
limit. No measured samples ran; the dataset workload did not start. This receipt
uses `fs173-stopped-qualification-v1`, not a successful capacity format.

The bundle includes the original runner's full/compact records, all lifecycle
and qualification logs, Docker inspection, 64 matching source identities, the
unexecuted disposable dataset driver and its diff, and the orchestration scripts.
It also retains the separate sandbox-denied startup logs: no workload started
until Docker access was approved, with a new output directory. Every member and
the bundle were persisted and read back through local ObjectStore. Verify their
hashes/sizes against `storage.members` and `storage.bundle` as for step 2.

The owner-confirmed window ended after verified lane-3 teardown; no lane-3
containers or networks remained. Nothing was retried, and no settings, fixture
pins, targets or budgets changed. Both capacity claims remain blocked pending
an approved attempt. Historical evidence is unchanged.

The owner subsequently identified the stop as a tier-selection error, not a
performance result. It does not count toward qualification. Full-season fixture
preparation belongs on the large tier; #242's original `4edb698` measurement
predates #247's standard-tier temporary-file limit. Both matrices are approved
on lane-3 large tier (2 GiB, at least 608 MiB free at admission), pending a new
owner-confirmed quiet window. Prediction runs first. Each new matrix receipt
will record the tier, actual mount and observed PostgreSQL settings; original
runner records retain their bytes and any historical hardcoded metadata is
distinguished from those observations. The stopped receipt and bundle are
unchanged; no failed attempt is replaced or relabelled as a qualification.

## Step 3: completed prediction, outer-driver stop

[`step-3-prediction-20261109T084110Z.json`](step-3-prediction-20261109T084110Z.json)
and its [private archive reference](step-3-prediction-records-20261109T084110Z.reference.json) retain all
600 passing large-tier prediction samples at `43a3802`. The existing #242
auditor verifies the samples, recomputes every summary and checks the work,
process and request-coverage contracts. All 64 source identities match. The
worst full-path p95 is 123.465 ms; maximum sample 251.122 ms. Targets and budgets
are unchanged. `fs173-prediction-qualification-v1` wraps the original versioned
#242 records; verify its bundle and member hashes against `storage`.

The receipt includes observed PostgreSQL settings and the actual 2 GiB mount.
It explicitly distinguishes the original runner's hardcoded 512 MiB metadata
from that observed environment. All records and the bundle were persisted and
read back through ObjectStore. The bundle has 23 members, including the
unexecuted dataset adapter/diff and the outer-driver code and logs.

After successful prediction, the outer driver stopped on an output-selection
assertion: a stale pointer routed the output to the earlier private staging
directory, which now held two uniquely named qualification subdirectories.
No prediction sample was lost, retried or replaced. The stopped run's local
working folder, `codex-briefs/173-step3-20261109T080936Z/`, was partly
overwritten by the prediction run, including its lane logs. The unbundled
scratch folder is no longer an authoritative record of the stop. Its saved
bundle remains unchanged, SHA-256
`c49b179a1cd841a8010d9ff55f4050616a9f57bad23b786d1a1c980cdddcf3ba`, and
stays the authoritative record. The prediction bundle separately matches
`a9c6acac27d007d2fb5b15c8ea7744d9d99e07d2cc04a22a1b1779e273f919d1`.
The stopped receipt is unchanged; current staging logs are captured separately
in the new bundle.
The dataset matrix did not start; step 3 remains incomplete. Lane-3 teardown
was verified and ALT given the all-clear.

The owner accepted prediction as its independent qualification and approved a
dataset-only continuation. Prediction is not rerun. The disposable driver takes
an explicit absolute per-run output directory, refuses any pre-existing path
(including an empty directory), creates it exclusively before any command and
reads results only from its exact receipt path. After workload and teardown it
records every output file's relative name, size and SHA-256, before evidence
packaging. The inventory excludes itself to avoid a self-referential digest;
the durable receipt will identify that boundary and bind the inventory too.
Wait for a new owner-confirmed quiet window before starting large-tier lane-3.
The remaining matrix is three fresh-process cold plus three warm dataset builds,
with unchanged targets, budgets, deadlines and stop rules, actual PostgreSQL
settings captured, and a commit-approval stop afterwards.

## Step 3: dataset-only qualification

[`step-3-dataset-20261109T085139Z.json`](step-3-dataset-20261109T085139Z.json)
and its [private archive reference](step-3-dataset-records-20261109T085139Z.reference.json) retain six passing
dataset builds in the next owner-confirmed window, at `43a3802`. Prediction was
not rerun. Cold builds took 472.590 / 451.283 / 438.905 ms; warm builds took
360.926 / 344.167 / 342.243 ms. Each used 8 SQL / 2 batched rights/status checks,
produced 2,504 rows and matched the pinned natural content hash. Exact bytes
match across all six. All 48 source identities verify, including the #241 SQL.

`fs173-dataset-qualification-v1` records actual large-tier PostgreSQL settings,
the explicit new output directory, the complete 38-file list with hashes/sizes,
and the inventory's post-teardown/pre-packaging boundary. Its own manifest is
excluded from that list to avoid a self-referential hash; the receipt and bundle
bind the manifest separately. Six offline routing refusal/creation checks pass.
The wrapper scopes the legacy driver's old issue/step and rights/deletion-pass
label to this dataset matrix; historical deletion/rebuild probes were not rerun.

The 25-member bundle includes full/compact measurements, source verification,
the inventory, actual settings, lifecycle logs, original/adapted driver and diff,
the routing check record and packaging code. Each member and the bundle were
persisted/read back through ObjectStore. Full dataset and pinned raw bytes stay
in ObjectStore; they are listed by hash rather than duplicated in this mirror.
Verify `storage.bundle` and every `storage.members` entry as for earlier receipts.

Lane-3 teardown was verified at `2026-11-09T08:51:39Z`; ALT received the all-clear.
All attempts are kept, with no retry or replacement. Both capacity renewals now
pass; earlier stopped and prediction evidence remains unchanged. Step 3 awaits
commit approval. The final integrated go/no-go remains step 4.

## Main advanced after the original qualification

After the matrices finished, main advanced to `d661b02` through
[#258 / PR #259](https://github.com/ven2dev/dfs-ev-demo/pull/259), removing the
host/database cross-clock constraint. This is not the separate test-timeout fix.
Those receipts retain checkpoint `286f4d0`, measured at `43a3802`; their source
identities are unchanged. Only `packages/db/proposals/138_feature_store.sql`
differs among the prediction/dataset source maps. Its measured SHA-256 is
`183007219f71c27ed98138bbc3a1c10d86782e3660d20fda225f314bfb89c97a`;
new main has `50ea3a7b943d5b9b26766cee0d0930cec2a101979fffe448507f0d2babddc361`.
The diff removes the CHECK and adds a comment, with no query/function/index
change. These passes qualify the approved checkpoint, not the newer main.
The owner then approved adoption and both reruns below. Historical ledgers,
receipts and bundles remain unchanged.

## Step 3: adopted-checkpoint requalification

[`step-3-requalification-20261109T091550Z.json`](step-3-requalification-20261109T091550Z.json)
and its [private archive reference](step-3-requalification-records-20261109T091550Z.reference.json)
qualify `d661b02`, measured at merge `83bb28f`. The earlier nine-file step 3
evidence was committed as `6e1daa6` before that merge. Both matrices ran in one
owner-confirmed quiet window on lane-3 large, prediction first, with unchanged
targets/budgets/deadlines and no retries or replacements.

Prediction: 600/600 pass; worst full-path p95 120.110 ms, maximum sample
172.723 ms, maximum startup 151.342 ms. All six trials and `trial-p95-v2`
startup gates pass, with 3 SQL / 2 checks / 1 GET per sample. The existing
auditor, rights/deletion controls, diversity and 300 cold-process checks pass.
All 64 measured source hashes/blob IDs match the adopted checkpoint.

Dataset: three fresh-process cold builds (506.727 / 435.916 / 446.178 ms) and
three warm builds (354.645 / 343.859 / 363.358 ms), each 8 SQL / 2 checks and
2,504 rows. Exact bytes match within the matrix and the original natural hash
is preserved. All 48 measured source hashes/blob IDs match the checkpoint.
The legacy issue/step/deletion-pass label is scoped to the six dataset builds;
historical deletion/rebuild probes were not rerun.

The `fs173-checkpoint-requalification-v1` wrapper contains observed mount,
admission and PostgreSQL settings for each matrix. Six offline routing checks
and all 72 output-file hashes/sizes verify. Explicit new output directories
were reserved before startup; results came only from those exact paths. The
three inventories were captured after teardown, before packaging, excluding
themselves. OS/file/database caches remain unflushed and preparation-warmed;
no cold-disk or hosted claim follows. The old runner's hardcoded 512 MiB field
is distinguished from the observed 2 GiB mount.

The owner directed reuse of #258's producer/replay requalification at `cad93c9`.
The new wrapper binds those receipt hashes: all 30 producer attempts pass,
maximum ingestion pair 11.588 s / feature job 4.813 s; all 77 producer pins
match. Both replay hashes and current source content identity verify, with
103,468 normalized rows and 20 contexts per run. Proposal 138's bytes match
`d661b02`. These are receipt/source checks, not new producer or replay runs.
The detailed producer archive remains outside Git per #197 and is not copied.

The 35-member mirror contains both full/compact measurement records, source
verification and citations, the three output inventories, routing checks,
driver sources/diffs and lifecycle/settings logs. All members and the bundle
were persisted/read back through ObjectStore. Verify bundle SHA-256
`5804fab749f8bc88676092821e1a413a5130d012baa83c7a73df341204211b98`
and `storage.members`; do not use the older generic receipt-projection schema.
Raw fixture and full dataset bytes remain in ObjectStore.

The cross-clock rule is fixed by #258. Snapshot ordering
`job.recorded_at <= snapshot.ingested_at <= job.finished_at` is checked by tests,
not a database constraint; the owner foreign key remains. The #231/#241 commit
visibility gap is still accepted. The adopted checkpoint retains the separate
`domainPackage.test.ts` 5 s timeout CI exception
([#260](https://github.com/ven2dev/dfs-ev-demo/issues/260)), with both DB jobs passing.

Lane-3 teardown was verified at `2026-11-09T09:15:50Z`, with no lane-3 containers
or networks remaining; ALT received the all-clear. The new qualification was
committed as `0cdbe3a` after owner approval.

## Step 4: scoped final verdict

The [written decision](../../feature-store-thin-slice-verdict.md#final-gono-go-at-d661b02)
records **GO for bounded local retrospective research** on the pinned fixture
at `d661b02`, and **NO-GO for public or hosted use**. All four capacity targets
pass: #258 at `cad93c9` qualifies ingestion/features, and the renewed step 3
receipt qualifies dataset/prediction. No workload or database was started for
step 4, and no existing ledger, receipt or bundle was rewritten.

The decision keeps historical availability unverified (2,504 retrospective,
zero strict forecasts), population completeness unestablished (#54), and all
183 infinite log-loss cases visible. Rights remain scoped by #171/#197, with
new participation-derived public outputs held and #256's qualified CC BY-SA
notice review open. The intended hosted pipeline role/driver is unqualified;
R2's live proof used synthetic data only. Review-provenance gaps and the
accepted #231/#241 visibility gap remain. #258 fixed the cross-clock rule;
snapshot ordering is checked by tests, not a database constraint. App and CI
fail under the checkpoint's owner-accepted #260 timeout exception.

The PR draft and review handoff are prepared locally. Step 4 was committed
after direct owner approval; independent review and fresh consent remain required
before any push. No public release, deployment, migration freeze, UI integration
or #54 completion follows.

## Publication storage boundary

The owner approved an unpublished-history rebuild following #258. Full
payload-containing archives stay private through ObjectStore; Git contains
compact receipts and the following hash/size references instead. The original
receipts retain their historical `storage.bundle.path` and all member hashes.
Those paths name private artifacts, not missing public mirrors. Measured
values, verdicts and source identities were not changed or rerun.

- [step-3-dataset-records-20261109T085139Z.tar.gz](step-3-dataset-records-20261109T085139Z.reference.json): 56,651 bytes, SHA-256 `5b9413ff07e6eb44cfd94c3cd788df96c1217d914893e583b2afb395e3dd3228`.
- [step-3-prediction-records-20261109T084110Z.tar.gz](step-3-prediction-records-20261109T084110Z.reference.json): 325,665 bytes, SHA-256 `a9c6acac27d007d2fb5b15c8ea7744d9d99e07d2cc04a22a1b1779e273f919d1`.
- [step-3-requalification-records-20261109T091550Z.tar.gz](step-3-requalification-records-20261109T091550Z.reference.json): 366,041 bytes, SHA-256 `5804fab749f8bc88676092821e1a413a5130d012baa83c7a73df341204211b98`.

These archives contain full forecast responses and/or sampled dataset rows,
not just timing metadata. The original commits and exact bytes remain in a
local-only backup and private ObjectStore. Do not push the backup tag.

The [publication inventory](publication-inventory.json) records the scan of all
5 archives / 123 members, including 1,206 JSON-encoded strings. Step 2
and the stopped-run archive have no row-payload matches and remain in-tree.
The compact receipts/ledger also have no row-payload matches. The PR remains
blocked pending review; no backup ref or private archive is approved for push.
