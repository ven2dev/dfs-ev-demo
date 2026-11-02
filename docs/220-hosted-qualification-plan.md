# #220 hosted qualification — local harness review

Status: commit A is recorded as a local checkpoint. A subsequent runner-preflight
fix is uncommitted for review on
`feature/dfsEV-220-hosted-harness`. Stop for owner review. No commit, push,
provisioning, configuration change, deployment or hosted run is authorized.
This branch must never merge: proxy.ts would add an invocation to every
Production /api request, including SSE. PR #226 retains only its original
qualification docs, proposal and local spike script; that worktree is clean.

## Design basis

Pattern: externally driven, paired topology comparison with alternating arm
order. One request from the owner's Mac maps to one function invocation and one
sample. The generator runs bounded waves of 20 distinct potential leaders,
measuring time inside each invocation. Preallocated tickets enforce transitions
through function code without introducing a globally locked measurement counter.
No worker loop runs inside the route.

Arms: iad1 is current Production parity; pdx1 is a co-located candidate for the
us-west-2 database. Both use the same project, schema-only disposable Neon branch,
compute, Node 24.x, @neondatabase/serverless 1.2.0, pooled HTTP driver, resource
fixture and test matrix. Each arm has a distinct run ID and 18,483 tickets.
Only one arm drives the shared database at a time. Report each arm separately;
never pool regions. Preserve baseline, admission-only and full-path reports.

Alternatives: one arm cannot separate topology from admission cost; running all
iad1 samples before all pdx1 samples confounds time-of-day drift; concurrent arms
would add database contention between treatments. A worker pool inside one
invocation hides cross-instance behavior, while client RTT includes Mac/network
cost. Changing the project-level region or using the existing Preview database
would violate parity and alter shared resources. Default Neon branching copies
Production rows, so only explicit schema-only creation is eligible.

Targets: for each arm and mode, p95 <=140 ms in every 20-leader warm round, and
overall warm p95 <=200 ms across that mode's six warm groups (three rounds at
one and 20 leaders). Maximum and p99 are informational only. A single sample
above 140 ms does not fail a round whose p95 passes. An individual one-leader
round does not independently fail the 200 ms gate; the overall warm distribution
owns that gate. Failed/missing/invalid samples fail their group and cannot be
silently dropped or retried. Stale quota and independently proven cold results
stay outside warm percentiles. Stale quota has no elapsed target until measured.
These are qualification targets, not a claim of a hosted pass.

Requirement reasons: a never-merge branch prevents Production proxy invocation
cost; Preview protection plus route bearer/identity/expiry guards prevent public
experimental access; schema-only setup and a schema-limited runner protect
Production rows; distinct run IDs prevent ticket replay across arms; pausing the
other run and draining traffic before fixture resets prevent cross-arm
contamination. Fixed request modes prevent arbitrary route SQL. No log/report
contains a password, connection string, bearer or bypass secret. No paid provider
call is made by the experiment, to avoid spending real credits while qualifying.

Assumptions: project prj_GLXDEeScMKPAeDAUoYIoiNknwKJd, root apps/web, Preview
only. Production functions are iad1. Production database project is
wandering-tree-67967407, host
`ep-old-snow-aralp6jm-pooler.c-4.us-west-2.aws.neon.tech` (AWS us-west-2).
Production branch, CU range/autoscaling and suspend timeout remain unverified;
provisioning and invocation fail closed until that parity profile is verified.
A Production region change is out of scope. If pdx1 wins, propose a separate
issue with before/after measurement on existing routes; do not treat this
synthetic result as approval to move Production.

## Read-only parity and capability findings

Vercel's Production store is neon-cordovan-nest, store_sIohx3i6MWXh1htB, external
Neon project wandering-tree-67967407. The existing dfs-ev-preview store uses
small-pond-10949870 and is connected only to Preview; it is not substituted.
The Production host above was extracted in memory from DATABASE_URL. Only its
hostname was recorded; no password or complete connection string was saved.

