# Thin-slice readiness verdict (#173)

Step 1 is committed as `be53387`. Step 2's integrated assessment and offline
validation are complete, pending commit approval. The two approved reruns and
the final owner verdict are pending.
This document does not claim that the full thin slice passed.

Checkpoint: `286f4d05d5d1eb34ec085a1a772f7e21afb40a27`. The owner created
`feature/dfsEV-173-thin-slice-verdict` from this commit. The
[approved roadmap](https://github.com/ven2dev/dfs-ev-demo/issues/173#issuecomment-6734499691)
authorizes documentation and the scoped reruns, with commit approval after each
step and a confirmed quiet window before either rerun.

## Design basis

**Pattern.** Use an evidence-backed readiness checklist pinned to immutable
source, fixture and review identities. Reconcile existing receipts and reuse
the existing dataset and prediction runners. There is no new serving path,
storage subsystem or performance optimization in this issue.

**Alternatives.** Issue closure alone hides stale measurements and unverified
prerequisites. Reusing every historical timing after affected code changes
overstates its qualification scope. Repeating every successor benchmark would
rerun unaffected work without clarifying the disputed claims. Compare sources,
keep historical results and rerun the two affected capacity paths instead.

**Targets.** Preserve the original #138 deadlines and 30% headroom: ingestion
42 s under 60 s; full-season features 84 s under 120 s; dataset build/write/hash
21 s under 30 s; prediction trial p95 210 ms under 300 ms. Ingestion is 12 SQL,
derived jobs 8 SQL, dataset builds 8 SQL / 2 batched rights/status checks,
context predictions 3 SQL / 2 checks / 1 descriptor GET, and model-only reads
2 SQL. These are separate workloads, not one combined budget. No per-example
calls are permitted because they conceal growth with cohort size.

Prediction uses #242's `trial-p95-v2` rule: each cold trial's startup p95 is at
most 210 ms; every full-path and startup sample is at most 300 ms. The sample
ceiling prevents a pathological tail hiding below a passing percentile.

**Requirement reasons.** Bind sources, policy, fixture and receipts by exact
identity to prevent substitution or stale approval. Retain failures and
refusals to prevent favorable-sample selection. Recheck current rights/status
at delivery to avoid serving withdrawn inputs. Keep retrospective, public and
hosted dispositions separate so local research proof cannot authorize release.
Use owner-controlled quiet windows to avoid interference. Append new evidence
without changing old receipts so past failures and evidence formats retain
their meaning. SQL stays in `packages/db/proposals/`, preventing an experimental
qualification from changing frozen deployment history.

**Assumptions.** Trusted pipeline/database owner, restricted readers, immutable
snapshots and private local research. The fixture is the 16 pinned 2021–2025
wire files; 2021 is warm-up and 2022–2025 evaluation. There are 2,504 usable
retrospective examples with natural SHA-256
`a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d`.
OS/file/database caches are unflushed and disclosed. This is not a population,
historical-availability, concurrency, hosted-latency or public-release proof.
The owner/database remains trusted; this does not defend against malicious
administrators. No migration freeze, deployment, public UI or #54 completion
follows from a local go verdict.

## Checkpoint and CI

| Checkpoint | App | Core DB | Feature-store DB | CI | Scope |
| --- | --- | --- | --- | --- | --- |
| `7d1883f` | Pass | Pass | Pass | Pass | Integrated runtime checkpoint after #169 |
| `286f4d0` | Fail | Pass | Pass | Fail | Same runtime code; #197 adds only documentation, notices and an inventory |

The sole App failure at the pinned checkpoint was
`services/pipeline/tests/feature-store/domainPackage.test.ts:8` reaching the
5,000 ms test timeout. The aggregate CI failed because App failed. This is a
real failed check, handled separately; the earlier green checkpoint does not
turn it into a pass. Both facts were accepted by the owner for #173's pin.
See the [pinned CI run](https://github.com/ven2dev/dfs-ev-demo/actions/runs/42575488546).
If the timeout fix merges before this issue finishes, advance the checkpoint
and reassess affected identities and checks. Do not inherit review across an
affected code change.

## Capacity verdict before the approved reruns

| Target | Verdict | Evidence scope |
| --- | --- | --- |
| Ingestion ≤42 s; each leg under 60 s; 12 SQL | Pass | #169 final 24 ingestion attempts: maximum pair 18.139 s. All 77 pinned source hashes match this checkpoint. |
| Full-season features ≤84 s under 120 s; 8 SQL | Pass | #169 final six feature attempts: maximum 7.419 s. Same matching source inventory. |
| Dataset ≤21 s under 30 s; 8 SQL / 2 checks | Blocked | Historical #138 and #241 passes; current-source fresh-process matrix is approved but not run. |
| Prediction trial p95 ≤210 ms under 300 ms; 3 SQL / 2 checks / 1 GET | Blocked | #242 historical six-trial pass; current-source startup graph has changed. Approved rerun not run. |

Blocked means current qualification is incomplete, not that a numeric target
was missed. The 21 s dataset claim was checked first. #138's fresh-process
cold trials were 851.749 / 600.891 / 628.190 ms; warm trials were
519.161 / 463.930 / 458.611 ms. #241's six candidate builds were
467.146–504.940 ms, each 8 SQL / 2 checks, but its cold condition meant a new
connection in the same Node process. That comparison is not the original
fresh-process matrix.

The #241 dataset source inventory has 27 files; seven differ now. The later
`241_job_visibility.sql` change is comment-only, and `datasets.ts` still matches.
Local ObjectStore adds bounded reads/page listing; ObjectStore later adds the
verified-wire accessor registration. Harness, audit and compose changes are
separate setup/environment drift. These byte changes are not evidence of a
regression; neither do they establish current-source capacity.

#242 measured six 100-sample trials at `4edb698`; the worst full-path p95 was
170.547 ms and maximum startup 175.631 ms. Its 62-file inventory has seven
changes. The handler, owner helper, domain math and proposal SQL match; the
ObjectStore import graph changed, relevant to fresh-process startup. Ingest,
normalization, source transport, harness, auditor and compose changes are
recorded separately. No historical receipt is relabelled as current proof.

## Original criteria and owner amendments

The [machine ledger](evidence/feature-store-173/step-1-ledger.json) expands these
groups into individual requirements with evidence paths, exact receipt hashes,
final PR heads, measured identities and review provenance. A pass below has the
stated historical or implementation scope; it is not a renewed timing claim.
The step 2 assessment below covers affected integrated code once.

| Ledger IDs | Criterion/amendment | Final issues | Disposition and principal evidence |
| --- | --- | --- | --- |
| C01–C03 | Approved design/source inventory; preregistration before scores; main-based proposal-only code, immutable history and retired-code boundary | #138 | Pass for foundation scope: source inventory, source manifest and foundation checkpoint. Proposal path is now `packages/db/proposals/`. |
| C04–C07 | Exact original bytes through ObjectStore; atomic create-once; idempotent trusted jobs and real clocks; typed normalization and ambiguity/version/corruption refusal | #138, #163, #241, #251 | Pass for pinned probes. #241 adds missing completion boundaries; #251 production transport still refuses loopback. |
| C08–C10 | Latest ≤16 prior eligible REG games, minimum 2; kickoff−1 h; exclude target/equal/future games in both modes; unavailable labels are not zero | #138, #163, #164, #241 | Pass for pinned event-time and population probes; historical availability remains unverified. |
| C11–C12 | Corrections preserve old versions and permitted last-valid values; stale/superseded flags and conservative season lineage | #138, #241 | Pass for correction probes. Dataset stale now describes today's newest completed value, not a fallback at the requested time. |
| C13–C16 | Immutable feature/label dataset pins, flag policy, exact and natural hashes; 2021 warm-up excluded; 8 SQL / 2 batched checks; dataset capacity | #138, #241 | Pinned behavior/work pass; current fresh-process 21 s qualification blocked pending approved rerun. |
| C17–C21 | Current rights and deletion races; upload before BEGIN; short writer address lock and metadata HEAD; readers without explicit coordination locks; delayed cleanup/pruning; scoped 2025 deletion | #138, #165, #166, #228, #229 | Pass for pinned behavior/work evidence. 1,948 features + 1,948 labels + 6 datasets invalidated; 5,517 earlier feature and label rows each survive unchanged without recomputation. |
| C22–C24 | Immutable model/report pins; idempotent publication and bounded orphan recovery; two model-read queries and one GET per selected artifact | #165, #166, #231 | Pass for pinned publication, retry, lifecycle and work proofs. Normal-path and exceptional re-creation counts are distinguished. |
| C25–C27 | Chronological folds; registered half-yard thresholds/Brier/log loss/calibration/integer RPS; seasons and n bands; preserve infinity; genuine market-only comparison | #164 | Pass for historical scoring proof: 2,504 retrospective/0 strict forecasts, 183 infinite-loss cases. Calibration correction changes 369 placements only. Current evaluation capacity is not newly qualified. |
| C28–C30 | Governed predictor; selected-feature sample size; Q2 context and distinct receipts; evidence-mode refusal; one deadline, no partial/late delivery; owner-only disposal | #167, #168, #235 | Pass for pinned behavior proofs. Response excludes connection state; caller deadline only shortens 300 ms; owner helper applies disposition exactly once. |
| C31–C33 | ≥3 cold and ≥3 warm trials; no no-op capacity substitution; ≥100 predictions/trial; fresh cold process/connection, pinned diversity, disclosed caches; startup percentile/sample rules | #168, #169, #242 | Producer qualification passes on matching sources; current prediction capacity blocked pending approved rerun. Retain #168's original evidence version. |
| C34–C35 | Every attempt kept, failures censored, refusals not successes; ABBA for actual comparisons only; ingestion includes network | #138, #169, #241, #242, #251 | Pass for evidence policy. #169 owner amendment measures live GitHub transfer plus exact pinned loopback ingestion; changed upstream bytes are observations. |
| C36–C37 | Bounded integrity verification and independent recompute from exact raw bytes | #170, #244 | Historical pass: 16 objects / 246,304,787 bytes scrubbed; two replays matched 103,468 normalized rows and 20 derived contexts. Current shared-source changes receive scoped assessment in step 2. |
| C38–C40 | Source declarations and scoped schedule permission; public ShareAlike disposition; actual Neon configuration separate from defaults | #171, #197 | Declaration/notice record passes in its scope. New public participation-derived outputs and intended pipeline-role/driver qualification remain blocked. |
| C41 | External adapter owner amendment: R2 replaces original GCS/Blaze gate | #172 | Pass for synthetic live R2 contract at recorded adapter blobs; current bounded methods and public/default-store use are distinct claims. No GCS prerequisite remains active. |
| C42–C45 | Independent review, integrated CI, original scope/successor split, explicit full go/no-go without deployment or population implications | #138, #173 | Review history gaps retained; pinned CI exception disclosed; final integrated assessment/verdict pending. |
| C46–C47 | Accepted terminal-UPDATE-to-COMMIT limitation and host/database cross-clock constraint | #231, #241, #258 | Visibility gap accepted. Cross-clock repair remains open in #258, without timestamp adjustment here. |

## Source and review provenance

Final PR heads identify merged artifacts; they do not, by themselves, prove an
independent review. The machine ledger retains full 40-character SHAs. The
following short forms aid reading.

| Issue | Final PR head | Measured/probed identity or additional evidence | Review provenance |
| --- | --- | --- | --- |
| #138 / PR #174 | `545c606` | Approved implementation `420710f`; integrated code `05bf12c`; preserved archive tag `1383b5c` | Older receipt says review pending; exact final reviewed SHA not established here |
| #163 / PR #178 | `7b35183` | `review-1-correctness.json`, `review-1-hot-path.json`; later completion repair #241 | Preserve receipt scope; do not substitute merge for exact review |
| #164 / PR #202 | `14bf012` | `ff87274` plus separately hashed calibration correction | PR records independent review; no formal GitHub review object or final reviewed SHA established here |
| #165 / PR #227 | `6894aa2` | Relative benchmark and correction/re-created-object receipts | Owner's no-rerun decision for unchanged normal SQL/HEAD counts is retained; exact final review gap remains |
| #166 / PR #230 | `8c97163` | Receipt reviewed head `da46a72`, correction `eb0562b` | Exact receipt scope; later affected changes not automatically approved |
| #167 / PR #239 | `f12af17` | Final receipt plus step-0 follow-ups | Owner session confirms both step-0 reviews and handler review; later #168 contract supersedes old handler timing |
| #168 / PR #240 | `d371981` | 600-sample final receipt at `d371981` | Owner independently verified branch, source identities and results |
| #169 / PR #255 | `7013a43` | Requalification at `42ef490`; evidence-only final commit | Owner confirms `9ef323e..cd9fe66` and requalification at `42ef490` |
| #170 / PR #245 | `12250ec` | Scrub `47e7ffe`, receipt hash and memory wrapper | Measured identity distinct from final PR head; exact independent reviewed range not supplied |
| #171 / PR #199 | `74a5d48` | Dated qualification receipt and scoped follow-ups | Owner decisions documented; no blanket legal or hosted-runtime clearance |
| #172 / PR #243 | `cf705de` | Review-fix adapter blob `d87be63`, with live contract receipt | Preserve exact tested blob; later #170 adapter additions are separate |
| #231 / PR #233 | `3b5d59a` | Composite/context receipts; carried corrections in #167 | Owner-approved carried fixes retained with new receipts |
| #241 / PR #246 | `1d4a33c` | Final benchmark `441aaf9`; restored-plan cleanup receipt | Owner confirms #241 review; exact reviewed range not supplied |
| #242 / PR #248 | `96f7e21` | Final benchmark `4edb698` | Owner confirms `03fac00..96f7e21` |
| #244 / PR #253 | `42f9740` | Two committed CLI runs at `a946c82`; dirty-code guard follow-up | Qualification does not silently move to final head; exact independent reviewed range not supplied |
| #251 / PR #252 | `00ced71` | Shared transfer/loopback refusal tests | Owner confirms `4ce685a..00ced71` |
| #197 / PR #257 | `af5c828` | Approved data notices and output/channel hold dispositions | #197 closes its decision/documentation scope; product enforcement belongs to #53 |

## Integrated assessment and offline validation (step 2)

The [assessment receipt](evidence/feature-store-173/step-2-assessment-20261109T075101Z.json)
records the scope, findings and checks at `be53387`, whose runtime matches the
pinned checkpoint. The detailed record binds 23 assessed source files by SHA-256
and Git blob ID. This is the implementing agent's integration assessment, not
an independent review or a fresh database/capacity qualification.

**Premise.** The integrated code follows the approved set-based dataflow,
immutable ObjectStore boundaries and functional prediction core. No new
blocking runtime correctness or wrong-pattern finding was identified. The
following conclusions remain bounded by source inspection and the named checks.

| Area | Assessment | Qualification limit |
| --- | --- | --- |
| Prediction | Query-only borrowed client; one same-process deadline through serialization; selected-feature sample size; Q2 context and both receipts; private refusal and interruption latch; owner-only disposal. | Existing behavior receipts retain their scope; current-source capacity awaits the approved rerun. |
| Dataset and job visibility | Set-based cutoff-qualified pins, current completed-job freshness, two batched rights/status boundaries, upload before BEGIN and metadata-only publication. Shared relational visibility helper and intentionally repeated join CASE remain in place. | Fresh-process dataset capacity is pending; terminal UPDATE-to-COMMIT gap remains accepted. |
| Verified wire, scrub and replay | Registration retains the same dedicated ArrayBuffer without a second payload copy. Released/replaced allocations are refused. Scrub remains bounded; replay shares normalization and strengthens its dirty-input guard. | Four focused tests cover the changed allocation/identity contracts. No scrub or replay database rerun is claimed. |
| Scoring | Domain math matches final #164 head; corrected report bytes and logical hashes verify. | Historical 2,504 retrospective/zero strict folds remain historical proof; no fresh report latency or predictive-superiority claim. |
| R2 | Preserve the recorded synthetic live contract at its tested adapter blobs. | Later bounded read/list methods have local/mock qualification; their live behavior, hosted capacity and default-store adoption remain unqualified. |

Under Node `24.18.1`, seven offline audits passed for #166, #231, #167, #168,
#241, #242 and #169: **319 retained records**. These verify archive bytes and
receipt projections, not independent execution of every recorded DB assertion.
The **24 offline evidence tests** also passed, including recomputed capacity
statistics, work/schedule checks and tamper controls. **Four focused integration
tests** passed for verified-wire reuse/release/registration and the replay
repository-identity guard. No full suite was run in this step.

Additional offline checks verified:

- All **52 original #138 archive files**, including retained failures, match
  their index's hashes, sizes and line counts at `1383b5c`.
- #170's machine receipt matches its wrapper hash, records 16 verified objects /
  246,304,787 bytes and equal initial/final state hashes.
- Both #244 replay receipts match their wrapper hashes. Each records 103,468
  normalized rows and 20 derived contexts; the natural-key/value and derived
  parity records agree across runs, with unchanged boundary state hashes.
- #164's three calibration-correction receipt references match. The correction
  proof, verifier and two report artifacts verify through local ObjectStore;
  the reports' logical hashes and 2,504/zero fold counts also match. Reading
  retained proof bytes does not independently rerun the calibration verifier.

The disposable archive checker initially counted newline delimiters rather
than logical lines and rejected a one-line file without a trailing newline.
Its digest and size matched. Correcting that checker to count logical lines
made all 52 index entries agree; this was not a benchmark retry. The observation
is retained in the assessment.

**Rerun containment.** The legacy dataset driver hardcodes a #138 evidence path
and continues after a numeric-only sample failure. Do not run it directly: that
would risk overwriting history and violating the approved stop policy. Step 3
will use an isolated disposable copy with output redirection and a fail-fast
check immediately after saving each sample, before starting another. Retain
the original/adapted driver hashes and diff. Preserve its timed build/worker
path, fixture, targets, counts and cache boundary. Prediction uses an explicit
new output directory and `trial-p95-v2`. These are qualification-harness
constraints, not new serving-path repairs.

Remote main was still `286f4d0` at this assessment. The accepted CI timeout
exception and the requirement to advance the pin if its separate fix merges
remain in force. No lane, DB query, hosted access or capacity timing ran in
step 2. Dataset and prediction capacity stay **blocked** pending the approved
reruns; public/hosted/strict-history limits remain unchanged.

## Accepted exceptions and remaining limits

- **Temporal evidence.** Retrospective corrections and postseason participation
  never become captured pregame knowledge. Strict and retrospective outputs stay
  separate. The 2,504 examples do not establish population completeness or #54.
- **Commit visibility.** #231/#241 accept `finished_at` stamped by the terminal
  UPDATE before COMMIT. A cutoff in that window can change its answer after
  COMMIT; the measured 0.5 ms example remains a limitation.
- **Cross-clock rule.** [#258](https://github.com/ven2dev/dfs-ev-demo/issues/258)
  owns `captured_at <= ingested_at`. It compares a host timestamp with a database
  timestamp. Do not adjust clocks/timestamps to make it pass.
- **Scoring.** Preserve positive-infinity log loss, exclusions and empty strata.
  No accuracy/ROI threshold was registered. The empirical method is itself the
  naive baseline; no independent baseline was beaten. Market comparison is
  unavailable without genuine captured compatible lines.
- **Rights.** #171 qualifies scoped release declarations, including the schedule
  release copy, not every third-party right. #197 approves notices for the listed
  existing Git fixture/excerpts. New participation-derived API/UI, exports and
  artifacts remain held for output-specific decisions and #53 enforcement.
  Notices do not clear public model release or change the application license.
- **Hosted operations.** Console-role Neon timeout observations do not qualify
  the actual pipeline role/driver. Synthetic R2 proof does not establish hosted
  capacity or make R2 the default. Its remote-HEAD address-lock time remains a
  prerequisite to that change. The historical GCS/Blaze gate was superseded.
- **Storage and cleanup.** Season lineage is deliberately conservative. The
  orphan/recovery policy assumes PUT completes within its recovery window;
  revocation after the final delivery snapshot remains an accepted delivery gap.
  Scrub/replay use operator quiescence and synthetic disposable grants, not a
  grant of rights over a live catalog.
- **Retained failures.** Keep #241's unexplained 668 ms retrospective sample,
  resource failures and owner-accepted producer comparison exception, stopped
  plans and withdrawn cleanup rewrite. A successful checksum audit does not
  convert any of them into a passing performance attempt. #169's earlier-source
  qualification remains history beside its final-source rerun.

## Remaining sequence and estimate

1. Evidence/review ledger committed as `be53387` after owner approval.
2. Integrated assessment and offline validation complete; stop for commit
   approval of its documentation, receipt and durable evidence mirror.
3. In one owner-confirmed quiet window, prediction first: reuse #242's six
   100-sample trials with `trial-p95-v2`, then 3 fresh-process cold and 3 warm
   dataset builds. Use Node 24 and lane-3 standard tier, derive its URL through
   the lane tool and run preflight. Disclose unflushed caches; warm trials still
   check current rights/status. Keep every attempt, stop on any failure, append
   new evidence through ObjectStore, verify teardown and announce window end.
   Stop for commit approval. Historical runner output paths need interception
   or an isolated disposable tree so they cannot overwrite #138 evidence.
4. Record the final go/no-go and review handoff, then stop for commit approval.
   Fresh consent after review is required before push.

Remaining approved planning range: 3.5–5 active hours including the reruns,
excluding owner and quiet-window waits. Report and propose a split before
exceeding five hours or adding repairs. No final qualification, public release,
deployment, hosted write or Production command is authorized by this ledger.