On 2026-10-31, inspected Vercel → Storage → neon-cordovan-nest → Settings:
https://vercel.com/vernon-neillys-projects/~/integrations/neon/icfg_7OdQVIxc9sFpe2JJvxfsAD2y/resources/storage/store_sIohx3i6MWXh1htB/settings

It shows Region Portland, USA (West), pdx1; Auth False; Realtime False; Launch
plan. The plan advertises sizes up to 16 CU / 64 GB RAM; this is a plan limit,
not this database's current compute allocation. The header's Compute 3 hours is
usage, not compute size. The settings page does not expose actual min/max CU,
autoscaling or scale-to-zero timeout. No setting or configuration was changed.
Neon MCP access still has the recorded project 404/account-association blocker;
the owner also faces the Neon activation loop. Provisioning stays blocked. Only
the owner has selected the support-request path to restore Neon access. No
separate Neon project is permitted. The support draft below remains unsent; this
local-only instruction does not authorize sending it.

Vercel documents Automation Bypass on all plans and branch-scoped Preview
variables, with Secret as the current name for Sensitive. Actual configuration
preflight must still prove acceptance; if Hobby rejects either, stop rather than
using shared Preview variables.
https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation
https://vercel.com/docs/environment-variables
https://vercel.com/docs/environment-variables/sensitive-environment-variables

## Two Git commits and immutable Previews — planned, not created

Git-push deployments read apps/web/vercel.json. The CLI-only alternate config has
been deleted; no CLI deployment is eligible because branch-scoped Preview
variables are not guaranteed on that path. The never-merge branch has two planned
commits, both requiring owner commit approval, with pushes separately gated as
part of the hosted follow-up:

1. Commit A contains the reviewed harness with vercel.json regions ["iad1"].
   After access/parity is restored and hosted/push approval is obtained, set the
   exact-branch Preview Secrets for the iad1 run, including binding.reviewedSha
   equal to SHA_A. Push that commit to trigger its Git Preview; wait for READY,
   verify its captured settings/region/source, and preserve its immutable URL/ID.
2. Commit B is a direct child of A and changes only apps/web/vercel.json regions to ["pdx1"]. Verify the
   Git diff A..B contains only that region change, preserving all harness code,
   tests and cron settings. Update only the branch-scoped Preview bindings for
   the pdx1 run with binding.reviewedSha equal to SHA_B, then separately approved
   push triggers the second Git Preview. Keep the first deployment live.

Both deployments remain live for alternating arm blocks. Each captures the same
branch-scoped variable names with its own arm/run/SHA values at creation; changing
branch values for B does not update A. Confirm effective bindings on both exact
immutable URLs before measurement, not the moving branch alias. No project-level
function region, Production setting or existing Preview store is changed.

A local durable runner receipt outside Git records expectedShaByArm =
{iad1: SHA_A, pdx1: SHA_B}, distinct deployment IDs/URLs and run IDs. Actual SHAs
are unknown until the separately approved commits exist; current evidence keeps
them null, and the runner refuses missing/equal pins. Timed measurement waits
until both commits and deployment receipts are pinned. Do not put a commit's own
SHA into its tracked source: populate the external receipt and branch-scoped
binding after the commit is created and before its approved push. The two-region
comparison code/config is otherwise identical between commits. No third evidence
commit/push is needed: retain run receipts outside Git for the owner review.

verifyArmReceipts checks both Git-source Preview receipts against the distinct
expected SHA pins. verifyPreview/runGroup enforce the arm's expected SHA, exact
branch and deployed-function region; summarizeArm refuses groups from a different
SHA as well as a different arm. Each group receipt carries deployment ID, arm,
run ID, observed SHA and the full expected-SHA map. verifyRegionOnlyChange checks
the reviewed A..B path/config diff; it does not create either commit.
https://vercel.com/docs/functions/configuring-functions/region

Before every arm block, verify the exact deployment's qualification function
region using deployment/function metadata, not configuration text alone. The
runner requires a receipt identifying deployment ID, function path, actual
single region and source deployment-function-metadata. It also verifies project,
Preview target, that arm's expected Git SHA/branch, protection and direct deployment URL.
The response must report that same arm and VERCEL_REGION. Missing/mismatched
metadata fails closed. No project-level region, Production config or Preview
store change is allowed.

## Matrix, alternation and timing

Each arm uses the same 240-key catalog (20 events ×12 registered markets).
Each wave uses one market for each of 20 distinct events, testing shared-account
contention rather than same-item followers. A wave drains before the next starts,
so a fast lane cannot overtake a slower prior lease. This is not an unbounded
arrival-rate test or a multi-market batch benchmark.

Per arm: at one and 20 leaders, three alternating mode orders; each mode has
20 warm-up samples immediately followed by 1,000 timed samples. There are also
three cold baseline samples and three stale/next-tick pairs of 20 requests.
Total: 18,483 distinct tickets per arm, 36,966 across the two separate runs.
No SQL cap is raised: hosted_run still permits at most 20,000 tickets per run.
The second initialization omits shared catalog/budget insertion but creates a
new run and new tickets. The distinct run IDs are bound into immutable Preview
configuration and reported with each sample.

armSchedule() pairs each warmup+warm block or stale+next-tick block and alternates
its arm order AB, BA, AB, BA. Its output preserves the identical full schedule
within each arm. A block's stages are sent as separate homogeneous runGroup()
calls. Drain both deployments before changing groups; prepareGroup takes the
chosen run ID, activates only that run and pauses the other. No arms run
concurrently against the shared budget. Before each arm block, reconfirm region
metadata and reset the synthetic fixture only after traffic has drained. A
stale round's next tick preserves its predecessor's state; it is not reset.
Do not continue/reset an ambiguous invocation until it has ended or its bounded
lifetime is independently accounted for.

Report inFunctionPreProviderMs as the qualification timing. It includes handler
authorization/body validation/lazy driver setup, but excludes platform scheduling
and initialization before entry. Client RTT is context only. Pre-provider SQL
count/time are distinct from total SQL count/time and post-boundary release.
Each query records its fixed operation label and round-trip milliseconds; no SQL
arguments or credentials appear in telemetry.

Every non-cold baseline sample also issues a standalone literal SELECT 1 through
the same cached Neon HTTP driver, after the baseline measurement boundary. Its
round-trip time is separately recorded as transportRoundTripMs, with per-round,
per-concurrency summaries within each arm and an arm-specific warm distribution.
It is not added to admission/full-path calls. It estimates the transport/dispatch
floor, not pure network time; do not mechanically subtract percentiles and claim
that difference is PostgreSQL CPU. A cold baseline's first database call remains
the cold measurement and has no appended transport probe.

## Deterministic work budgets

| Mode/path | Pre-provider SQL round trips | External calls | Post-boundary SQL |
| --- | --- | --- | --- |
| Warm baseline cache read | 1 | 0 | 1 standalone SELECT 1 transport probe |
| Cold baseline cache read | 1 | 0 | 0 |
| Warm admission only | 1 | 0 | 1 owner-fenced lease release |
| Warm full cache-miss path | 2 | 0 | 1 owner-fenced lease release |
| Stale quota, probe leader accepted | 5 | 1 free /events | 1 owner-fenced lease release |
| Stale quota, probe follower / claim backoff / needs-init | 3 | 0 | 0 |
| Stale quota, finish backoff / needs-init / unavailable | 4 | 1 free /events | 0 |
| Stale quota, invalid observation | 4 | 1 free /events | 0 |

runGroup gates each 20-leader warm round by p95 <=140 ms. summarizeArm requires
all six 1,000-sample warm groups per mode and gates their combined warm p95 at
200 ms, for that arm and mode only. It reports p99/max without gating them.
Warm-up, cold, stale and next-tick values do not enter overall warm p95.
Transport results do not replace the admission/full-path gates.

Synthetic admissions reserve credits but make no paid call and are not
reconciled; operator-only fixture restoration between drained groups resets
this synthetic ledger. Ticket transitions are enforced by function code; the
runner role technically holds UPDATE on hosted_tickets and DML on budget tables.
The runner DSN is a branch-scoped Secret held only by the server route, and the
branch is disposable. SECURITY INVOKER keeps admit() under the production design's
privilege model, not a database sandbox against a compromised DSN. Table-level
SELECT on hosted_run is revoked; only id, expires_at, active_group and runner
are readable. The bearer is verified only by authorize(). SQL hosted_check is
only a run-exists, expiry and current_user fence; it stores/checks no token hash.
hosted_begin(false) accepts only path tickets. These gates add no SQL round trips.

Stale-quota fixtures first initialize the synthetic account with an approved
free observation's real total/counters, then age only its timestamp. Never feed
real headers into the 100,000-credit warm fixture. Probe followers immediately
return typed stale/unavailable; the next tick retries, with no polling. No actual
SSE transport or application data serving is implemented in this experiment.
Cold samples require independent suspension evidence for the exact endpoint
before each arm's observation. Idle time alone is insufficient. If Production
disables suspension, report not applicable; do not enable it just for this test.
Each arm has its own cold and stale report; neither enters warm distributions.

## Provisioning, secrets and cleanup contract — not executed

Create only an explicitly schema-only child of the confirmed Production branch,
with matching region, min/max CU, autoscaling and suspend settings. The exposed
MCP default create_branch copies data and is ineligible. Do not enable the
Neon–Vercel per-Preview integration. Verify no application rows were inherited.
Audit inherited PUBLIC privileges, memberships and role flags, including table,
column, sequence, function, schema CREATE and database TEMP rights outside
spike220. Verify server timeouts before the runner's first SQL statement. The
role grant helper does not replace this branch-specific audit.

All harness variables remain branch-scoped Preview Secret/Sensitive values.
Each immutable deployment captures its arm/run binding; replacing values for a
later arm never grants permission to modify Production or shared Preview values.
Preview Deployment Protection is the outer gate; feature flag, bearer, expiry,
project/branch/SHA/host/region checks are inside. Automation Bypass is project-wide,
so use an approved named/existing secret only on the exact Preview host as a
header. Do not rotate the default/system binding. Actual credentials live in
per-arm 0600 regular owner-controlled files outside Git; none are generated in this phase.

After separately approved hosted work, verify deletion of the exact Neon child
and role, exact branch-scoped variable IDs, both arm deployment URLs, and the
local secret files. Keep sanitized IDs for interrupted cleanup, never broad-prefix
deletes. No cleanup API is called during local preparation.

## Estimate and split for review

The earlier 3.5–5.5-hour single-arm estimate is superseded. The two-arm end-to-end
scope is estimated at 5–8 active engineering hours, excluding external access
waits, so it is split before any further commitment:

1. Local harness refinement/review package: 1.5–2.5 active hours, hard stop at
   2.5. Two-arm bindings/configs/schedule, telemetry/gates, tests and this plan.
   This is the only work currently authorized; no live GitHub issue is created.
2. Separate proposed hosted-qualification follow-up issue: 3.5–5.5 active hours,
   hard stop at 5.5, only after verified parity/access, review and fresh hosted
   approval. Scope: exact resource setup/audit, immutable Preview arms, alternating
   runs, separate evidence and verified cleanup. The owner reviews this split
   and issue creation before hosted work begins. A local issue-body draft is in
   docs/220-hosted-qualification-follow-up-draft.md; it has not been created on
   GitHub. The separate owner push approval covers the Git Preview triggers, not
   merely a source upload. If revised LOE exceeds six
   hours, split again; do not consume the excess under #220.

Any Production region move is another issue, not part of either package.
Account/activation repair remains an external blocker with no invented deadline.

## Local validation and review gate

Validation passed: 24 focused Node tests, eight loopback PostgreSQL checks on
the standard PostgreSQL 18.6 / 512 MiB fixture, root typecheck, lint/import
boundaries and build. The local schema/role and owned fixture were removed.
Review all local changes against f806e73 on the never-merge harness branch. Check
that regional configuration is isolated, deployment evidence gates precede each
arm, matrix order alternates, transport queries stay out of admission timing,
results never pool regions, and p99/max do not gate. Passing local tests proves
behavior and compilation only; no hosted latency or parity acceptance is claimed.

Owner decision: restore Neon access through the support request, with no separate
Neon project. The draft below remains unsent; sending it is outside this local
change authorization. Provisioning stays blocked until access is restored.

> Vercel-managed Neon project wandering-tree-67967407, resource
> neon-cordovan-nest (store_sIohx3i6MWXh1htB), installation
> icfg_7OdQVIxc9sFpe2JJvxfsAD2y, is connected to Production for dfs-ev-demo.
> Opening Neon encounters an account activation loop; the connected Neon API
> account returns 404. Vercel settings show region and plan but not actual
> compute/autoscaling/suspend settings. Please restore the correct account/SSO
> association and supported control-plane access. We need read-only Production
> branch/endpoint and compute metadata, then separately approved schema-only
> disposable-child management. Do not reset/migrate the database, copy Production
> rows, change Production settings or enable per-Preview branching integration.


## Subsequent local iteration: mandatory runner preflight

Review found that commit A's region-diff verifier existed but runGroup could be
called without it or the paired deployment receipts. The new local correction
makes both mandatory before any HTTP request. readRegionCommitProof reads only
local Git objects with rev-list, diff and show; it validates B's sole parent is
A and only the iad1-to-pdx1 configuration changes. verifyArmReceipts ties that
proof to both expected SHAs, and runGroup checks the selected deployment/run/URL
against the verified pair. Missing, wrong-parent, merge-parent or extra-path
proofs fail before fetch. This does not add SQL or measured-path work.

The correction remains uncommitted after the recorded A checkpoint; no B exists.
To preserve the two-commit design, it would need owner-approved amendment of A
before any push. That would change SHA_A and require refreshing the external
receipt; no amendment is authorized or performed in this iteration. Current A
is not approved for pushing, and Neon access still blocks hosted work.

Iteration validation: 27 focused Node tests and targeted ESLint passed. The
valid Git-reader command sequence is unit-tested with a mock, and the real
read-only Git path rejects a missing B. No real B has been created to exercise
a complete actual A/B pair. Application and SQL sources are unchanged from the
previous checked checkpoint, so build/database suites were not repeated.


## Subsequent local iteration: raw-sample report gates

After the preflight fix was committed into A, review reproduced a false pass in
summarizeArm: raw 20-leader round p95 was 150 ms (over 140 ms), but a cached group
timing of 100 ms and cached passed=true caused the assembler to pass. The local
correction recomputes each round's distribution from raw non-failed rows and
requires all 1,000 samples. Overall p95 is also derived from raw rows. Cached
passed/timing/failures summaries cannot override actual samples. Failed or
non-finite samples cannot be converted into a pass. Targets, SQL work and the
measured application path are unchanged.

This correction remains uncommitted for owner review; A has not been amended
again. It would need a separately approved amendment before B so the region-only
second-commit invariant remains true. No new commit, B, push or hosted work is
part of this iteration.

## Merged qualification SQL synchronization

The never-merge harness incorporates main (PR #226) through a merge, preserving
the original harness commit history. Setup and
between-group resets call initialize_budget, the sole terminal-probe reset path,
after draining leases and clearing synthetic attempts. Stale groups initialize
a fresh snapshot first, then age only its timestamp. Sticky cost-overrun remains
sticky; operator setup does not forgive it.

Probe needs-init and backoff are distinct typed report outcomes, neither successful
admissions nor request errors. Claims return them immediately without polling or
a free call; finish may also return either after one free call. The existing
confirmation/backoff policy comes from main's proposal SQL. An accepted/fresh
probe permits one bounded retry with a new owner/attempt UUID inside hosted_sample,
with no additional round trip. Stale-path timing remains separate with no target.
No hosted work is authorized while #86 remains open.
